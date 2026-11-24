import { describe, expect, it } from 'vitest';
import { computeCameraPose, projectPointFromPose } from '../src/render/cameraPose';
import { computeHudReticlePoint } from '../src/render/cockpitHud';
import { buildHostileFrigateMesh } from '../src/render/models';
import type { HullTextureSet } from '../src/render/textures';
import { COMBAT_TUNING, computePlayerFireSolution, findTargetContact } from '../src/sim/combat';
import {
  add,
  computeLeadPoint,
  distance,
  dot,
  normalize,
  quatLookAt,
  scale,
  solveInterceptTime,
  sub,
  vec3,
} from '../src/sim/math';
import {
  DEFAULT_SORTIE_SEED,
  FIXED_DT,
  NEUTRAL_INPUT,
  type CameraMode,
  type Vec3,
  type WorldState,
} from '../src/sim/types';
import { createInitialWorld, stepWorld } from '../src/sim/world';

describe('ballistic lead solver, HUD convergence, unreachable guards, pause freeze, and frigate layout', () => {
  it('solves exact quadratic intercept and scores a real hit on a fast crossing enemy in stepWorld', () => {
    const shooterPos = vec3(0, 0, 0);
    const shooterVel = vec3(0, 0, -60);
    const targetPos = vec3(-120, 25, -360);
    const targetVel = vec3(110, -20, 40);

    const t = solveInterceptTime(
      sub(targetPos, shooterPos),
      sub(targetVel, shooterVel),
      COMBAT_TUNING.boltSpeed,
      COMBAT_TUNING.boltTtl,
    );
    expect(t).not.toBeNull();
    const lead = computeLeadPoint(
      shooterPos,
      shooterVel,
      targetPos,
      targetVel,
      COMBAT_TUNING.boltSpeed,
      COMBAT_TUNING.boltTtl,
    );
    expect(lead).not.toBeNull();
    if (t === null || lead === null) return;
    expect(Math.abs(distance(shooterPos, lead) - COMBAT_TUNING.boltSpeed * t)).toBeLessThan(1e-3);

    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    const baseEnemy = base.enemies[0];
    expect(baseEnemy).toBeDefined();
    if (baseEnemy === undefined) return;

    const aimDir = normalize(sub(lead, shooterPos));
    const playerOrientation = quatLookAt(aimDir);
    let world: WorldState = {
      ...base,
      player: {
        ...base.player,
        position: shooterPos,
        velocity: shooterVel,
        orientation: playerOrientation,
        selectedTargetId: baseEnemy.id,
      },
      enemies: [
        {
          ...baseEnemy,
          position: targetPos,
          velocity: targetVel,
          orientation: quatLookAt(normalize(targetVel)),
          fireCooldown: 99,
        },
      ],
    };

    const startHull = world.enemies[0]?.hull ?? 0;
    world = stepWorld(world, { ...NEUTRAL_INPUT, firePrimary: true }, FIXED_DT);
    expect(world.projectiles.length).toBeGreaterThan(0);

    let hitConfirmed = false;
    for (let i = 0; i < 60; i += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
      const currentHull = world.enemies[0]?.hull ?? 0;
      if (currentHull < startHull || world.events.some((e) => e.kind === 'hit_confirmed')) {
        hitConfirmed = true;
        break;
      }
    }
    expect(hitConfirmed).toBe(true);
  });

  it('returns null for unreachable receding targets and intercepts beyond bolt TTL', () => {
    // 300 m away, receding at 700 m/s (> 580 m/s boltSpeed): no positive intercept exists.
    expect(
      solveInterceptTime(vec3(0, 0, -300), vec3(90, 0, -700), COMBAT_TUNING.boltSpeed, COMBAT_TUNING.boltTtl),
    ).toBeNull();
    expect(
      computeLeadPoint(
        vec3(0, 0, 0),
        vec3(0, 0, 0),
        vec3(0, 0, -300),
        vec3(90, 0, -700),
        COMBAT_TUNING.boltSpeed,
        COMBAT_TUNING.boltTtl,
      ),
    ).toBeNull();

    // 1,400 m crossing shot: mathematical intercept exists (~2.44 s) but exceeds 1.9 s bolt TTL.
    expect(
      computeLeadPoint(
        vec3(0, 0, 0),
        vec3(0, 0, 0),
        vec3(0, 0, -1400),
        vec3(120, 0, 0),
        COMBAT_TUNING.boltSpeed,
        COMBAT_TUNING.boltTtl,
      ),
    ).toBeNull();
  });

  it('projects the real HUD reticle onto the exact crossing point of both spawned bolts across cockpit/chase cams, aim assist, and mid-FOV transitions', () => {
    const width = 1280;
    const height = 720;
    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    const baseEnemy = base.enemies[0];
    expect(baseEnemy).toBeDefined();
    if (baseEnemy === undefined) return;

    const scenarios: readonly {
      readonly cameraMode: CameraMode;
      readonly targetPos: Vec3;
      readonly liveFov: number;
    }[] = [
      { cameraMode: 'cockpit', targetPos: vec3(0, 0, -90), liveFov: 68 },
      { cameraMode: 'chase', targetPos: vec3(0, 0, -90), liveFov: 68 },
      // 6 deg off-axis at 260 m during a mid-boost FOV lerp (triggers aim assist + off-center projection).
      { cameraMode: 'chase', targetPos: vec3(27.3, 6, -258.5), liveFov: 74.2 },
    ];

    for (const scenario of scenarios) {
      const world: WorldState = {
        ...base,
        cameraMode: scenario.cameraMode,
        player: {
          ...base.player,
          position: vec3(0, 0, 0),
          velocity: vec3(0, 0, 0),
          orientation: quatLookAt(vec3(0, 0, -1)),
          selectedTargetId: baseEnemy.id,
        },
        enemies: [
          {
            ...baseEnemy,
            position: scenario.targetPos,
            velocity: vec3(0, 0, 0),
            fireCooldown: 99,
          },
        ],
      };

      const pose = computeCameraPose(world.player, world.cameraMode);
      const liveProject = (point: Vec3, w: number, h: number) =>
        projectPointFromPose(pose, point, w, h, scenario.liveFov);

      // Measure actual HUD reticle coordinates from production cockpitHud.ts.
      const hudReticle = computeHudReticlePoint(world, liveProject, width, height);

      // Fire real bolts from combat.ts and intersect both trajectories with the convergence plane.
      const selected = findTargetContact(world.player.selectedTargetId, world.enemies, world.hostileFrigate);
      const fireSolution = computePlayerFireSolution(world.player, selected);
      expect(fireSolution.barrels.length).toBe(2);

      const planeNormal = normalize(sub(fireSolution.convergencePoint, world.player.position));
      for (const barrel of fireSolution.barrels) {
        const denom = dot(barrel.direction, planeNormal);
        expect(denom).toBeGreaterThan(0.5);
        const distToPlane = dot(sub(fireSolution.convergencePoint, barrel.muzzle), planeNormal) / denom;
        const crossingWorld = add(barrel.muzzle, scale(barrel.direction, distToPlane));
        const crossingScreen = liveProject(crossingWorld, width, height);
        const pxErr = Math.hypot(crossingScreen.x - hudReticle.x, crossingScreen.y - hudReticle.y);
        expect(pxErr).toBeLessThan(0.5);
      }
    }
  });

  it('freezes simulation completely while paused and resumes without losing elapsed time or state', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    for (let i = 0; i < 15; i += 1) {
      world = stepWorld(world, { ...NEUTRAL_INPUT, firePrimary: i === 0 }, FIXED_DT);
    }
    expect(world.phase.kind).toBe('active');
    const prePauseTick = world.tick;
    const prePauseElapsed = world.phase.kind === 'active' ? world.phase.elapsedSeconds : -1;
    const prePausePos = world.player.position;
    const prePauseProjCount = world.projectiles.length;

    world = stepWorld(world, { ...NEUTRAL_INPUT, togglePause: true }, FIXED_DT);
    expect(world.phase.kind).toBe('paused');

    // Idempotent pauseRequested never unpauses when already paused.
    world = stepWorld(world, { ...NEUTRAL_INPUT, pauseRequested: true }, FIXED_DT);
    expect(world.phase.kind).toBe('paused');

    for (let i = 0; i < 90; i += 1) {
      world = stepWorld(world, { ...NEUTRAL_INPUT, firePrimary: true, boost: true, pitch: 1 }, FIXED_DT);
    }
    expect(world.phase.kind).toBe('paused');
    expect(world.tick).toBe(prePauseTick);
    expect(world.phase.kind === 'paused' ? world.phase.elapsedSeconds : -1).toBe(prePauseElapsed);
    expect(world.player.position).toEqual(prePausePos);
    expect(world.projectiles.length).toBe(prePauseProjCount);
    expect(world.events).toEqual([]);

    world = stepWorld(world, { ...NEUTRAL_INPUT, togglePause: true }, FIXED_DT);
    expect(world.phase.kind).toBe('active');
    expect(world.phase.kind === 'active' ? world.phase.elapsedSeconds : -1).toBe(prePauseElapsed);

    world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    expect(world.tick).toBe(prePauseTick + 1);
  });

  it('keeps Frigate visual subsystem mesh positions locked to simulation hitbox localOffsets', () => {
    const world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    const stubTextures = {
      frigateHull: undefined,
    } as unknown as HullTextureSet;
    const rig = buildHostileFrigateMesh(stubTextures);

    expect(world.hostileFrigate.subsystems.length).toBeGreaterThan(0);
    for (const subsys of world.hostileFrigate.subsystems) {
      const mesh = rig.subsystemMeshes.get(subsys.id);
      expect(mesh).toBeDefined();
      expect(mesh?.position.x).toBe(subsys.localOffset.x);
      expect(mesh?.position.y).toBe(subsys.localOffset.y);
      expect(mesh?.position.z).toBe(subsys.localOffset.z);
    }
  });
});
