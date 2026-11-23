import { describe, expect, it } from 'vitest';
import { stepCombat, stepLockState } from '../src/sim/combat';
import { stepEnergy } from '../src/sim/energy';
import { vec3 } from '../src/sim/math';
import { FIXED_DT, NEUTRAL_INPUT, type LockState } from '../src/sim/types';
import { createInitialWorld } from '../src/sim/world';

function ticksUntil(step: (tick: number) => boolean): number {
  for (let tick = 1; tick <= 1000; tick += 1) {
    if (step(tick)) {
      return tick;
    }
  }
  throw new Error('Simulation boundary was not reached in 1000 ticks');
}

describe('formal TLA+ timing agreement at 60 Hz', () => {
  it('matches EnergyAndLock.tla tick boundaries for drift, recovery, lock, and missile rearm', () => {
    const world = createInitialWorld(1, true);
    const initial = { ...world.player.energy, engineCharge: 75, weaponCharge: 50, shieldCharge: 50 };
    const advance = (energy: typeof initial, boost: boolean, drift: boolean) =>
      stepEnergy(energy, boost, drift, world.player.velocity, FIXED_DT).energy;

    const boost = advance(initial, true, false);
    const boostRecovering = advance(boost, false, false);
    const driftEntry = advance(initial, true, true);

    let driftState = driftEntry;
    const maxDriftTicks = ticksUntil(() => {
      driftState = advance(driftState, false, true);
      return driftState.boostMode.kind === 'recovering';
    });

    const measureRecovery = (start: typeof initial): number => {
      let state = start;
      return ticksUntil(() => {
        state = advance(state, true, true);
        return state.boostMode.kind === 'ready';
      });
    };

    const contact = {
      id: 'target',
      label: 'TARGET',
      kind: 'enemy' as const,
      position: vec3(0, 0, -50),
      velocity: vec3(0, 0, 0),
    };
    let lock: LockState = { kind: 'none' };
    const acquireTicks = ticksUntil(() => {
      lock = stepLockState(lock, contact, vec3(0, 0, 0), vec3(0, 0, -1), 1, FIXED_DT).lockState;
      return lock.kind === 'locked';
    });

    const fireBoth = { ...NEUTRAL_INPUT, fireMissile: true, firePrimary: true };
    let player = world.player;
    const missileTicks: number[] = [];
    const shotTicks: number[] = [];
    ticksUntil((tick) => {
      const result = stepCombat({
        tick,
        rngState: world.rngState,
        player,
        wingmate: world.wingmate,
        enemies: [],
        friendlyCarrier: world.friendlyCarrier,
        hostileFrigate: world.hostileFrigate,
        asteroids: [],
        projectiles: [],
        explosions: [],
        radio: null,
        input: fireBoth,
        dt: FIXED_DT,
      });
      player = result.player;
      if (result.events.some((e) => e.kind === 'missile_fired')) {
        missileTicks.push(tick);
      }
      if (result.events.some((e) => e.kind === 'cannon_fired' && e.faction === 'friendly')) {
        shotTicks.push(tick);
      }
      return missileTicks.length === player.maxMissiles + 2;
    });

    const rack = player.maxMissiles;
    expect(maxDriftTicks).toBe(121);
    expect(measureRecovery(boostRecovering)).toBe(39);
    expect(measureRecovery(driftState)).toBe(45);
    expect(acquireTicks).toBe(48);
    expect((shotTicks[1] ?? 0) - (shotTicks[0] ?? 0)).toBe(8);
    expect((missileTicks[1] ?? 0) - (missileTicks[0] ?? 0)).toBe(31);
    expect((missileTicks[rack] ?? 0) - (missileTicks[0] ?? 0)).toBe(241);
    expect((missileTicks[rack + 1] ?? 0) - (missileTicks[rack] ?? 0)).toBe(240);
  });
});
