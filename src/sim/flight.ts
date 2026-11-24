import { stepEnergy } from './energy';
import {
  add,
  clamp,
  dot,
  forwardOf,
  len,
  lerpVec3,
  normalize,
  normalizeQuat,
  quatFromAxisAngle,
  quatMul,
  rightOf,
  rotateVec3,
  scale,
  sub,
  toLocalPoint,
  upOf,
} from './math';
import type {
  AsteroidState,
  CapitalShipState,
  FlightInput,
  PlayerShipState,
  SimEvent,
  Vec3,
} from './types';

export const FLIGHT_TUNING = {
  minSpeed: 22,
  maxCruiseSpeed: 102,
  boostSpeed: 180,
  pitchRate: 2.35,
  yawRate: 2.05,
  rollRate: 2.85,
  driftTurnMultiplier: 2.45,
  angularResponse: 12.5,
  throttleRate: 0.85,
  velocityResponse: 5.4,
  driftMomentumKeep: 0.968,
  carrierClearanceMargin: 18,
  carrierRepelSpeed: 58,
  asteroidClearanceMargin: 10,
  arenaRadius: 2600,
} as const;

export interface FlightStepResult {
  readonly player: PlayerShipState;
  readonly events: readonly SimEvent[];
}

function sweetSpotTurnFactor(throttle: number): number {
  const distanceFromOptimal = Math.abs(throttle - 0.55);
  return clamp(1.16 - distanceFromOptimal * 0.35, 0.9, 1.16);
}

export function resolveObstacleClearance(
  position: Vec3,
  velocity: Vec3,
  ships: readonly CapitalShipState[],
  asteroids: readonly AsteroidState[],
): { readonly position: Vec3; readonly velocity: Vec3; readonly warning: boolean } {
  let nextPos = position;
  let nextVel = velocity;
  let warning = false;

  for (const ship of ships) {
    const localDelta = toLocalPoint(ship.position, ship.orientation, nextPos);
    const ex = ship.halfExtents.x + FLIGHT_TUNING.carrierClearanceMargin;
    const ey = ship.halfExtents.y + FLIGHT_TUNING.carrierClearanceMargin;
    const ez = ship.halfExtents.z + FLIGHT_TUNING.carrierClearanceMargin;

    if (
      Math.abs(localDelta.x) < ex + 24 &&
      Math.abs(localDelta.y) < ey + 24 &&
      Math.abs(localDelta.z) < ez + 24
    ) {
      warning = true;
    }

    if (Math.abs(localDelta.x) < ex && Math.abs(localDelta.y) < ey && Math.abs(localDelta.z) < ez) {
      const penX = ex - Math.abs(localDelta.x);
      const penY = ey - Math.abs(localDelta.y);
      const penZ = ez - Math.abs(localDelta.z);

      let localNormal: Vec3;
      let penetration: number;
      if (penY <= penX && penY <= penZ) {
        localNormal = { x: 0, y: localDelta.y >= 0 ? 1 : -1, z: 0 };
        penetration = penY;
      } else if (penX <= penZ) {
        localNormal = { x: localDelta.x >= 0 ? 1 : -1, y: 0, z: 0 };
        penetration = penX;
      } else {
        localNormal = { x: 0, y: 0, z: localDelta.z >= 0 ? 1 : -1 };
        penetration = penZ;
      }

      const pushNormal = normalize(rotateVec3(ship.orientation, localNormal));
      nextPos = add(nextPos, scale(pushNormal, penetration + 0.5));
      const inwardSpeed = dot(nextVel, pushNormal);
      if (inwardSpeed < FLIGHT_TUNING.carrierRepelSpeed) {
        nextVel = add(nextVel, scale(pushNormal, FLIGHT_TUNING.carrierRepelSpeed - inwardSpeed));
      }
    }
  }

  for (const rock of asteroids) {
    const delta = sub(nextPos, rock.position);
    const dist = len(delta);
    const safeRadius = rock.radius + FLIGHT_TUNING.asteroidClearanceMargin;
    if (dist < safeRadius + 16) {
      warning = true;
    }
    if (dist < safeRadius && dist > 1e-4) {
      const normal = scale(delta, 1 / dist);
      nextPos = add(rock.position, scale(normal, safeRadius + 0.5));
      const inward = dot(nextVel, normal);
      if (inward < 45) {
        nextVel = add(nextVel, scale(normal, 45 - inward));
      }
    }
  }

  return { position: nextPos, velocity: nextVel, warning };
}

export function stepPlayerFlight(
  player: PlayerShipState,
  input: FlightInput,
  capitalShips: readonly CapitalShipState[],
  asteroids: readonly AsteroidState[],
  dt: number,
): FlightStepResult {
  const energyStep = stepEnergy(player.energy, input.boost, input.drift, player.velocity, dt);
  const energy = energyStep.energy;
  const throttle = clamp(player.throttle + input.throttleDelta * FLIGHT_TUNING.throttleRate * dt, 0.15, 1);

  const isDrifting = energy.boostMode.kind === 'drifting';
  const turnScale = sweetSpotTurnFactor(throttle) * (isDrifting ? FLIGHT_TUNING.driftTurnMultiplier : 1);

  const targetAngVel: Vec3 = {
    x: input.pitch * FLIGHT_TUNING.pitchRate * turnScale,
    y: -input.yaw * FLIGHT_TUNING.yawRate * turnScale,
    z: -input.roll * FLIGHT_TUNING.rollRate,
  };
  const angularVelocity = lerpVec3(
    player.angularVelocity,
    targetAngVel,
    clamp(FLIGHT_TUNING.angularResponse * dt, 0, 1),
  );

  let orientation = player.orientation;
  const pitchQuat = quatFromAxisAngle(rightOf(orientation), angularVelocity.x * dt);
  orientation = normalizeQuat(quatMul(pitchQuat, orientation));
  const yawQuat = quatFromAxisAngle(upOf(orientation), angularVelocity.y * dt);
  orientation = normalizeQuat(quatMul(yawQuat, orientation));
  const rollQuat = quatFromAxisAngle(forwardOf(orientation), angularVelocity.z * dt);
  orientation = normalizeQuat(quatMul(rollQuat, orientation));

  const forward = forwardOf(orientation);
  const targetSpeed =
    energy.boostMode.kind === 'boosting'
      ? FLIGHT_TUNING.boostSpeed
      : FLIGHT_TUNING.minSpeed + (FLIGHT_TUNING.maxCruiseSpeed - FLIGHT_TUNING.minSpeed) * throttle;

  let nextVelocity: Vec3;
  if (energy.boostMode.kind === 'drifting') {
    const carried = scale(energy.boostMode.driftVelocity, Math.pow(FLIGHT_TUNING.driftMomentumKeep, dt * 60));
    const thrustNudge = scale(forward, targetSpeed * 0.42);
    nextVelocity = lerpVec3(carried, add(carried, thrustNudge), clamp(dt * 1.9, 0, 1));
  } else {
    const desiredVelocity = scale(forward, targetSpeed);
    nextVelocity = lerpVec3(player.velocity, desiredVelocity, clamp(FLIGHT_TUNING.velocityResponse * dt, 0, 1));
  }

  const rawPosition = add(player.position, scale(nextVelocity, dt));
  const clearance = resolveObstacleClearance(rawPosition, nextVelocity, capitalShips, asteroids);
  const clampedDistance = len(clearance.position);
  let arenaPosition = clearance.position;
  let arenaVelocity = clearance.velocity;
  if (clampedDistance > FLIGHT_TUNING.arenaRadius) {
    const outwardNormal = scale(clearance.position, 1 / clampedDistance);
    arenaPosition = scale(outwardNormal, FLIGHT_TUNING.arenaRadius);
    const outwardSpeed = dot(arenaVelocity, outwardNormal);
    if (outwardSpeed > 0) {
      arenaVelocity = sub(arenaVelocity, scale(outwardNormal, outwardSpeed));
    }
  }

  const updatedEnergy =
    energy.boostMode.kind === 'drifting'
      ? {
          ...energy,
          boostMode: {
            ...energy.boostMode,
            driftVelocity: arenaVelocity,
          },
        }
      : energy;

  return {
    player: {
      ...player,
      position: arenaPosition,
      velocity: arenaVelocity,
      orientation,
      angularVelocity,
      throttle,
      energy: updatedEnergy,
      proximityWarning: clearance.warning,
      hitFlash: Math.max(0, player.hitFlash - dt * 2.5),
      recoilKick: Math.max(0, player.recoilKick - dt * 6),
    },
    events: energyStep.events,
  };
}
