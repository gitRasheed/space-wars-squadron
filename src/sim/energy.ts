import { clamp } from './math';
import { absorbIntoShield, regenShield, SHIP_STATS } from './ships';
import type { EnergyState, SimEvent, WeaponState } from './types';

export const ENERGY_RULES = {
  minOverdriveShield: 15,
  overdriveShieldDrainPerSecond: 24,
  weaponCoolPerSecond: 24,
  // Slower than normal cooling, so bursting inside the heat budget out-shoots riding the lockout.
  overheatCoolPerSecond: 15,
  primaryShotHeat: 9.5,
  maxHeat: 100,
  /** Firing a ready gun at or above this heat is a Hot Zone shot. */
  hotZoneHeat: 80,
  manualRechargePerSecond: 28,
} as const;

export interface EnergyStepResult {
  readonly energy: EnergyState;
  readonly events: readonly SimEvent[];
}

export function createInitialEnergy(): EnergyState {
  return {
    overdrive: false,
    recharging: false,
    weaponState: 'ready',
    weaponHeat: 0,
    shieldCharge: SHIP_STATS.player.shields,
    shieldRegenDelay: 0,
  };
}

export function inHotZone(energy: EnergyState): boolean {
  return energy.weaponState === 'ready' && energy.weaponHeat >= ENERGY_RULES.hotZoneHeat;
}

/**
 * One tick of overdrive, shields and cannon heat. Holding manual recharge drops Overdrive, refuses to
 * enter it, fills the shield past the regen delay and holds a ready gun's heat where it is; an
 * overheat lockout keeps cooling so it always ends.
 */
export function stepEnergy(
  current: EnergyState,
  enterOverdrive: boolean,
  cancelOverdrive: boolean,
  recharging: boolean,
  dt: number,
): EnergyStepResult {
  const events: SimEvent[] = [];

  let overdrive = current.overdrive;
  if (cancelOverdrive || recharging) {
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
  } else if (recharging) {
    shieldRegenDelay = Math.max(0, current.shieldRegenDelay - dt);
    shieldCharge = clamp(current.shieldCharge + ENERGY_RULES.manualRechargePerSecond * dt, 0, SHIP_STATS.player.shields);
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
  const coolRate =
    weaponState === 'overheated'
      ? ENERGY_RULES.overheatCoolPerSecond
      : recharging
        ? 0
        : ENERGY_RULES.weaponCoolPerSecond;
  const weaponHeat = clamp(current.weaponHeat - coolRate * dt, 0, ENERGY_RULES.maxHeat);
  if (weaponState === 'overheated' && weaponHeat <= 0) {
    weaponState = 'ready';
    events.push({ kind: 'weapon_ready' });
  }

  return {
    energy: {
      overdrive,
      recharging,
      weaponState,
      weaponHeat,
      shieldCharge,
      shieldRegenDelay,
    },
    events,
  };
}

export function addWeaponHeat(
  energy: EnergyState,
  heat: number,
): { readonly energy: EnergyState; readonly overheatedNow: boolean } | null {
  if (energy.weaponState === 'overheated' || energy.weaponHeat >= ENERGY_RULES.maxHeat) {
    return null;
  }
  const next = energy.weaponHeat + heat;
  if (next >= ENERGY_RULES.maxHeat) {
    return {
      energy: { ...energy, weaponHeat: ENERGY_RULES.maxHeat, weaponState: 'overheated' },
      overheatedNow: true,
    };
  }
  return { energy: { ...energy, weaponHeat: clamp(next, 0, ENERGY_RULES.maxHeat) }, overheatedNow: false };
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
  return { ...energy, weaponState: 'ready', weaponHeat: 0 };
}
