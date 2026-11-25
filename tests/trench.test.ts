import { describe, expect, it } from 'vitest';
import { buildSolidGeometry, buildTrenchLevel } from '../src/render/trenchModels';
import { arenaBox, boxCorners, isInsideArena, moveThroughArena, sweepArena } from '../src/sim/arena';
import { COMBAT_TUNING, stepCombat } from '../src/sim/combat';
import { FLIGHT_TUNING, stepPlayerFlight } from '../src/sim/flight';
import { add, len, nextRandom, quatLookAt, scale, vec3 } from '../src/sim/math';
import { SHIP_STATS } from '../src/sim/ships';
import {
  TRENCH_ARENA,
  TRENCH_CLEARANCE,
  TRENCH_DIMENSIONS,
  TRENCH_REACTORS,
  TRENCH_ROCK_FACET_JITTER,
} from '../src/sim/trenchLayout';
import {
  DEFAULT_SORTIE_SEED,
  FIXED_DT,
  NEUTRAL_INPUT,
  type ArenaSolid,
  type FlightInput,
  type ProjectileState,
  type Vec3,
  type WorldState,
} from '../src/sim/types';
import { createInitialWorld, stepWorld, TRENCH_SORTIE_CONFIG } from '../src/sim/world';

const PAD = FLIGHT_TUNING.arenaHullPad;

function trenchWorld(seed = DEFAULT_SORTIE_SEED): WorldState {
  return createInitialWorld(seed, true, TRENCH_SORTIE_CONFIG);
}

/** No enemies, no projectiles: just the player and the level. */
function quietTrench(): WorldState {
  return { ...trenchWorld(), enemies: [], radio: null };
}

function bolt(faction: 'friendly' | 'hostile', position: Vec3, velocity: Vec3): ProjectileState {
  return {
    id: `t-${faction}`,
    kind: 'bolt',
    faction,
    owner: faction === 'friendly' ? 'player' : 'hostile',
    position,
    velocity,
    targetId: null,
    damage: faction === 'friendly' ? COMBAT_TUNING.boltDamage : COMBAT_TUNING.enemyBoltDamage,
    ttl: 1,
  };
}

function combatTick(world: WorldState): ReturnType<typeof stepCombat> {
  return stepCombat({
    tick: world.tick + 1,
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
    input: NEUTRAL_INPUT,
    dt: FIXED_DT,
  });
}

function solidById(id: string): ArenaSolid {
  const solid = TRENCH_ARENA.find((s) => s.id === id);
  if (solid === undefined) throw new Error(`no solid ${id}`);
  return solid;
}

describe('trench layout', () => {
  it('keeps the promised 140 x 95 m rib-to-rib envelope and a clear straight line from mouth to exit', () => {
    expect(TRENCH_CLEARANCE.halfWidth * 2).toBe(140);
    expect(TRENCH_CLEARANCE.top - TRENCH_CLEARANCE.bottom).toBe(95);
    expect(TRENCH_DIMENSIONS.halfLength * 2).toBe(1800);

    const run = sweepArena(vec3(0, 0, TRENCH_DIMENSIONS.halfLength + 200), vec3(0, 0, -TRENCH_DIMENSIONS.halfLength - 200), TRENCH_ARENA, PAD);
    expect(run).toBeNull();

    for (const solid of TRENCH_ARENA.filter((s) => s.role === 'rib' && s.kind === 'box')) {
      if (solid.kind !== 'box') continue;
      const innerX = Math.min(...boxCorners(solid).map((c) => Math.abs(c.x)));
      const bottom = Math.min(...boxCorners(solid).map((c) => c.y));
      if (solid.id.endsWith('beam')) {
        expect(bottom).toBeCloseTo(TRENCH_CLEARANCE.top, 6);
      } else {
        expect(innerX).toBeCloseTo(TRENCH_CLEARANCE.halfWidth, 6);
        // Proud of the smoothest wall face by at least the ink threshold.
        expect(TRENCH_DIMENSIONS.wallInnerX - innerX).toBeGreaterThanOrEqual(TRENCH_DIMENSIONS.ribProud);
      }
    }
  });

  it('keeps the outer rock mass out of the flight envelope and every spawn clear of geometry', () => {
    for (const rock of TRENCH_ARENA.filter((s) => s.kind === 'sphere' && s.role === 'rock')) {
      if (rock.kind !== 'sphere') continue;
      const inside = {
        x: Math.max(0, Math.abs(rock.center.x) - TRENCH_DIMENSIONS.wallInnerX),
        y: Math.max(0, rock.center.y - TRENCH_DIMENSIONS.ceilingY, TRENCH_DIMENSIONS.floorY - rock.center.y),
        z: Math.max(0, Math.abs(rock.center.z) - TRENCH_DIMENSIONS.halfLength),
      };
      expect(len(inside)).toBeGreaterThan(rock.radius);
    }
    const world = trenchWorld();
    expect(isInsideArena(world.player.position, TRENCH_ARENA, PAD + 10)).toBe(false);
    expect(isInsideArena(world.wingmate.position, TRENCH_ARENA, PAD + 10)).toBe(false);
    for (const enemy of world.enemies) {
      expect(isInsideArena(enemy.position, TRENCH_ARENA, SHIP_STATS.enemies[enemy.kind].hitRadius + 6)).toBe(false);
    }
    expect(world.hostileFrigate).toBeNull();
    expect(world.reactors).toHaveLength(3);
  });

  it('builds every mesh from its collider: boxes exactly, rocks within the facet jitter', () => {
    for (const solid of TRENCH_ARENA) {
      const geo = buildSolidGeometry(solid);
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (bb === null) throw new Error('no bounds');
      if (solid.kind === 'box') {
        const corners = boxCorners(solid);
        expect(bb.min.x).toBeCloseTo(Math.min(...corners.map((c) => c.x)), 3);
        expect(bb.max.y).toBeCloseTo(Math.max(...corners.map((c) => c.y)), 3);
        expect(bb.max.z).toBeCloseTo(Math.max(...corners.map((c) => c.z)), 3);
      } else {
        const pos = geo.getAttribute('position');
        for (let i = 0; i < pos.count; i += 1) {
          const r = len(vec3(pos.getX(i) - solid.center.x, pos.getY(i) - solid.center.y, pos.getZ(i) - solid.center.z));
          expect(Math.abs(r / solid.radius - 1)).toBeLessThanOrEqual(TRENCH_ROCK_FACET_JITTER + 1e-6);
        }
      }
    }
    const rig = buildTrenchLevel();
    for (const reactor of TRENCH_REACTORS) {
      const mesh = rig.coreMeshes.get(reactor.id);
      expect(mesh?.position.toArray()).toEqual([reactor.position.x, reactor.position.y, reactor.position.z]);
    }
  });
});

describe('trench collision', () => {
  const wallX = -TRENCH_DIMENSIONS.wallInnerX;

  it('glances the player off a wall at Overdrive speed with shield damage, never through it', () => {
    const base = quietTrench();
    // 20 m off the left wall, between ribs, nosed 60 degrees into it at 168 m/s.
    const dir = vec3(-Math.sin(Math.PI / 3), 0, -Math.cos(Math.PI / 3));
    let player = { ...base.player, position: vec3(wallX + 20, 0, 400), velocity: vec3(dir.x * 168, 0, dir.z * 168), orientation: quatLookAt(dir) };
    let damaged = false;
    for (let i = 0; i < 40; i += 1) {
      const step = stepPlayerFlight(player, NEUTRAL_INPUT, [], [], TRENCH_ARENA, FIXED_DT);
      player = step.player;
      damaged ||= step.events.some((e) => e.kind === 'player_damaged');
      expect(isInsideArena(player.position, TRENCH_ARENA, PAD - 0.01)).toBe(false);
      expect(player.position.x).toBeGreaterThan(wallX);
    }
    expect(damaged).toBe(true);
    expect(player.energy.shieldCharge).toBeLessThan(base.player.energy.shieldCharge);
  });

  it('lets a shallow skim slide along the deck with no damage and most of its speed', () => {
    const base = quietTrench();
    const dir = vec3(0, -Math.sin(0.12), -Math.cos(0.12));
    const deckY = TRENCH_DIMENSIONS.floorY;
    let player = { ...base.player, position: vec3(0, deckY + PAD + 2, 720), velocity: vec3(0, dir.y * 102, dir.z * 102), orientation: quatLookAt(dir), throttle: 1 };
    let scraped = false;
    for (let i = 0; i < 30; i += 1) {
      const step = stepPlayerFlight(player, NEUTRAL_INPUT, [], [], TRENCH_ARENA, FIXED_DT);
      player = step.player;
      expect(step.events.some((e) => e.kind === 'player_damaged')).toBe(false);
      scraped ||= step.events.some((e) => e.kind === 'wall_scrape');
    }
    expect(scraped).toBe(true);
    expect(len(player.velocity)).toBeGreaterThan(90);
    expect(player.energy.shieldCharge).toBe(base.player.energy.shieldCharge);
  });

  it('sees a point inside a padded box corner, past the unpadded bounding sphere plus the pad', () => {
    const cube = [arenaBox('cube', 'wall', vec3(0, 0, 0), vec3(1, 1, 1))];
    expect(isInsideArena(vec3(6.9, 6.9, 6.9), cube, 6)).toBe(true);
  });

  it('holds the last clear position where the floor, wall-l-4 and monolith-2 meet', () => {
    // One recorded tick into the junction: pushing out of one padded solid used to land 5.96 m from another.
    const from = vec3(-71.95, -47.457372190577665, 18.458751796453274);
    const velocity = vec3(-17.240257237005977, -16.83410641607493, -83.8641135120991);
    const move = moveThroughArena(from, add(from, scale(velocity, FIXED_DT)), velocity, TRENCH_ARENA, PAD, FLIGHT_TUNING.wallRestitution, FLIGHT_TUNING.wallMinSeparation);
    expect(isInsideArena(move.position, TRENCH_ARENA, PAD)).toBe(false);
  });

  it('stops a sweep that would jump clean over a 6 m rib in one step', () => {
    const rib = solidById('rib-5-l');
    // Just inside the pillar's padded inner face, clear of the wall behind it.
    const from = vec3(-66, 0, rib.center.z + 30);
    const to = vec3(-66, 0, rib.center.z - 30);
    const moved = moveThroughArena(from, to, vec3(0, 0, -3600), TRENCH_ARENA, PAD, 0.35, 6);
    expect(moved.position.z).toBeGreaterThan(rib.center.z);
    expect(moved.velocity.z).toBeGreaterThan(0);
    expect(moved.impactSpeed).toBeCloseTo(3600, 6);
  });

  it('stops friendly and hostile bolts on walls and ribs: real cover both ways', () => {
    const base = quietTrench();
    // This slab's face is stepped back to x = -84.
    const friendly = combatTick({ ...base, projectiles: [bolt('friendly', vec3(-80, 0, 400), vec3(-560, 0, 0))] });
    expect(friendly.projectiles).toHaveLength(0);
    expect(friendly.explosions.some((e) => e.id.startsWith('wall-'))).toBe(true);
    expect(friendly.events.some((e) => e.kind === 'hit_confirmed')).toBe(false);

    // A raider bolt aimed straight at the player through a rib pillar never arrives.
    const rib = solidById('rib-5-l');
    const player = { ...base.player, position: vec3(rib.center.x, 0, rib.center.z - 9), velocity: vec3(0, 0, 0) };
    const hostile = combatTick({ ...base, player, projectiles: [bolt('hostile', vec3(rib.center.x, 0, rib.center.z + 8), vec3(0, 0, -1200))] });
    expect(hostile.projectiles).toHaveLength(0);
    expect(hostile.player.energy.shieldCharge).toBe(base.player.energy.shieldCharge);
    expect(hostile.events.some((e) => e.kind === 'player_damaged')).toBe(false);
  });
});

describe('trench objective', () => {
  it('damages conduit cores with bolts, lets dead cores block fire, and wins when all three go dark', () => {
    const base = quietTrench();
    const core = TRENCH_REACTORS[0];
    if (core === undefined) throw new Error('no reactor');
    const shot = bolt('friendly', vec3(core.position.x, core.position.y, core.position.z + 14), vec3(0, 0, -560));
    const hit = combatTick({ ...base, projectiles: [shot] });
    expect(hit.reactors[0]?.hull).toBeLessThan(core.maxHull);
    expect(hit.events.some((e) => e.kind === 'hit_confirmed')).toBe(true);

    const twoDown = { ...base, reactors: base.reactors.map((r, i) => (i < 2 ? { ...r, hull: 0 } : r)) };
    const deadShot = combatTick({ ...twoDown, projectiles: [shot] });
    expect(deadShot.projectiles).toHaveLength(0);
    expect(deadShot.events.some((e) => e.kind === 'hit_confirmed')).toBe(false);

    const last = twoDown.reactors[2];
    if (last === undefined) throw new Error('no third reactor');
    const finishing = { ...twoDown, reactors: twoDown.reactors.map((r, i) => (i === 2 ? { ...r, hull: 1 } : r)) };
    const kill = bolt('friendly', vec3(last.position.x, last.position.y, last.position.z + 14), vec3(0, 0, -560));
    const won = stepWorld({ ...finishing, projectiles: [kill] }, NEUTRAL_INPUT, FIXED_DT);
    expect(won.phase.kind).toBe('victory');
    if (won.phase.kind === 'victory') expect(won.phase.reactorsDestroyed).toBe(1);
    // Escorts still alive do not hold the win back.
    expect(trenchWorld().enemies.length).toBeGreaterThan(0);
  });

  it('holds guards on station until the player closes in', () => {
    const world = trenchWorld();
    const guard = world.enemies.find((e) => e.maneuver.kind === 'patrol');
    if (guard === undefined) throw new Error('no guard');
    const far = combatTick({ ...world, enemies: [guard], player: { ...world.player, position: vec3(0, 0, 2400) } });
    expect(far.enemies[0]?.maneuver.kind).toBe('patrol');
    const near = combatTick({ ...world, enemies: [guard], player: { ...world.player, position: { ...guard.position, z: guard.position.z + 200 } } });
    expect(near.enemies[0]?.maneuver.kind).toBe('approach');
  });
});

describe('mission select', () => {
  it('switches level only from the briefing and keeps it across restarts', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, false);
    expect(world.sortie.level).toBe('saturn');
    world = stepWorld(world, { ...NEUTRAL_INPUT, selectLevel: 'trench' }, FIXED_DT);
    expect(world.sortie.level).toBe('trench');
    expect(world.phase.kind).toBe('briefing');
    world = stepWorld(world, { ...NEUTRAL_INPUT, launchBriefing: true }, FIXED_DT);
    world = stepWorld(world, { ...NEUTRAL_INPUT, selectLevel: 'saturn' }, FIXED_DT);
    expect(world.sortie.level).toBe('trench');
    world = stepWorld(world, { ...NEUTRAL_INPUT, restartSortie: true }, FIXED_DT);
    expect(world.sortie.level).toBe('trench');
    expect(world.reactors.every((r) => r.hull === r.maxHull)).toBe(true);
  });
});

describe('trench soak', () => {
  it('survives 60 s of randomized flight inside the trench with no ship ever inside geometry', () => {
    for (const seed of [DEFAULT_SORTIE_SEED, 7, 21, 99]) {
      let world = trenchWorld(seed);
      let rng = seed ^ 0x7e7c;
      let aiInWallTicks = 0;
      let insideTrenchTicks = 0;
      let enemyTicks = 0;
      let enemyGrindingTicks = 0;
      for (let tick = 0; tick < 3600; tick += 1) {
        const r = [0, 0, 0].map(() => {
          const next = nextRandom(rng);
          rng = next.nextState;
          return next.value;
        });
        const [r1 = 0, r2 = 0, r3 = 0] = r;
        const input: FlightInput = {
          ...NEUTRAL_INPUT,
          pitch: (r1 - 0.5) * 1.2,
          yaw: (r2 - 0.5) * 1.2,
          roll: r3 > 0.75 ? 1 : r3 < 0.25 ? -1 : 0,
          throttleDelta: r1 > 0.6 ? 1 : r1 < 0.15 ? -1 : 0,
          throttlePushEdge: tick % 240 === 0,
          firePrimary: r3 > 0.45,
          fireMissile: tick % 120 === 0,
        };
        world = stepWorld(world, input, FIXED_DT);

        const p = world.player.position;
        expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
        expect(len(p)).toBeLessThanOrEqual(FLIGHT_TUNING.arenaRadius + 1e-6);
        expect(isInsideArena(p, TRENCH_ARENA, PAD - 0.01)).toBe(false);
        if (Math.abs(p.x) < TRENCH_DIMENSIONS.wallInnerX && Math.abs(p.z) < TRENCH_DIMENSIONS.halfLength) insideTrenchTicks += 1;
        expect(world.player.energy.weaponCharge).toBeGreaterThanOrEqual(0);
        expect(world.player.energy.shieldCharge).toBeGreaterThanOrEqual(0);
        for (const r of world.reactors) {
          expect(r.hull).toBeGreaterThanOrEqual(0);
        }
        for (const enemy of world.enemies) {
          const hitRadius = SHIP_STATS.enemies[enemy.kind].hitRadius;
          if (isInsideArena(enemy.position, TRENCH_ARENA, hitRadius - 0.01)) aiInWallTicks += 1;
          enemyTicks += 1;
          if (isInsideArena(enemy.position, TRENCH_ARENA, hitRadius + COMBAT_TUNING.aiHullClearance + 0.1)) enemyGrindingTicks += 1;
        }
        if (isInsideArena(world.wingmate.position, TRENCH_ARENA, 6.99)) aiInWallTicks += 1;
        if (world.phase.kind !== 'active') {
          world = stepWorld(world, { ...NEUTRAL_INPUT, restartSortie: true }, FIXED_DT);
          expect(world.sortie.level).toBe('trench');
        }
      }
      expect(aiInWallTicks).toBe(0);
      // The run must actually happen inside the spine, and AI must steer, not lean on the slide.
      expect(insideTrenchTicks / 3600).toBeGreaterThan(0.3);
      expect(enemyGrindingTicks / enemyTicks).toBeLessThan(0.08);
    }
  }, 60_000);
});
