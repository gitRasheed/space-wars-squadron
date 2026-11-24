import { absorbShieldDamage, ENERGY_RULES, spendWeaponCharge } from './energy';
import {
  add,
  clamp,
  computeLeadPoint,
  cross,
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
  toLocalPoint,
  upOf,
} from './math';
import type {
  AsteroidState,
  CapitalShipState,
  EnemyManeuver,
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
  boltSpeed: 580,
  boltDamage: 24,
  boltTtl: 1.9,
  primaryFireInterval: 0.13,
  missileSpeed: 320,
  missileDamage: 80,
  missileTtl: 5.2,
  missileCooldown: 0.5,
  missileRearmSeconds: 4.0,
  missileTurnRate: 4.8,
  lockConeCos: 0.86,
  lockMaxRange: 1200,
  lockAcquireSeconds: 0.8,
  enemyBoltSpeed: 310,
  enemyBoltDamage: 6,
  enemyHitRadius: 14,
  playerHitRadius: 7.5,
  enemyMinApproachDistance: 215,
  enemyBreakAwaySeconds: 3.4,
  enemyApproachSeconds: 5.5,
} as const;

export interface TargetContact {
  readonly id: string;
  readonly label: string;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly kind: 'enemy' | 'subsystem';
}

export interface CombatStepInput {
  readonly tick: number;
  readonly rngState: number;
  readonly player: PlayerShipState;
  readonly wingmate: WingmateState;
  readonly enemies: readonly EnemyShipState[];
  readonly friendlyCarrier: CapitalShipState;
  readonly hostileFrigate: CapitalShipState;
  readonly asteroids: readonly AsteroidState[];
  readonly projectiles: readonly ProjectileState[];
  readonly explosions: readonly ExplosionState[];
  readonly radio: RadioMessage | null;
  readonly input: FlightInput;
  readonly dt: number;
}

export interface CombatStepOutput {
  readonly player: PlayerShipState;
  readonly wingmate: WingmateState;
  readonly enemies: readonly EnemyShipState[];
  readonly friendlyCarrier: CapitalShipState;
  readonly hostileFrigate: CapitalShipState;
  readonly asteroids: readonly AsteroidState[];
  readonly projectiles: readonly ProjectileState[];
  readonly explosions: readonly ExplosionState[];
  readonly radio: RadioMessage | null;
  readonly enemiesDestroyedDelta: number;
  readonly subsystemsDestroyedDelta: number;
  readonly rngState: number;
  readonly events: readonly SimEvent[];
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

export function isInsideCapitalBox(pos: Vec3, ship: CapitalShipState, pad: number): boolean {
  const local = toLocalPoint(ship.position, ship.orientation, pos);
  return (
    Math.abs(local.x) <= ship.halfExtents.x + pad &&
    Math.abs(local.y) <= ship.halfExtents.y + pad &&
    Math.abs(local.z) <= ship.halfExtents.z + pad
  );
}

function stepPlayerWeapons(
  tick: number,
  player: PlayerShipState,
  enemies: readonly EnemyShipState[],
  hostileFrigate: CapitalShipState,
  input: FlightInput,
  dt: number,
): {
  readonly player: PlayerShipState;
  readonly spawned: readonly ProjectileState[];
  readonly events: readonly SimEvent[];
} {
  const events: SimEvent[] = [];
  const spawned: ProjectileState[] = [];
  const playerForward = forwardOf(player.orientation);
  const contacts = listHostileContacts(enemies, hostileFrigate);
  const selectedTargetId = selectNextTarget(
    player.selectedTargetId,
    player.position,
    playerForward,
    contacts,
    input.cycleTarget,
  );
  const selectedContact = findTargetContact(selectedTargetId, enemies, hostileFrigate);

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

  if (input.firePrimary && primaryCooldown <= 0) {
    const spent = spendWeaponCharge(energy, ENERGY_RULES.primaryShotCost);
    if (spent !== null) {
      energy = spent;
      primaryCooldown = COMBAT_TUNING.primaryFireInterval;
      recoilKick = 1;
      const fireSolution = computePlayerFireSolution(player, selectedContact);

      for (let i = 0; i < fireSolution.barrels.length; i += 1) {
        const barrel = fireSolution.barrels[i];
        if (barrel === undefined) {
          continue;
        }
        spawned.push({
          id: `pb-${tick}-${i === 0 ? 'l' : 'r'}`,
          kind: 'bolt',
          faction: 'friendly',
          position: barrel.muzzle,
          velocity: add(player.velocity, scale(barrel.direction, COMBAT_TUNING.boltSpeed)),
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
    spawned.push({
      id: `pm-${tick}`,
      kind: 'missile',
      faction: 'friendly',
      position: launchPos,
      velocity: add(player.velocity, scale(playerForward, COMBAT_TUNING.missileSpeed * 0.8)),
      targetId: lockedId,
      damage: COMBAT_TUNING.missileDamage,
      ttl: COMBAT_TUNING.missileTtl,
    });
    events.push({ kind: 'missile_fired' });
  }

  return {
    player: {
      ...player,
      energy,
      primaryCooldown,
      missileCooldown,
      missilesReady,
      missileRearmTimer,
      selectedTargetId,
      lockState,
      recoilKick,
    },
    spawned,
    events,
  };
}

function stepNpcAgents(
  tick: number,
  rngState: number,
  player: PlayerShipState,
  wingmateInput: WingmateState,
  enemiesInput: readonly EnemyShipState[],
  friendlyCarrier: CapitalShipState,
  hostileFrigate: CapitalShipState,
  radioInput: RadioMessage | null,
  dt: number,
): {
  readonly wingmate: WingmateState;
  readonly enemies: readonly EnemyShipState[];
  readonly spawned: readonly ProjectileState[];
  readonly radio: RadioMessage | null;
  readonly rngState: number;
  readonly events: readonly SimEvent[];
} {
  let nextRng = rngState;
  let radio = radioInput;
  const spawned: ProjectileState[] = [];
  const events: SimEvent[] = [];

  const wingmateStep = stepWingmate(tick, wingmateInput, player, enemiesInput, hostileFrigate, dt);
  if (wingmateStep.projectile !== null) {
    spawned.push(wingmateStep.projectile);
  }
  if (wingmateStep.callout !== null && radio === null) {
    radio = {
      speaker: wingmateStep.wingmate.callsign,
      text: wingmateStep.callout,
      remainingSeconds: 3.0,
    };
  }

  const enemies: EnemyShipState[] = [];
  for (const enemy of enemiesInput) {
    const enemyStep = stepEnemyAi(tick, nextRng, enemy, player, friendlyCarrier, dt);
    nextRng = enemyStep.rngState;
    enemies.push(enemyStep.enemy);
    if (enemyStep.projectile !== null) {
      spawned.push(enemyStep.projectile);
      events.push({ kind: 'cannon_fired', faction: 'hostile' });
    }
  }

  return {
    wingmate: wingmateStep.wingmate,
    enemies,
    spawned,
    radio,
    rngState: nextRng,
    events,
  };
}

function stepProjectilesAndHits(
  tick: number,
  playerInput: PlayerShipState,
  wingmateCallsign: string,
  enemiesInput: readonly EnemyShipState[],
  friendlyCarrierInput: CapitalShipState,
  hostileFrigateInput: CapitalShipState,
  asteroidsInput: readonly AsteroidState[],
  projectilesInput: readonly ProjectileState[],
  explosionsInput: readonly ExplosionState[],
  radioInput: RadioMessage | null,
  dt: number,
): {
  readonly player: PlayerShipState;
  readonly enemies: readonly EnemyShipState[];
  readonly friendlyCarrier: CapitalShipState;
  readonly hostileFrigate: CapitalShipState;
  readonly asteroids: readonly AsteroidState[];
  readonly projectiles: readonly ProjectileState[];
  readonly explosions: readonly ExplosionState[];
  readonly radio: RadioMessage | null;
  readonly enemiesDestroyedDelta: number;
  readonly subsystemsDestroyedDelta: number;
  readonly events: readonly SimEvent[];
} {
  let player = playerInput;
  let friendlyCarrier = friendlyCarrierInput;
  let radio = radioInput;
  const events: SimEvent[] = [];
  const survivingProjectiles: ProjectileState[] = [];
  const nextExplosions: ExplosionState[] = explosionsInput
    .map((e) => ({ ...e, elapsed: e.elapsed + dt }))
    .filter((e) => e.elapsed < e.duration);

  const enemyMap = new Map<string, EnemyShipState>();
  for (const e of enemiesInput) {
    enemyMap.set(e.id, e);
  }
  const asteroidMap = new Map<string, AsteroidState>();
  for (const ast of asteroidsInput) {
    asteroidMap.set(ast.id, ast);
  }
  const subsystems = hostileFrigateInput.subsystems.map((s) => ({ ...s }));

  let enemiesDestroyedDelta = 0;
  let subsystemsDestroyedDelta = 0;

  for (const proj of projectilesInput) {
    const ttl = proj.ttl - dt;
    if (ttl <= 0) {
      continue;
    }

    let velocity = proj.velocity;
    if (proj.kind === 'missile' && proj.targetId !== null) {
      const targetPos = resolveTargetPosition(proj.targetId, enemyMap, hostileFrigateInput, subsystems);
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
              radius: enemy.kind === 'striker' ? 30 : 22,
              elapsed: 0,
              duration: 1.0,
              tint: 'amber',
            });
            radio = {
              speaker: wingmateCallsign,
              text: `Splash ${enemy.callsign}! Good kill, lead.`,
              remainingSeconds: 2.8,
            };
          } else {
            enemyMap.set(id, { ...enemy, hull: nextHull, shields: nextShields });
            events.push({ kind: 'hit_confirmed', isKill: false });
            nextExplosions.push({
              id: `hit-${tick}-${proj.id}`,
              position: nextPos,
              radius: 6,
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
          const worldPos = subsystemWorldPosition(hostileFrigateInput, subsys);
          if (distance(nextPos, worldPos) <= subsys.radius + 9) {
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
                radius: 44,
                elapsed: 0,
                duration: 1.35,
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
                radius: 7.5,
                elapsed: 0,
                duration: 0.3,
                tint: 'crimson',
              });
            }
            break;
          }
        }
      }

      if (!hit) {
        for (const [id, ast] of asteroidMap) {
          if (distance(nextPos, ast.position) <= ast.radius + 4) {
            hit = true;
            const nextHull = ast.hull - proj.damage;
            if (nextHull <= 0) {
              asteroidMap.delete(id);
              events.push({ kind: 'hit_confirmed', isKill: true });
              nextExplosions.push({
                id: `ast-${tick}-${id}`,
                position: ast.position,
                radius: ast.radius * 1.15,
                elapsed: 0,
                duration: 1.1,
                tint: 'amber',
              });
            } else {
              asteroidMap.set(id, { ...ast, hull: nextHull });
              nextExplosions.push({
                id: `asthit-${tick}-${proj.id}`,
                position: nextPos,
                radius: 6,
                elapsed: 0,
                duration: 0.25,
                tint: 'amber',
              });
            }
            break;
          }
        }
      }
    } else if (distance(nextPos, player.position) <= COMBAT_TUNING.playerHitRadius) {
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
        hull: Math.max(0, friendlyCarrier.hull - proj.damage * 0.4),
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

    if (!hit) {
      survivingProjectiles.push({
        ...proj,
        position: nextPos,
        velocity,
        ttl,
      });
    }
  }

  return {
    player,
    enemies: Array.from(enemyMap.values()),
    friendlyCarrier,
    hostileFrigate: { ...hostileFrigateInput, subsystems },
    asteroids: Array.from(asteroidMap.values()),
    projectiles: survivingProjectiles,
    explosions: nextExplosions,
    radio,
    enemiesDestroyedDelta,
    subsystemsDestroyedDelta,
    events,
  };
}

export function stepCombat(ctx: CombatStepInput): CombatStepOutput {
  const decayedRadio: RadioMessage | null =
    ctx.radio !== null && ctx.radio.remainingSeconds > ctx.dt
      ? { ...ctx.radio, remainingSeconds: ctx.radio.remainingSeconds - ctx.dt }
      : null;

  const weaponStep = stepPlayerWeapons(
    ctx.tick,
    ctx.player,
    ctx.enemies,
    ctx.hostileFrigate,
    ctx.input,
    ctx.dt,
  );

  const agentStep = stepNpcAgents(
    ctx.tick,
    ctx.rngState,
    weaponStep.player,
    ctx.wingmate,
    ctx.enemies,
    ctx.friendlyCarrier,
    ctx.hostileFrigate,
    decayedRadio,
    ctx.dt,
  );

  const hitStep = stepProjectilesAndHits(
    ctx.tick,
    weaponStep.player,
    agentStep.wingmate.callsign,
    agentStep.enemies,
    ctx.friendlyCarrier,
    ctx.hostileFrigate,
    ctx.asteroids,
    [...ctx.projectiles, ...weaponStep.spawned, ...agentStep.spawned],
    ctx.explosions,
    agentStep.radio,
    ctx.dt,
  );

  let player = hitStep.player;
  const finalTargetValid =
    player.selectedTargetId !== null &&
    findTargetContact(player.selectedTargetId, hitStep.enemies, hitStep.hostileFrigate) !== null;
  if (!finalTargetValid) {
    const remainingContacts = listHostileContacts(hitStep.enemies, hitStep.hostileFrigate);
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

  let wingmate = agentStep.wingmate;
  if (
    wingmate.targetId !== null &&
    findTargetContact(wingmate.targetId, hitStep.enemies, hitStep.hostileFrigate) === null
  ) {
    wingmate = { ...wingmate, targetId: null };
  }

  return {
    player,
    wingmate,
    enemies: hitStep.enemies,
    friendlyCarrier: hitStep.friendlyCarrier,
    hostileFrigate: hitStep.hostileFrigate,
    asteroids: hitStep.asteroids,
    projectiles: hitStep.projectiles,
    explosions: hitStep.explosions,
    radio: hitStep.radio,
    enemiesDestroyedDelta: hitStep.enemiesDestroyedDelta,
    subsystemsDestroyedDelta: hitStep.subsystemsDestroyedDelta,
    rngState: agentStep.rngState,
    events: [...weaponStep.events, ...agentStep.events, ...hitStep.events],
  };
}

export interface PlayerFireSolution {
  readonly leadPoint: Vec3 | null;
  readonly convergencePoint: Vec3;
  readonly barrels: readonly { readonly muzzle: Vec3; readonly direction: Vec3 }[];
}

export function computePlayerFireSolution(
  player: PlayerShipState,
  target: TargetContact | null,
): PlayerFireSolution {
  const playerForward = forwardOf(player.orientation);
  const right = rightOf(player.orientation);
  const down = scale(upOf(player.orientation), -1.0);

  const leadPoint =
    target !== null
      ? computeLeadPoint(
          player.position,
          player.velocity,
          target.position,
          target.velocity,
          COMBAT_TUNING.boltSpeed,
          COMBAT_TUNING.boltTtl,
        )
      : null;

  let aimDir = playerForward;
  if (leadPoint !== null) {
    const toLead = normalize(sub(leadPoint, player.position));
    // Subtle gimbal convergence inside a 7-degree cone makes leading shots feel crisp with mouse aim.
    if (dot(playerForward, toLead) >= 0.992) {
      aimDir = normalize(lerpVec3(playerForward, toLead, 0.72));
    }
  }

  const maxBoltReach = COMBAT_TUNING.boltSpeed * COMBAT_TUNING.boltTtl;
  const convergenceRange =
    leadPoint !== null
      ? clamp(distance(player.position, leadPoint), 15, maxBoltReach)
      : 420;
  const convergencePoint = add(player.position, scale(aimDir, convergenceRange));

  const barrels = ([-1, 1] as const).map((side) => {
    const muzzle = add(
      add(player.position, scale(playerForward, 5)),
      add(scale(right, side * 3.1), down),
    );
    return {
      muzzle,
      direction: normalize(sub(convergencePoint, muzzle)),
    };
  });

  return {
    leadPoint,
    convergencePoint,
    barrels,
  };
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

function pickWingmateTarget(
  player: PlayerShipState,
  enemies: readonly EnemyShipState[],
  hostileFrigate: CapitalShipState,
): TargetContact | null {
  let closestThreat: EnemyShipState | null = null;
  let closestDist = Infinity;
  for (const enemy of enemies) {
    const d = distance(enemy.position, player.position);
    if (d < closestDist) {
      closestDist = d;
      closestThreat = enemy;
    }
  }
  if (closestThreat !== null && closestDist < 750) {
    return {
      id: closestThreat.id,
      label: closestThreat.callsign,
      position: closestThreat.position,
      velocity: closestThreat.velocity,
      kind: 'enemy',
    };
  }
  const contacts = listHostileContacts(enemies, hostileFrigate);
  return contacts[0] ?? null;
}

function stepWingmate(
  tick: number,
  wingmate: WingmateState,
  player: PlayerShipState,
  enemies: readonly EnemyShipState[],
  hostileFrigate: CapitalShipState,
  dt: number,
): {
  readonly wingmate: WingmateState;
  readonly projectile: ProjectileState | null;
  readonly callout: string | null;
} {
  let target = findTargetContact(wingmate.targetId, enemies, hostileFrigate);
  let callout: string | null = null;
  if (target === null) {
    target = pickWingmateTarget(player, enemies, hostileFrigate);
    if (target !== null && tick > 60 && tick % 180 === 0) {
      callout = `Covering your six—engaging ${target.label}.`;
    }
  }

  const right = rightOf(player.orientation);
  const forward = forwardOf(player.orientation);
  const up = upOf(player.orientation);
  const formationPos = add(
    add(player.position, scale(right, -30)),
    add(scale(forward, -16), scale(up, 8)),
  );

  const desiredPos = target !== null ? target.position : formationPos;
  const toDesired = sub(desiredPos, wingmate.position);
  const dist = len(toDesired);
  const desiredDir = dist > 1 ? scale(toDesired, 1 / dist) : forward;
  const targetQuat = quatLookAt(desiredDir);
  const orientation = slerpQuat(wingmate.orientation, targetQuat, clamp(dt * 3.0, 0, 1));
  const playerSpeed = len(player.velocity);
  const speed = target !== null ? 96 : clamp(playerSpeed + dist * 0.45, 45, 130);
  const velocity = lerpVec3(
    wingmate.velocity,
    scale(forwardOf(orientation), speed),
    clamp(dt * 3.5, 0, 1),
  );
  const position = add(wingmate.position, scale(velocity, dt));

  let fireCooldown = Math.max(0, wingmate.fireCooldown - dt);
  let projectile: ProjectileState | null = null;
  if (
    target !== null &&
    fireCooldown <= 0 &&
    dist < 540 &&
    dist > 90 &&
    dot(forwardOf(orientation), desiredDir) > 0.94
  ) {
    const lead = computeLeadPoint(
      position,
      velocity,
      target.position,
      target.velocity,
      COMBAT_TUNING.boltSpeed,
      1.4,
    );
    if (lead !== null) {
      fireCooldown = 0.62;
      const shotDir = normalize(sub(lead, position));
      projectile = {
        id: `wb-${tick}`,
        kind: 'bolt',
        faction: 'friendly',
        position: add(position, scale(shotDir, 6)),
        velocity: add(velocity, scale(shotDir, COMBAT_TUNING.boltSpeed)),
        targetId: null,
        damage: 11,
        ttl: 1.4,
      };
    }
  }

  return {
    wingmate: {
      ...wingmate,
      targetId: target?.id ?? null,
      position,
      velocity,
      orientation,
      fireCooldown,
    },
    projectile,
    callout,
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
  let nextRng = rngState;
  const toPlayer = sub(player.position, enemy.position);
  const distToPlayer = len(toPlayer);
  const dirToPlayer = distToPlayer > 1 ? scale(toPlayer, 1 / distToPlayer) : forwardOf(enemy.orientation);

  let maneuver: EnemyManeuver = enemy.maneuver;
  let goalDir: Vec3;

  if (maneuver.kind === 'approach') {
    const remainingSeconds = maneuver.remainingSeconds - dt;
    if (distToPlayer < COMBAT_TUNING.enemyMinApproachDistance || remainingSeconds <= 0) {
      const r = nextRandom(nextRng);
      nextRng = r.nextState;
      const sideSign = r.value >= 0.5 ? 1 : -1;
      const away = scale(dirToPlayer, -1);
      const lateral = normalize(cross(away, { x: 0, y: 1, z: 0 }));
      const escapeDir = normalize(
        add(add(scale(away, 0.7), scale(lateral, sideSign * 0.72)), {
          x: 0,
          y: (r.value - 0.5) * 0.6,
          z: 0,
        }),
      );
      maneuver = {
        kind: 'break_away',
        escapeDir,
        remainingSeconds: COMBAT_TUNING.enemyBreakAwaySeconds + r.value * 1.1,
      };
      goalDir = escapeDir;
    } else {
      maneuver = { kind: 'approach', remainingSeconds };
      const time = tick / 60 + enemy.phaseOffset;
      const anchor =
        enemy.kind === 'raider'
          ? add(player.position, {
              x: Math.sin(time * 0.6) * 95,
              y: Math.cos(time * 0.5) * 55,
              z: Math.cos(time * 0.6) * 95,
            })
          : add(friendlyCarrier.position, {
              x: Math.cos(time * 0.35) * 260,
              y: 65 + Math.sin(time * 0.5) * 60,
              z: Math.sin(time * 0.35) * 260,
            });
      goalDir = normalize(sub(anchor, enemy.position));
    }
  } else {
    const remainingSeconds = maneuver.remainingSeconds - dt;
    if (remainingSeconds <= 0 && distToPlayer > 320) {
      maneuver = { kind: 'approach', remainingSeconds: COMBAT_TUNING.enemyApproachSeconds };
    } else if (remainingSeconds <= -1.2) {
      maneuver = { kind: 'approach', remainingSeconds: COMBAT_TUNING.enemyApproachSeconds };
    } else {
      maneuver = {
        kind: 'break_away',
        escapeDir: maneuver.escapeDir,
        remainingSeconds,
      };
    }
    goalDir = maneuver.kind === 'break_away' ? maneuver.escapeDir : dirToPlayer;
  }

  const targetQuat = quatLookAt(goalDir);
  const turnSpeed = enemy.kind === 'raider' ? 1.65 : 1.15;
  const orientation = slerpQuat(enemy.orientation, targetQuat, clamp(dt * turnSpeed, 0, 1));
  const cruiseSpeed =
    maneuver.kind === 'break_away'
      ? enemy.kind === 'raider'
        ? 92
        : 68
      : enemy.kind === 'raider'
        ? 78
        : 58;
  const velocity = lerpVec3(enemy.velocity, scale(forwardOf(orientation), cruiseSpeed), clamp(dt * 2.5, 0, 1));
  const position = add(enemy.position, scale(velocity, dt));

  let fireCooldown = Math.max(0, enemy.fireCooldown - dt);
  let projectile: ProjectileState | null = null;
  const facingPlayer = dot(forwardOf(orientation), dirToPlayer) > 0.92;

  if (
    maneuver.kind === 'approach' &&
    fireCooldown <= 0 &&
    distToPlayer > 175 &&
    distToPlayer < 480 &&
    facingPlayer
  ) {
    const roll = nextRandom(nextRng);
    nextRng = roll.nextState;
    fireCooldown = 1.35 + roll.value * 0.85;
    const spread = (roll.value - 0.5) * 0.05;
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
      maneuver,
      fireCooldown,
    },
    projectile,
    rngState: nextRng,
  };
}
