import { describe, expect, it } from 'vitest';
import { createInitialEnergy, ENERGY_RULES, stepEnergy } from '../src/sim/energy';
import { distance, nextRandom, vec3 } from '../src/sim/math';
import { DEFAULT_SORTIE_SEED, FIXED_DT, NEUTRAL_INPUT } from '../src/sim/types';
import { createInitialWorld, stepWorld } from '../src/sim/world';

describe('energy and snap-turn drift kernel', () => {
  it('enforces recovery cooldown after boost release and blocks immediate boost-gasping', () => {
    let energy = createInitialEnergy();
    const vel = vec3(0, 0, -90);

    energy = stepEnergy(energy, true, false, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('boosting');

    energy = stepEnergy(energy, false, false, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('recovering');

    energy = stepEnergy(energy, true, false, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('recovering');

    energy = stepEnergy(energy, false, true, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('recovering');

    const recoveryTicks = Math.ceil(ENERGY_RULES.boostRecoverySeconds / FIXED_DT) + 2;
    for (let i = 0; i < recoveryTicks; i += 1) {
      energy = stepEnergy(energy, false, false, vel, FIXED_DT).energy;
    }
    expect(energy.boostMode.kind).toBe('ready');
  });

  it('caps snap-turn drift duration and forces transition into recovery', () => {
    let energy = createInitialEnergy();
    const vel = vec3(0, 0, -110);

    energy = stepEnergy(energy, false, true, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('drifting');

    const maxTicks = Math.ceil(ENERGY_RULES.maxDriftSeconds / FIXED_DT) + 2;
    for (let i = 0; i < maxTicks; i += 1) {
      energy = stepEnergy(energy, false, true, vel, FIXED_DT).energy;
    }
    expect(energy.boostMode.kind).toBe('recovering');
  });
});

describe('sortie simulation contracts', () => {
  it('launches from briefing, ignores Enter during active flight, and restarts only on explicit restart', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, false);
    expect(world.phase.kind).toBe('briefing');

    world = stepWorld(world, { ...NEUTRAL_INPUT, launchBriefing: true }, FIXED_DT);
    expect(world.phase.kind).toBe('active');

    world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    const tickBeforeEnter = world.tick;

    world = stepWorld(world, { ...NEUTRAL_INPUT, launchBriefing: true }, FIXED_DT);
    expect(world.tick).toBe(tickBeforeEnter + 1);

    world = stepWorld(world, { ...NEUTRAL_INPUT, restartSortie: true }, FIXED_DT);
    expect(world.tick).toBe(0);
    expect(world.phase.kind).toBe('active');
  });

  it('breaks enemy raiders away after close passes instead of gluing them behind the player', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    let sawBreakAway = false;
    for (let i = 0; i < 420; i += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
      if (world.enemies.some((e) => e.maneuver.kind === 'break_away')) {
        sawBreakAway = true;
      }
      for (const e of world.enemies) {
        if (e.maneuver.kind === 'break_away') {
          expect(distance(e.position, world.player.position)).toBeGreaterThan(20);
        }
      }
    }
    expect(sawBreakAway).toBe(true);
  });

  it('toggles camera, fires cannons, and maintains autonomous wingmate target', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    world = stepWorld(world, { ...NEUTRAL_INPUT, toggleCamera: true, firePrimary: true }, FIXED_DT);
    expect(world.cameraMode).toBe('chase');
    expect(world.projectiles.length).toBeGreaterThanOrEqual(2);
    expect(world.wingmate.targetId).not.toBeNull();
  });

  it('clears lock and rearms missiles after firing', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    world = stepWorld(world, { ...NEUTRAL_INPUT, fireMissile: true }, FIXED_DT);
    expect(world.player.missilesReady).toBe(3);
    expect(world.player.lockState.kind).toBe('none');

    for (let i = 0; i < 270; i += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    }
    expect(world.player.missilesReady).toBe(4);
  });

  it('shatters asteroids when hit by player projectiles', () => {
    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    const targetRock = base.asteroids[0];
    expect(targetRock).toBeDefined();
    if (targetRock === undefined) {
      return;
    }

    const worldWithShot = {
      ...base,
      projectiles: [
        {
          id: 'test-missile',
          kind: 'missile' as const,
          faction: 'friendly' as const,
          position: targetRock.position,
          velocity: vec3(0, 0, -1),
          targetId: null,
          damage: targetRock.hull + 10,
          ttl: 2,
        },
      ],
    };

    const next = stepWorld(worldWithShot, NEUTRAL_INPUT, FIXED_DT);
    expect(next.asteroids.some((a) => a.id === targetRock.id)).toBe(false);
    expect(next.explosions.length).toBeGreaterThan(0);
  });

  it('survives 60 seconds of randomized combat flight with finite state and valid invariants', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    let seed = 0xdeadbeef;

    for (let tick = 0; tick < 3600; tick += 1) {
      const r1 = nextRandom(seed);
      const r2 = nextRandom(r1.nextState);
      const r3 = nextRandom(r2.nextState);
      seed = r3.nextState;

      world = stepWorld(
        world,
        {
          ...NEUTRAL_INPUT,
          pitch: (r1.value - 0.5) * 1.4,
          yaw: (r2.value - 0.5) * 1.4,
          roll: r3.value > 0.7 ? 1 : r3.value < 0.3 ? -1 : 0,
          boost: r1.value > 0.82,
          drift: r2.value > 0.88,
          firePrimary: r3.value > 0.5,
          fireMissile: tick % 90 === 0,
          cycleTarget: tick % 180 === 0,
        },
        FIXED_DT,
      );

      expect(Number.isFinite(world.player.position.x)).toBe(true);
      expect(Number.isFinite(world.player.position.y)).toBe(true);
      expect(Number.isFinite(world.player.position.z)).toBe(true);
      expect(world.player.energy.engineCharge).toBeGreaterThanOrEqual(0);
      expect(world.player.energy.engineCharge).toBeLessThanOrEqual(100);
      expect(world.player.energy.weaponCharge).toBeGreaterThanOrEqual(0);
      expect(world.player.energy.weaponCharge).toBeLessThanOrEqual(100);
      expect(world.player.missilesReady).toBeGreaterThanOrEqual(0);
      expect(world.player.missilesReady).toBeLessThanOrEqual(world.player.maxMissiles);

      if (world.player.lockState.kind !== 'none') {
        expect(world.player.missilesReady).toBeGreaterThan(0);
      }

      if (world.phase.kind !== 'active') {
        world = stepWorld(world, { ...NEUTRAL_INPUT, restartSortie: true }, FIXED_DT);
      }
    }
  });
});
