import { ENERGY_RULES } from '../sim/energy';
import { FLIGHT_TUNING } from '../sim/flight';
import { HULL_CRITICAL_FRACTION, type PlayerShipState } from '../sim/types';

export function hullCritical(player: PlayerShipState): boolean {
  return player.hull > 0 && player.hull <= player.maxHull * HULL_CRITICAL_FRACTION;
}

/** True while a tap on W would engage Overdrive. */
export function overdriveArmed(player: PlayerShipState): boolean {
  const { energy } = player;
  return !energy.overdrive
    && player.throttle >= FLIGHT_TUNING.maxCruiseThrottle - 0.005
    && energy.shieldCharge >= ENERGY_RULES.minOverdriveShield;
}
