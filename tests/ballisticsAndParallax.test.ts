import { describe, expect, it } from 'vitest';
import { computeCameraPose, projectPointFromPose } from '../src/render/cameraPose';
import { computeHudReticlePoint } from '../src/render/cockpitHud';
import { buildCockpitRig, buildHostileFrigateMesh } from '../src/render/models';
import type { HullTextureSet } from '../src/render/textures';
import { frigateOf } from './support/levels';
import {
  COCKPIT_CAMERA_OFFSET,
  COCKPIT_GUN_LOCAL,
  COMBAT_TUNING,
  computePlayerFireSolution,
  FIGHTER_WEAPON_LAYOUT,
  findTargetContact,
} from '../src/sim/combat';
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
  type Vec3,
  type WorldState,
} from '../src/sim/types';
import { createInitialWorld, stepWorld } from '../src/sim/world';

describe('ballistic lead solver, manual aim, cockpit gun alignment, pause freeze, and frigate layout', () => {
  it('solves exact quadratic intercept and scores a real hit on a fast crossing enemy in stepWorld', () => {
    const shooterPos = vec3(0, 0, 0);
    const shooterVel = vec3(0, 0, -60);
    const targetPos = vec3(-95, 20, -280);
    const targetVel = vec3(95, -15, 35);

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

    const startIntegrity = (world.enemies[0]?.shields ?? 0) + (world.enemies[0]?.hull ?? 0);
    world = stepWorld(world, { ...NEUTRAL_INPUT, firePrimary: true }, FIXED_DT);
    expect(world.projectiles.length).toBeGreaterThan(0);

    let hitConfirmed = false;
    for (let i = 0; i < 60; i += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
      const currentIntegrity = (world.enemies[0]?.shields ?? 0) + (world.enemies[0]?.hull ?? 0);
      if (currentIntegrity < startIntegrity || world.events.some((e) => e.kind === 'hit_confirmed')) {
        hitConfirmed = true;
        break;
      }
    }
    expect(hitConfirmed).toBe(true);
  });

  it('returns null for unreachable receding targets and intercepts beyond bolt TTL', () => {
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

    // 700 m crossing shot exceeds the ~515 m bolt reach (560 m/s * 0.92 s).
    expect(
      computeLeadPoint(
        vec3(0, 0, 0),
        vec3(0, 0, 0),
        vec3(0, 0, -700),
        vec3(120, 0, 0),
        COMBAT_TUNING.boltSpeed,
        COMBAT_TUNING.boltTtl,
      ),
    ).toBeNull();
  });

  it('keeps LMB manual with zero aim assist and projects cockpit reticle onto exact barrel convergence across ranges and FOV', () => {
    const width = 1280;
    const height = 720;
    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    const baseEnemy = base.enemies[0];
    expect(baseEnemy).toBeDefined();
    if (baseEnemy === undefined) return;

    const scenarios: readonly { readonly targetPos: Vec3; readonly liveFov: number }[] = [
      { targetPos: vec3(0, 0, -90), liveFov: 68 },
      // 6 deg off-axis at 260 m during overdrive FOV lerp: must NOT bend toward target!
      { targetPos: vec3(27.3, 6, -258.5), liveFov: 74.2 },
      { targetPos: vec3(-18, 9, -460), liveFov: 68 },
    ];

    for (const scenario of scenarios) {
      const world: WorldState = {
        ...base,
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

      const pose = computeCameraPose(world.player, 'cockpit');
      const liveProject = (point: Vec3, w: number, h: number) =>
        projectPointFromPose(pose, point, w, h, scenario.liveFov);
      const hudReticle = computeHudReticlePoint(world, liveProject, width, height);

      const selected = findTargetContact(world.player.selectedTargetId, world.enemies, world.hostileFrigate);
      const fireSolution = computePlayerFireSolution(world.player, selected);
      expect(fireSolution.barrels.length).toBe(2);

      // Zero aim assist: convergencePoint lies strictly along ship forward (-Z), never bent toward X/Y!
      expect(fireSolution.convergencePoint.x).toBeCloseTo(0, 6);
      expect(fireSolution.convergencePoint.y).toBeCloseTo(0, 6);
      expect(fireSolution.convergencePoint.z).toBeLessThan(0);

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

    world = stepWorld(world, { ...NEUTRAL_INPUT, pauseRequested: true }, FIXED_DT);
    expect(world.phase.kind).toBe('paused');

    for (let i = 0; i < 90; i += 1) {
      world = stepWorld(world, { ...NEUTRAL_INPUT, firePrimary: true, throttlePushEdge: true, pitch: 1 }, FIXED_DT);
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

    expect(frigateOf(world).subsystems.length).toBeGreaterThan(0);
    for (const subsys of frigateOf(world).subsystems) {
      const mesh = rig.subsystemMeshes.get(subsys.id);
      expect(mesh).toBeDefined();
      expect(mesh?.position.x).toBe(subsys.localOffset.x);
      expect(mesh?.position.y).toBe(subsys.localOffset.y);
      expect(mesh?.position.z).toBe(subsys.localOffset.z);
    }
  });

  it('keeps first-person cockpit gun barrel tips and sim FIGHTER_WEAPON_LAYOUT derived from one shared source', () => {
    const rig = buildCockpitRig();
    expect(rig.barrelLeft.position.x).toBe(-COCKPIT_GUN_LOCAL.x);
    expect(rig.barrelLeft.position.y).toBe(COCKPIT_GUN_LOCAL.y);
    expect(rig.muzzleLeft.position.z).toBe(-COCKPIT_GUN_LOCAL.forward);
    expect(rig.barrelRight.position.x).toBe(COCKPIT_GUN_LOCAL.x);
    expect(rig.barrelRight.position.y).toBe(COCKPIT_GUN_LOCAL.y);
    expect(rig.muzzleRight.position.z).toBe(-COCKPIT_GUN_LOCAL.forward);

    expect(FIGHTER_WEAPON_LAYOUT.muzzleX).toBe(COCKPIT_GUN_LOCAL.x);
    expect(FIGHTER_WEAPON_LAYOUT.muzzleY).toBeCloseTo(COCKPIT_CAMERA_OFFSET.up + COCKPIT_GUN_LOCAL.y, 6);
    expect(FIGHTER_WEAPON_LAYOUT.muzzleForward).toBeCloseTo(
      COCKPIT_CAMERA_OFFSET.forward + COCKPIT_GUN_LOCAL.forward,
      6,
    );
  });
});
