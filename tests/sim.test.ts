import { describe, expect, it } from 'vitest';
import {
  COMBAT_TUNING,
  critChance,
  critMultiplier,
  enemyAimError,
  isInsideCapitalBox,
  resolveTargetSelection,
  selectNextTarget,
  stepCombat,
  subsystemWorldPosition,
  type TargetContact,
} from '../src/sim/combat';
import { addWeaponHeat, createInitialEnergy, ENERGY_RULES, stepEnergy } from '../src/sim/energy';
import { FLIGHT_TUNING, resolveObstacleClearance } from '../src/sim/flight';
import { add, dot, len, nextRandom, normalize, quatFromAxisAngle, quatLookAt, rotateVec3, scale, segmentClosestApproach, sub, vec3 } from '../src/sim/math';
import { SHIP_STATS } from '../src/sim/ships';
import {
  DEFAULT_SORTIE_SEED,
  FIXED_DT,
  HULL_CRITICAL_FRACTION,
  NEUTRAL_INPUT,
  type CapitalShipState,
  type EnemyShipState,
  type FlightInput,
  type ProjectileState,
  type SortieConfig,
  type Vec3,
  type WorldState,
} from '../src/sim/types';
import { createInitialWorld, DEFAULT_SORTIE_CONFIG, stepFrame, stepWorld } from '../src/sim/world';
import { frigateOf } from './support/levels';
import { afkPilot, cannonPilot, evasivePilot, flySortie, type Pilot } from './support/pilots';

describe('throttle overdrive and weapon overheat kernel', () => {
  it('stops throttle at 100% high-watermark while holding W, enters 120% Overdrive on second W press draining shields, and drops cleanly on S or 0 shields', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    world = { ...world, enemies: [], asteroids: [] };

    // Hold W continuously without a second press: climbs to 1.00 and stops cleanly at the detent.
    for (let i = 0; i < 60; i += 1) {
      world = stepWorld(
        world,
        { ...NEUTRAL_INPUT, throttleDelta: 1, throttlePushEdge: i === 0 },
        FIXED_DT,
      );
    }
    expect(world.player.throttle).toBeCloseTo(1.0, 4);
    expect(world.player.energy.overdrive).toBe(false);

    // Second W press at 100% kicks into 120% Overdrive and starts burning shields.
    const preOverdriveShield = world.player.energy.shieldCharge;
    world = stepWorld(
      world,
      { ...NEUTRAL_INPUT, throttleDelta: 1, throttlePushEdge: true },
      FIXED_DT,
    );
    expect(world.player.energy.overdrive).toBe(true);
    expect(world.player.throttle).toBeCloseTo(1.2, 4);
    expect(world.player.energy.shieldCharge).toBeLessThan(preOverdriveShield);

    // Pressing S immediately cancels Overdrive back to <= 100%.
    world = stepWorld(world, { ...NEUTRAL_INPUT, throttleDelta: -1 }, FIXED_DT);
    expect(world.player.energy.overdrive).toBe(false);
    expect(world.player.throttle).toBeLessThanOrEqual(1.0);

    // Re-enter Overdrive and burn shields all the way to 0: auto-drops out cleanly.
    world = { ...world, player: { ...world.player, throttle: 1.0 } };
    world = stepWorld(world, { ...NEUTRAL_INPUT, throttleDelta: 1, throttlePushEdge: true }, FIXED_DT);
    expect(world.player.energy.overdrive).toBe(true);
    for (let i = 0; i < 300; i += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
      if (!world.player.energy.overdrive) break;
    }
    expect(world.player.energy.overdrive).toBe(false);
    expect(world.player.energy.shieldCharge).toBe(0);
    expect(world.player.throttle).toBeCloseTo(1.0, 4);
  });

  it('heats the cannons from cold to 100, locks them out there and unlocks only once they cool back to 0', () => {
    let energy = createInitialEnergy();
    expect(energy.weaponHeat).toBe(0);
    let shotsFired = 0;
    while (energy.weaponState === 'ready' && shotsFired < 20) {
      const spent = addWeaponHeat(energy, ENERGY_RULES.primaryShotHeat);
      expect(spent).not.toBeNull();
      if (spent === null) break;
      energy = spent.energy;
      shotsFired += 1;
    }
    expect(shotsFired).toBe(Math.ceil(ENERGY_RULES.maxHeat / ENERGY_RULES.primaryShotHeat));
    expect(energy.weaponState).toBe('overheated');
    expect(energy.weaponHeat).toBe(100);

    // Cannot fire while overheated, even after partial cooling.
    for (let i = 0; i < 100; i += 1) {
      energy = stepEnergy(energy, false, false, false, FIXED_DT).energy;
    }
    expect(energy.weaponHeat).toBeCloseTo(100 - 100 * FIXED_DT * ENERGY_RULES.overheatCoolPerSecond, 6);
    expect(energy.weaponState).toBe('overheated');
    expect(addWeaponHeat(energy, ENERGY_RULES.primaryShotHeat)).toBeNull();

    // Once cooled back to 0, cannons unlock cleanly and announce it.
    let readyEvents = 0;
    for (let i = 0; i < 400 && energy.weaponState !== 'ready'; i += 1) {
      const step = stepEnergy(energy, false, false, false, FIXED_DT);
      energy = step.energy;
      readyEvents += step.events.filter((e) => e.kind === 'weapon_ready').length;
    }
    expect(energy.weaponState).toBe('ready');
    expect(readyEvents).toBe(1);
    expect(energy.weaponHeat).toBe(0);
    expect(addWeaponHeat(energy, ENERGY_RULES.primaryShotHeat)).not.toBeNull();
  });

  it('cools a ready gun at 24/s and an overheated one at 15/s', () => {
    const warm = { ...createInitialEnergy(), weaponHeat: 50 };
    expect(stepEnergy(warm, false, false, false, 1).energy.weaponHeat).toBe(50 - ENERGY_RULES.weaponCoolPerSecond);
    expect(stepEnergy({ ...warm, weaponState: 'overheated' }, false, false, false, 1).energy.weaponHeat).toBe(50 - ENERGY_RULES.overheatCoolPerSecond);
  });
});

describe('sortie simulation contracts and enemy shield entities', () => {
  it('launches from briefing, ignores Enter during active flight, and restarts only on explicit restart', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, false);
    expect(world.phase.kind).toBe('briefing');

    world = stepWorld(world, { ...NEUTRAL_INPUT, launchBriefing: true }, FIXED_DT);
    expect(world.phase.kind).toBe('active');

    world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    const tickBeforeEnter = world.tick;

    world = stepWorld(world, { ...NEUTRAL_INPUT, launchBriefing: true }, FIXED_DT);
    expect(world.tick).toBe(tickBeforeEnter + 1);

    world = stepWorld(world, { ...NEUTRAL_INPUT, restartSortie: true }, FIXED_DT);
    expect(world.tick).toBe(0);
    expect(world.phase.kind).toBe('active');
  });

  it('alternates left/right reciprocating barrels on LMB and stays in first-person cockpit mode', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    world = stepWorld(world, { ...NEUTRAL_INPUT, firePrimary: true }, FIXED_DT);
    expect(world.cameraMode).toBe('cockpit');
    expect(world.player.recoilLeft).toBe(1);
    expect(world.player.recoilRight).toBe(0);
    expect(world.player.nextBarrel).toBe('right');
    expect(world.events.some((e) => e.kind === 'cannon_fired' && e.barrel === 'left')).toBe(true);

    for (let i = 0; i < 10; i += 1) {
      world = stepWorld(world, { ...NEUTRAL_INPUT, firePrimary: true }, FIXED_DT);
      if (world.events.some((e) => e.kind === 'cannon_fired' && e.barrel === 'right')) {
        break;
      }
    }
    expect(world.player.recoilRight).toBe(1);
    expect(world.player.nextBarrel).toBe('left');
  });

  it('gives raiders real shields: 1 missile strips shield with shield_broken event, 1 missile kills an unshielded raider', () => {
    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    const raider = base.enemies[0];
    expect(raider).toBeDefined();
    if (raider === undefined) return;
    expect(raider.maxShields).toBeGreaterThan(0);
    expect(raider.shields).toBe(raider.maxShields);

    // Hit 1: one missile strips the fresh raider's entire shield, emits shield_broken, leaves raider alive.
    const afterFirstMissile = stepWorld(
      {
        ...base,
        enemies: [{ ...raider, fireCooldown: 99 }],
        projectiles: [
          {
            id: 'm1',
            kind: 'missile',
            faction: 'friendly',
            owner: 'player',
            position: raider.position,
            velocity: vec3(0, 0, -1),
            targetId: raider.id,
            damage: COMBAT_TUNING.missileDamage,
            ttl: 2,
          },
        ],
      },
      NEUTRAL_INPUT,
      FIXED_DT,
    );
    expect(afterFirstMissile.enemies).toHaveLength(1);
    expect(afterFirstMissile.enemies[0]?.shields).toBe(0);
    expect(afterFirstMissile.enemies[0]?.hull).toBeGreaterThan(0);
    expect(afterFirstMissile.events.some((e) => e.kind === 'shield_broken')).toBe(true);

    // Hit 2: one missile destroys an unshielded raider cleanly.
    const unshieldedRaider = afterFirstMissile.enemies[0];
    expect(unshieldedRaider).toBeDefined();
    if (unshieldedRaider === undefined) return;
    const afterSecondMissile = stepWorld(
      {
        ...afterFirstMissile,
        projectiles: [
          {
            id: 'm2',
            kind: 'missile',
            faction: 'friendly',
            owner: 'player',
            position: unshieldedRaider.position,
            velocity: vec3(0, 0, -1),
            targetId: unshieldedRaider.id,
            damage: COMBAT_TUNING.missileDamage,
            ttl: 2,
          },
        ],
      },
      NEUTRAL_INPUT,
      FIXED_DT,
    );
    expect(afterSecondMissile.enemies).toHaveLength(0);
    expect(afterSecondMissile.events.some((e) => e.kind === 'hit_confirmed' && e.isKill)).toBe(true);
  });

  it('auto-focuses whichever hostile is in the center of your view so lead pip and lock-on track who you are actually fighting', () => {
    const contacts = [
      { id: 'behind', label: 'VANE-1', position: vec3(0, 0, 260), velocity: vec3(0, 0, 0), kind: 'enemy' as const },
      { id: 'ahead', label: 'VANE-2', position: vec3(8, 2, -320), velocity: vec3(0, 0, 0), kind: 'enemy' as const },
    ];
    // Previously locked onto 'behind', now looking straight at 'ahead' (-Z): automatically switches focus!
    const selected = selectNextTarget('behind', vec3(0, 0, 0), vec3(0, 0, -1), contacts, false);
    expect(selected).toBe('ahead');

    // If nobody is in the forward cone, keep tracking the current target so the edge arrow guides you back.
    const outOfView = selectNextTarget(
      'behind',
      vec3(0, 0, 0),
      vec3(1, 0, 0),
      contacts,
      false,
    );
    expect(outOfView).toBe('behind');
  });

  it('clears lock and rearms missiles after firing', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    world = stepWorld(world, { ...NEUTRAL_INPUT, fireMissile: true, fireMissilePressed: true }, FIXED_DT);
    expect(world.player.missilesReady).toBe(3);
    expect(world.player.lockState.kind).toBe('none');

    const rearmTicks = Math.ceil(COMBAT_TUNING.missileRearmSeconds / FIXED_DT);
    for (let i = 0; i < rearmTicks - 2; i += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    }
    expect(world.player.missilesReady).toBe(3);
    for (let i = 0; i < 4; i += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    }
    expect(world.player.missilesReady).toBe(4);
  });

  it('shatters asteroids when hit by player projectiles', () => {
    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    const targetRock = base.asteroids[0];
    expect(targetRock).toBeDefined();
    if (targetRock === undefined) return;

    const next = stepWorld(
      {
        ...base,
        projectiles: [
          {
            id: 'test-missile',
            kind: 'missile',
            faction: 'friendly',
            owner: 'player',
            position: targetRock.position,
            velocity: vec3(0, 0, -1),
            targetId: null,
            damage: targetRock.hull + 10,
            ttl: 2,
          },
        ],
      },
      NEUTRAL_INPUT,
      FIXED_DT,
    );
    expect(next.asteroids.some((a) => a.id === targetRock.id)).toBe(false);
    expect(next.explosions.length).toBeGreaterThan(0);
    expect(next.events.some((e) => e.kind === 'hit_confirmed' && e.isKill)).toBe(false);
  });

  it('transitions to victory when all raiders and subsystems are cleared, and retries cleanly', () => {
    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    const cleared = {
      ...base,
      enemies: [],
      hostileFrigate: {
        ...frigateOf(base),
        subsystems: frigateOf(base).subsystems.map((s) => ({ ...s, hull: 0 })),
      },
    };
    const won = stepWorld(cleared, NEUTRAL_INPUT, FIXED_DT);
    expect(won.phase.kind).toBe('victory');

    const retried = stepWorld(won, { ...NEUTRAL_INPUT, launchBriefing: true }, FIXED_DT);
    expect(retried.phase.kind).toBe('active');
    expect(retried.tick).toBe(0);
    expect(retried.enemies.length).toBeGreaterThan(0);
  });

  it('transitions to failed when either player fighter or friendly carrier is destroyed', () => {
    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    const deadPlayer = stepWorld(
      { ...base, player: { ...base.player, hull: 0 } },
      NEUTRAL_INPUT,
      FIXED_DT,
    );
    expect(deadPlayer.phase.kind).toBe('failed');
    if (deadPlayer.phase.kind === 'failed') {
      expect(deadPlayer.phase.reason).toBe('FIGHTER DESTROYED');
    }

    const deadCarrier = stepWorld(
      { ...base, friendlyCarrier: { ...base.friendlyCarrier, hull: 0 } },
      NEUTRAL_INPUT,
      FIXED_DT,
    );
    expect(deadCarrier.phase.kind).toBe('failed');
    if (deadCarrier.phase.kind === 'failed') {
      expect(deadCarrier.phase.reason).toBe('CARRIER HEARTHSTONE LOST');
    }
  });

  it('resolves rotated capital-ship clearance, deals closing-speed collision damage, and checks hitboxes in ship-local space', () => {
    const rotatedFrigate: CapitalShipState = {
      id: 'rotated-frigate',
      name: 'ROTATED FRIGATE',
      faction: 'hostile',
      position: vec3(0, 0, 0),
      orientation: quatFromAxisAngle(vec3(0, 1, 0), Math.PI / 2),
      halfExtents: vec3(20, 15, 100),
      hull: 1000,
      maxHull: 1000,
      subsystems: [],
    };

    expect(isInsideCapitalBox(vec3(80, 0, 0), rotatedFrigate, 0)).toBe(true);
    expect(isInsideCapitalBox(vec3(0, 0, 80), rotatedFrigate, 0)).toBe(false);

    const alongRotatedHull = resolveObstacleClearance(
      vec3(80, 0, 14),
      vec3(0, 0, -60),
      [rotatedFrigate],
      [],
    );
    expect(alongRotatedHull.warning).toBe(true);
    expect(alongRotatedHull.impactSpeed).toBeCloseTo(60, 4);
    expect(alongRotatedHull.position.x).toBeCloseTo(80, 4);
    expect(alongRotatedHull.position.z).toBeGreaterThan(20);
  });

  it('preserves custom sortie configuration across restarts without re-passing config', () => {
    const reconConfig: SortieConfig = {
      ...DEFAULT_SORTIE_CONFIG,
      id: 'sortie-recon',
      openingRadio: {
        speaker: 'CONTROL',
        text: 'Recon sweep clear.',
        remainingSeconds: 4,
      },
      enemies: [],
    };
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true, reconConfig);
    world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    const restarted = stepWorld(world, { ...NEUTRAL_INPUT, restartSortie: true }, FIXED_DT);

    expect(restarted.sortie.id).toBe('sortie-recon');
    expect(restarted.enemies.length).toBe(0);
    expect(restarted.radio?.text).toBe('Recon sweep clear.');
  });

  it('strips outward radial velocity when clamped against the arena boundary', () => {
    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    let world: WorldState = {
      ...base,
      enemies: [],
      asteroids: [],
      player: {
        ...base.player,
        position: vec3(0, 0, -(FLIGHT_TUNING.arenaRadius - 2)),
        velocity: vec3(0, 0, -100),
        throttle: 1,
      },
    };

    for (let i = 0; i < 15; i += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    }

    const pos = world.player.position;
    const vel = world.player.velocity;
    const outward = normalize(pos);
    expect(len(pos)).toBeLessThanOrEqual(FLIGHT_TUNING.arenaRadius + 1e-4);
    expect(dot(vel, outward)).toBeLessThanOrEqual(1e-3);
    expect(len(vel)).toBeLessThan(1);
  });

  it('survives 60 seconds of randomized combat flight with finite state and valid invariants', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    let seed = 0xdeadbeef;

    for (let tick = 0; tick < 3600; tick += 1) {
      const r1 = nextRandom(seed);
      const r2 = nextRandom(r1.nextState);
      const r3 = nextRandom(r2.nextState);
      seed = r3.nextState;

      world = stepWorld(
        world,
        {
          ...NEUTRAL_INPUT,
          pitch: (r1.value - 0.5) * 1.4,
          yaw: (r2.value - 0.5) * 1.4,
          roll: r3.value > 0.7 ? 1 : r3.value < 0.3 ? -1 : 0,
          throttleDelta: r1.value > 0.65 ? 1 : r1.value < 0.2 ? -1 : 0,
          throttlePushEdge: tick % 120 === 0,
          firePrimary: r3.value > 0.5,
          fireMissile: tick % 90 === 0,
          fireMissilePressed: tick % 90 === 0,
          cycleTarget: tick % 180 === 0,
        },
        FIXED_DT,
      );

      expect(Number.isFinite(world.player.position.x)).toBe(true);
      expect(Number.isFinite(world.player.position.y)).toBe(true);
      expect(Number.isFinite(world.player.position.z)).toBe(true);
      expect(world.player.energy.weaponHeat).toBeGreaterThanOrEqual(0);
      expect(world.player.energy.weaponHeat).toBeLessThanOrEqual(100);
      expect(world.player.energy.shieldCharge).toBeGreaterThanOrEqual(0);
      expect(world.player.energy.shieldCharge).toBeLessThanOrEqual(100);
      if (world.player.energy.overdrive) {
        expect(world.player.energy.shieldCharge).toBeGreaterThan(0);
      } else {
        expect(world.player.throttle).toBeLessThanOrEqual(FLIGHT_TUNING.maxCruiseThrottle);
      }
      expect(world.player.missilesReady).toBeGreaterThanOrEqual(0);
      expect(world.player.missilesReady).toBeLessThanOrEqual(world.player.maxMissiles);

      if (world.player.lockState.kind !== 'none') {
        expect(world.player.missilesReady).toBeGreaterThan(0);
      }

      if (world.phase.kind !== 'active') {
        world = stepWorld(world, { ...NEUTRAL_INPUT, restartSortie: true }, FIXED_DT);
      }
    }
  });
});

const BALANCE_SEEDS = [DEFAULT_SORTIE_SEED, 1, 2, 3, 4, 5];

function playerBolt(id: string, position: Vec3, velocity: Vec3): ProjectileState {
  return {
    id,
    kind: 'bolt',
    faction: 'friendly',
    owner: 'player',
    position,
    velocity,
    targetId: null,
    damage: COMBAT_TUNING.boltDamage,
    ttl: 1,
  };
}

function hostileBolt(position: Vec3, velocity: Vec3): ProjectileState {
  return { ...playerBolt('eb', position, velocity), faction: 'hostile', owner: 'hostile', damage: COMBAT_TUNING.enemyBoltDamage };
}

function parkedRaider(position: Vec3, overrides: Partial<EnemyShipState> = {}): EnemyShipState {
  const raider = DEFAULT_SORTIE_CONFIG.enemies[0];
  if (raider === undefined) throw new Error('default sortie has no raider');
  return { ...raider, position, velocity: vec3(0, 0, 0), fireCooldown: 99, ...overrides };
}

/** One combat tick with the flight step skipped, so the player stays exactly where the test put them. */
function combatTick(
  world: WorldState,
  tick = 1,
  input: FlightInput = NEUTRAL_INPUT,
  playerStartPosition: Vec3 = world.player.position,
): ReturnType<typeof stepCombat> {
  return stepCombat({
    playerStartPosition,
    tick,
    rngState: world.rngState,
    player: world.player,
    wingmate: world.wingmate,
    enemies: world.enemies,
    friendlyCarrier: world.friendlyCarrier,
    hostileFrigate: world.hostileFrigate,
    reactors: world.reactors,
    arena: world.sortie.arena,
    asteroids: world.asteroids,
    projectiles: world.projectiles,
    explosions: [],
    radio: null,
    input,
    dt: FIXED_DT,
  });
}

function emptyArena(seed = DEFAULT_SORTIE_SEED): WorldState {
  return { ...createInitialWorld(seed, true), enemies: [], asteroids: [] };
}

describe('precision hitboxes and frigate hull occlusion', () => {
  const center = vec3(0, 0, -300);

  it('misses a raider with a bolt that only grazes its solar vanes, 7 m from the core', () => {
    const world = { ...emptyArena(), enemies: [parkedRaider(center)], projectiles: [playerBolt('b', add(center, vec3(7, 0, 8)), vec3(0, 0, -560))] };
    const after = combatTick(world);
    expect(SHIP_STATS.enemies.raider.hitRadius).toBeLessThan(7);
    expect(after.events.some((e) => e.kind === 'hit_confirmed')).toBe(false);
  });

  it('hits with a fast bolt whose tick-to-tick step would jump clean over the hitbox', () => {
    const world = { ...emptyArena(), enemies: [parkedRaider(center)], projectiles: [playerBolt('b', add(center, vec3(0, 0, 10)), vec3(0, 0, -1400))] };
    const after = combatTick(world);
    expect(after.events.some((e) => e.kind === 'hit_confirmed')).toBe(true);
  });

  it('stops a bolt fired up from under the frigate at the hull instead of the dorsal shield dome', () => {
    const base = emptyArena();
    const frigate = frigateOf(base);
    const dome = frigate.subsystems[0];
    if (dome === undefined) throw new Error('frigate has no dome');
    const domePos = subsystemWorldPosition(frigate, dome);
    const up = rotateVec3(frigate.orientation, vec3(0, 1, 0));

    // 50 m under the dome sits one tick below the keel, so the bolt meets the hull within this step.
    const fromBelow = combatTick({ ...base, projectiles: [playerBolt('b', sub(domePos, scale(up, 50)), scale(up, 560))] });
    expect(frigateOf(fromBelow).subsystems[0]?.hull).toBe(dome.maxHull);
    expect(fromBelow.projectiles).toHaveLength(0);

    const fromAbove = combatTick({ ...base, projectiles: [playerBolt('b', add(domePos, scale(up, 22)), scale(up, -560))] });
    expect(frigateOf(fromAbove).subsystems[0]?.hull).toBeLessThan(dome.maxHull);
  });
});

describe('bolts swept against moving ships', () => {
  it('lands an enemy bolt that passes 4 m from a player moving at Overdrive speed, with no near miss', () => {
    const base = emptyArena();
    const start = base.player.position;
    const velocity = vec3(FLIGHT_TUNING.overdriveSpeed, 0, 0);
    const end = add(start, scale(velocity, FIXED_DT));
    // Crossing 3 m behind where the tick began: 5.8 m from where it ended, but 4 m from the ship as both moved.
    const bolt = hostileBolt(add(start, vec3(-3, -3.25, 0)), vec3(0, 390, 0));
    const world: WorldState = { ...base, player: { ...base.player, position: end, velocity }, projectiles: [bolt] };
    const after = combatTick(world, 1, NEUTRAL_INPUT, start);
    expect(after.events.some((e) => e.kind === 'player_damaged')).toBe(true);
    expect(after.events.some((e) => e.kind === 'near_miss')).toBe(false);
  });

  it('misses a raider that moved out of the bolt path during the tick', () => {
    const base = emptyArena();
    const start = vec3(0, 0, -300);
    const raider = parkedRaider(start, { velocity: vec3(112, 0, 0), maneuver: { kind: 'approach', remainingSeconds: 5 } });
    const bolt = playerBolt('b', add(start, vec3(7.4, 0, 3.25)), vec3(0, 0, -390));
    const after = combatTick({ ...base, enemies: [raider], projectiles: [bolt] });
    const moved = after.enemies[0]?.position ?? start;
    const boltEnd = add(bolt.position, scale(bolt.velocity, FIXED_DT));
    const radius = SHIP_STATS.enemies.raider.hitRadius;
    // Against the raider's end position alone the bolt would have hit.
    expect(segmentClosestApproach(bolt.position, boltEnd, moved).distance).toBeLessThan(radius);
    expect(after.events.some((e) => e.kind === 'hit_confirmed')).toBe(false);
  });
});

describe('frigate hull proxy', () => {
  it('lets a bolt through the empty air beside the narrow prow but stops one on the hull', () => {
    const base = emptyArena();
    const frigate = frigateOf(base);
    const local = (x: number, y: number, z: number): Vec3 => add(frigate.position, rotateVec3(frigate.orientation, vec3(x, y, z)));
    const down = rotateVec3(frigate.orientation, vec3(0, -560, 0));
    // 25 m off the centreline at the prow: inside the old 34 m box, well clear of the 12-24 m wide hull there.
    expect(isInsideCapitalBox(local(25, 0, -120), frigate, 0)).toBe(true);
    const beside = combatTick({ ...base, projectiles: [playerBolt('b', local(25, 20, -120), down)] }, 1);
    expect(beside.projectiles).toHaveLength(1);
    const onHull = combatTick({ ...base, projectiles: [playerBolt('b', local(0, 20, -120), down)] }, 1);
    expect(onHull.projectiles).toHaveLength(0);
  });
});

describe('cannon Hot Zone', () => {
  it('doubles the crit bonus: 1.75x normally, 2.5x from the Hot Zone', () => {
    expect(critMultiplier(false)).toBe(1.75);
    expect(critMultiplier(true)).toBe(2.5);
  });

  it('stamps a bolt fired at 80+ heat from a ready gun, using the heat before the shot', () => {
    const base = emptyArena();
    const fire = { ...NEUTRAL_INPUT, firePrimary: true };
    const shot = (weaponHeat: number) => combatTick({ ...base, player: { ...base.player, energy: { ...base.player.energy, weaponHeat } } }, 1, fire);
    expect(shot(ENERGY_RULES.hotZoneHeat).projectiles[0]?.hotZone).toBe(true);
    expect(shot(ENERGY_RULES.hotZoneHeat - 0.5).projectiles[0]?.hotZone).toBe(false);
  });

  it('deals 2.5x crit damage from a Hot Zone bolt even after the gun has cooled', () => {
    const target = vec3(0, 0, -300);
    let hotCrits = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const base = emptyArena(seed);
      const bolt = { ...playerBolt('b', add(target, vec3(0, 0, 4)), vec3(0, 0, -390)), hotZone: true };
      const after = combatTick({ ...base, enemies: [parkedRaider(target)], projectiles: [bolt] });
      if (!after.events.some((e) => e.kind === 'crit_hit')) continue;
      hotCrits += 1;
      const shieldLoss = SHIP_STATS.enemies.raider.shields - (after.enemies[0]?.shields ?? 0);
      expect(shieldLoss).toBeCloseTo(COMBAT_TUNING.boltDamage * 2.5, 6);
    }
    expect(hotCrits).toBeGreaterThan(0);
  });
});

describe('manual shield recharge', () => {
  const recharge = { ...NEUTRAL_INPUT, rechargeShields: true };

  it('fills shields at 28/s straight through the regen delay', () => {
    const energy = { ...createInitialEnergy(), shieldCharge: 20, shieldRegenDelay: SHIP_STATS.player.shieldRegenDelay };
    expect(stepEnergy(energy, false, false, true, 1).energy.shieldCharge).toBe(48);
    expect(stepEnergy({ ...energy, shieldCharge: 90 }, false, false, true, 1).energy.shieldCharge).toBe(100);
    expect(stepEnergy(energy, false, false, false, 1).energy.shieldCharge).toBe(20);
  });

  it('holds a ready gun at its heat but keeps an overheat lockout cooling', () => {
    const warm = { ...createInitialEnergy(), weaponHeat: 60 };
    expect(stepEnergy(warm, false, false, true, 1).energy.weaponHeat).toBe(60);
    expect(stepEnergy({ ...warm, weaponState: 'overheated' }, false, false, true, 1).energy.weaponHeat).toBe(60 - ENERGY_RULES.overheatCoolPerSecond);
  });

  it('keeps cannons and missiles silent while held', () => {
    const base = emptyArena();
    const after = combatTick(base, 1, { ...recharge, firePrimary: true, fireMissile: true, fireMissilePressed: true });
    expect(after.events.filter((e) => e.kind === 'cannon_fired' || e.kind === 'missile_fired')).toEqual([]);
    expect(after.player.missilesReady).toBe(base.player.missilesReady);
  });

  it('drops Overdrive to the 100% detent and refuses to re-enter it while held', () => {
    let world = emptyArena();
    world = { ...world, player: { ...world.player, throttle: FLIGHT_TUNING.overdriveThrottle, energy: { ...world.player.energy, overdrive: true } } };
    world = stepWorld(world, recharge, FIXED_DT);
    expect(world.player.energy.overdrive).toBe(false);
    expect(world.player.throttle).toBe(FLIGHT_TUNING.maxCruiseThrottle);
    world = stepWorld(world, { ...recharge, throttleDelta: 1, throttlePushEdge: true }, FIXED_DT);
    expect(world.player.energy.overdrive).toBe(false);
  });
});

describe('low-hull alarm', () => {
  it('sounds at 35% hull and repeats every 1.5 s, never above it', () => {
    const base = emptyArena();
    const critical = { ...base, player: { ...base.player, hull: base.player.maxHull * HULL_CRITICAL_FRACTION } };
    let world = critical;
    const alarms: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      world = stepWorld({ ...world, player: { ...world.player, hull: critical.player.hull } }, NEUTRAL_INPUT, FIXED_DT);
      if (world.events.some((e) => e.kind === 'hull_critical')) alarms.push(world.tick);
    }
    expect(alarms).toEqual([1, 91, 181]);

    const healthy = stepWorld({ ...base, player: { ...base.player, hull: base.player.maxHull * 0.36 } }, NEUTRAL_INPUT, FIXED_DT);
    expect(healthy.events.some((e) => e.kind === 'hull_critical')).toBe(false);
  });
});

describe('shield break attribution', () => {
  it('names the wingmate when its bolt breaks a raider shield', () => {
    const base = emptyArena();
    const target = vec3(0, 0, -300);
    const bolt = { ...playerBolt('wb', add(target, vec3(0, 0, 4)), vec3(0, 0, -390)), owner: 'wingmate' as const };
    const after = combatTick({ ...base, enemies: [parkedRaider(target, { id: 'raider-x', shields: 1 })], projectiles: [bolt] });
    expect(after.events).toContainEqual(expect.objectContaining({ kind: 'shield_broken', targetId: 'raider-x', attackerId: 'wingmate' }));
  });
});

describe('variable-ratio reinforcement', () => {
  it('scales crit chance from a 14% base with dead-centre precision and a capped pity ramp', () => {
    expect(critChance(0, 0)).toBeCloseTo(0.14, 6);
    expect(critChance(1, 0)).toBeCloseTo(0.3, 6);
    expect(critChance(0, 3)).toBeGreaterThan(critChance(0, 0));
    expect(critChance(1, 100)).toBe(COMBAT_TUNING.critMaxChance);
  });

  it.each([
    ['already inside the hitbox', 4],
    ['entering late in its tick, short of the centre', SHIP_STATS.enemies.raider.hitRadius + 8],
  ])('lands dead-centre crits at about the advertised rate for 1.75x shield damage (bolt %s)', (_label, startOffset) => {
    const target = vec3(0, 0, -300);
    let crits = 0;
    const trials = 400;
    for (let seed = 1; seed <= trials; seed += 1) {
      const world = {
        ...emptyArena(seed),
        enemies: [parkedRaider(target)],
        projectiles: [playerBolt('b', add(target, vec3(0, 0, startOffset)), vec3(0, 0, -560))],
      };
      const after = combatTick(world);
      const shieldLoss = SHIP_STATS.enemies.raider.shields - (after.enemies[0]?.shields ?? 0);
      if (after.events.some((e) => e.kind === 'crit_hit')) {
        crits += 1;
        expect(shieldLoss).toBeCloseTo(COMBAT_TUNING.boltDamage * COMBAT_TUNING.critMultiplier, 6);
      } else {
        expect(shieldLoss).toBeCloseTo(COMBAT_TUNING.boltDamage, 6);
      }
    }
    expect(crits / trials).toBeGreaterThan(0.22);
    expect(crits / trials).toBeLessThan(0.38);
  });

  it('turns a kill into a supply drop once pity is maxed, flushing an overheated gun with a radio callout', () => {
    const base = emptyArena();
    const target = vec3(0, 0, -300);
    const world: WorldState = {
      ...base,
      player: {
        ...base.player,
        dropPity: 4,
        energy: { ...base.player.energy, weaponState: 'overheated', weaponHeat: 70 },
      },
      enemies: [parkedRaider(target, { hull: 1, shields: 0 })],
      projectiles: [playerBolt('b', add(target, vec3(0, 0, 4)), vec3(0, 0, -560))],
    };
    const after = combatTick(world);
    expect(after.events).toContainEqual({ kind: 'supply_drop', drop: 'heat_flush' });
    expect(after.events).toContainEqual({ kind: 'weapon_ready' });
    expect(after.player.energy).toMatchObject({ weaponState: 'ready', weaponHeat: 0 });
    expect(after.player.dropPity).toBe(0);
    expect(after.radio?.text).toContain('Supply drop');
  });

  it('pays a near miss for a bolt that skims a fast-moving player, but not a slow, straight one', () => {
    const base = emptyArena();
    const pass = hostileBolt(add(base.player.position, vec3(10, 0, -3)), vec3(0, 0, 390));
    const fast: WorldState = {
      ...base,
      player: { ...base.player, velocity: vec3(0, 0, -100), energy: { ...base.player.energy, weaponHeat: 50 } },
      projectiles: [pass],
    };
    const rewarded = combatTick(fast);
    expect(rewarded.events).toContainEqual({ kind: 'near_miss', source: 'bolt', reward: 'heat_vent' });
    expect(rewarded.player.energy.weaponHeat).toBeCloseTo(50 - COMBAT_TUNING.nearMissHeatVent, 6);

    const slow = combatTick({ ...fast, player: { ...fast.player, velocity: vec3(0, 0, -40) } });
    expect(slow.events.some((e) => e.kind === 'near_miss')).toBe(false);
  });

  it('pays a near miss for buzzing an asteroid at speed', () => {
    const base = emptyArena();
    const world: WorldState = {
      ...base,
      player: { ...base.player, velocity: vec3(0, 0, -100) },
      asteroids: [{ id: 'rock', position: add(base.player.position, vec3(30, 0, 0)), radius: 10, rotation: vec3(0, 0, 0), hull: 50, tint: 'ice' }],
    };
    expect(combatTick(world).events).toContainEqual({ kind: 'near_miss', source: 'buzz', reward: 'shield' });
  });
});

describe('enemy fire model', () => {
  function raidersFacingPlayer(world: WorldState): readonly EnemyShipState[] {
    return [-60, 0, 60].map((x, i) =>
      parkedRaider(add(world.player.position, vec3(x, 0, -300)), {
        id: `raider-${i}`,
        orientation: quatLookAt(normalize(vec3(-x, 0, 300))),
        fireCooldown: 0,
        maneuver: { kind: 'approach', remainingSeconds: 5 },
      }),
    );
  }

  it('holds fire through the opening grace window', () => {
    const base = emptyArena();
    const after = combatTick({ ...base, enemies: raidersFacingPlayer(base) }, 1);
    expect(after.events.some((e) => e.kind === 'incoming_fire')).toBe(false);
  });

  it('lets at most two raiders shoot at the player at once, each announcing incoming fire', () => {
    const base = emptyArena();
    const graceTicks = Math.ceil(COMBAT_TUNING.openingGraceSeconds / FIXED_DT);
    const after = combatTick({ ...base, enemies: raidersFacingPlayer(base) }, graceTicks + 1);
    expect(after.events.filter((e) => e.kind === 'incoming_fire')).toHaveLength(COMBAT_TUNING.attackTokens);
  });

  it('aims tight at a slow, straight target and wide at an Overdrive pilot crossing the line of fire', () => {
    const base = emptyArena().player;
    const shooter = add(base.position, vec3(0, 0, 300));
    const slowStraight = { ...base, velocity: vec3(0, 0, -50) };
    const overdriveCrossing = {
      ...base,
      velocity: vec3(FLIGHT_TUNING.overdriveSpeed, 0, 0),
      angularVelocity: vec3(0, 1.5, 0),
      energy: { ...base.energy, overdrive: true },
    };
    expect(enemyAimError(slowStraight, shooter)).toBeLessThan(0.01);
    expect(enemyAimError(overdriveCrossing, shooter)).toBeGreaterThan(8 * enemyAimError(slowStraight, shooter));
  });

  it('lets the raider attack-run timer reach zero and break away unless it sits on the player tail', () => {
    const base = emptyArena();
    const run = { kind: 'approach', remainingSeconds: 0.01 } as const;
    const ahead = combatTick({ ...base, enemies: [parkedRaider(add(base.player.position, vec3(0, 0, -400)), { maneuver: run })] });
    expect(ahead.enemies[0]?.maneuver.kind).toBe('break_away');

    const onTail = combatTick({ ...base, enemies: [parkedRaider(add(base.player.position, vec3(0, 0, 400)), { maneuver: run })] });
    expect(onTail.enemies[0]?.maneuver).toEqual({ kind: 'approach', remainingSeconds: 0 });
  });

  it('drops Overdrive throttle back to 100% in the same tick a bolt empties the shields', () => {
    const base = emptyArena();
    const world: WorldState = {
      ...base,
      player: { ...base.player, throttle: FLIGHT_TUNING.overdriveThrottle, energy: { ...base.player.energy, overdrive: true, shieldCharge: 5 } },
      projectiles: [hostileBolt(add(base.player.position, vec3(0, 0, -4)), vec3(0, 0, 390))],
    };
    const after = combatTick(world);
    expect(after.player.energy.overdrive).toBe(false);
    expect(after.player.throttle).toBe(FLIGHT_TUNING.maxCruiseThrottle);
  });
});

describe('missile trigger and manual target pin', () => {
  it('fires one unguided missile for a held RMB with nothing to lock, never a stream', () => {
    const base = emptyArena();
    let world: WorldState = {
      ...base,
      hostileFrigate: { ...frigateOf(base), subsystems: frigateOf(base).subsystems.map((s) => ({ ...s, hull: 0 })) },
      enemies: [parkedRaider(vec3(0, 0, 2000))],
    };
    let launches = 0;
    for (let i = 0; i < 300; i += 1) {
      world = stepWorld(world, { ...NEUTRAL_INPUT, fireMissile: true, fireMissilePressed: i === 0 }, FIXED_DT);
      launches += world.events.filter((e) => e.kind === 'missile_fired').length;
    }
    expect(launches).toBe(1);
  });

  it('launches on a press released before the tick ran, even straight after a held tick', () => {
    const base = emptyArena();
    const held = stepWorld(base, { ...NEUTRAL_INPUT, fireMissile: true, fireMissilePressed: true }, FIXED_DT);
    let world = held;
    for (let i = 0; i < Math.ceil(COMBAT_TUNING.missileCooldown / FIXED_DT); i += 1) {
      world = stepWorld(world, { ...NEUTRAL_INPUT, fireMissile: true }, FIXED_DT);
    }
    const tapped = stepWorld(world, { ...NEUTRAL_INPUT, fireMissilePressed: true }, FIXED_DT);
    expect(tapped.events.filter((e) => e.kind === 'missile_fired')).toHaveLength(1);
  });

  it('holds RMB through the lock and launches the next missile only once the lock completes', () => {
    const base = emptyArena();
    let world: WorldState = { ...base, enemies: [parkedRaider(add(base.player.position, vec3(0, 0, -500)))] };
    const launchTicks: number[] = [];
    for (let i = 0; i < 120 && launchTicks.length < 2; i += 1) {
      world = stepWorld(world, { ...NEUTRAL_INPUT, fireMissile: true, fireMissilePressed: i === 0 }, FIXED_DT);
      if (world.events.some((e) => e.kind === 'missile_fired')) launchTicks.push(world.tick);
    }
    const guided = world.projectiles.filter((p) => p.kind === 'missile' && p.targetId !== null);
    expect(launchTicks).toHaveLength(2);
    expect((launchTicks[1] ?? 0) - (launchTicks[0] ?? 0)).toBeGreaterThanOrEqual(Math.round(COMBAT_TUNING.lockAcquireSeconds / FIXED_DT));
    expect(guided).toHaveLength(1);
  });

  it.each(['raider-1', 'striker-1'])('lands a locked missile on a manoeuvring %s and breaks its shield', (id) => {
    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    let world: WorldState = { ...base, enemies: base.enemies.filter((e) => e.id === id), asteroids: [] };
    for (let i = 0; i < 120 && world.player.lockState.kind !== 'locked'; i += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    }
    expect(world.player.lockState).toEqual({ kind: 'locked', targetId: id });

    world = stepWorld(world, { ...NEUTRAL_INPUT, fireMissile: true, fireMissilePressed: true }, FIXED_DT);
    expect(world.projectiles.some((p) => p.kind === 'missile' && p.targetId === id)).toBe(true);
    let shieldBroken = false;
    for (let i = 0; i < COMBAT_TUNING.missileTtl / FIXED_DT && !shieldBroken; i += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
      shieldBroken = world.events.some((e) => e.kind === 'shield_broken');
    }
    expect(shieldBroken).toBe(true);
  });

  const nose = vec3(0, 0, -1);
  const origin = vec3(0, 0, 0);
  const contact = (id: string, position: Vec3): TargetContact => ({ id, label: id, position, velocity: vec3(0, 0, 0), kind: 'enemy' });
  const deadAheadFar = contact('far', vec3(0, 0, -900));
  const offAxisNear = contact('near', vec3(40, 0, -300));

  it('never lets a closer off-axis contact steal auto-focus from a dead-centre one', () => {
    const slightlyOff = contact('close', vec3(8, 0, -150));
    expect(selectNextTarget(null, origin, nose, [slightlyOff, deadAheadFar], false)).toBe('far');
  });

  it('pins the T pick against auto-focus until it leaves the forward cone', () => {
    const contacts = [deadAheadFar, offAxisNear];
    const auto = resolveTargetSelection({ targetId: null, pinned: false }, origin, nose, contacts, false);
    expect(auto).toEqual({ targetId: 'far', pinned: false });

    const picked = resolveTargetSelection(auto, origin, nose, contacts, true);
    expect(picked).toEqual({ targetId: 'near', pinned: true });
    expect(resolveTargetSelection(picked, origin, nose, contacts, false)).toEqual(picked);

    const turnedAway = resolveTargetSelection(picked, origin, vec3(-1, 0, 0), contacts, false);
    expect(turnedAway.pinned).toBe(false);
  });

  it('releases the pin when T is pressed on the only contact in the cone', () => {
    const pinned = { targetId: 'far', pinned: true };
    expect(resolveTargetSelection(pinned, origin, nose, [deadAheadFar], true)).toEqual({ targetId: 'far', pinned: false });
  });
});

describe('frame event delivery', () => {
  it('hands the renderer every event from a multi-tick frame, not just the last tick', () => {
    const base = emptyArena();
    const target = vec3(0, 0, -600);
    const world: WorldState = {
      ...base,
      enemies: [parkedRaider(target)],
      projectiles: [playerBolt('b', add(target, vec3(0, 0, 4)), vec3(0, 0, -560))],
    };
    const frame = stepFrame(world, 3, () => NEUTRAL_INPUT, () => undefined);
    expect(frame.world.tick).toBe(3);
    expect(frame.world.events.some((e) => e.kind === 'hit_confirmed')).toBe(false);
    expect(frame.frameEvents.some((e) => e.kind === 'hit_confirmed')).toBe(true);
  });
});

describe('two-sided balance harness', () => {
  // The floor dropped from 20 s to 18 s when raiders went from 86/98 m/s to 98/112 m/s: seed 2 now falls at 19.9 s.
  it.each(BALANCE_SEEDS)('kills an AFK pilot within 18-65 s (seed %i)', (seed) => {
    const outcome = flySortie(seed, afkPilot, 90);
    expect(outcome.result).toBe('failed');
    expect(outcome.reason).toBe('FIGHTER DESTROYED');
    expect(outcome.seconds).toBeGreaterThanOrEqual(18);
    expect(outcome.seconds).toBeLessThanOrEqual(65);
  });

  it.each(BALANCE_SEEDS)('lets a competent cannon-only pilot with a 2.5 deg fire cone win (seed %i)', (seed) => {
    const outcome = flySortie(seed, cannonPilot(2.5), 180);
    expect(outcome.result).toBe('victory');
  });

  it('makes hard, fast flying and Overdrive cut the share of enemy shots that land', () => {
    const hitShare = (pilot: Pilot): number => {
      let hits = 0;
      let shots = 0;
      for (const seed of BALANCE_SEEDS.slice(0, 3)) {
        const outcome = flySortie(seed, pilot, 60);
        hits += outcome.hitsTaken;
        shots += outcome.incomingFire;
      }
      return hits / shots;
    };
    const afk = hitShare(afkPilot);
    const weaving = hitShare(evasivePilot(false));
    const overdrive = hitShare(evasivePilot(true));
    expect(weaving).toBeLessThan(afk / 3);
    expect(overdrive).toBeLessThan(weaving);
  });

  it('rewards disciplined bursts with more sustained cannon fire than riding the overheat lockout', () => {
    const shotsOver30s = (burstCeiling: number, burstResume: number): number => {
      let world = emptyArena();
      let holdFire = false;
      let shots = 0;
      for (let i = 0; i < 30 * 60; i += 1) {
        const heat = world.player.energy.weaponHeat;
        if (heat > burstCeiling) holdFire = true;
        else if (heat <= burstResume) holdFire = false;
        world = stepWorld(world, { ...NEUTRAL_INPUT, firePrimary: !holdFire }, FIXED_DT);
        shots += world.events.filter((e) => e.kind === 'cannon_fired' && e.faction === 'friendly').length;
      }
      return shots;
    };
    const disciplined = shotsOver30s(75, 40);
    const overheating = shotsOver30s(101, 101);
    expect(disciplined).toBeGreaterThan(overheating * 1.2);
  });
});
