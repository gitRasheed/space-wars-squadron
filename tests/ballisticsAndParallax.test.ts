import { describe, expect, it } from 'vitest';
import { computeCameraPose, projectPointFromPose } from '../src/render/cameraPose';
import { COMBAT_TUNING } from '../src/sim/combat';
import {
  computeGunBoresightPoint,
  computeLeadPoint,
  distance,
  normalize,
  quatLookAt,
  solveInterceptTime,
  sub,
  vec3,
} from '../src/sim/math';
import {
  DEFAULT_SORTIE_SEED,
  FIXED_DT,
  NEUTRAL_INPUT,
  type CameraMode,
  type WorldState,
} from '../src/sim/types';
import { createInitialWorld, stepWorld } from '../src/sim/world';

describe('ballistic lead solver, camera parallax invariance, and pause freeze', () => {
  it('solves exact quadratic intercept and scores a real hit on a fast crossing enemy in stepWorld', () => {
    const shooterPos = vec3(0, 0, 0);
    const shooterVel = vec3(0, 0, -60);
    const targetPos = vec3(-120, 25, -360);
    const targetVel = vec3(110, -20, 40);

    const t = solveInterceptTime(sub(targetPos, shooterPos), sub(targetVel, shooterVel), COMBAT_TUNING.boltSpeed);
    const lead = computeLeadPoint(shooterPos, shooterVel, targetPos, targetVel, COMBAT_TUNING.boltSpeed);
    expect(Math.abs(distance(shooterPos, lead) - COMBAT_TUNING.boltSpeed * t)).toBeLessThan(1e-3);

    // End-to-end simulation proof: orient fighter straight at lead, fire once, step until hit.
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

  it('maintains sub-pixel reticle-to-lead alignment across both cockpit and chase cameras at all combat ranges', () => {
    const width = 1280;
    const height = 720;
    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);

    for (const cameraMode of ['cockpit', 'chase'] as const satisfies readonly CameraMode[]) {
      for (const range of [90, 260, 640]) {
        const targetPos = vec3(45, -18, -range);
        const targetVel = vec3(-85, 22, 35);
        const lead = computeLeadPoint(
          base.player.position,
          base.player.velocity,
          targetPos,
          targetVel,
          COMBAT_TUNING.boltSpeed,
        );
        const orientedPlayer = {
          ...base.player,
          orientation: quatLookAt(normalize(sub(lead, base.player.position))),
        };
        const pose = computeCameraPose(orientedPlayer, cameraMode);
        const boresight = computeGunBoresightPoint(orientedPlayer.position, orientedPlayer.orientation, lead);
        const projReticle = projectPointFromPose(pose, boresight, width, height);
        const projLead = projectPointFromPose(pose, lead, width, height);

        expect(projReticle.inFront).toBe(true);
        expect(projLead.inFront).toBe(true);
        const pxError = Math.hypot(projReticle.x - projLead.x, projReticle.y - projLead.y);
        expect(pxError).toBeLessThan(0.5);
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
});
