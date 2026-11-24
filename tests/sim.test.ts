import { describe, expect, it } from 'vitest';
import { COMBAT_TUNING, isInsideCapitalBox, selectNextTarget } from '../src/sim/combat';
import { createInitialEnergy, ENERGY_RULES, spendWeaponCharge, stepEnergy } from '../src/sim/energy';
import { FLIGHT_TUNING, resolveObstacleClearance } from '../src/sim/flight';
import { dot, len, nextRandom, normalize, quatFromAxisAngle, vec3 } from '../src/sim/math';
import {
  DEFAULT_SORTIE_SEED,
  FIXED_DT,
  NEUTRAL_INPUT,
  type CapitalShipState,
  type SortieConfig,
  type WorldState,
} from '../src/sim/types';
import { createInitialWorld, DEFAULT_SORTIE_CONFIG, stepWorld } from '../src/sim/world';

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

    // Once cooled back to 100%, cannons unlock cleanly.
    for (let i = 0; i < 200; i += 1) {
      energy = stepEnergy(energy, false, false, FIXED_DT).energy;
      if (energy.weaponState === 'ready') break;
    }
    expect(energy.weaponState).toBe('ready');
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

    for (let i = 0; i < 290; i += 1) {
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

  it('balance gate: an AFK pilot takes real damage or loses Hearthstone instead of sitting immune', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    let minPlayerShield = 100;
    let minPlayerHull = world.player.hull;
    let minCarrierHull = world.friendlyCarrier.hull;

    for (let tick = 0; tick < 60 * 90; tick += 1) {
      world = stepWorld(world, { ...NEUTRAL_INPUT, throttleDelta: -1 }, FIXED_DT);
      minPlayerShield = Math.min(minPlayerShield, world.player.energy.shieldCharge);
      minPlayerHull = Math.min(minPlayerHull, world.player.hull);
      minCarrierHull = Math.min(minCarrierHull, world.friendlyCarrier.hull);
      if (world.phase.kind !== 'active') break;
    }

    // Real stakes: either the AFK pilot/carrier was destroyed, or took serious shield/hull damage.
    const tookSeriousDamage =
      world.phase.kind === 'failed' ||
      minPlayerShield < 50 ||
      minPlayerHull < world.player.maxHull ||
      minCarrierHull < world.friendlyCarrier.maxHull - 100;
    expect(tookSeriousDamage).toBe(true);
    expect(world.phase.kind).not.toBe('victory');
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
