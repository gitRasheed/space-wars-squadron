import { describe, expect, it } from 'vitest';
import {
  COMBAT_TUNING,
  critChance,
  enemyAimError,
  isInsideCapitalBox,
  resolveTargetSelection,
  selectNextTarget,
  stepCombat,
  subsystemWorldPosition,
  type TargetContact,
} from '../src/sim/combat';
import { createInitialEnergy, ENERGY_RULES, spendWeaponCharge, stepEnergy } from '../src/sim/energy';
import { FLIGHT_TUNING, resolveObstacleClearance } from '../src/sim/flight';
import { add, dot, len, nextRandom, normalize, quatFromAxisAngle, quatLookAt, rotateVec3, scale, sub, vec3 } from '../src/sim/math';
import { SHIP_STATS } from '../src/sim/ships';
import {
  DEFAULT_SORTIE_SEED,
  FIXED_DT,
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
import { afkPilot, cannonPilot, flySortie } from './support/pilots';

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

  it('locks out primary cannons on overheat at 0 charge until weapon charge cools all the way to 100%', () => {
    let energy = createInitialEnergy();
    let shotsFired = 0;
    while (energy.weaponState === 'ready' && shotsFired < 20) {
      const spent = spendWeaponCharge(energy, ENERGY_RULES.primaryShotCost);
      expect(spent).not.toBeNull();
      if (spent === null) break;
      energy = spent.energy;
      shotsFired += 1;
    }
    expect(energy.weaponState).toBe('overheated');
    expect(energy.weaponCharge).toBe(0);

    // Cannot fire while overheated, even after partial cooling (e.g., 50%).
    for (let i = 0; i < 100; i += 1) {
      energy = stepEnergy(energy, false, false, FIXED_DT).energy;
    }
    expect(energy.weaponCharge).toBeGreaterThan(20);
    expect(energy.weaponCharge).toBeLessThan(100);
    expect(energy.weaponState).toBe('overheated');
    expect(spendWeaponCharge(energy, ENERGY_RULES.primaryShotCost)).toBeNull();

    // Once cooled back to 100%, cannons unlock cleanly and announce it.
    let readyEvents = 0;
    for (let i = 0; i < 400 && energy.weaponState !== 'ready'; i += 1) {
      const step = stepEnergy(energy, false, false, FIXED_DT);
      energy = step.energy;
      readyEvents += step.events.filter((e) => e.kind === 'weapon_ready').length;
    }
    expect(energy.weaponState).toBe('ready');
    expect(readyEvents).toBe(1);
    expect(energy.weaponCharge).toBe(100);
    expect(spendWeaponCharge(energy, ENERGY_RULES.primaryShotCost)).not.toBeNull();
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
    world = stepWorld(world, { ...NEUTRAL_INPUT, fireMissile: true }, FIXED_DT);
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
        ...base.hostileFrigate,
        subsystems: base.hostileFrigate.subsystems.map((s) => ({ ...s, hull: 0 })),
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
          cycleTarget: tick % 180 === 0,
        },
        FIXED_DT,
      );

      expect(Number.isFinite(world.player.position.x)).toBe(true);
      expect(Number.isFinite(world.player.position.y)).toBe(true);
      expect(Number.isFinite(world.player.position.z)).toBe(true);
      expect(world.player.energy.weaponCharge).toBeGreaterThanOrEqual(0);
      expect(world.player.energy.weaponCharge).toBeLessThanOrEqual(100);
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
function combatTick(world: WorldState, tick = 1, input: FlightInput = NEUTRAL_INPUT): ReturnType<typeof stepCombat> {
  return stepCombat({
    tick,
    rngState: world.rngState,
    player: world.player,
    wingmate: world.wingmate,
    enemies: world.enemies,
    friendlyCarrier: world.friendlyCarrier,
    hostileFrigate: world.hostileFrigate,
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
    const frigate = base.hostileFrigate;
    const dome = frigate.subsystems[0];
    if (dome === undefined) throw new Error('frigate has no dome');
    const domePos = subsystemWorldPosition(frigate, dome);
    const up = rotateVec3(frigate.orientation, vec3(0, 1, 0));

    const fromBelow = combatTick({ ...base, projectiles: [playerBolt('b', sub(domePos, scale(up, 60)), scale(up, 560))] });
    expect(fromBelow.hostileFrigate.subsystems[0]?.hull).toBe(dome.maxHull);
    expect(fromBelow.projectiles).toHaveLength(0);

    const fromAbove = combatTick({ ...base, projectiles: [playerBolt('b', add(domePos, scale(up, 22)), scale(up, -560))] });
    expect(fromAbove.hostileFrigate.subsystems[0]?.hull).toBeLessThan(dome.maxHull);
  });
});

describe('variable-ratio reinforcement', () => {
  it('scales crit chance from a 14% base with dead-centre precision and a capped pity ramp', () => {
    expect(critChance(0, 0)).toBeCloseTo(0.14, 6);
    expect(critChance(1, 0)).toBeCloseTo(0.3, 6);
    expect(critChance(0, 3)).toBeGreaterThan(critChance(0, 0));
    expect(critChance(1, 100)).toBe(COMBAT_TUNING.critMaxChance);
  });

  it('lands dead-centre crits at about the advertised rate for 1.75x shield damage', () => {
    const target = vec3(0, 0, -300);
    let crits = 0;
    const trials = 400;
    for (let seed = 1; seed <= trials; seed += 1) {
      const world = {
        ...emptyArena(seed),
        enemies: [parkedRaider(target)],
        projectiles: [playerBolt('b', add(target, vec3(0, 0, 4)), vec3(0, 0, -560))],
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
        energy: { ...base.player.energy, weaponState: 'overheated', weaponCharge: 30 },
      },
      enemies: [parkedRaider(target, { hull: 1, shields: 0 })],
      projectiles: [playerBolt('b', add(target, vec3(0, 0, 4)), vec3(0, 0, -560))],
    };
    const after = combatTick(world);
    expect(after.events).toContainEqual({ kind: 'supply_drop', drop: 'heat_flush' });
    expect(after.events).toContainEqual({ kind: 'weapon_ready' });
    expect(after.player.energy).toMatchObject({ weaponState: 'ready', weaponCharge: 100 });
    expect(after.player.dropPity).toBe(0);
    expect(after.radio?.text).toContain('Supply drop');
  });

  it('pays a near miss for a bolt that skims a fast-moving player, but not a slow, straight one', () => {
    const base = emptyArena();
    const pass = hostileBolt(add(base.player.position, vec3(10, 0, -3)), vec3(0, 0, 390));
    const fast: WorldState = {
      ...base,
      player: { ...base.player, velocity: vec3(0, 0, -100), energy: { ...base.player.energy, weaponCharge: 50 } },
      projectiles: [pass],
    };
    const rewarded = combatTick(fast);
    expect(rewarded.events).toContainEqual({ kind: 'near_miss', source: 'bolt', reward: 'heat_vent' });
    expect(rewarded.player.energy.weaponCharge).toBeCloseTo(50 + COMBAT_TUNING.nearMissHeatVent, 6);

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
      hostileFrigate: { ...base.hostileFrigate, subsystems: base.hostileFrigate.subsystems.map((s) => ({ ...s, hull: 0 })) },
      enemies: [parkedRaider(vec3(0, 0, 2000))],
    };
    let launches = 0;
    for (let i = 0; i < 300; i += 1) {
      world = stepWorld(world, { ...NEUTRAL_INPUT, fireMissile: true }, FIXED_DT);
      launches += world.events.filter((e) => e.kind === 'missile_fired').length;
    }
    expect(launches).toBe(1);
  });

  it('holds RMB through the lock and launches the next missile only once the lock completes', () => {
    const base = emptyArena();
    let world: WorldState = { ...base, enemies: [parkedRaider(add(base.player.position, vec3(0, 0, -500)))] };
    const launchTicks: number[] = [];
    for (let i = 0; i < 120 && launchTicks.length < 2; i += 1) {
      world = stepWorld(world, { ...NEUTRAL_INPUT, fireMissile: true }, FIXED_DT);
      if (world.events.some((e) => e.kind === 'missile_fired')) launchTicks.push(world.tick);
    }
    const guided = world.projectiles.filter((p) => p.kind === 'missile' && p.targetId !== null);
    expect(launchTicks).toHaveLength(2);
    expect((launchTicks[1] ?? 0) - (launchTicks[0] ?? 0)).toBeGreaterThanOrEqual(Math.round(COMBAT_TUNING.lockAcquireSeconds / FIXED_DT));
    expect(guided).toHaveLength(1);
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
  it.each(BALANCE_SEEDS)('kills an AFK pilot within 20-65 s (seed %i)', (seed) => {
    const outcome = flySortie(seed, afkPilot, 90);
    expect(outcome.result).toBe('failed');
    expect(outcome.reason).toBe('FIGHTER DESTROYED');
    expect(outcome.seconds).toBeGreaterThanOrEqual(20);
    expect(outcome.seconds).toBeLessThanOrEqual(65);
  });

  it.each(BALANCE_SEEDS)('lets a competent cannon-only pilot with a 2.5 deg fire cone win (seed %i)', (seed) => {
    const outcome = flySortie(seed, cannonPilot(2.5), 180);
    expect(outcome.result).toBe('victory');
  });

  it('rewards disciplined bursts with more sustained cannon fire than riding the overheat lockout', () => {
    const shotsOver30s = (burstFloor: number, burstResume: number): number => {
      let world = emptyArena();
      let holdFire = false;
      let shots = 0;
      for (let i = 0; i < 30 * 60; i += 1) {
        const charge = world.player.energy.weaponCharge;
        if (charge < burstFloor) holdFire = true;
        else if (charge >= burstResume) holdFire = false;
        world = stepWorld(world, { ...NEUTRAL_INPUT, firePrimary: !holdFire }, FIXED_DT);
        shots += world.events.filter((e) => e.kind === 'cannon_fired' && e.faction === 'friendly').length;
      }
      return shots;
    };
    const disciplined = shotsOver30s(25, 60);
    const overheating = shotsOver30s(-1, -1);
    expect(disciplined).toBeGreaterThan(overheating * 1.2);
  });
});
