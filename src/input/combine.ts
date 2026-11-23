import { clamp } from '../sim/math';
import type { FlightInput } from '../sim/types';

export function applyDeadzone(value: number, deadzone: number): number {
  const safeDeadzone = clamp(deadzone, 0, 0.99);
  const abs = Math.abs(value);
  if (abs < safeDeadzone) {
    return 0;
  }
  const scaled = (abs - safeDeadzone) / (1 - safeDeadzone);
  return Math.sign(value) * clamp(scaled, 0, 1);
}

export function mergeFlightInputs(primary: FlightInput, secondary: FlightInput): FlightInput {
  return {
    pitch: clamp(primary.pitch + secondary.pitch, -1, 1),
    yaw: clamp(primary.yaw + secondary.yaw, -1, 1),
    roll: clamp(primary.roll + secondary.roll, -1, 1),
    throttleDelta: clamp(primary.throttleDelta + secondary.throttleDelta, -1, 1),
    boost: primary.boost || secondary.boost,
    drift: primary.drift || secondary.drift,
    firePrimary: primary.firePrimary || secondary.firePrimary,
    fireMissile: primary.fireMissile || secondary.fireMissile,
    cycleTarget: primary.cycleTarget || secondary.cycleTarget,
    toggleCamera: primary.toggleCamera || secondary.toggleCamera,
    launchBriefing: primary.launchBriefing || secondary.launchBriefing,
    restartSortie: primary.restartSortie || secondary.restartSortie,
    toggleMute: primary.toggleMute || secondary.toggleMute,
  };
}
