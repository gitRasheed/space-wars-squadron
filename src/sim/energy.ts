import { clamp } from './math';
import type { BoostMode, EnergyState, PowerMode, SimEvent, Vec3 } from './types';

export const ENERGY_RULES = {
  minBoostEngageCharge: 22,
  minDriftEngageCharge: 18,
  boostDrainPerSecond: 32,
  driftDrainPerSecond: 26,
  maxDriftSeconds: 2.2,
  boostRecoverySeconds: 0.75,
  driftRecoverySeconds: 0.95,
  primaryShotCost: 5.5,
  weaponDrawWhileBoosting: 10,
} as const;

const RECHARGE_RATES: Record<
  PowerMode,
  { readonly engines: number; readonly weapons: number; readonly shields: number }
> = {
  engines: { engines: 24, weapons: 9, shields: 5 },
  balanced: { engines: 15, weapons: 17, shields: 9 },
  weapons: { engines: 9, weapons: 27, shields: 7 },
};

export interface EnergyStepResult {
  readonly energy: EnergyState;
  readonly events: readonly SimEvent[];
}

export function createInitialEnergy(): EnergyState {
  return {
    powerMode: 'balanced',
    boostMode: { kind: 'ready' },
    engineCharge: 100,
    weaponCharge: 100,
    shieldCharge: 100,
  };
}

export function stepEnergy(
  current: EnergyState,
  requestedPower: PowerMode | null,
  wantBoost: boolean,
  wantDrift: boolean,
  currentVelocity: Vec3,
  dt: number,
): EnergyStepResult {
  const powerMode = requestedPower ?? current.powerMode;
  const rates = RECHARGE_RATES[powerMode];
  const events: SimEvent[] = [];

  let boostMode: BoostMode = current.boostMode;
  let engineCharge = current.engineCharge;
  let weaponCharge = current.weaponCharge;
  const shieldCharge = clamp(current.shieldCharge + rates.shields * dt, 0, 100);

  switch (boostMode.kind) {
    case 'ready': {
      if (wantDrift && engineCharge >= ENERGY_RULES.minDriftEngageCharge) {
        boostMode = {
          kind: 'drifting',
          driftVelocity: currentVelocity,
          elapsedSeconds: 0,
        };
        engineCharge = clamp(engineCharge - ENERGY_RULES.driftDrainPerSecond * dt, 0, 100);
        events.push({ kind: 'drift_engaged' });
      } else if (wantBoost && engineCharge >= ENERGY_RULES.minBoostEngageCharge) {
        boostMode = { kind: 'boosting' };
        engineCharge = clamp(engineCharge - ENERGY_RULES.boostDrainPerSecond * dt, 0, 100);
        weaponCharge = clamp(weaponCharge - ENERGY_RULES.weaponDrawWhileBoosting * dt, 0, 100);
        events.push({ kind: 'boost_engaged' });
      } else {
        engineCharge = clamp(engineCharge + rates.engines * dt, 0, 100);
        weaponCharge = clamp(weaponCharge + rates.weapons * dt, 0, 100);
      }
      break;
    }

    case 'boosting': {
      if (wantDrift && engineCharge >= ENERGY_RULES.minDriftEngageCharge) {
        boostMode = {
          kind: 'drifting',
          driftVelocity: currentVelocity,
          elapsedSeconds: 0,
        };
        engineCharge = clamp(engineCharge - ENERGY_RULES.driftDrainPerSecond * dt, 0, 100);
        events.push({ kind: 'drift_engaged' });
      } else if (wantBoost && engineCharge > 0) {
        engineCharge = clamp(engineCharge - ENERGY_RULES.boostDrainPerSecond * dt, 0, 100);
        weaponCharge = clamp(weaponCharge - ENERGY_RULES.weaponDrawWhileBoosting * dt, 0, 100);
        if (engineCharge <= 0) {
          boostMode = { kind: 'recovering', remainingSeconds: ENERGY_RULES.boostRecoverySeconds };
        }
      } else {
        boostMode = { kind: 'recovering', remainingSeconds: ENERGY_RULES.boostRecoverySeconds };
      }
      break;
    }

    case 'drifting': {
      const elapsedSeconds = boostMode.elapsedSeconds + dt;
      engineCharge = clamp(engineCharge - ENERGY_RULES.driftDrainPerSecond * dt, 0, 100);
      weaponCharge = clamp(weaponCharge + rates.weapons * 0.6 * dt, 0, 100);
      if (!wantDrift || engineCharge <= 0 || elapsedSeconds >= ENERGY_RULES.maxDriftSeconds) {
        boostMode = { kind: 'recovering', remainingSeconds: ENERGY_RULES.driftRecoverySeconds };
      } else {
        boostMode = {
          kind: 'drifting',
          driftVelocity: boostMode.driftVelocity,
          elapsedSeconds,
        };
      }
      break;
    }

    case 'recovering': {
      const remainingSeconds = boostMode.remainingSeconds - dt;
      engineCharge = clamp(engineCharge + rates.engines * 0.5 * dt, 0, 100);
      weaponCharge = clamp(weaponCharge + rates.weapons * dt, 0, 100);
      boostMode =
        remainingSeconds <= 0
          ? { kind: 'ready' }
          : { kind: 'recovering', remainingSeconds };
      break;
    }
  }

  return {
    energy: {
      powerMode,
      boostMode,
      engineCharge,
      weaponCharge,
      shieldCharge,
    },
    events,
  };
}

export function spendWeaponCharge(energy: EnergyState, cost: number): EnergyState | null {
  if (energy.weaponCharge < cost) {
    return null;
  }
  return {
    ...energy,
    weaponCharge: clamp(energy.weaponCharge - cost, 0, 100),
  };
}

export function absorbShieldDamage(
  energy: EnergyState,
  damage: number,
): { readonly energy: EnergyState; readonly hullDamage: number } {
  const absorbed = Math.min(energy.shieldCharge, damage);
  return {
    energy: {
      ...energy,
      shieldCharge: clamp(energy.shieldCharge - absorbed, 0, 100),
    },
    hullDamage: Math.max(0, damage - absorbed),
  };
}
