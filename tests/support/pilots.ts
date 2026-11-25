import { COMBAT_TUNING, subsystemWorldPosition } from '../../src/sim/combat';
import {
  add,
  clamp,
  computeLeadPoint,
  distance,
  dot,
  forwardOf,
  len,
  nextRandom,
  normalize,
  rotateVec3,
  scale,
  segmentBoxEntry,
  sub,
  toLocalPoint,
} from '../../src/sim/math';
import {
  FIXED_DT,
  NEUTRAL_INPUT,
  type CapitalShipState,
  type FlightInput,
  type Vec3,
  type WorldState,
} from '../../src/sim/types';
import { createInitialWorld, stepWorld } from '../../src/sim/world';

export interface PilotMemory {
  readonly rng: number;
  readonly jitter: Vec3;
  readonly holdFire: boolean;
  /** Extending away from a static core to set up the next gun run. */
  readonly extending: boolean;
}

export type Pilot = (world: WorldState, memory: PilotMemory) => {
  readonly input: FlightInput;
  readonly memory: PilotMemory;
};

export interface SortieOutcome {
  readonly result: 'victory' | 'failed' | 'timeout';
  readonly reason: string;
  readonly seconds: number;
  readonly enemiesDestroyed: number;
  readonly subsystemsDestroyed: number;
  readonly hull: number;
  readonly minShield: number;
  readonly hitsTaken: number;
  readonly crits: number;
  readonly drops: number;
  readonly nearMisses: number;
  readonly incomingFire: number;
  readonly shotsFired: number;
  readonly hits: number;
}

export function flySortie(seed: number, pilot: Pilot, maxSeconds: number): SortieOutcome {
  let world = createInitialWorld(seed, true);
  let memory: PilotMemory = { rng: seed ^ 0x5eed, jitter: { x: 0, y: 0, z: 0 }, holdFire: false, extending: false };
  let shotsFired = 0;
  let hits = 0;
  let minShield = world.player.energy.shieldCharge;
  let hitsTaken = 0;
  let crits = 0;
  let drops = 0;
  let nearMisses = 0;
  let incomingFire = 0;
  for (let tick = 0; tick < maxSeconds * 60; tick += 1) {
    const decision = pilot(world, memory);
    memory = decision.memory;
    world = stepWorld(world, decision.input, FIXED_DT);
    for (const event of world.events) {
      if (event.kind === 'cannon_fired' && event.faction === 'friendly') shotsFired += 1;
      if (event.kind === 'hit_confirmed') hits += 1;
      if (event.kind === 'player_damaged') hitsTaken += 1;
      if (event.kind === 'crit_hit') crits += 1;
      if (event.kind === 'supply_drop') drops += 1;
      if (event.kind === 'near_miss') nearMisses += 1;
      if (event.kind === 'incoming_fire') incomingFire += 1;
    }
    minShield = Math.min(minShield, world.player.energy.shieldCharge);
    if (world.phase.kind !== 'active') break;
  }
  const phase = world.phase;
  return {
    result: phase.kind === 'victory' || phase.kind === 'failed' ? phase.kind : 'timeout',
    reason: phase.kind === 'failed' ? phase.reason : '',
    seconds: phase.kind === 'active' || phase.kind === 'paused' || phase.kind === 'victory' || phase.kind === 'failed'
      ? Math.round(phase.elapsedSeconds * 10) / 10
      : 0,
    enemiesDestroyed: world.enemiesDestroyed,
    subsystemsDestroyed: world.subsystemsDestroyed,
    hull: Math.round(world.player.hull),
    minShield: Math.round(minShield),
    hitsTaken,
    crits,
    drops,
    nearMisses,
    incomingFire,
    shotsFired,
    hits,
  };
}

export const afkPilot: Pilot = (_world, memory) => ({ input: NEUTRAL_INPUT, memory });

interface AimGoal {
  readonly point: Vec3;
  readonly attack: boolean;
}

function chooseGoal(world: WorldState, extending: boolean): (AimGoal & { readonly extending: boolean }) | null {
  const player = world.player;
  let nearest = null as (typeof world.enemies)[number] | null;
  for (const enemy of world.enemies) {
    if (nearest === null || distance(enemy.position, player.position) < distance(nearest.position, player.position)) {
      nearest = enemy;
    }
  }
  if (nearest !== null) {
    const lead = computeLeadPoint(
      player.position,
      player.velocity,
      nearest.position,
      nearest.velocity,
      COMBAT_TUNING.boltSpeed,
      COMBAT_TUNING.boltTtl,
    );
    return { point: lead ?? nearest.position, attack: true, extending: false };
  }
  const frigate = world.hostileFrigate;
  const subsystem = frigate.subsystems.find((s) => s.hull > 0);
  if (subsystem === undefined) return null;
  const core = subsystemWorldPosition(frigate, subsystem);
  // Attack each core from its exposed side; the hull blocks shots through it.
  const exposed = normalize(rotateVec3(frigate.orientation, { x: 0, y: Math.sign(subsystem.localOffset.y), z: 0 }));
  const fromCore = sub(player.position, core);
  const coreDist = len(fromCore);
  const onExposedSide = dot(fromCore, exposed) > 0.55 * coreDist;
  const keepExtending = extending ? coreDist < 420 : coreDist < 140;
  if (keepExtending || !onExposedSide) {
    return { point: add(core, scale(exposed, 420)), attack: false, extending: keepExtending };
  }
  return { point: core, attack: true, extending: false };
}

function padded(ship: CapitalShipState, pad: number): Vec3 {
  return add(ship.halfExtents, { x: pad, y: pad, z: pad });
}

/** Detour around a capital ship's flank when the straight path to `point` would cross its hull. */
function routeAround(world: WorldState, point: Vec3): Vec3 {
  const from = world.player.position;
  for (const ship of [world.friendlyCarrier, world.hostileFrigate]) {
    if (segmentBoxEntry(from, point, ship.position, ship.orientation, padded(ship, 40)) !== null) {
      const local = toLocalPoint(ship.position, ship.orientation, from);
      const side = rotateVec3(ship.orientation, { x: local.x >= 0 ? 1 : -1, y: 0, z: 0 });
      return add(ship.position, scale(side, ship.halfExtents.x + 180));
    }
  }
  return point;
}

function avoidObstacles(world: WorldState, desired: Vec3): Vec3 {
  const player = world.player;
  const forward = forwardOf(player.orientation);
  const lookAhead = add(player.position, scale(forward, 170));
  for (const ship of [world.friendlyCarrier, world.hostileFrigate]) {
    if (segmentBoxEntry(player.position, lookAhead, ship.position, ship.orientation, padded(ship, 30)) !== null) {
      return normalize(add(normalize(sub(player.position, ship.position)), forward));
    }
  }
  for (const rock of world.asteroids) {
    const toCenter = sub(rock.position, player.position);
    const along = dot(toCenter, forward);
    const radius = rock.radius + 24;
    if (along < 0 || along > 160 + radius) continue;
    const closest = sub(toCenter, scale(forward, along));
    const miss = len(closest);
    if (miss < radius) {
      const away = miss > 1e-3 ? scale(closest, -1 / miss) : { x: 0, y: 1, z: 0 };
      return normalize(add(scale(away, 2.5), forward));
    }
  }
  return desired;
}

/** A cannon-only pilot that tracks the lead point and fires only inside `fireConeDeg`. */
export function cannonPilot(fireConeDeg: number, burstFloor = 22, burstResume = 55): Pilot {
  const fireConeCos = Math.cos((fireConeDeg * Math.PI) / 180);
  return (world, memory) => {
    let { rng, jitter, holdFire } = memory;
    const { extending } = memory;
    if (world.tick % 15 === 0) {
      const a = nextRandom(rng);
      const b = nextRandom(a.nextState);
      const c = nextRandom(b.nextState);
      rng = c.nextState;
      jitter = scale({ x: a.value - 0.5, y: b.value - 0.5, z: c.value - 0.5 }, 0.02);
    }
    const player = world.player;
    const goal = chooseGoal(world, extending);
    if (goal === null) {
      return { input: NEUTRAL_INPUT, memory: { rng, jitter, holdFire, extending } };
    }
    const toGoal = sub(goal.attack ? goal.point : routeAround(world, goal.point), player.position);
    const goalDist = len(toGoal);
    const aimDir = normalize(add(scale(toGoal, 1 / Math.max(goalDist, 1)), jitter));
    const steerDir = avoidObstacles(world, aimDir);
    const local = toLocalPoint({ x: 0, y: 0, z: 0 }, player.orientation, steerDir);
    const yawError = Math.atan2(local.x, -local.z);
    const pitchError = Math.atan2(local.y, -local.z);

    const charge = player.energy.weaponCharge;
    if (charge < burstFloor) holdFire = true;
    else if (charge >= burstResume) holdFire = false;
    const aligned = dot(forwardOf(player.orientation), aimDir) >= fireConeCos;
    const inRange = goalDist < COMBAT_TUNING.boltSpeed * COMBAT_TUNING.boltTtl * 0.92;
    const desiredThrottle = goalDist < 160 ? 0.55 : 0.85;

    return {
      input: {
        ...NEUTRAL_INPUT,
        yaw: clamp(yawError * 5, -1, 1),
        pitch: clamp(pitchError * 5, -1, 1),
        throttleDelta: Math.sign(desiredThrottle - player.throttle),
        firePrimary: goal.attack && aligned && inRange && !holdFire,
      },
      memory: { rng, jitter, holdFire, extending: goal.extending },
    };
  };
}

/** A pilot that never shoots and only weaves at full throttle, tapping into Overdrive when asked and shields allow. */
export function evasivePilot(useOverdrive: boolean): Pilot {
  return (world, memory) => {
    const t = world.tick * FIXED_DT;
    const player = world.player;
    const atDetent = player.throttle >= 0.995;
    const wantOverdrive = useOverdrive && atDetent && !player.energy.overdrive && player.energy.shieldCharge > 60;
    return {
      input: {
        ...NEUTRAL_INPUT,
        yaw: Math.sin(t * 1.3) * 0.8,
        pitch: Math.sin(t * 0.9 + 1) * 0.6,
        throttleDelta: 1,
        throttlePushEdge: wantOverdrive && world.tick % 2 === 0,
      },
      memory,
    };
  };
}
