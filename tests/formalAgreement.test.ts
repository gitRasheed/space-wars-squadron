import { describe, expect, it } from 'vitest';
import { COMBAT_TUNING, stepCombat, stepLockState } from '../src/sim/combat';
import { absorbShieldDamage, stepEnergy } from '../src/sim/energy';
import { vec3 } from '../src/sim/math';
import { FIXED_DT, NEUTRAL_INPUT, type EnergyState, type LockState } from '../src/sim/types';
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
  it('matches EnergyAndLock.tla tick boundaries for shield delay, lock, primary fire, and missile rearm', () => {
    const world = createInitialWorld(1, true);
    const damaged = absorbShieldDamage(world.player.energy, COMBAT_TUNING.enemyBoltDamage).energy;
    let delayState = damaged;
    const shieldDelayTicks = ticksUntil(() => {
      delayState = stepEnergy(delayState, false, false, FIXED_DT).energy;
      return delayState.shieldRegenDelay <= 0;
    });

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

    let ohState: EnergyState = { ...world.player.energy, weaponState: 'overheated', weaponCharge: 0 };
    const overheatTicks = ticksUntil(() => {
      ohState = stepEnergy(ohState, false, false, FIXED_DT).energy;
      return ohState.weaponState === 'ready';
    });

    const rack = player.maxMissiles;
    expect(shieldDelayTicks).toBe(211);
    expect(overheatTicks).toBe(215);
    expect(acquireTicks).toBe(48);
    expect((shotTicks[1] ?? 0) - (shotTicks[0] ?? 0)).toBe(9);
    expect((missileTicks[1] ?? 0) - (missileTicks[0] ?? 0)).toBe(34);
    expect((missileTicks[rack] ?? 0) - (missileTicks[0] ?? 0)).toBe(271);
    expect((missileTicks[rack + 1] ?? 0) - (missileTicks[rack] ?? 0)).toBe(270);
  });
});
