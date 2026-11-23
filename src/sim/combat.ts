import { absorbShieldDamage, ENERGY_RULES, spendWeaponCharge } from './energy';
import {
  add,
  clamp,
  computeLeadPoint,
  distance,
  dot,
  forwardOf,
  len,
  lerpVec3,
  nextRandom,
  normalize,
  quatLookAt,
  rightOf,
  rotateVec3,
  scale,
  slerpQuat,
  sub,
  upOf,
} from './math';
import type {
  CapitalShipState,
  EnemyShipState,
  ExplosionState,
  FlightInput,
  LockState,
  PlayerShipState,
  ProjectileState,
  RadioMessage,
  SimEvent,
  SubsystemState,
  Vec3,
  WingmateState,
} from './types';

export const COMBAT_TUNING = {
  boltSpeed: 540,
  boltDamage: 22,
  boltTtl: 1.9,
  primaryFireInterval: 0.14,
  missileSpeed: 290,
  missileDamage: 75,
  missileTtl: 5.2,
  missileCooldown: 0.55,
  missileRearmSeconds: 4.5,
  missileTurnRate: 4.2,
  lockConeCos: 0.88,
  lockMaxRange: 1150,
  lockAcquireSeconds: 0.9,
  enemyBoltSpeed: 340,
  enemyBoltDamage: 8,
  enemyHitRadius: 11,
  playerHitRadius: 8,
} as const;

export interface TargetContact {
  readonly id: string;
  readonly label: string;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly kind: 'enemy' | 'subsystem';
}

export function subsystemWorldPosition(ship: CapitalShipState, subsys: SubsystemState): Vec3 {
  return add(ship.position, rotateVec3(ship.orientation, subsys.localOffset));
}

export function listHostileContacts(
  enemies: readonly EnemyShipState[],
  hostileFrigate: CapitalShipState,
): readonly TargetContact[] {
  const contacts: TargetContact[] = [];
  for (const enemy of enemies) {
    contacts.push({
      id: enemy.id,
      label: enemy.callsign,
      position: enemy.position,
      velocity: enemy.velocity,
      kind: 'enemy',
    });
  }
  for (const subsys of hostileFrigate.subsystems) {
    if (subsys.hull > 0) {
      contacts.push({
        id: subsys.id,
        label: subsys.label,
        position: subsystemWorldPosition(hostileFrigate, subsys),
        velocity: { x: 0, y: 0, z: 0 },
        kind: 'subsystem',
      });
    }
  }
  return contacts;
}

export function findTargetContact(
  targetId: string | null,
  enemies: readonly EnemyShipState[],
  hostileFrigate: CapitalShipState,
): TargetContact | null {
  if (targetId === null) {
    return null;
  }
  const contacts = listHostileContacts(enemies, hostileFrigate);
  return contacts.find((c) => c.id === targetId) ?? null;
}

export function selectNextTarget(
  currentId: string | null,
  playerPos: Vec3,
  playerForward: Vec3,
  contacts: readonly TargetContact[],
  cycleRequested: boolean,
): string | null {
  if (contacts.length === 0) {
    return null;
  }
  const currentIndex = currentId === null ? -1 : contacts.findIndex((c) => c.id === currentId);
  if (cycleRequested) {
    const nextIndex = (currentIndex + 1) % contacts.length;
    return contacts[nextIndex]?.id ?? null;
  }
  if (currentIndex >= 0) {
    return currentId;
  }

  let bestId = contacts[0]?.id ?? null;
  let bestScore = -Infinity;
  for (const contact of contacts) {
    const toTarget = sub(contact.position, playerPos);
    const dist = Math.max(len(toTarget), 1);
    const alignment = dot(playerForward, scale(toTarget, 1 / dist));
    const score = alignment * 2 - dist / 1400;
    if (score > bestScore) {
      bestScore = score;
      bestId = contact.id;
    }
  }
  return bestId;
}

export function stepLockState(
  previous: LockState,
  selectedTarget: TargetContact | null,
  playerPos: Vec3,
  playerForward: Vec3,
  missilesReady: number,
  dt: number,
): { readonly lockState: LockState; readonly acquiredNow: boolean } {
  if (selectedTarget === null || missilesReady <= 0) {
    return { lockState: { kind: 'none' }, acquiredNow: false };
  }

  const toTarget = sub(selectedTarget.position, playerPos);
  const dist = len(toTarget);
  const inCone =
    dist <= COMBAT_TUNING.lockMaxRange &&
    dist > 1 &&
    dot(playerForward, scale(toTarget, 1 / dist)) >= COMBAT_TUNING.lockConeCos;

  if (!inCone) {
    return { lockState: { kind: 'none' }, acquiredNow: false };
  }

  if (previous.kind === 'locked' && previous.targetId === selectedTarget.id) {
    return { lockState: previous, acquiredNow: false };
  }

  const priorProgress =
    previous.kind === 'acquiring' && previous.targetId === selectedTarget.id ? previous.progress : 0;
  const nextProgress = priorProgress + dt / COMBAT_TUNING.lockAcquireSeconds;
  if (nextProgress >= 1) {
    return {
      lockState: { kind: 'locked', targetId: selectedTarget.id },
      acquiredNow: true,
    };
  }
  return {
    lockState: { kind: 'acquiring', targetId: selectedTarget.id, progress: nextProgress },
    acquiredNow: false,
  };
}

export interface CombatStepOutput {
  readonly player: PlayerShipState;
  readonly wingmate: WingmateState;
  readonly enemies: readonly EnemyShipState[];
  readonly friendlyCarrier: CapitalShipState;
  readonly hostileFrigate: CapitalShipState;
  readonly projectiles: readonly ProjectileState[];
  readonly explosions: readonly ExplosionState[];
  readonly radio: RadioMessage | null;
  readonly enemiesDestroyedDelta: number;
  readonly subsystemsDestroyedDelta: number;
  readonly rngState: number;
  readonly events: readonly SimEvent[];
}

export function stepCombat(
  tick: number,
  rngState: number,
  playerInput: PlayerShipState,
  wingmateInput: WingmateState,
  enemiesInput: readonly EnemyShipState[],
  friendlyCarrierInput: CapitalShipState,
  hostileFrigateInput: CapitalShipState,
  projectilesInput: readonly ProjectileState[],
  explosionsInput: readonly ExplosionState[],
  radioInput: RadioMessage | null,
  input: FlightInput,
  dt: number,
): CombatStepOutput {
  const events: SimEvent[] = [];
  let nextRng = rngState;
  let player = playerInput;
  let wingmate = wingmateInput;
  let friendlyCarrier = friendlyCarrierInput;
  let hostileFrigate = hostileFrigateInput;
  let radio: RadioMessage | null =
    radioInput !== null && radioInput.remainingSeconds > dt
      ? { ...radioInput, remainingSeconds: radioInput.remainingSeconds - dt }
      : null;

  const playerForward = forwardOf(player.orientation);
  const contacts = listHostileContacts(enemiesInput, hostileFrigate);
  const selectedTargetId = selectNextTarget(
    player.selectedTargetId,
    player.position,
    playerForward,
    contacts,
    input.cycleTarget,
  );
  const selectedContact = findTargetContact(selectedTargetId, enemiesInput, hostileFrigate);

  let missilesReady = player.missilesReady;
  let missileRearmTimer = player.missileRearmTimer;
  if (missilesReady < player.maxMissiles) {
    missileRearmTimer += dt;
    if (missileRearmTimer >= COMBAT_TUNING.missileRearmSeconds) {
      missilesReady += 1;
      missileRearmTimer -= COMBAT_TUNING.missileRearmSeconds;
    }
  } else {
    missileRearmTimer = 0;
  }

  const lockStep = stepLockState(
    player.lockState,
    selectedContact,
    player.position,
    playerForward,
    missilesReady,
    dt,
  );
  if (lockStep.acquiredNow) {
    events.push({ kind: 'target_locked' });
  }

  let primaryCooldown = Math.max(0, player.primaryCooldown - dt);
  let missileCooldown = Math.max(0, player.missileCooldown - dt);
  let energy = player.energy;
  let recoilKick = player.recoilKick;
  let lockState = lockStep.lockState;
  const spawnedProjectiles: ProjectileState[] = [];

  if (input.firePrimary && primaryCooldown <= 0) {
    const spent = spendWeaponCharge(energy, ENERGY_RULES.primaryShotCost);
    if (spent !== null) {
      energy = spent;
      primaryCooldown = COMBAT_TUNING.primaryFireInterval;
      recoilKick = 1;
      const right = rightOf(player.orientation);
      const down = scale(upOf(player.orientation), -1.1);
      const aimDir = computeAimAssistDirection(player.position, player.velocity, playerForward, selectedContact);

      for (const side of [-1, 1] as const) {
        const muzzle = add(
          add(player.position, scale(playerForward, 5)),
          add(scale(right, side * 3.1), down),
        );
        spawnedProjectiles.push({
          id: `pb-${tick}-${side > 0 ? 'r' : 'l'}`,
          kind: 'bolt',
          faction: 'friendly',
          position: muzzle,
          velocity: add(player.velocity, scale(aimDir, COMBAT_TUNING.boltSpeed)),
          targetId: null,
          damage: COMBAT_TUNING.boltDamage,
          ttl: COMBAT_TUNING.boltTtl,
        });
      }
      events.push({ kind: 'cannon_fired', faction: 'friendly' });
    }
  }

  if (input.fireMissile && missileCooldown <= 0 && missilesReady > 0) {
    const lockedId = lockState.kind === 'locked' ? lockState.targetId : null;
    missilesReady -= 1;
    missileCooldown = COMBAT_TUNING.missileCooldown;
    lockState = { kind: 'none' };
    const right = rightOf(player.orientation);
    const side = missilesReady % 2 === 0 ? 1 : -1;
    const launchPos = add(
      add(player.position, scale(playerForward, 4)),
      scale(right, side * 4.2),
    );
    spawnedProjectiles.push({
      id: `pm-${tick}`,
      kind: 'missile',
      faction: 'friendly',
      position: launchPos,
      velocity: add(player.velocity, scale(playerForward, COMBAT_TUNING.missileSpeed * 0.75)),
      targetId: lockedId,
      damage: COMBAT_TUNING.missileDamage,
      ttl: COMBAT_TUNING.missileTtl,
    });
    events.push({ kind: 'missile_fired' });
  }

  if (input.orderWingmate && selectedContact !== null) {
    wingmate = { ...wingmate, assignedTargetId: selectedContact.id };
    radio = {
      speaker: wingmate.callsign,
      text: `Copy, breaking onto ${selectedContact.label}.`,
      remainingSeconds: 3.4,
    };
    events.push({ kind: 'wingmate_ordered' });
  }

  player = {
    ...player,
    energy,
    primaryCooldown,
    missileCooldown,
    missilesReady,
    missileRearmTimer,
    selectedTargetId,
    lockState,
    recoilKick,
  };

  const wingmateStep = stepWingmate(tick, wingmate, player, enemiesInput, hostileFrigate, dt);
  wingmate = wingmateStep.wingmate;
  if (wingmateStep.projectile !== null) {
    spawnedProjectiles.push(wingmateStep.projectile);
  }

  const steppedEnemies: EnemyShipState[] = [];
  for (const enemy of enemiesInput) {
    const enemyStep = stepEnemyAi(tick, nextRng, enemy, player, friendlyCarrier, dt);
    nextRng = enemyStep.rngState;
    steppedEnemies.push(enemyStep.enemy);
    if (enemyStep.projectile !== null) {
      spawnedProjectiles.push(enemyStep.projectile);
      events.push({ kind: 'cannon_fired', faction: 'hostile' });
    }
  }

  const activeProjectiles = [...projectilesInput, ...spawnedProjectiles];
  const survivingProjectiles: ProjectileState[] = [];
  const nextExplosions: ExplosionState[] = explosionsInput
    .map((e) => ({ ...e, elapsed: e.elapsed + dt }))
    .filter((e) => e.elapsed < e.duration);

  const enemyMap = new Map<string, EnemyShipState>();
  for (const e of steppedEnemies) {
    enemyMap.set(e.id, e);
  }
  const subsystems = hostileFrigate.subsystems.map((s) => ({ ...s }));

  let enemiesDestroyedDelta = 0;
  let subsystemsDestroyedDelta = 0;

  for (const proj of activeProjectiles) {
    const ttl = proj.ttl - dt;
    if (ttl <= 0) {
      continue;
    }

    let velocity = proj.velocity;
    if (proj.kind === 'missile' && proj.targetId !== null) {
      const targetPos = resolveTargetPosition(proj.targetId, enemyMap, hostileFrigate, subsystems);
      if (targetPos !== null) {
        const desiredDir = normalize(sub(targetPos, proj.position));
        const currentDir = normalize(velocity);
        const steeredDir = normalize(
          lerpVec3(currentDir, desiredDir, clamp(COMBAT_TUNING.missileTurnRate * dt, 0, 1)),
        );
        velocity = scale(steeredDir, COMBAT_TUNING.missileSpeed);
      }
    }

    const nextPos = add(proj.position, scale(velocity, dt));
    let hit = false;

    if (proj.faction === 'friendly') {
      for (const [id, enemy] of enemyMap) {
        if (distance(nextPos, enemy.position) <= COMBAT_TUNING.enemyHitRadius) {
          hit = true;
          const shieldAbsorbed = Math.min(enemy.shields, proj.damage);
          const hullDmg = Math.max(0, proj.damage - shieldAbsorbed);
          const nextHull = enemy.hull - hullDmg;
          const nextShields = enemy.shields - shieldAbsorbed;

          if (nextHull <= 0) {
            enemyMap.delete(id);
            enemiesDestroyedDelta += 1;
            events.push({ kind: 'hit_confirmed', isKill: true });
            nextExplosions.push({
              id: `exp-${tick}-${id}`,
              position: enemy.position,
              radius: enemy.kind === 'striker' ? 28 : 20,
              elapsed: 0,
              duration: 0.95,
              tint: 'amber',
            });
            radio = {
              speaker: wingmate.callsign,
              text: `Splash ${enemy.callsign}! Good kill, lead.`,
              remainingSeconds: 2.8,
            };
          } else {
            enemyMap.set(id, { ...enemy, hull: nextHull, shields: nextShields });
            events.push({ kind: 'hit_confirmed', isKill: false });
            nextExplosions.push({
              id: `hit-${tick}-${proj.id}`,
              position: nextPos,
              radius: 5.5,
              elapsed: 0,
              duration: 0.28,
              tint: 'emerald',
            });
          }
          break;
        }
      }

      if (!hit) {
        for (let i = 0; i < subsystems.length; i += 1) {
          const subsys = subsystems[i];
          if (subsys === undefined || subsys.hull <= 0) {
            continue;
          }
          const worldPos = subsystemWorldPosition(hostileFrigate, subsys);
          if (distance(nextPos, worldPos) <= subsys.radius + 7) {
            hit = true;
            const nextHull = Math.max(0, subsys.hull - proj.damage);
            subsystems[i] = { ...subsys, hull: nextHull };
            const destroyed = nextHull <= 0;
            events.push({ kind: 'hit_confirmed', isKill: destroyed });
            if (destroyed) {
              subsystemsDestroyedDelta += 1;
              events.push({ kind: 'subsystem_destroyed', label: subsys.label });
              nextExplosions.push({
                id: `sub-${tick}-${subsys.id}`,
                position: worldPos,
                radius: 42,
                elapsed: 0,
                duration: 1.3,
                tint: 'crimson',
              });
              radio = {
                speaker: 'HEARTHSTONE',
                text: `Frigate ${subsys.label} neutralized!`,
                remainingSeconds: 3.6,
              };
            } else {
              nextExplosions.push({
                id: `subhit-${tick}-${proj.id}`,
                position: nextPos,
                radius: 7,
                elapsed: 0,
                duration: 0.3,
                tint: 'crimson',
              });
            }
            break;
          }
        }
      }
    } else {
      if (distance(nextPos, player.position) <= COMBAT_TUNING.playerHitRadius) {
        hit = true;
        const absorbed = absorbShieldDamage(player.energy, proj.damage);
        player = {
          ...player,
          energy: absorbed.energy,
          hull: Math.max(0, player.hull - absorbed.hullDamage),
          hitFlash: 1,
        };
        events.push({ kind: 'player_damaged' });
      } else if (isInsideCapitalBox(nextPos, friendlyCarrier, 4)) {
        hit = true;
        friendlyCarrier = {
          ...friendlyCarrier,
          hull: Math.max(0, friendlyCarrier.hull - proj.damage * 0.45),
        };
        nextExplosions.push({
          id: `carhit-${tick}-${proj.id}`,
          position: nextPos,
          radius: 8,
          elapsed: 0,
          duration: 0.32,
          tint: 'amber',
        });
      }
    }

    if (!hit) {
      survivingProjectiles.push({
        ...proj,
        position: nextPos,
        velocity,
        ttl,
      });
    }
  }

  hostileFrigate = { ...hostileFrigate, subsystems };
  const survivingEnemies = Array.from(enemyMap.values());

  const finalTargetValid =
    player.selectedTargetId !== null &&
    findTargetContact(player.selectedTargetId, survivingEnemies, hostileFrigate) !== null;
  if (!finalTargetValid) {
    const remainingContacts = listHostileContacts(survivingEnemies, hostileFrigate);
    const nextSelectedId = selectNextTarget(
      null,
      player.position,
      forwardOf(player.orientation),
      remainingContacts,
      false,
    );
    player = {
      ...player,
      selectedTargetId: nextSelectedId,
      lockState: { kind: 'none' },
    };
  }

  if (
    wingmate.assignedTargetId !== null &&
    findTargetContact(wingmate.assignedTargetId, survivingEnemies, hostileFrigate) === null
  ) {
    wingmate = { ...wingmate, assignedTargetId: null };
  }

  return {
    player,
    wingmate,
    enemies: survivingEnemies,
    friendlyCarrier,
    hostileFrigate,
    projectiles: survivingProjectiles,
    explosions: nextExplosions,
    radio,
    enemiesDestroyedDelta,
    subsystemsDestroyedDelta,
    rngState: nextRng,
    events,
  };
}

function computeAimAssistDirection(
  shooterPos: Vec3,
  shooterVel: Vec3,
  playerForward: Vec3,
  target: TargetContact | null,
): Vec3 {
  if (target === null) {
    return playerForward;
  }
  const leadPoint = computeLeadPoint(
    shooterPos,
    shooterVel,
    target.position,
    target.velocity,
    COMBAT_TUNING.boltSpeed,
  );
  const toLead = normalize(sub(leadPoint, shooterPos));
  // Subtle gimbal convergence inside a narrow 5-degree cone keeps mouse aiming crisp without auto-aiming.
  if (dot(playerForward, toLead) >= 0.996) {
    return normalize(lerpVec3(playerForward, toLead, 0.65));
  }
  return playerForward;
}

function resolveTargetPosition(
  targetId: string,
  enemyMap: ReadonlyMap<string, EnemyShipState>,
  hostileFrigate: CapitalShipState,
  subsystems: readonly SubsystemState[],
): Vec3 | null {
  const enemy = enemyMap.get(targetId);
  if (enemy !== undefined) {
    return enemy.position;
  }
  const subsys = subsystems.find((s) => s.id === targetId && s.hull > 0);
  if (subsys !== undefined) {
    return subsystemWorldPosition(hostileFrigate, subsys);
  }
  return null;
}

function isInsideCapitalBox(pos: Vec3, ship: CapitalShipState, pad: number): boolean {
  const d = sub(pos, ship.position);
  return (
    Math.abs(d.x) <= ship.halfExtents.x + pad &&
    Math.abs(d.y) <= ship.halfExtents.y + pad &&
    Math.abs(d.z) <= ship.halfExtents.z + pad
  );
}

function stepWingmate(
  tick: number,
  wingmate: WingmateState,
  player: PlayerShipState,
  enemies: readonly EnemyShipState[],
  hostileFrigate: CapitalShipState,
  dt: number,
): { readonly wingmate: WingmateState; readonly projectile: ProjectileState | null } {
  const assigned = findTargetContact(wingmate.assignedTargetId, enemies, hostileFrigate);
  const right = rightOf(player.orientation);
  const forward = forwardOf(player.orientation);
  const up = upOf(player.orientation);
  const formationPos = add(
    add(player.position, scale(right, -28)),
    add(scale(forward, -18), scale(up, 6)),
  );

  const desiredPos = assigned !== null ? assigned.position : formationPos;
  const toDesired = sub(desiredPos, wingmate.position);
  const dist = len(toDesired);
  const desiredDir = dist > 1 ? scale(toDesired, 1 / dist) : forward;
  const targetQuat = quatLookAt(desiredDir);
  const orientation = slerpQuat(wingmate.orientation, targetQuat, clamp(dt * 3.2, 0, 1));
  const speed = assigned !== null ? 96 : clamp(player.speed + dist * 0.45, 45, 130);
  const velocity = lerpVec3(wingmate.velocity, scale(forwardOf(orientation), speed), clamp(dt * 3.5, 0, 1));
  const position = add(wingmate.position, scale(velocity, dt));

  let fireCooldown = Math.max(0, wingmate.fireCooldown - dt);
  let projectile: ProjectileState | null = null;
  if (
    assigned !== null &&
    fireCooldown <= 0 &&
    dist < 520 &&
    dot(forwardOf(orientation), desiredDir) > 0.94
  ) {
    fireCooldown = 0.48;
    const lead = computeLeadPoint(position, velocity, assigned.position, assigned.velocity, COMBAT_TUNING.boltSpeed);
    const shotDir = normalize(sub(lead, position));
    projectile = {
      id: `wb-${tick}`,
      kind: 'bolt',
      faction: 'friendly',
      position: add(position, scale(shotDir, 6)),
      velocity: add(velocity, scale(shotDir, COMBAT_TUNING.boltSpeed)),
      targetId: null,
      damage: 14,
      ttl: 1.4,
    };
  }

  return {
    wingmate: {
      ...wingmate,
      position,
      velocity,
      orientation,
      fireCooldown,
    },
    projectile,
  };
}

function stepEnemyAi(
  tick: number,
  rngState: number,
  enemy: EnemyShipState,
  player: PlayerShipState,
  friendlyCarrier: CapitalShipState,
  dt: number,
): { readonly enemy: EnemyShipState; readonly projectile: ProjectileState | null; readonly rngState: number } {
  const time = tick / 60 + enemy.phaseOffset;
  const orbitRadius = enemy.kind === 'raider' ? 280 : 380;
  const orbitTarget: Vec3 = {
    x: friendlyCarrier.position.x + Math.cos(time * 0.42) * orbitRadius,
    y: friendlyCarrier.position.y + Math.sin(time * 0.65) * 95 + 25,
    z: friendlyCarrier.position.z + Math.sin(time * 0.42) * orbitRadius - 120,
  };

  const playerDist = distance(enemy.position, player.position);
  const attackTarget =
    enemy.kind === 'raider' && playerDist < 540
      ? add(player.position, {
          x: Math.sin(time * 1.1) * 75,
          y: Math.cos(time * 0.9) * 45,
          z: Math.cos(time * 1.1) * 75,
        })
      : orbitTarget;

  const toGoal = sub(attackTarget, enemy.position);
  const goalDir = normalize(toGoal);
  const targetQuat = quatLookAt(goalDir);
  const turnSpeed = enemy.kind === 'raider' ? 2.4 : 1.5;
  const orientation = slerpQuat(enemy.orientation, targetQuat, clamp(dt * turnSpeed, 0, 1));
  const cruiseSpeed = enemy.kind === 'raider' ? 84 : 62;
  const velocity = lerpVec3(enemy.velocity, scale(forwardOf(orientation), cruiseSpeed), clamp(dt * 2.8, 0, 1));
  const position = add(enemy.position, scale(velocity, dt));

  let nextRng = rngState;
  let fireCooldown = Math.max(0, enemy.fireCooldown - dt);
  let projectile: ProjectileState | null = null;

  const toPlayer = sub(player.position, position);
  const distToPlayer = len(toPlayer);
  const dirToPlayer = distToPlayer > 1 ? scale(toPlayer, 1 / distToPlayer) : forwardOf(orientation);
  const facingPlayer = dot(forwardOf(orientation), dirToPlayer) > 0.91;

  if (fireCooldown <= 0 && distToPlayer < 460 && facingPlayer) {
    const roll = nextRandom(nextRng);
    nextRng = roll.nextState;
    fireCooldown = 1.1 + roll.value * 0.7;
    const spread = (roll.value - 0.5) * 0.04;
    const shotDir = normalize(add(dirToPlayer, { x: spread, y: -spread * 0.5, z: 0 }));
    projectile = {
      id: `eb-${tick}-${enemy.id}`,
      kind: 'bolt',
      faction: 'hostile',
      position: add(position, scale(shotDir, 7)),
      velocity: add(velocity, scale(shotDir, COMBAT_TUNING.enemyBoltSpeed)),
      targetId: null,
      damage: COMBAT_TUNING.enemyBoltDamage,
      ttl: 1.7,
    };
  }

  return {
    enemy: {
      ...enemy,
      position,
      velocity,
      orientation,
      fireCooldown,
    },
    projectile,
    rngState: nextRng,
  };
}
