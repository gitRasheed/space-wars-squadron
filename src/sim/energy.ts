import { clamp } from './math';
import type { BoostMode, EnergyState, SimEvent, Vec3 } from './types';

export const ENERGY_RULES = {
  minBoostEngageCharge: 20,
  minDriftEngageCharge: 16,
  boostDrainPerSecond: 30,
  driftDrainPerSecond: 24,
  maxDriftSeconds: 2.0,
  boostRecoverySeconds: 0.65,
  driftRecoverySeconds: 0.75,
  engineRechargePerSecond: 18,
  weaponRechargePerSecond: 22,
  shieldRechargePerSecond: 10,
  primaryShotCost: 4.5,
  weaponDrawWhileBoosting: 8,
} as const;

export interface EnergyStepResult {
  readonly energy: EnergyState;
  readonly events: readonly SimEvent[];
}

export function createInitialEnergy(): EnergyState {
  return {
    boostMode: { kind: 'ready' },
    engineCharge: 100,
    weaponCharge: 100,
    shieldCharge: 100,
  };
}

export function stepEnergy(
  current: EnergyState,
  wantBoost: boolean,
  wantDrift: boolean,
  currentVelocity: Vec3,
  dt: number,
): EnergyStepResult {
  const events: SimEvent[] = [];

  let boostMode: BoostMode = current.boostMode;
  let engineCharge = current.engineCharge;
  let weaponCharge = current.weaponCharge;
  const shieldCharge = clamp(
    current.shieldCharge + ENERGY_RULES.shieldRechargePerSecond * dt,
    0,
    100,
  );

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
        engineCharge = clamp(engineCharge + ENERGY_RULES.engineRechargePerSecond * dt, 0, 100);
        weaponCharge = clamp(weaponCharge + ENERGY_RULES.weaponRechargePerSecond * dt, 0, 100);
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
      weaponCharge = clamp(
        weaponCharge + ENERGY_RULES.weaponRechargePerSecond * 0.7 * dt,
        0,
        100,
      );
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
      engineCharge = clamp(
        engineCharge + ENERGY_RULES.engineRechargePerSecond * 0.6 * dt,
        0,
        100,
      );
      weaponCharge = clamp(weaponCharge + ENERGY_RULES.weaponRechargePerSecond * dt, 0, 100);
      boostMode =
        remainingSeconds <= 0
          ? { kind: 'ready' }
          : { kind: 'recovering', remainingSeconds };
      break;
    }
  }

  return {
    energy: {
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
