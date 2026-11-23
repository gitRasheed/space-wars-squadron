import { describe, expect, it } from 'vitest';
import { createInitialEnergy, ENERGY_RULES, stepEnergy } from '../src/sim/energy';
import { nextRandom, vec3 } from '../src/sim/math';
import { DEFAULT_SORTIE_SEED, FIXED_DT, NEUTRAL_INPUT } from '../src/sim/types';
import { createInitialWorld, stepWorld } from '../src/sim/world';

describe('energy and AOA drift kernel', () => {
  it('enforces recovery cooldown after boost release and blocks immediate boost-gasping', () => {
    let energy = createInitialEnergy();
    const vel = vec3(0, 0, -90);

    energy = stepEnergy(energy, null, true, false, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('boosting');

    energy = stepEnergy(energy, null, false, false, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('recovering');

    energy = stepEnergy(energy, 'engines', true, false, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('recovering');

    energy = stepEnergy(energy, 'engines', false, true, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('recovering');

    const recoveryTicks = Math.ceil(ENERGY_RULES.boostRecoverySeconds / FIXED_DT) + 2;
    for (let i = 0; i < recoveryTicks; i += 1) {
      energy = stepEnergy(energy, null, false, false, vel, FIXED_DT).energy;
    }
    expect(energy.boostMode.kind).toBe('ready');
  });

  it('caps AOA drift duration and forces transition into recovery', () => {
    let energy = createInitialEnergy();
    const vel = vec3(0, 0, -110);

    energy = stepEnergy(energy, null, false, true, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('drifting');

    const maxTicks = Math.ceil(ENERGY_RULES.maxDriftSeconds / FIXED_DT) + 2;
    for (let i = 0; i < maxTicks; i += 1) {
      energy = stepEnergy(energy, null, false, true, vel, FIXED_DT).energy;
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

  it('toggles camera, fires cannons, and orders wingmate', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    world = stepWorld(
      world,
      { ...NEUTRAL_INPUT, toggleCamera: true, firePrimary: true, orderWingmate: true },
      FIXED_DT,
    );
    expect(world.cameraMode).toBe('chase');
    expect(world.projectiles.length).toBeGreaterThanOrEqual(2);
    expect(world.wingmate.assignedTargetId).toBe(world.player.selectedTargetId);
  });

  it('clears lock and rearms missiles after firing', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    world = stepWorld(world, { ...NEUTRAL_INPUT, fireMissile: true }, FIXED_DT);
    expect(world.player.missilesReady).toBe(3);
    expect(world.player.lockState.kind).toBe('none');

    for (let i = 0; i < 300; i += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    }
    expect(world.player.missilesReady).toBe(4);
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
          orderWingmate: tick % 240 === 0,
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
