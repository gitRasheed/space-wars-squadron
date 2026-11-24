import { clamp } from './math';
import type { EnergyState, SimEvent, WeaponState } from './types';

export const ENERGY_RULES = {
  minOverdriveShield: 15,
  overdriveShieldDrainPerSecond: 24,
  shieldRechargePerSecond: 10,
  shieldRegenDelaySeconds: 3.5,
  weaponRechargePerSecond: 18,
  overheatCooldownPerSecond: 28,
  primaryShotCost: 11,
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
    shieldCharge: 100,
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
  let shieldCharge = current.shieldCharge;
  const shieldRegenDelay = Math.max(0, current.shieldRegenDelay - dt);

  if (cancelOverdrive) {
    overdrive = false;
  } else if (!overdrive && enterOverdrive && shieldCharge >= ENERGY_RULES.minOverdriveShield) {
    overdrive = true;
    events.push({ kind: 'overdrive_engaged' });
  }

  if (overdrive) {
    shieldCharge = clamp(shieldCharge - ENERGY_RULES.overdriveShieldDrainPerSecond * dt, 0, 100);
    if (shieldCharge <= 0) {
      overdrive = false;
    }
  } else if (shieldRegenDelay <= 0) {
    shieldCharge = clamp(shieldCharge + ENERGY_RULES.shieldRechargePerSecond * dt, 0, 100);
  }

  let weaponState: WeaponState = current.weaponState;
  const rechargeRate =
    weaponState === 'overheated'
      ? ENERGY_RULES.overheatCooldownPerSecond
      : ENERGY_RULES.weaponRechargePerSecond;
  const weaponCharge = clamp(current.weaponCharge + rechargeRate * dt, 0, 100);
  if (weaponState === 'overheated' && weaponCharge >= 100) {
    weaponState = 'ready';
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
  const absorbed = Math.min(energy.shieldCharge, damage);
  const nextShield = clamp(energy.shieldCharge - absorbed, 0, 100);
  return {
    energy: {
      ...energy,
      shieldCharge: nextShield,
      shieldRegenDelay: ENERGY_RULES.shieldRegenDelaySeconds,
      overdrive: nextShield <= 0 ? false : energy.overdrive,
    },
    hullDamage: Math.max(0, damage - absorbed),
  };
}
