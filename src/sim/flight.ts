import { isInsideArena, moveThroughArena } from './arena';
import { absorbShieldDamage, stepEnergy } from './energy';
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
  ArenaSolid,
  AsteroidState,
  CapitalShipState,
  FlightInput,
  PlayerShipState,
  SimEvent,
  Vec3,
} from './types';

export const FLIGHT_TUNING = {
  minThrottle: 0.15,
  maxCruiseThrottle: 1.0,
  overdriveThrottle: 1.2,
  minSpeed: 24,
  maxCruiseSpeed: 102,
  overdriveSpeed: 168,
  pitchRate: 2.45,
  yawRate: 2.15,
  rollRate: 2.9,
  angularResponse: 12.5,
  throttleRate: 0.9,
  velocityResponse: 5.4,
  carrierClearanceMargin: 18,
  carrierRepelSpeed: 58,
  asteroidClearanceMargin: 10,
  collisionDamagePerSpeed: 0.32,
  arenaRadius: 2600,
  /** Hull-to-surface standoff against level geometry; keeps the cockpit camera clear of wall faces. */
  arenaHullPad: 6,
  /** Fraction of closing speed a wall throws back, and the least it leaves pointing away. */
  wallRestitution: 0.35,
  wallMinSeparation: 6,
  wallWarningRange: 14,
} as const;

export interface FlightStepResult {
  readonly player: PlayerShipState;
  readonly events: readonly SimEvent[];
}

export function resolveObstacleClearance(
  position: Vec3,
  velocity: Vec3,
  ships: readonly CapitalShipState[],
  asteroids: readonly AsteroidState[],
): {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly warning: boolean;
  readonly impactSpeed: number;
} {
  let nextPos = position;
  let nextVel = velocity;
  let warning = false;
  let impactSpeed = 0;

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
      if (inwardSpeed < 0) {
        impactSpeed = Math.max(impactSpeed, -inwardSpeed);
      }
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
      if (inward < 0) {
        impactSpeed = Math.max(impactSpeed, -inward);
      }
      if (inward < 45) {
        nextVel = add(nextVel, scale(normal, 45 - inward));
      }
    }
  }

  return { position: nextPos, velocity: nextVel, warning, impactSpeed };
}

export function stepPlayerFlight(
  player: PlayerShipState,
  input: FlightInput,
  capitalShips: readonly CapitalShipState[],
  asteroids: readonly AsteroidState[],
  arena: readonly ArenaSolid[],
  dt: number,
): FlightStepResult {
  // High-watermark throttle detent: holding W climbs smoothly to 100% and stops;
  // pressing W again at 100% pushes into 120% Overdrive (burning shields).
  const atHighWatermark = player.throttle >= FLIGHT_TUNING.maxCruiseThrottle - 0.005;
  const enterOverdrive = !player.energy.overdrive && atHighWatermark && input.throttlePushEdge;
  const cancelOverdrive = player.energy.overdrive && input.throttleDelta < 0;

  const energyStep = stepEnergy(player.energy, enterOverdrive, cancelOverdrive, dt);
  const energy = energyStep.energy;
  const events: SimEvent[] = [...energyStep.events];

  let throttle: number;
  if (energy.overdrive) {
    throttle = FLIGHT_TUNING.overdriveThrottle;
  } else if (player.energy.overdrive) {
    // Dropped out of overdrive (shield depleted or S pressed): return cleanly to 100% detent.
    throttle =
      input.throttleDelta < 0
        ? clamp(
            FLIGHT_TUNING.maxCruiseThrottle + input.throttleDelta * FLIGHT_TUNING.throttleRate * dt,
            FLIGHT_TUNING.minThrottle,
            FLIGHT_TUNING.maxCruiseThrottle,
          )
        : FLIGHT_TUNING.maxCruiseThrottle;
  } else {
    throttle = clamp(
      player.throttle + input.throttleDelta * FLIGHT_TUNING.throttleRate * dt,
      FLIGHT_TUNING.minThrottle,
      FLIGHT_TUNING.maxCruiseThrottle,
    );
  }

  const targetAngVel: Vec3 = {
    x: input.pitch * FLIGHT_TUNING.pitchRate,
    y: -input.yaw * FLIGHT_TUNING.yawRate,
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
  const targetSpeed = energy.overdrive
    ? FLIGHT_TUNING.overdriveSpeed
    : FLIGHT_TUNING.minSpeed +
      ((FLIGHT_TUNING.maxCruiseSpeed - FLIGHT_TUNING.minSpeed) *
        (throttle - FLIGHT_TUNING.minThrottle)) /
        (FLIGHT_TUNING.maxCruiseThrottle - FLIGHT_TUNING.minThrottle);

  const desiredVelocity = scale(forward, targetSpeed);
  const nextVelocity = lerpVec3(
    player.velocity,
    desiredVelocity,
    clamp(FLIGHT_TUNING.velocityResponse * dt, 0, 1),
  );

  // Level geometry is swept, so no speed can carry the hull through a wall or rib.
  const wallMove = moveThroughArena(
    player.position,
    add(player.position, scale(nextVelocity, dt)),
    nextVelocity,
    arena,
    FLIGHT_TUNING.arenaHullPad,
    FLIGHT_TUNING.wallRestitution,
    FLIGHT_TUNING.wallMinSeparation,
  );
  if (wallMove.contactPoint !== null) {
    events.push({ kind: 'wall_scrape', position: wallMove.contactPoint });
  }
  const clearance = resolveObstacleClearance(wallMove.position, wallMove.velocity, capitalShips, asteroids);
  const nearWall =
    arena.length > 0 && isInsideArena(clearance.position, arena, FLIGHT_TUNING.arenaHullPad + FLIGHT_TUNING.wallWarningRange);
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

  const flown: PlayerShipState = {
    ...player,
    position: arenaPosition,
    velocity: arenaVelocity,
    orientation,
    angularVelocity,
    throttle,
    energy,
    proximityWarning: clearance.warning || nearWall,
    hitFlash: Math.max(0, player.hitFlash - dt * 2.5),
    recoilKick: Math.max(0, player.recoilKick - dt * 6.5),
    recoilLeft: Math.max(0, player.recoilLeft - dt * 7.5),
    recoilRight: Math.max(0, player.recoilRight - dt * 7.5),
  };
  const impactSpeed = Math.max(clearance.impactSpeed, wallMove.impactSpeed);
  if (impactSpeed <= 22) {
    return { player: flown, events };
  }
  events.push({ kind: 'player_damaged' });
  const collisionDamage = (impactSpeed - 20) * FLIGHT_TUNING.collisionDamagePerSpeed;
  return { player: damagePlayer(flown, collisionDamage), events };
}

/** Every source of player damage goes through here, so a shield-depleting hit drops Overdrive throttle in the same tick. */
export function damagePlayer(player: PlayerShipState, damage: number): PlayerShipState {
  const absorbed = absorbShieldDamage(player.energy, damage);
  return {
    ...player,
    energy: absorbed.energy,
    hull: Math.max(0, player.hull - absorbed.hullDamage),
    hitFlash: 1,
    throttle: absorbed.energy.overdrive
      ? player.throttle
      : Math.min(player.throttle, FLIGHT_TUNING.maxCruiseThrottle),
  };
}
