import { hasLineOfSight, isInsideArena, moveThroughArena, steerClearOfArena, sweepArena } from './arena';
import { addWeaponHeat, ENERGY_RULES, flushWeaponHeat, inHotZone } from './energy';
import { damagePlayer, FLIGHT_TUNING } from './flight';
import { FRIGATE_HULL_PROXY } from './frigateLayout';
import { GROUND_TARGET_SPECS } from './planetaryLayout';
import { absorbIntoShield, regenShield, SHIP_STATS } from './ships';
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
  segmentBoxEntry,
  segmentClosestApproach,
  segmentSphereEntry,
  slerpQuat,
  sub,
  toLocalPoint,
  upOf,
} from './math';
import type {
  ArenaSolid,
  AsteroidState,
  BarrelSide,
  CapitalShipState,
  EnemyManeuver,
  EnemyShipState,
  ExplosionState,
  FlightInput,
  GroundTargetState,
  LockState,
  PlayerShipState,
  ProjectileState,
  RadioMessage,
  ReactorState,
  SimEvent,
  SubsystemState,
  SupplyDrop,
  Vec3,
  WingmateState,
} from './types';

// Single source of truth shared across cameraPose.ts, models.ts, and combat.ts so first-person
// bolts spawn directly from the visible left/right cockpit barrels.
export const COCKPIT_CAMERA_OFFSET = {
  forward: 1.8,
  up: 1.35,
} as const;

export const COCKPIT_GUN_LOCAL = {
  x: 0.99,
  y: -0.54,
  forward: 2.32,
} as const;

export const FIGHTER_WEAPON_LAYOUT = {
  muzzleX: COCKPIT_GUN_LOCAL.x,
  muzzleY: COCKPIT_CAMERA_OFFSET.up + COCKPIT_GUN_LOCAL.y,
  muzzleForward: COCKPIT_CAMERA_OFFSET.forward + COCKPIT_GUN_LOCAL.forward,
} as const;

export const COMBAT_TUNING = {
  // Slow enough that crossing targets need the lead pip; the TTL keeps reach near 520 m.
  boltSpeed: 390,
  boltDamage: 18,
  boltTtl: 1.33,
  wingmateBoltSpeed: 560,
  primaryFireInterval: 0.14,
  missileSpeed: 330,
  missileDamage: 85,
  missileTtl: 5.2,
  missileCooldown: 0.55,
  missileRearmSeconds: 12,
  missileTurnRate: 4.9,
  lockConeCos: 0.88,
  lockMaxRange: 1100,
  lockAcquireSeconds: 0.8,
  autoFocusConeCos: 0.92,
  /** Angular gap (rad) inside which distance may break a tie between two centred contacts. */
  autoFocusTieRadians: 0.0105,
  autoFocusHysteresisRadians: 0.0105,
  pinConeCos: 0.5,
  pinMaxRange: 1400,
  enemyBoltSpeed: 390,
  enemyBoltDamage: 14,
  enemyCarrierDamage: 24,
  enemyMinApproachDistance: 155,
  enemyBreakAwaySeconds: 2.6,
  enemyApproachSeconds: 7.2,
  openingGraceSeconds: 4.5,
  attackTokens: 2,
  enemyAimBaseError: 0.006,
  enemyAimSpeedError: 0.03,
  enemyAimCrossingError: 0.15,
  enemyAimTurnError: 0.012,
  enemyAimOverdriveError: 0.045,
  subsystemHitTolerance: 1.5,
  asteroidHitTolerance: 2,
  critBaseChance: 0.14,
  critPrecisionBonus: 0.16,
  critPityStep: 0.03,
  critMaxChance: 0.55,
  critMultiplier: 1.75,
  dropBaseChance: 0.35,
  dropPityStep: 0.2,
  shieldSurge: 25,
  nearMissRadius: 16,
  nearMissMinSpeed: 80,
  nearMissMinTurnRate: 0.6,
  nearMissCooldown: 1.5,
  nearMissHeatVent: 12,
  nearMissShieldRestore: 6,
  buzzEnemyDistance: 24,
  buzzClearance: 12,
  /** A guard on patrol breaks station when the player closes inside this range. */
  patrolAggroRange: 520,
  patrolOrbitRadius: 36,
  /** Seconds of flight an AI craft looks ahead for walls. */
  avoidLookaheadSeconds: 1.3,
  avoidMinLookahead: 70,
  aiHullClearance: 2,
} as const;

// Wingmate mesh shares the player fighter's bounds.
const WINGMATE_HULL_PAD = 7;

/** True when nothing solid sits between `from` and the target, counting the target's own core as the target. */
function clearShot(from: Vec3, target: TargetContact, arena: readonly ArenaSolid[]): boolean {
  const hit = sweepArena(from, target.position, arena, 0);
  return hit === null || (hit.solid.kind === 'sphere' && hit.solid.reactorId === target.id);
}

export interface TargetContact {
  readonly id: string;
  readonly label: string;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly kind: 'enemy' | 'subsystem' | 'ground';
}

/** Earliest fraction along a swept segment where it enters solid ground, or null; absent off-planet. */
export type TerrainEntry = (a: Vec3, b: Vec3) => number | null;

export interface CombatStepInput {
  readonly tick: number;
  readonly rngState: number;
  readonly player: PlayerShipState;
  readonly wingmate: WingmateState;
  readonly enemies: readonly EnemyShipState[];
  readonly friendlyCarrier: CapitalShipState;
  readonly hostileFrigate: CapitalShipState | null;
  readonly reactors: readonly ReactorState[];
  readonly arena: readonly ArenaSolid[];
  readonly asteroids: readonly AsteroidState[];
  readonly projectiles: readonly ProjectileState[];
  readonly explosions: readonly ExplosionState[];
  readonly radio: RadioMessage | null;
  readonly input: FlightInput;
  readonly dt: number;
  readonly groundTargets?: readonly GroundTargetState[];
  readonly terrainEntry?: TerrainEntry;
  /** Who calls out ground kills on the radio. */
  readonly groundSpeaker?: string;
  /** Extra geometry the wingmate steers around, such as canyon terrain outside the arena. */
  readonly wingmateObstacles?: readonly ArenaSolid[];
  /** Where the player started this tick, before flight moved it; bolts are swept against that motion. */
  readonly playerStartPosition?: Vec3;
}

export interface CombatStepOutput {
  readonly player: PlayerShipState;
  readonly wingmate: WingmateState;
  readonly enemies: readonly EnemyShipState[];
  readonly friendlyCarrier: CapitalShipState;
  readonly hostileFrigate: CapitalShipState | null;
  readonly reactors: readonly ReactorState[];
  readonly asteroids: readonly AsteroidState[];
  readonly projectiles: readonly ProjectileState[];
  readonly explosions: readonly ExplosionState[];
  readonly radio: RadioMessage | null;
  readonly enemiesDestroyedDelta: number;
  readonly subsystemsDestroyedDelta: number;
  readonly reactorsDestroyedDelta: number;
  readonly groundTargets: readonly GroundTargetState[];
  readonly groundTargetsDestroyedDelta: number;
  readonly rngState: number;
  readonly events: readonly SimEvent[];
}

export function subsystemWorldPosition(ship: CapitalShipState, subsys: SubsystemState): Vec3 {
  return add(ship.position, rotateVec3(ship.orientation, subsys.localOffset));
}

export function listHostileContacts(
  enemies: readonly EnemyShipState[],
  hostileFrigate: CapitalShipState | null,
  reactors: readonly ReactorState[] = [],
  groundTargets: readonly GroundTargetState[] = [],
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
  for (const subsys of hostileFrigate?.subsystems ?? []) {
    if (hostileFrigate !== null && subsys.hull > 0) {
      contacts.push({
        id: subsys.id,
        label: subsys.label,
        position: subsystemWorldPosition(hostileFrigate, subsys),
        velocity: { x: 0, y: 0, z: 0 },
        kind: 'subsystem',
      });
    }
  }
  for (const reactor of reactors) {
    if (reactor.hull > 0) {
      contacts.push({ id: reactor.id, label: reactor.label, position: reactor.position, velocity: { x: 0, y: 0, z: 0 }, kind: 'subsystem' });
    }
  }
  for (const target of groundTargets) {
    if (target.hull > 0) {
      contacts.push({ id: target.id, label: target.label, position: target.position, velocity: { x: 0, y: 0, z: 0 }, kind: 'ground' });
    }
  }
  return contacts;
}

export function findTargetContact(
  targetId: string | null,
  enemies: readonly EnemyShipState[],
  hostileFrigate: CapitalShipState | null,
  reactors: readonly ReactorState[] = [],
  groundTargets: readonly GroundTargetState[] = [],
): TargetContact | null {
  if (targetId === null) {
    return null;
  }
  const contacts = listHostileContacts(enemies, hostileFrigate, reactors, groundTargets);
  return contacts.find((c) => c.id === targetId) ?? null;
}

function angleOffNose(playerPos: Vec3, playerForward: Vec3, target: Vec3): { readonly angle: number; readonly dist: number } {
  const toTarget = sub(target, playerPos);
  const dist = Math.max(len(toTarget), 1);
  return { angle: Math.acos(clamp(dot(playerForward, scale(toTarget, 1 / dist)), -1, 1)), dist };
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

  // Centre-of-view auto-focus: the contact nearest the crosshair wins. Distance only breaks
  // near-ties, so a closer off-axis contact never steals focus from a centred one.
  const maxAngle = Math.acos(COMBAT_TUNING.autoFocusConeCos);
  const inView: { readonly id: string; readonly angle: number; readonly dist: number }[] = [];
  for (const contact of contacts) {
    const view = angleOffNose(playerPos, playerForward, contact.position);
    if (view.dist <= COMBAT_TUNING.lockMaxRange && view.angle <= maxAngle) {
      const hysteresis = contact.id === currentId ? COMBAT_TUNING.autoFocusHysteresisRadians : 0;
      inView.push({ id: contact.id, angle: view.angle - hysteresis, dist: view.dist });
    }
  }
  if (inView.length > 0) {
    const bestAngle = Math.min(...inView.map((c) => c.angle));
    let best: (typeof inView)[number] | null = null;
    for (const candidate of inView) {
      if (candidate.angle <= bestAngle + COMBAT_TUNING.autoFocusTieRadians && (best === null || candidate.dist < best.dist)) {
        best = candidate;
      }
    }
    if (best !== null) {
      return best.id;
    }
  }

  // Pure center-of-view targeting: when nothing is inside your forward cone, select nothing
  // instead of sticking to an off-screen contact or forcing an arbitrary "next objective".
  return null;
}

export interface TargetSelection {
  readonly targetId: string | null;
  readonly pinned: boolean;
}

function insidePinCone(playerPos: Vec3, playerForward: Vec3, contact: TargetContact): boolean {
  const view = angleOffNose(playerPos, playerForward, contact.position);
  return view.dist <= COMBAT_TUNING.pinMaxRange && Math.cos(view.angle) >= COMBAT_TUNING.pinConeCos;
}

/**
 * `T` cycles through contacts in the forward pin cone and pins the pick; the pin holds until that
 * contact dies or leaves the cone, or `T` is pressed on the only candidate. Unpinned, auto-focus runs.
 */
export function resolveTargetSelection(
  current: TargetSelection,
  playerPos: Vec3,
  playerForward: Vec3,
  contacts: readonly TargetContact[],
  cycleRequested: boolean,
): TargetSelection {
  if (cycleRequested) {
    const candidates = contacts.filter((c) => insidePinCone(playerPos, playerForward, c));
    if (candidates.length === 0) {
      return { targetId: null, pinned: false };
    }
    const index = candidates.findIndex((c) => c.id === current.targetId);
    if (current.pinned && candidates.length === 1 && index === 0) {
      return { targetId: current.targetId, pinned: false };
    }
    const next = candidates[(index + 1) % candidates.length] ?? candidates[0];
    return { targetId: next?.id ?? null, pinned: true };
  }

  if (current.pinned) {
    const pinned = contacts.find((c) => c.id === current.targetId);
    if (pinned !== undefined && insidePinCone(playerPos, playerForward, pinned)) {
      return current;
    }
  }
  return {
    targetId: selectNextTarget(current.targetId, playerPos, playerForward, contacts, false),
    pinned: false,
  };
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
  hostileFrigate: CapitalShipState | null,
  reactors: readonly ReactorState[],
  groundTargets: readonly GroundTargetState[],
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
  const contacts = listHostileContacts(enemies, hostileFrigate, reactors, groundTargets);
  const selection = resolveTargetSelection(
    { targetId: player.selectedTargetId, pinned: player.targetPinned },
    player.position,
    playerForward,
    contacts,
    input.cycleTarget,
  );
  const selectedContact = contacts.find((c) => c.id === selection.targetId) ?? null;

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
  let recoilLeft = player.recoilLeft;
  let recoilRight = player.recoilRight;
  let nextBarrel: BarrelSide = player.nextBarrel;
  let lockState = lockStep.lockState;

  if (input.firePrimary && primaryCooldown <= 0) {
    const hotZone = inHotZone(energy);
    const spent = addWeaponHeat(energy, ENERGY_RULES.primaryShotHeat);
    if (spent !== null) {
      energy = spent.energy;
      primaryCooldown = COMBAT_TUNING.primaryFireInterval;
      recoilKick = 0.72;
      const firedBarrel = nextBarrel;
      nextBarrel = firedBarrel === 'left' ? 'right' : 'left';
      if (firedBarrel === 'left') {
        recoilLeft = 1;
      } else {
        recoilRight = 1;
      }

      const fireSolution = computePlayerFireSolution(player, selectedContact);
      const barrel = fireSolution.barrels[firedBarrel === 'left' ? 0 : 1];
      if (barrel !== undefined) {
        spawned.push({
          id: `pb-${tick}-${firedBarrel === 'left' ? 'l' : 'r'}`,
          kind: 'bolt',
          faction: 'friendly',
          owner: 'player',
          position: barrel.muzzle,
          velocity: add(player.velocity, scale(barrel.direction, COMBAT_TUNING.boltSpeed)),
          targetId: null,
          damage: COMBAT_TUNING.boltDamage,
          ttl: COMBAT_TUNING.boltTtl,
          hotZone,
        });
      }
      events.push({ kind: 'cannon_fired', faction: 'friendly', barrel: firedBarrel });
      if (spent.overheatedNow) {
        events.push({ kind: 'weapon_overheated' });
      }
    }
  }

  // A held trigger only launches on a completed lock; a fresh press launches immediately.
  const lockedId = lockState.kind === 'locked' ? lockState.targetId : null;
  const missileTriggered = input.fireMissilePressed || (input.fireMissile && lockedId !== null);
  if (missileTriggered && missileCooldown <= 0 && missilesReady > 0) {
    missilesReady -= 1;
    missileCooldown = COMBAT_TUNING.missileCooldown;
    lockState = { kind: 'none' };
    const right = rightOf(player.orientation);
    const up = upOf(player.orientation);
    const side = missilesReady % 2 === 0 ? 1 : -1;
    const launchPos = add(
      add(player.position, scale(playerForward, FIGHTER_WEAPON_LAYOUT.muzzleForward)),
      add(scale(right, side * 1.45), scale(up, FIGHTER_WEAPON_LAYOUT.muzzleY - 0.2)),
    );
    spawned.push({
      id: `pm-${tick}`,
      kind: 'missile',
      faction: 'friendly',
      owner: 'player',
      position: launchPos,
      velocity: add(player.velocity, scale(playerForward, COMBAT_TUNING.missileSpeed * 0.85)),
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
      selectedTargetId: selection.targetId,
      targetPinned: selection.pinned,
      lockState,
      recoilKick,
      recoilLeft,
      recoilRight,
      nextBarrel,
    },
    spawned,
    events,
  };
}

/** Nearest raiders on an attack run hold the tokens; the rest manoeuvre without shooting at the player. */
function assignAttackTokens(enemies: readonly EnemyShipState[], player: PlayerShipState): ReadonlySet<string> {
  const attackers = enemies
    .filter((e) => e.kind === 'raider' && e.maneuver.kind === 'approach')
    .map((e) => ({ id: e.id, dist: distance(e.position, player.position) }))
    .sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
  return new Set(attackers.slice(0, COMBAT_TUNING.attackTokens).map((e) => e.id));
}

function stepNpcAgents(
  tick: number,
  rngState: number,
  player: PlayerShipState,
  wingmateInput: WingmateState,
  enemiesInput: readonly EnemyShipState[],
  friendlyCarrier: CapitalShipState,
  hostileFrigate: CapitalShipState | null,
  reactors: readonly ReactorState[],
  arena: readonly ArenaSolid[],
  wingmateObstacles: readonly ArenaSolid[],
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

  const wingmateStep = stepWingmate(tick, wingmateInput, player, enemiesInput, hostileFrigate, reactors, arena, wingmateObstacles, dt);
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

  const weaponsFree = tick * dt >= COMBAT_TUNING.openingGraceSeconds;
  const tokens = assignAttackTokens(enemiesInput, player);
  const enemies: EnemyShipState[] = [];
  for (const enemy of enemiesInput) {
    const enemyStep = stepEnemyAi(tick, nextRng, enemy, player, friendlyCarrier, arena, weaponsFree, tokens.has(enemy.id), dt);
    nextRng = enemyStep.rngState;
    enemies.push(enemyStep.enemy);
    if (enemyStep.projectile !== null) {
      spawned.push(enemyStep.projectile);
      events.push({ kind: 'cannon_fired', faction: 'hostile' });
      if (enemyStep.atPlayer) {
        events.push({ kind: 'incoming_fire', position: enemyStep.enemy.position });
      }
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

export function critChance(precision: number, pity: number): number {
  const precisionBonus = COMBAT_TUNING.critPrecisionBonus * clamp((precision - 0.5) / 0.5, 0, 1);
  return Math.min(
    COMBAT_TUNING.critMaxChance,
    COMBAT_TUNING.critBaseChance + precisionBonus + pity * COMBAT_TUNING.critPityStep,
  );
}

/** A Hot Zone shot doubles the crit bonus: 1.75x becomes 1 + 2 * 0.75 = 2.5x. */
export function critMultiplier(hotZone: boolean): number {
  const bonus = COMBAT_TUNING.critMultiplier - 1;
  return 1 + (hotZone ? 2 : 1) * bonus;
}

export function dropChance(pity: number): number {
  return Math.min(1, COMBAT_TUNING.dropBaseChance + pity * COMBAT_TUNING.dropPityStep);
}

const DROP_LABELS: Readonly<Record<SupplyDrop, string>> = {
  heat_flush: 'HEAT FLUSH, cannons cold',
  shield_surge: 'SHIELD SURGE',
  missile_resupply: 'MISSILE RESUPPLY',
};

function usefulDrops(player: PlayerShipState): readonly SupplyDrop[] {
  const drops: SupplyDrop[] = [];
  if (player.energy.weaponState === 'overheated' || player.energy.weaponHeat > 0) drops.push('heat_flush');
  if (player.energy.shieldCharge < SHIP_STATS.player.shields) drops.push('shield_surge');
  if (player.missilesReady < player.maxMissiles) drops.push('missile_resupply');
  return drops.length > 0 ? drops : ['shield_surge'];
}

function applySupplyDrop(player: PlayerShipState, drop: SupplyDrop): PlayerShipState {
  switch (drop) {
    case 'heat_flush':
      return { ...player, energy: flushWeaponHeat(player.energy) };
    case 'shield_surge':
      return {
        ...player,
        energy: {
          ...player.energy,
          shieldCharge: Math.min(SHIP_STATS.player.shields, player.energy.shieldCharge + COMBAT_TUNING.shieldSurge),
        },
      };
    case 'missile_resupply':
      return { ...player, missilesReady: Math.min(player.maxMissiles, player.missilesReady + 1) };
  }
}

function nearMissReward(
  player: PlayerShipState,
  source: 'bolt' | 'buzz',
): { readonly player: PlayerShipState; readonly event: SimEvent } {
  const energy = player.energy;
  const vent = energy.weaponState === 'ready' && energy.weaponHeat > 0;
  const rewarded: PlayerShipState = {
    ...player,
    nearMissCooldown: COMBAT_TUNING.nearMissCooldown,
    energy: vent
      ? { ...energy, weaponHeat: Math.max(0, energy.weaponHeat - COMBAT_TUNING.nearMissHeatVent) }
      : {
          ...energy,
          shieldCharge: Math.min(SHIP_STATS.player.shields, energy.shieldCharge + COMBAT_TUNING.nearMissShieldRestore),
        },
  };
  return { player: rewarded, event: { kind: 'near_miss', source, reward: vent ? 'heat_vent' : 'shield' } };
}

/** Near misses pay out only while flying fast or hard; a straight, slow (AFK) pilot earns nothing. */
function flyingDaringly(player: PlayerShipState): boolean {
  return (
    player.nearMissCooldown <= 0 &&
    (len(player.velocity) >= COMBAT_TUNING.nearMissMinSpeed ||
      len(player.angularVelocity) >= COMBAT_TUNING.nearMissMinTurnRate)
  );
}

function isBuzzing(
  player: PlayerShipState,
  enemies: readonly EnemyShipState[],
  asteroids: readonly AsteroidState[],
  capitalShips: readonly CapitalShipState[],
  arena: readonly ArenaSolid[],
): boolean {
  if (player.hitFlash >= 0.99 || len(player.velocity) < COMBAT_TUNING.nearMissMinSpeed) {
    return false;
  }
  const pos = player.position;
  return (
    isInsideArena(pos, arena, FLIGHT_TUNING.arenaHullPad + COMBAT_TUNING.buzzClearance) ||
    enemies.some((e) => distance(e.position, pos) <= COMBAT_TUNING.buzzEnemyDistance) ||
    asteroids.some(
      (a) => distance(a.position, pos) <= a.radius + FLIGHT_TUNING.asteroidClearanceMargin + COMBAT_TUNING.buzzClearance,
    ) ||
    capitalShips.some((s) => isInsideCapitalBox(pos, s, FLIGHT_TUNING.carrierClearanceMargin + COMBAT_TUNING.buzzClearance))
  );
}

type FriendlyHit =
  | { readonly kind: 'hull'; readonly t: number }
  | { readonly kind: 'enemy'; readonly t: number; readonly id: string; readonly precision: number }
  | { readonly kind: 'subsystem'; readonly t: number; readonly index: number; readonly precision: number }
  | { readonly kind: 'asteroid'; readonly t: number; readonly id: string }
  | { readonly kind: 'reactor'; readonly t: number; readonly id: string; readonly precision: number }
  | { readonly kind: 'wall'; readonly t: number }
  | { readonly kind: 'ground'; readonly t: number; readonly index: number; readonly precision: number }
  | { readonly kind: 'terrain'; readonly t: number };

/** Miss distance of the bolt's line of flight, so precision doesn't depend on where the tick boundary fell. */
function precisionOf(a: Vec3, b: Vec3, center: Vec3, radius: number): number {
  const missDistance = len(cross(sub(center, a), normalize(sub(b, a))));
  return clamp(1 - missDistance / radius, 0, 1);
}

/**
 * Earliest entry along the swept segment wins, so the frigate hull shields cores behind it and
 * level walls are real cover.
 */
const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

/** A bolt's path in the frame of a ship that moved `shipStart → shipEnd` over the same tick. */
function relativePath(a: Vec3, b: Vec3, shipStart: Vec3, shipEnd: Vec3): { readonly a: Vec3; readonly b: Vec3 } {
  return { a: sub(a, shipStart), b: sub(b, shipEnd) };
}

function findFriendlyHit(
  a: Vec3,
  b: Vec3,
  enemies: ReadonlyMap<string, EnemyShipState>,
  enemyStarts: ReadonlyMap<string, Vec3>,
  frigate: CapitalShipState | null,
  subsystems: readonly SubsystemState[],
  reactors: readonly ReactorState[],
  arena: readonly ArenaSolid[],
  asteroids: ReadonlyMap<string, AsteroidState>,
  groundTargets: readonly GroundTargetState[],
  terrainEntry: TerrainEntry | null,
): FriendlyHit | null {
  let best: FriendlyHit | null = null;
  const consider = (hit: FriendlyHit): void => {
    if (best === null || hit.t < best.t) best = hit;
  };

  const wall = sweepArena(a, b, arena, 0);
  if (wall !== null) {
    const reactorId = wall.solid.kind === 'sphere' ? wall.solid.reactorId : null;
    const reactor = reactorId === null ? undefined : reactors.find((r) => r.id === reactorId && r.hull > 0);
    consider(
      reactor === undefined
        ? { kind: 'wall', t: wall.t }
        : { kind: 'reactor', t: wall.t, id: reactor.id, precision: precisionOf(a, b, reactor.position, reactor.radius) },
    );
  }
  if (frigate !== null) {
    for (const slab of FRIGATE_HULL_PROXY) {
      const center = add(frigate.position, rotateVec3(frigate.orientation, slab.center));
      const hullT = segmentBoxEntry(a, b, center, frigate.orientation, slab.halfExtents);
      if (hullT !== null) consider({ kind: 'hull', t: hullT });
    }
  }
  subsystems.forEach((subsys, index) => {
    if (frigate === null || subsys.hull <= 0) return;
    const center = subsystemWorldPosition(frigate, subsys);
    const radius = subsys.radius + COMBAT_TUNING.subsystemHitTolerance;
    const t = segmentSphereEntry(a, b, center, radius);
    if (t !== null) consider({ kind: 'subsystem', t, index, precision: precisionOf(a, b, center, radius) });
  });
  for (const [id, enemy] of enemies) {
    const radius = SHIP_STATS.enemies[enemy.kind].hitRadius;
    const rel = relativePath(a, b, enemyStarts.get(id) ?? enemy.position, enemy.position);
    const t = segmentSphereEntry(rel.a, rel.b, ORIGIN, radius);
    if (t !== null) consider({ kind: 'enemy', t, id, precision: precisionOf(rel.a, rel.b, ORIGIN, radius) });
  }
  for (const [id, rock] of asteroids) {
    const t = segmentSphereEntry(a, b, rock.position, rock.radius + COMBAT_TUNING.asteroidHitTolerance);
    if (t !== null) consider({ kind: 'asteroid', t, id });
  }
  groundTargets.forEach((target, index) => {
    if (target.hull <= 0) return;
    const t = segmentSphereEntry(a, b, target.position, target.hitRadius);
    if (t !== null) consider({ kind: 'ground', t, index, precision: precisionOf(a, b, target.position, target.hitRadius) });
  });
  if (terrainEntry !== null) {
    const t = terrainEntry(a, b);
    if (t !== null) consider({ kind: 'terrain', t });
  }
  return best;
}

function attackerOf(proj: ProjectileState): 'player' | 'wingmate' | 'enemy' {
  return proj.owner === 'hostile' ? 'enemy' : proj.owner;
}

/** A bolt or missile that meets level geometry stops there with a short dust flash. */
function wallImpact(tick: number, proj: ProjectileState, position: Vec3): ExplosionState {
  const missile = proj.kind === 'missile';
  return {
    id: `wall-${tick}-${proj.id}`,
    position,
    radius: missile ? 14 : 4.5,
    elapsed: 0,
    duration: missile ? 0.7 : 0.22,
    tint: proj.faction === 'friendly' ? 'amber' : 'emerald',
  };
}

function stepProjectilesAndHits(
  tick: number,
  rngState: number,
  playerInput: PlayerShipState,
  playerStart: Vec3,
  wingmateCallsign: string,
  enemyStarts: ReadonlyMap<string, Vec3>,
  enemiesInput: readonly EnemyShipState[],
  friendlyCarrierInput: CapitalShipState,
  hostileFrigateInput: CapitalShipState | null,
  reactorsInput: readonly ReactorState[],
  arena: readonly ArenaSolid[],
  asteroidsInput: readonly AsteroidState[],
  projectilesInput: readonly ProjectileState[],
  explosionsInput: readonly ExplosionState[],
  radioInput: RadioMessage | null,
  groundTargetsInput: readonly GroundTargetState[],
  terrainEntry: TerrainEntry | null,
  groundSpeaker: string,
  dt: number,
): Omit<CombatStepOutput, 'wingmate'> {
  let rng = rngState;
  const roll = (): number => {
    const r = nextRandom(rng);
    rng = r.nextState;
    return r.value;
  };
  let player: PlayerShipState = {
    ...playerInput,
    nearMissCooldown: Math.max(0, playerInput.nearMissCooldown - dt),
  };
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
  const subsystems = (hostileFrigateInput?.subsystems ?? []).map((s) => ({ ...s }));
  const reactors = reactorsInput.map((r) => ({ ...r }));

  let enemiesDestroyedDelta = 0;
  let subsystemsDestroyedDelta = 0;
  let reactorsDestroyedDelta = 0;
  const groundTargets = groundTargetsInput.map((g) => ({ ...g }));
  let groundTargetsDestroyedDelta = 0;

  const rollCannonDamage = (proj: ProjectileState, precision: number, position: Vec3): number => {
    if (proj.owner !== 'player' || proj.kind !== 'bolt') {
      return proj.damage;
    }
    if (roll() < critChance(precision, player.critPity)) {
      player = { ...player, critPity: 0 };
      events.push({ kind: 'crit_hit', position });
      return proj.damage * critMultiplier(proj.hotZone === true);
    }
    player = { ...player, critPity: player.critPity + 1 };
    return proj.damage;
  };

  for (const proj of projectilesInput) {
    const ttl = proj.ttl - dt;
    if (ttl <= 0) {
      continue;
    }

    let velocity = proj.velocity;
    if (proj.kind === 'missile' && proj.targetId !== null) {
      const targetPos = resolveTargetPosition(proj.targetId, enemyMap, hostileFrigateInput, subsystems, reactors, groundTargets);
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
      const found = findFriendlyHit(
        proj.position, nextPos, enemyMap, enemyStarts, hostileFrigateInput, subsystems, reactors, arena, asteroidMap, groundTargets, terrainEntry,
      );
      hit = found !== null;
      const impact = found === null ? nextPos : lerpVec3(proj.position, nextPos, found.t);

      if (found?.kind === 'wall') {
        nextExplosions.push(wallImpact(tick, proj, impact));
      } else if (found?.kind === 'reactor') {
        const index = reactors.findIndex((r) => r.id === found.id);
        const core = reactors[index];
        if (core !== undefined) {
          const damage = rollCannonDamage(proj, found.precision, impact);
          const nextHull = Math.max(0, core.hull - damage);
          reactors[index] = { ...core, hull: nextHull };
          const destroyed = nextHull <= 0;
          if (proj.owner === 'player') {
            events.push({ kind: 'hit_confirmed', isKill: destroyed });
          }
          if (destroyed) {
            reactorsDestroyedDelta += 1;
            events.push({ kind: 'subsystem_destroyed', label: core.label });
            nextExplosions.push({ id: `core-${tick}-${core.id}`, position: core.position, radius: 40, elapsed: 0, duration: 1.35, tint: 'crimson' });
            const left = reactors.filter((r) => r.hull > 0).length;
            radio = {
              speaker: 'HEARTHSTONE',
              text: left > 0 ? `${core.label} is dark. ${left} to go.` : 'Spine is dead. Exit cold, lead.',
              remainingSeconds: 3.6,
            };
          } else {
            nextExplosions.push({ id: `corehit-${tick}-${proj.id}`, position: impact, radius: 7.5, elapsed: 0, duration: 0.3, tint: 'crimson' });
          }
        }
      } else if (found?.kind === 'hull') {
        nextExplosions.push({
          id: `hullhit-${tick}-${proj.id}`,
          position: impact,
          radius: 6,
          elapsed: 0,
          duration: 0.25,
          tint: 'crimson',
        });
      } else if (found?.kind === 'enemy') {
        const enemy = enemyMap.get(found.id);
        if (enemy !== undefined) {
          const damage = rollCannonDamage(proj, found.precision, impact);
          const hadShields = enemy.shields > 0;
          const absorbed = absorbIntoShield(enemy.shields, damage);
          const nextHull = enemy.hull - absorbed.hullDamage;

          if (absorbed.broke) {
            events.push({ kind: 'shield_broken', position: enemy.position, targetId: enemy.id, attackerId: attackerOf(proj) });
            nextExplosions.push({
              id: `shdbrk-${tick}-${enemy.id}`,
              position: enemy.position,
              radius: 20,
              elapsed: 0,
              duration: 0.52,
              tint: 'cyan',
            });
          }

          if (nextHull <= 0) {
            enemyMap.delete(enemy.id);
            enemiesDestroyedDelta += 1;
            if (proj.owner === 'player') {
              events.push({ kind: 'hit_confirmed', isKill: true, shieldHit: false });
              let radioText = `Splash ${enemy.callsign}! Good kill, lead.`;
              if (roll() < dropChance(player.dropPity)) {
                const options = usefulDrops(player);
                const drop = options[Math.min(options.length - 1, Math.floor(roll() * options.length))] ?? 'shield_surge';
                const wasOverheated = player.energy.weaponState === 'overheated';
                player = { ...applySupplyDrop(player, drop), dropPity: 0 };
                events.push({ kind: 'supply_drop', drop });
                if (wasOverheated && player.energy.weaponState === 'ready') {
                  events.push({ kind: 'weapon_ready' });
                }
                radioText = `Splash ${enemy.callsign}! Supply drop: ${DROP_LABELS[drop]}.`;
              } else {
                player = { ...player, dropPity: player.dropPity + 1 };
              }
              radio = { speaker: wingmateCallsign, text: radioText, remainingSeconds: 2.8 };
            }
            nextExplosions.push({
              id: `exp-${tick}-${enemy.id}`,
              position: enemy.position,
              radius: enemy.kind === 'striker' ? 30 : 22,
              elapsed: 0,
              duration: 1.0,
              tint: 'amber',
            });
          } else {
            enemyMap.set(enemy.id, {
              ...enemy,
              hull: nextHull,
              shields: absorbed.shield,
              shieldRegenDelay: SHIP_STATS.enemies[enemy.kind].shieldRegenDelay,
              shieldHitFlash: hadShields ? 1 : enemy.shieldHitFlash,
            });
            if (proj.owner === 'player') {
              events.push({ kind: 'hit_confirmed', isKill: false, shieldHit: hadShields && !absorbed.broke });
            }
            if (!absorbed.broke) {
              nextExplosions.push({
                id: `hit-${tick}-${proj.id}`,
                position: impact,
                radius: hadShields ? 8.5 : 6,
                elapsed: 0,
                duration: 0.28,
                tint: hadShields ? 'cyan' : 'emerald',
              });
            }
          }
        }
      } else if (found?.kind === 'subsystem') {
        const subsys = subsystems[found.index];
        if (subsys !== undefined && hostileFrigateInput !== null) {
          const worldPos = subsystemWorldPosition(hostileFrigateInput, subsys);
          const damage = rollCannonDamage(proj, found.precision, impact);
          const nextHull = Math.max(0, subsys.hull - damage);
          subsystems[found.index] = { ...subsys, hull: nextHull };
          const destroyed = nextHull <= 0;
          if (proj.owner === 'player') {
            events.push({ kind: 'hit_confirmed', isKill: destroyed });
          }
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
              position: impact,
              radius: 7.5,
              elapsed: 0,
              duration: 0.3,
              tint: 'crimson',
            });
          }
        }
      } else if (found?.kind === 'ground') {
        const target = groundTargets[found.index];
        if (target !== undefined) {
          const shielded = target.shieldedBy !== null && groundTargets.some((g) => g.id === target.shieldedBy && g.hull > 0);
          if (shielded) {
            groundTargets[found.index] = { ...target, shieldHitFlash: 1 };
            if (proj.owner === 'player') {
              events.push({ kind: 'hit_confirmed', isKill: false, shieldHit: true });
            }
            nextExplosions.push({ id: `gshd-${tick}-${proj.id}`, position: impact, radius: 8.5, elapsed: 0, duration: 0.28, tint: 'cyan' });
          } else {
            const damage = rollCannonDamage(proj, found.precision, impact);
            const nextHull = Math.max(0, target.hull - damage);
            groundTargets[found.index] = { ...target, hull: nextHull };
            const destroyed = nextHull <= 0;
            if (proj.owner === 'player') {
              events.push({ kind: 'hit_confirmed', isKill: destroyed });
            }
            if (destroyed) {
              groundTargetsDestroyedDelta += 1;
              events.push({ kind: 'ground_target_destroyed', label: target.label, position: target.position });
              nextExplosions.push({
                id: `gnd-${tick}-${target.id}`,
                position: target.position,
                radius: target.kind === 'artillery' ? 40 : 26,
                elapsed: 0,
                duration: 1.2,
                tint: 'amber',
              });
              radio = { speaker: groundSpeaker, text: GROUND_TARGET_SPECS[target.kind].killCall, remainingSeconds: 3.4 };
            } else {
              nextExplosions.push({ id: `ghit-${tick}-${proj.id}`, position: impact, radius: 6.5, elapsed: 0, duration: 0.28, tint: 'amber' });
            }
          }
        }
      } else if (found?.kind === 'terrain') {
        nextExplosions.push({ id: `dirt-${tick}-${proj.id}`, position: impact, radius: proj.kind === 'missile' ? 12 : 4, elapsed: 0, duration: 0.3, tint: 'amber' });
      } else if (found?.kind === 'asteroid') {
        const ast = asteroidMap.get(found.id);
        if (ast !== undefined) {
          const nextHull = ast.hull - proj.damage;
          if (proj.owner === 'player') {
            events.push({ kind: 'hit_confirmed', isKill: false });
          }
          if (nextHull <= 0) {
            asteroidMap.delete(ast.id);
            nextExplosions.push({
              id: `ast-${tick}-${ast.id}`,
              position: ast.position,
              radius: ast.radius * 1.15,
              elapsed: 0,
              duration: 1.1,
              tint: 'amber',
            });
          } else {
            asteroidMap.set(ast.id, { ...ast, hull: nextHull });
            nextExplosions.push({
              id: `asthit-${tick}-${proj.id}`,
              position: impact,
              radius: 6,
              elapsed: 0,
              duration: 0.25,
              tint: 'amber',
            });
          }
        }
      }
    } else {
      const wall = sweepArena(proj.position, nextPos, arena, 0);
      const wallT = wall?.t ?? Infinity;
      const relToPlayer = relativePath(proj.position, nextPos, playerStart, player.position);
      const playerHitT = segmentSphereEntry(relToPlayer.a, relToPlayer.b, ORIGIN, SHIP_STATS.player.hitRadius);
      const carrierPad = { x: 4, y: 4, z: 4 };
      const carrierHitT = segmentBoxEntry(
        proj.position,
        nextPos,
        friendlyCarrier.position,
        friendlyCarrier.orientation,
        add(friendlyCarrier.halfExtents, carrierPad),
      );
      const terrainT = terrainEntry === null ? null : terrainEntry(proj.position, nextPos);
      // Walls and terrain are both cover: whichever the bolt meets first stops it.
      const coverT = Math.min(wallT, terrainT ?? Infinity);
      const playerT = playerHitT !== null && playerHitT < coverT ? playerHitT : null;
      const carrierT = carrierHitT !== null && carrierHitT < coverT ? carrierHitT : null;
      if (wall !== null && wallT <= (terrainT ?? Infinity) && playerT === null && carrierT === null) {
        hit = true;
        nextExplosions.push(wallImpact(tick, proj, lerpVec3(proj.position, nextPos, wall.t)));
      } else if (playerT !== null && (carrierT === null || playerT <= carrierT)) {
        hit = true;
        player = damagePlayer(player, proj.damage);
        events.push({ kind: 'player_damaged' });
      } else if (carrierT !== null) {
        hit = true;
        friendlyCarrier = {
          ...friendlyCarrier,
          hull: Math.max(0, friendlyCarrier.hull - proj.damage),
        };
        nextExplosions.push({
          id: `carhit-${tick}-${proj.id}`,
          position: lerpVec3(proj.position, nextPos, carrierT),
          radius: 10,
          elapsed: 0,
          duration: 0.36,
          tint: 'amber',
        });
      } else if (terrainT !== null) {
        hit = true;
        nextExplosions.push({
          id: `dirt-${tick}-${proj.id}`,
          position: lerpVec3(proj.position, nextPos, terrainT),
          radius: proj.kind === 'flak' ? 10 : 4,
          elapsed: 0,
          duration: 0.3,
          tint: proj.kind === 'flak' ? 'emerald' : 'amber',
        });
      } else if (proj.kind === 'bolt' && flyingDaringly(player)) {
        // The closest point falls strictly inside one segment per pass, so each bolt pays out once.
        const pass = segmentClosestApproach(relToPlayer.a, relToPlayer.b, ORIGIN);
        if (pass.t > 0 && pass.t < 1 && pass.distance <= COMBAT_TUNING.nearMissRadius) {
          const reward = nearMissReward(player, 'bolt');
          player = reward.player;
          events.push(reward.event);
        }
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

  const enemies = Array.from(enemyMap.values());
  const asteroids = Array.from(asteroidMap.values());
  const hostileFrigate = hostileFrigateInput === null ? null : { ...hostileFrigateInput, subsystems };
  if (
    player.nearMissCooldown <= 0 &&
    isBuzzing(player, enemies, asteroids, hostileFrigate === null ? [friendlyCarrier] : [friendlyCarrier, hostileFrigate], arena)
  ) {
    const reward = nearMissReward(player, 'buzz');
    player = reward.player;
    events.push(reward.event);
  }

  return {
    player,
    enemies,
    friendlyCarrier,
    hostileFrigate,
    reactors,
    asteroids,
    projectiles: survivingProjectiles,
    explosions: nextExplosions,
    radio,
    enemiesDestroyedDelta,
    subsystemsDestroyedDelta,
    reactorsDestroyedDelta,
    groundTargets,
    groundTargetsDestroyedDelta,
    rngState: rng,
    events,
  };
}

export function stepCombat(ctx: CombatStepInput): CombatStepOutput {
  const decayedRadio: RadioMessage | null =
    ctx.radio !== null && ctx.radio.remainingSeconds > ctx.dt
      ? { ...ctx.radio, remainingSeconds: ctx.radio.remainingSeconds - ctx.dt }
      : null;

  const groundTargets = ctx.groundTargets ?? [];
  const weaponStep = stepPlayerWeapons(
    ctx.tick,
    ctx.player,
    ctx.enemies,
    ctx.hostileFrigate,
    ctx.reactors,
    groundTargets,
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
    ctx.reactors,
    ctx.arena,
    ctx.wingmateObstacles ?? [],
    decayedRadio,
    ctx.dt,
  );

  const hitStep = stepProjectilesAndHits(
    ctx.tick,
    agentStep.rngState,
    weaponStep.player,
    ctx.playerStartPosition ?? ctx.player.position,
    agentStep.wingmate.callsign,
    new Map(ctx.enemies.map((e) => [e.id, e.position])),
    agentStep.enemies,
    ctx.friendlyCarrier,
    ctx.hostileFrigate,
    ctx.reactors,
    ctx.arena,
    ctx.asteroids,
    [...ctx.projectiles, ...weaponStep.spawned, ...agentStep.spawned],
    ctx.explosions,
    agentStep.radio,
    groundTargets,
    ctx.terrainEntry ?? null,
    ctx.groundSpeaker ?? 'GROUND',
    ctx.dt,
  );

  let player = hitStep.player;
  const finalTargetValid =
    player.selectedTargetId !== null &&
    findTargetContact(player.selectedTargetId, hitStep.enemies, hitStep.hostileFrigate, hitStep.reactors, hitStep.groundTargets) !== null;
  if (!finalTargetValid) {
    const remainingContacts = listHostileContacts(hitStep.enemies, hitStep.hostileFrigate, hitStep.reactors, hitStep.groundTargets);
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
      targetPinned: false,
      lockState: { kind: 'none' },
    };
  }

  let wingmate = agentStep.wingmate;
  if (
    wingmate.targetId !== null &&
    findTargetContact(wingmate.targetId, hitStep.enemies, hitStep.hostileFrigate, hitStep.reactors) === null
  ) {
    wingmate = { ...wingmate, targetId: null };
  }

  return {
    player,
    wingmate,
    enemies: hitStep.enemies,
    friendlyCarrier: hitStep.friendlyCarrier,
    hostileFrigate: hitStep.hostileFrigate,
    reactors: hitStep.reactors,
    asteroids: hitStep.asteroids,
    projectiles: hitStep.projectiles,
    explosions: hitStep.explosions,
    radio: hitStep.radio,
    enemiesDestroyedDelta: hitStep.enemiesDestroyedDelta,
    subsystemsDestroyedDelta: hitStep.subsystemsDestroyedDelta,
    reactorsDestroyedDelta: hitStep.reactorsDestroyedDelta,
    groundTargets: hitStep.groundTargets,
    groundTargetsDestroyedDelta: hitStep.groundTargetsDestroyedDelta,
    rngState: hitStep.rngState,
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
  const up = upOf(player.orientation);

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

  // Honest manual aim on LMB: zero gimbal bending toward the lead point.
  const maxBoltReach = COMBAT_TUNING.boltSpeed * COMBAT_TUNING.boltTtl;
  const convergenceRange =
    target !== null
      ? clamp(distance(player.position, target.position), 30, maxBoltReach)
      : 300;
  const convergencePoint = add(player.position, scale(playerForward, convergenceRange));

  const barrels = ([-1, 1] as const).map((side) => {
    const muzzle = add(
      add(player.position, scale(playerForward, FIGHTER_WEAPON_LAYOUT.muzzleForward)),
      add(
        scale(right, side * FIGHTER_WEAPON_LAYOUT.muzzleX),
        scale(up, FIGHTER_WEAPON_LAYOUT.muzzleY),
      ),
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
  hostileFrigate: CapitalShipState | null,
  subsystems: readonly SubsystemState[],
  reactors: readonly ReactorState[],
  groundTargets: readonly GroundTargetState[],
): Vec3 | null {
  const enemy = enemyMap.get(targetId);
  if (enemy !== undefined) {
    return enemy.position;
  }
  const subsys = subsystems.find((s) => s.id === targetId && s.hull > 0);
  if (subsys !== undefined && hostileFrigate !== null) {
    return subsystemWorldPosition(hostileFrigate, subsys);
  }
  const reactor = reactors.find((r) => r.id === targetId && r.hull > 0);
  if (reactor !== undefined) {
    return reactor.position;
  }
  return groundTargets.find((g) => g.id === targetId && g.hull > 0)?.position ?? null;
}

function pickWingmateTarget(
  player: PlayerShipState,
  enemies: readonly EnemyShipState[],
  hostileFrigate: CapitalShipState | null,
  reactors: readonly ReactorState[],
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
  const contacts = listHostileContacts(enemies, hostileFrigate, reactors);
  return contacts[0] ?? null;
}

function stepWingmate(
  tick: number,
  wingmate: WingmateState,
  player: PlayerShipState,
  enemies: readonly EnemyShipState[],
  hostileFrigate: CapitalShipState | null,
  reactors: readonly ReactorState[],
  arena: readonly ArenaSolid[],
  obstacles: readonly ArenaSolid[],
  dt: number,
): {
  readonly wingmate: WingmateState;
  readonly projectile: ProjectileState | null;
  readonly callout: string | null;
} {
  let target = findTargetContact(wingmate.targetId, enemies, hostileFrigate, reactors);
  let callout: string | null = null;
  if (target === null) {
    target = pickWingmateTarget(player, enemies, hostileFrigate, reactors);
    if (target !== null && tick > 60 && tick % 240 === 0) {
      callout = `Covering your six—suppressing ${target.label}.`;
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
  const playerSpeed = len(player.velocity);
  const speed = target !== null ? 92 : clamp(playerSpeed + dist * 0.45, 45, 130);
  const steerDir = steerClearOfArena(
    wingmate.position,
    forwardOf(wingmate.orientation),
    desiredDir,
    Math.max(COMBAT_TUNING.avoidMinLookahead, speed * COMBAT_TUNING.avoidLookaheadSeconds),
    obstacles.length === 0 ? arena : arena.length === 0 ? obstacles : [...arena, ...obstacles],
    WINGMATE_HULL_PAD + 4,
  );
  const targetQuat = quatLookAt(steerDir);
  const orientation = slerpQuat(wingmate.orientation, targetQuat, clamp(dt * 3.0, 0, 1));
  const desiredVelocity = lerpVec3(
    wingmate.velocity,
    scale(forwardOf(orientation), speed),
    clamp(dt * 3.5, 0, 1),
  );
  const moved = moveThroughArena(
    wingmate.position,
    add(wingmate.position, scale(desiredVelocity, dt)),
    desiredVelocity,
    arena,
    WINGMATE_HULL_PAD,
    0,
    FLIGHT_TUNING.wallMinSeparation,
  );
  const position = moved.position;
  const velocity = moved.velocity;

  let fireCooldown = Math.max(0, wingmate.fireCooldown - dt);
  let projectile: ProjectileState | null = null;
  if (
    target !== null &&
    fireCooldown <= 0 &&
    dist < 460 &&
    dist > 100 &&
    dot(forwardOf(orientation), desiredDir) > 0.94 &&
    clearShot(position, target, arena)
  ) {
    const lead = computeLeadPoint(
      position,
      velocity,
      target.position,
      target.velocity,
      COMBAT_TUNING.wingmateBoltSpeed,
      0.9,
    );
    if (lead !== null) {
      fireCooldown = 1.35;
      const shotDir = normalize(sub(lead, position));
      projectile = {
        id: `wb-${tick}`,
        kind: 'bolt',
        faction: 'friendly',
        owner: 'wingmate',
        position: add(position, scale(shotDir, 6)),
        velocity: add(velocity, scale(shotDir, COMBAT_TUNING.wingmateBoltSpeed)),
        targetId: null,
        damage: 5,
        ttl: 0.9,
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

/**
 * Enemy gunnery error (rad). Straight, slow flight is easy to hit; speed, crossing the shooter's
 * line of sight, hard turns and Overdrive each widen the spread.
 */
export function enemyAimError(player: PlayerShipState, shooterPos: Vec3): number {
  const toPlayer = sub(player.position, shooterPos);
  const dist = Math.max(len(toPlayer), 1);
  const los = scale(toPlayer, 1 / dist);
  const crossingRate = len(sub(player.velocity, scale(los, dot(player.velocity, los)))) / dist;
  const speedFactor = clamp(
    (len(player.velocity) - 60) / (FLIGHT_TUNING.overdriveSpeed - 60),
    0,
    1,
  );
  return (
    COMBAT_TUNING.enemyAimBaseError +
    COMBAT_TUNING.enemyAimSpeedError * speedFactor +
    COMBAT_TUNING.enemyAimCrossingError * crossingRate +
    COMBAT_TUNING.enemyAimTurnError * len(player.angularVelocity) +
    (player.energy.overdrive ? COMBAT_TUNING.enemyAimOverdriveError : 0)
  );
}

function deflect(direction: Vec3, angle: number, spin: number): Vec3 {
  const reference = Math.abs(direction.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = normalize(cross(direction, reference));
  const v = cross(direction, u);
  const offset = add(scale(u, Math.cos(spin)), scale(v, Math.sin(spin)));
  return normalize(add(direction, scale(offset, Math.tan(angle))));
}

function stepEnemyAi(
  tick: number,
  rngState: number,
  enemy: EnemyShipState,
  player: PlayerShipState,
  friendlyCarrier: CapitalShipState,
  arena: readonly ArenaSolid[],
  weaponsFree: boolean,
  holdsAttackToken: boolean,
  dt: number,
): {
  readonly enemy: EnemyShipState;
  readonly projectile: ProjectileState | null;
  readonly atPlayer: boolean;
  readonly rngState: number;
} {
  let nextRng = rngState;
  const roll = (): number => {
    const r = nextRandom(nextRng);
    nextRng = r.nextState;
    return r.value;
  };
  const stats = SHIP_STATS.enemies[enemy.kind];
  const regen = regenShield(enemy.shields, enemy.maxShields, enemy.shieldRegenDelay, stats.shieldRegenPerSecond, dt);
  const shieldHitFlash = Math.max(0, enemy.shieldHitFlash - dt * 3.8);

  const toPlayer = sub(player.position, enemy.position);
  const distToPlayer = len(toPlayer);
  const dirToPlayer = distToPlayer > 1 ? scale(toPlayer, 1 / distToPlayer) : forwardOf(enemy.orientation);
  const toCarrier = sub(friendlyCarrier.position, enemy.position);
  const distToCarrier = len(toCarrier);
  const dirToCarrier = distToCarrier > 1 ? scale(toCarrier, 1 / distToCarrier) : forwardOf(enemy.orientation);

  // Behind the player, the line from enemy to player points along the player's nose.
  const onPlayerTail = enemy.kind === 'raider' && dot(forwardOf(player.orientation), dirToPlayer) > 0.25;

  let maneuver: EnemyManeuver = enemy.maneuver;
  let goalDir: Vec3;

  if (maneuver.kind === 'patrol') {
    const provoked =
      distToPlayer < COMBAT_TUNING.patrolAggroRange || enemy.shields < enemy.maxShields || enemy.hull < enemy.maxHull;
    if (provoked) {
      maneuver = { kind: 'approach', remainingSeconds: COMBAT_TUNING.enemyApproachSeconds };
      goalDir = dirToPlayer;
    } else {
      const time = tick / 60 + enemy.phaseOffset;
      const orbit = COMBAT_TUNING.patrolOrbitRadius;
      const anchor = add(maneuver.post, {
        x: Math.sin(time * 0.6) * orbit,
        y: Math.sin(time * 0.45) * orbit * 0.3,
        z: Math.cos(time * 0.6) * orbit,
      });
      goalDir = normalize(sub(anchor, enemy.position));
    }
  } else if (maneuver.kind === 'approach') {
    const remainingSeconds = Math.max(0, maneuver.remainingSeconds - dt);
    const tooClose =
      enemy.kind === 'striker'
        ? distToCarrier < 210
        : distToPlayer < COMBAT_TUNING.enemyMinApproachDistance;
    // Hold a tail position; otherwise break away on overshoot or when the attack run times out.
    const shouldBreak = tooClose || (remainingSeconds <= 0 && !onPlayerTail);
    if (shouldBreak) {
      const r = roll();
      const sideSign = r >= 0.5 ? 1 : -1;
      const refDir = enemy.kind === 'striker' ? dirToCarrier : dirToPlayer;
      const away = scale(refDir, -1);
      const lateral = normalize(cross(away, { x: 0, y: 1, z: 0 }));
      const escapeDir = normalize(
        add(add(scale(away, 0.65), scale(lateral, sideSign * 0.76)), {
          x: 0,
          y: (r - 0.5) * 0.6,
          z: 0,
        }),
      );
      maneuver = {
        kind: 'break_away',
        escapeDir,
        remainingSeconds: COMBAT_TUNING.enemyBreakAwaySeconds + r * 0.9,
      };
      goalDir = escapeDir;
    } else {
      maneuver = { kind: 'approach', remainingSeconds };
      const time = tick / 60 + enemy.phaseOffset;
      const evasiveJink = enemy.shieldHitFlash > 0.35 ? 1.8 : 1.0;
      const anchor =
        enemy.kind === 'raider'
          ? add(player.position, {
              x: Math.sin(time * 0.95) * 58 * evasiveJink,
              y: Math.cos(time * 0.75) * 34 * evasiveJink,
              z: Math.cos(time * 0.95) * 58 * evasiveJink,
            })
          : add(friendlyCarrier.position, {
              x: Math.cos(time * 0.45) * 120,
              y: 40 + Math.sin(time * 0.6) * 35,
              z: Math.sin(time * 0.45) * 120,
            });
      goalDir = normalize(sub(anchor, enemy.position));
    }
  } else {
    const remainingSeconds = maneuver.remainingSeconds - dt;
    const minReengageDist = enemy.kind === 'striker' ? 300 : 250;
    const currentDist = enemy.kind === 'striker' ? distToCarrier : distToPlayer;
    if ((remainingSeconds <= 0 && currentDist > minReengageDist) || remainingSeconds <= -1.0) {
      maneuver = { kind: 'approach', remainingSeconds: COMBAT_TUNING.enemyApproachSeconds };
    } else {
      maneuver = {
        kind: 'break_away',
        escapeDir: maneuver.escapeDir,
        remainingSeconds,
      };
    }
    goalDir =
      maneuver.kind === 'break_away'
        ? maneuver.escapeDir
        : enemy.kind === 'striker'
          ? dirToCarrier
          : dirToPlayer;
  }

  const cruiseSpeed =
    maneuver.kind === 'break_away' ? stats.breakAwaySpeed : maneuver.kind === 'patrol' ? stats.approachSpeed * 0.6 : stats.approachSpeed;
  const hullPad = stats.hitRadius + COMBAT_TUNING.aiHullClearance;
  goalDir = steerClearOfArena(
    enemy.position,
    forwardOf(enemy.orientation),
    goalDir,
    Math.max(COMBAT_TUNING.avoidMinLookahead, cruiseSpeed * COMBAT_TUNING.avoidLookaheadSeconds),
    arena,
    hullPad + 4,
  );
  if (maneuver.kind === 'break_away' && arena.length > 0) {
    // Remember the bent heading, or the next tick steers straight back at the wall.
    maneuver = { ...maneuver, escapeDir: goalDir };
  }
  const targetQuat = quatLookAt(goalDir);
  const orientation = slerpQuat(enemy.orientation, targetQuat, clamp(dt * stats.turnRate, 0, 1));
  const desiredVelocity = lerpVec3(enemy.velocity, scale(forwardOf(orientation), cruiseSpeed), clamp(dt * 2.8, 0, 1));
  const moved = moveThroughArena(
    enemy.position,
    add(enemy.position, scale(desiredVelocity, dt)),
    desiredVelocity,
    arena,
    hullPad,
    0,
    FLIGHT_TUNING.wallMinSeparation,
  );
  const position = moved.position;
  const velocity = moved.velocity;

  let fireCooldown = Math.max(0, enemy.fireCooldown - dt);
  let projectile: ProjectileState | null = null;
  let atPlayer = false;
  const nose = forwardOf(orientation);

  if (weaponsFree && maneuver.kind === 'approach' && fireCooldown <= 0) {
    if (enemy.kind === 'striker') {
      if (
        distToCarrier > stats.fireRangeMin &&
        distToCarrier < stats.fireRangeMax &&
        dot(nose, dirToCarrier) > 0.88 &&
        hasLineOfSight(position, friendlyCarrier.position, arena)
      ) {
        const r = roll();
        fireCooldown = 1.05 + r * 0.55;
        const spread = (r - 0.5) * 0.03;
        const shotDir = normalize(add(dirToCarrier, { x: spread, y: -spread * 0.5, z: 0 }));
        projectile = {
          id: `eb-${tick}-${enemy.id}`,
          kind: 'bolt',
          faction: 'hostile',
          owner: 'hostile',
          position: add(position, scale(shotDir, 8)),
          velocity: add(velocity, scale(shotDir, COMBAT_TUNING.enemyBoltSpeed)),
          targetId: null,
          damage: COMBAT_TUNING.enemyCarrierDamage,
          ttl: 1.9,
        };
      }
    } else if (
      holdsAttackToken &&
      distToPlayer > stats.fireRangeMin &&
      distToPlayer < stats.fireRangeMax &&
      dot(nose, dirToPlayer) > 0.88 &&
      hasLineOfSight(position, player.position, arena)
    ) {
      const lead = computeLeadPoint(
        position,
        velocity,
        player.position,
        player.velocity,
        COMBAT_TUNING.enemyBoltSpeed,
        1.7,
      );
      fireCooldown = 0.85 + roll() * 0.55;
      const aimDir = lead !== null ? normalize(sub(lead, position)) : dirToPlayer;
      const errorAngle = enemyAimError(player, position) * Math.sqrt(roll());
      const shotDir = deflect(aimDir, errorAngle, roll() * Math.PI * 2);
      atPlayer = true;
      projectile = {
        id: `eb-${tick}-${enemy.id}`,
        kind: 'bolt',
        faction: 'hostile',
        owner: 'hostile',
        position: add(position, scale(shotDir, 7)),
        velocity: add(velocity, scale(shotDir, COMBAT_TUNING.enemyBoltSpeed)),
        targetId: null,
        damage: COMBAT_TUNING.enemyBoltDamage,
        ttl: 1.7,
      };
    }
  }

  return {
    enemy: {
      ...enemy,
      position,
      velocity,
      orientation,
      maneuver,
      shields: regen.shield,
      shieldRegenDelay: regen.regenDelay,
      shieldHitFlash,
      fireCooldown,
    },
    projectile,
    atPlayer,
    rngState: nextRng,
  };
}
