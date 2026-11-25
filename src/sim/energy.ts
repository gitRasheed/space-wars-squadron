import { clamp } from './math';
import { absorbIntoShield, regenShield, SHIP_STATS } from './ships';
import type { EnergyState, SimEvent, WeaponState } from './types';

export const ENERGY_RULES = {
  minOverdriveShield: 15,
  overdriveShieldDrainPerSecond: 24,
  weaponRechargePerSecond: 24,
  // Slower than normal recharge, so bursting inside the heat budget out-shoots riding the lockout.
  overheatCooldownPerSecond: 15,
  primaryShotCost: 9.5,
} as const;

export interface EnergyStepResult {
  readonly energy: EnergyState;
  readonly events: readonly SimEvent[];
}

export function createInitialEnergy(): EnergyState {
  return {
    overdrive: false,
    weaponState: 'ready',
    weaponCharge: 100,
    shieldCharge: SHIP_STATS.player.shields,
    shieldRegenDelay: 0,
  };
}

export function stepEnergy(
  current: EnergyState,
  enterOverdrive: boolean,
  cancelOverdrive: boolean,
  dt: number,
): EnergyStepResult {
  const events: SimEvent[] = [];

  let overdrive = current.overdrive;
  if (cancelOverdrive) {
    overdrive = false;
  } else if (!overdrive && enterOverdrive && current.shieldCharge >= ENERGY_RULES.minOverdriveShield) {
    overdrive = true;
    events.push({ kind: 'overdrive_engaged' });
  }

  let shieldCharge: number;
  let shieldRegenDelay: number;
  if (overdrive) {
    shieldRegenDelay = Math.max(0, current.shieldRegenDelay - dt);
    shieldCharge = clamp(current.shieldCharge - ENERGY_RULES.overdriveShieldDrainPerSecond * dt, 0, 100);
    if (shieldCharge <= 0) {
      overdrive = false;
    }
  } else {
    const regen = regenShield(
      current.shieldCharge,
      SHIP_STATS.player.shields,
      current.shieldRegenDelay,
      SHIP_STATS.player.shieldRegenPerSecond,
      dt,
    );
    shieldCharge = regen.shield;
    shieldRegenDelay = regen.regenDelay;
  }

  let weaponState: WeaponState = current.weaponState;
  const rechargeRate =
    weaponState === 'overheated'
      ? ENERGY_RULES.overheatCooldownPerSecond
      : ENERGY_RULES.weaponRechargePerSecond;
  const weaponCharge = clamp(current.weaponCharge + rechargeRate * dt, 0, 100);
  if (weaponState === 'overheated' && weaponCharge >= 100) {
    weaponState = 'ready';
    events.push({ kind: 'weapon_ready' });
  }

  return {
    energy: {
      overdrive,
      weaponState,
      weaponCharge,
      shieldCharge,
      shieldRegenDelay,
    },
    events,
  };
}

export function spendWeaponCharge(
  energy: EnergyState,
  cost: number,
): { readonly energy: EnergyState; readonly overheatedNow: boolean } | null {
  if (energy.weaponState === 'overheated' || energy.weaponCharge <= 0) {
    return null;
  }
  const remaining = energy.weaponCharge - cost;
  if (remaining <= 0) {
    return {
      energy: {
        ...energy,
        weaponCharge: 0,
        weaponState: 'overheated',
      },
      overheatedNow: true,
    };
  }
  return {
    energy: {
      ...energy,
      weaponCharge: clamp(remaining, 0, 100),
    },
    overheatedNow: false,
  };
}

export function absorbShieldDamage(
  energy: EnergyState,
  damage: number,
): { readonly energy: EnergyState; readonly hullDamage: number } {
  const absorbed = absorbIntoShield(energy.shieldCharge, damage);
  return {
    energy: {
      ...energy,
      shieldCharge: absorbed.shield,
      shieldRegenDelay: SHIP_STATS.player.shieldRegenDelay,
      overdrive: absorbed.shield <= 0 ? false : energy.overdrive,
    },
    hullDamage: absorbed.hullDamage,
  };
}

export function flushWeaponHeat(energy: EnergyState): EnergyState {
  return { ...energy, weaponState: 'ready', weaponCharge: 100 };
}
