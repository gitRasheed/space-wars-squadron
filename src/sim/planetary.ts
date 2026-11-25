import { COMBAT_TUNING } from './combat';
import { damagePlayer } from './flight';
import { add, clamp, computeLeadPoint, cross, distance, dot, len, nextRandom, normalize, quatLookAt, scale, sub, vec3 } from './math';
import {
  AIR_WAVE,
  CONVOY_MAX_ADVANCE,
  FORWARD_OUTPOST,
  GROUND_TARGET_PLACEMENTS,
  GROUND_TARGET_SPECS,
  PLANETARY_TUNING,
  segmentTerrainEntry,
  TERRAIN_BOXES,
  terrainHeightAt,
} from './planetaryLayout';
import { SHIP_STATS } from './ships';
import type {
  CapitalShipState,
  EnemyShipState,
  ExplosionState,
  GroundTargetState,
  PlanetaryState,
  PlayerShipState,
  ProjectileState,
  RadioMessage,
  SimEvent,
  Vec3,
  WingmateState,
} from './types';

export const GROUND_SPEAKER = 'GRIT ACTUAL';
export const OUTPOST_LOST_REASON = 'FORWARD OUTPOST OVERRUN';
const UP: Vec3 = { x: 0, y: 1, z: 0 };

export function createGroundTargets(destroyedIds: ReadonlySet<string> = new Set()): readonly GroundTargetState[] {
  return GROUND_TARGET_PLACEMENTS.map((placement) => {
    const spec = GROUND_TARGET_SPECS[placement.kind];
    const ground = terrainHeightAt(placement.x, placement.z);
    return {
      id: placement.id,
      kind: placement.kind,
      label: spec.label,
      position: vec3(placement.x, ground + spec.centerHeight, placement.z),
      hull: destroyedIds.has(placement.id) ? 0 : spec.hull,
      maxHull: spec.hull,
      hitRadius: spec.hitRadius,
      shieldedBy: placement.shieldedBy,
      shieldHitFlash: 0,
      fireCooldown: PLANETARY_TUNING.flakCycleSeconds * 0.5 + placement.phase,
      charge: 0,
      // Walkers face down the road toward the outpost (+z).
      heading: 0,
    };
  });
}

export function spawnAirWave(): readonly EnemyShipState[] {
  return AIR_WAVE.map((spec) => {
    const stats = SHIP_STATS.enemies[spec.kind];
    const velocity = vec3(0, -42, 70);
    return {
      id: spec.id,
      callsign: spec.callsign,
      kind: spec.kind,
      position: spec.position,
      velocity,
      orientation: quatLookAt(normalize(velocity)),
      maneuver: { kind: 'approach', remainingSeconds: COMBAT_TUNING.enemyApproachSeconds },
      hull: stats.hull,
      maxHull: stats.hull,
      shields: stats.shields,
      maxShields: stats.shields,
      shieldRegenDelay: 0,
      shieldHitFlash: 0,
      fireCooldown: 1.6 + spec.phase * 0.15,
      phaseOffset: spec.phase,
    };
  });
}

export function createOutpost(): CapitalShipState {
  return {
    id: FORWARD_OUTPOST.id,
    name: FORWARD_OUTPOST.name,
    faction: 'friendly',
    position: FORWARD_OUTPOST.position,
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    halfExtents: FORWARD_OUTPOST.halfExtents,
    hull: FORWARD_OUTPOST.hull,
    maxHull: FORWARD_OUTPOST.hull,
    subsystems: [],
  };
}

export interface TerrainClearance {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly impactSpeed: number;
  readonly warning: boolean;
}

/** Pushes a point out of the floor and terraces along the shallowest axis and bounces its velocity off that face. */
export function resolveTerrainClearance(
  position: Vec3,
  velocity: Vec3,
  margin: number = PLANETARY_TUNING.terrainClearance,
): TerrainClearance {
  let pos = position;
  let vel = velocity;
  let impactSpeed = 0;

  const bounce = (normal: Vec3): void => {
    const inward = dot(vel, normal);
    if (inward < 0) {
      impactSpeed = Math.max(impactSpeed, -inward);
      vel = sub(vel, scale(normal, inward * (1 + PLANETARY_TUNING.terrainRestitution)));
    }
    const outward = dot(vel, normal);
    if (outward < PLANETARY_TUNING.terrainMinBounceSpeed) {
      vel = add(vel, scale(normal, PLANETARY_TUNING.terrainMinBounceSpeed - outward));
    }
  };

  if (pos.y < margin) {
    pos = { ...pos, y: margin };
    bounce(UP);
  }
  for (const terrace of TERRAIN_BOXES) {
    const local = sub(pos, terrace.center);
    const ex = terrace.halfExtents.x + margin;
    const ey = terrace.halfExtents.y + margin;
    const ez = terrace.halfExtents.z + margin;
    if (Math.abs(local.x) >= ex || Math.abs(local.y) >= ey || Math.abs(local.z) >= ez) continue;
    const penX = ex - Math.abs(local.x);
    const penY = ey - Math.abs(local.y);
    const penZ = ez - Math.abs(local.z);
    let normal: Vec3;
    let depth: number;
    if (penY <= penX && penY <= penZ) {
      normal = { x: 0, y: local.y >= 0 ? 1 : -1, z: 0 };
      depth = penY;
    } else if (penX <= penZ) {
      normal = { x: local.x >= 0 ? 1 : -1, y: 0, z: 0 };
      depth = penX;
    } else {
      normal = { x: 0, y: 0, z: local.z >= 0 ? 1 : -1 };
      depth = penZ;
    }
    pos = add(pos, scale(normal, depth + 0.05));
    bounce(normal);
  }

  const altitude = pos.y - terrainHeightAt(pos.x, pos.z);
  const ahead = add(pos, scale(vel, PLANETARY_TUNING.terrainLookAheadSeconds));
  const warning =
    altitude < PLANETARY_TUNING.terrainWarnAltitude ||
    ahead.y < terrainHeightAt(ahead.x, ahead.z) + PLANETARY_TUNING.terrainWarnAltitude * 0.5;
  return { position: pos, velocity: vel, impactSpeed, warning };
}

export function applyTerrainToPlayer(player: PlayerShipState): {
  readonly player: PlayerShipState;
  readonly warning: boolean;
  readonly events: readonly SimEvent[];
} {
  const clearance = resolveTerrainClearance(player.position, player.velocity);
  const moved: PlayerShipState = { ...player, position: clearance.position, velocity: clearance.velocity };
  if (clearance.impactSpeed <= PLANETARY_TUNING.terrainDamageThreshold) {
    return { player: moved, warning: clearance.warning, events: [] };
  }
  const damage = (clearance.impactSpeed - PLANETARY_TUNING.terrainDamageThreshold + 2) * PLANETARY_TUNING.terrainDamagePerSpeed;
  return { player: damagePlayer(moved, damage), warning: true, events: [{ kind: 'player_damaged' }] };
}

/** Flak shells burst on their fuse or beside the player, before the generic projectile pass would expire them. */
export function burstFlak(
  tick: number,
  projectiles: readonly ProjectileState[],
  playerInput: PlayerShipState,
  dt: number,
): {
  readonly projectiles: readonly ProjectileState[];
  readonly player: PlayerShipState;
  readonly explosions: readonly ExplosionState[];
  readonly events: readonly SimEvent[];
} {
  let player = playerInput;
  const remaining: ProjectileState[] = [];
  const explosions: ExplosionState[] = [];
  const events: SimEvent[] = [];
  for (const proj of projectiles) {
    if (proj.kind !== 'flak') {
      remaining.push(proj);
      continue;
    }
    const miss = distance(proj.position, player.position);
    if (proj.ttl - dt > 0 && miss > PLANETARY_TUNING.flakProximityFuse) {
      remaining.push(proj);
      continue;
    }
    events.push({ kind: 'flak_burst', position: proj.position });
    explosions.push({ id: `flak-${tick}-${proj.id}`, position: proj.position, radius: 5.5, elapsed: 0, duration: 0.45, tint: 'emerald' });
    if (miss < PLANETARY_TUNING.flakBurstRadius) {
      player = damagePlayer(player, proj.damage * (1 - miss / PLANETARY_TUNING.flakBurstRadius));
      events.push({ kind: 'player_damaged' });
    }
  }
  return { projectiles: remaining, player, explosions, events };
}

function hostileShot(id: string, from: Vec3, to: Vec3, speed: number, damage: number, kind: 'bolt' | 'flak'): ProjectileState {
  const dir = normalize(sub(to, from));
  return {
    id,
    kind,
    faction: 'hostile',
    owner: 'hostile',
    position: add(from, scale(dir, 4)),
    velocity: scale(dir, speed),
    targetId: null,
    damage,
    ttl: distance(from, to) / speed + (kind === 'flak' ? 0 : 0.5),
  };
}

/** Deterministic per-shot scatter ahead of and above the flight path; it uses no sim RNG, so replays stay identical. */
function barrageOffset(tick: number, id: string, player: PlayerShipState): Vec3 {
  let seed = tick * 7919;
  for (let i = 0; i < id.length; i += 1) seed = (Math.imul(seed, 31) + id.charCodeAt(i)) | 0;
  const draw = (): number => {
    const r = nextRandom(seed);
    seed = r.nextState;
    return r.value;
  };
  if (draw() < PLANETARY_TUNING.flakDirectShare) return vec3(0, 0, 0);
  const speed = len(player.velocity);
  const ahead = speed > 1 ? scale(player.velocity, 1 / speed) : vec3(0, 0, -1);
  const lateral = normalize(cross(ahead, UP));
  const [aheadMin, aheadMax] = PLANETARY_TUNING.flakLeadAhead;
  const [aboveMin, aboveMax] = PLANETARY_TUNING.flakLeadAbove;
  return add(
    add(scale(ahead, aheadMin + draw() * (aheadMax - aheadMin)), scale(lateral, (draw() * 2 - 1) * PLANETARY_TUNING.flakLeadSpread)),
    vec3(0, aboveMin + draw() * (aboveMax - aboveMin), 0),
  );
}

function stepGroundTarget(
  tick: number,
  target: GroundTargetState,
  player: PlayerShipState,
  outpost: CapitalShipState,
  dt: number,
): { readonly target: GroundTargetState; readonly shot: ProjectileState | null } {
  const decayed = { ...target, shieldHitFlash: Math.max(0, target.shieldHitFlash - dt * 3.8) };
  if (target.hull <= 0) {
    return { target: { ...decayed, charge: 0 }, shot: null };
  }
  const tuning = PLANETARY_TUNING;
  switch (target.kind) {
    case 'flak': {
      const muzzle = add(target.position, vec3(0, 4, 0));
      const canTrack =
        distance(muzzle, player.position) <= tuning.flakRange &&
        player.position.y - (target.position.y - GROUND_TARGET_SPECS.flak.centerHeight) >= tuning.flakMinAltitude &&
        segmentTerrainEntry(muzzle, player.position) === null;
      if (!canTrack) {
        const cooldown = Math.max(target.fireCooldown - dt, tuning.flakChargeSeconds);
        return { target: { ...decayed, fireCooldown: cooldown, charge: Math.max(0, target.charge - dt * 3) }, shot: null };
      }
      const cooldown = target.fireCooldown - dt;
      if (cooldown > 0) {
        const charge = cooldown < tuning.flakChargeSeconds ? 1 - cooldown / tuning.flakChargeSeconds : 0;
        return { target: { ...decayed, fireCooldown: cooldown, charge }, shot: null };
      }
      const intercept = computeLeadPoint(muzzle, vec3(0, 0, 0), player.position, player.velocity, tuning.flakShellSpeed, 3.5) ?? player.position;
      const lead = add(intercept, barrageOffset(tick, target.id, player));
      return {
        target: { ...decayed, fireCooldown: tuning.flakCycleSeconds, charge: 0 },
        shot: hostileShot(`fk-${tick}-${target.id}`, muzzle, lead, tuning.flakShellSpeed, tuning.flakBurstDamage, 'flak'),
      };
    }
    case 'walker': {
      const toOutpost = sub(outpost.position, target.position);
      const flat = vec3(toOutpost.x, 0, toOutpost.z);
      const range = len(flat);
      const dir = range > 1e-3 ? scale(flat, 1 / range) : vec3(0, 0, 1);
      const step = range > tuning.walkerStopDistance ? Math.min(tuning.walkerSpeed * dt, range - tuning.walkerStopDistance) : 0;
      const moved = add(target.position, scale(dir, step));
      const position = vec3(moved.x, terrainHeightAt(moved.x, moved.z) + GROUND_TARGET_SPECS.walker.centerHeight, moved.z);
      const heading = Math.atan2(dir.x, dir.z);
      if (range > tuning.walkerFireRange) {
        return { target: { ...decayed, position, heading, charge: 0 }, shot: null };
      }
      const cooldown = target.fireCooldown - dt;
      if (cooldown > 0) {
        return { target: { ...decayed, position, heading, fireCooldown: cooldown, charge: clamp(1 - cooldown / 0.4, 0, 1) }, shot: null };
      }
      return {
        target: { ...decayed, position, heading, fireCooldown: tuning.walkerFireInterval, charge: 0 },
        shot: hostileShot(`wk-${tick}-${target.id}`, add(position, vec3(0, 5, 0)), outpost.position, COMBAT_TUNING.enemyBoltSpeed, tuning.walkerBoltDamage, 'bolt'),
      };
    }
    case 'artillery': {
      const cooldown = target.fireCooldown - dt;
      if (cooldown > 0) {
        return { target: { ...decayed, fireCooldown: cooldown, charge: clamp(1 - cooldown, 0, 1) }, shot: null };
      }
      return {
        target: { ...decayed, fireCooldown: tuning.artilleryInterval, charge: 0 },
        shot: hostileShot(`ar-${tick}-${target.id}`, add(target.position, vec3(0, 10, 0)), outpost.position, tuning.artilleryShellSpeed, tuning.artilleryDamage, 'bolt'),
      };
    }
    case 'relay':
      return { target: decayed, shot: null };
  }
}

// Same push-out as the player with a wider margin, so an NPC slides along a cliff instead of popping onto the ledge.
function keepAboveGround<T extends { readonly position: Vec3; readonly velocity: Vec3 }>(ship: T): T {
  const clearance = resolveTerrainClearance(ship.position, ship.velocity, PLANETARY_TUNING.npcMinAltitude);
  if (clearance.position === ship.position) return ship;
  return { ...ship, position: clearance.position, velocity: clearance.velocity };
}

export interface GroundBattleInput {
  readonly tick: number;
  readonly planetary: PlanetaryState;
  readonly groundTargets: readonly GroundTargetState[];
  readonly groundTargetsDestroyedDelta: number;
  readonly terrainWarning: boolean;
  readonly player: PlayerShipState;
  readonly wingmate: WingmateState;
  readonly enemies: readonly EnemyShipState[];
  readonly outpost: CapitalShipState;
  readonly radio: RadioMessage | null;
  readonly dt: number;
}

export interface GroundBattleOutput {
  readonly planetary: PlanetaryState;
  readonly wingmate: WingmateState;
  readonly enemies: readonly EnemyShipState[];
  readonly spawned: readonly ProjectileState[];
  readonly radio: RadioMessage | null;
  readonly events: readonly SimEvent[];
}

/** Ground AI, NPC altitude floor, convoy advance and the ground-attack → air-superiority hand-off. */
export function stepGroundBattle(ctx: GroundBattleInput): GroundBattleOutput {
  const spawned: ProjectileState[] = [];
  const events: SimEvent[] = [];
  const groundTargets = ctx.groundTargets.map((target) => {
    const step = stepGroundTarget(ctx.tick, target, ctx.player, ctx.outpost, ctx.dt);
    if (step.shot !== null) spawned.push(step.shot);
    return step.target;
  });

  const destroyed = ctx.planetary.groundTargetsDestroyed + ctx.groundTargetsDestroyedDelta;
  const advanceGoal = (CONVOY_MAX_ADVANCE * destroyed) / groundTargets.length;
  const convoyAdvance = Math.min(advanceGoal, ctx.planetary.convoyAdvance + 14 * ctx.dt);

  let enemies = ctx.enemies.map(keepAboveGround);
  let radio = ctx.radio;
  let stage = ctx.planetary.stage;
  if (stage.kind === 'ground_attack' && destroyed >= PLANETARY_TUNING.airWaveThreshold) {
    stage = { kind: 'air_superiority', elapsedSeconds: 0 };
    enemies = [...enemies, ...spawnAirWave()];
    events.push({ kind: 'air_wave_inbound' });
    radio = {
      speaker: 'OVERWATCH',
      text: 'SCRAMBLE! Bandits diving through the cloud deck. Break and engage!',
      remainingSeconds: 4.5,
    };
  } else if (stage.kind === 'air_superiority') {
    stage = { kind: 'air_superiority', elapsedSeconds: stage.elapsedSeconds + ctx.dt };
  }

  return {
    planetary: { stage, groundTargets, groundTargetsDestroyed: destroyed, convoyAdvance, terrainWarning: ctx.terrainWarning },
    wingmate: keepAboveGround(ctx.wingmate),
    enemies,
    spawned,
    radio,
    events,
  };
}

/** Hostiles still standing between the player and victory, counting the air wave before it scrambles. */
export function remainingPlanetaryHostiles(planetary: PlanetaryState, enemies: readonly EnemyShipState[]): number {
  const ground = planetary.groundTargets.filter((target) => target.hull > 0).length;
  const pendingWave = planetary.stage.kind === 'ground_attack' ? AIR_WAVE.length : 0;
  return enemies.length + ground + pendingWave;
}
