import { describe, expect, it } from 'vitest';
import { add, distance, IDENTITY_QUAT, len, nextRandom, normalize, quatLookAt, scale, segmentBoxEntry, sub, vec3 } from '../src/sim/math';
import { resolveTerrainClearance } from '../src/sim/planetary';
import {
  AIR_WAVE,
  GROUND_TARGET_PLACEMENTS,
  GROUND_TARGET_SPECS,
  PLANETARY_TUNING,
  segmentTerrainEntry,
  TERRACE_HEIGHTS,
  TERRAIN_BOXES,
  terrainHeightAt,
} from '../src/sim/planetaryLayout';
import {
  DEFAULT_SORTIE_SEED,
  FIXED_DT,
  NEUTRAL_INPUT,
  type GroundTargetState,
  type PlanetaryState,
  type ProjectileState,
  type SimEvent,
  type Vec3,
  type WorldState,
} from '../src/sim/types';
import { createInitialWorld, createPlanetarySortieConfig, PLANETARY_SORTIE_ID, stepWorld } from '../src/sim/world';

function planetaryWorld(airWave = false): WorldState {
  return createInitialWorld(DEFAULT_SORTIE_SEED, true, createPlanetarySortieConfig({ airWave }));
}

function planetaryOf(world: WorldState): PlanetaryState {
  if (world.planetary === null) throw new Error('expected a planetary sortie');
  return world.planetary;
}

function withGround(world: WorldState, edit: (target: GroundTargetState, index: number) => GroundTargetState): WorldState {
  const planetary = planetaryOf(world);
  return { ...world, planetary: { ...planetary, groundTargets: planetary.groundTargets.map(edit) } };
}

function boltAt(id: string, target: Vec3, from: Vec3): ProjectileState {
  return {
    id,
    kind: 'bolt',
    faction: 'friendly',
    owner: 'player',
    position: from,
    velocity: scale(normalize(sub(target, from)), 560),
    targetId: null,
    damage: 200,
    ttl: 0.9,
  };
}

function step(world: WorldState, ticks = 1): { readonly world: WorldState; readonly events: readonly SimEvent[] } {
  let current = world;
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i += 1) {
    current = stepWorld(current, NEUTRAL_INPUT, FIXED_DT);
    events.push(...current.events);
  }
  return { world: current, events };
}

function insideAnyTerrace(p: Vec3): boolean {
  return TERRAIN_BOXES.some(
    (b) =>
      Math.abs(p.x - b.center.x) < b.halfExtents.x &&
      Math.abs(p.y - b.center.y) < b.halfExtents.y &&
      Math.abs(p.z - b.center.z) < b.halfExtents.z,
  );
}

describe('planetary terrain layout', () => {
  it('is a flat floor with stepped terraces, and every ground target sits on clear floor inside the valley', () => {
    expect(terrainHeightAt(0, 0)).toBe(0);
    expect(terrainHeightAt(-2400, 0)).toBe(TERRACE_HEIGHTS[TERRACE_HEIGHTS.length - 1]);
    const heights = new Set(TERRAIN_BOXES.map((b) => b.center.y + b.halfExtents.y));
    for (const h of heights) {
      expect(TERRACE_HEIGHTS.some((tier) => tier === h) || (h >= 20 && h <= 120)).toBe(true);
    }
    for (const placement of GROUND_TARGET_PLACEMENTS) {
      expect(terrainHeightAt(placement.x, placement.z)).toBe(0);
    }
  });

  it('stops a swept segment at the floor and at a terrace face', () => {
    expect(segmentTerrainEntry(vec3(0, 10, 0), vec3(0, -10, 0))).toBeCloseTo(0.5, 6);
    expect(segmentTerrainEntry(vec3(0, 50, 0), vec3(0, 40, 0))).toBeNull();
    const wall = segmentTerrainEntry(vec3(0, 20, 0), vec3(-2000, 20, 0));
    expect(wall).not.toBeNull();
    const hitX = -2000 * (wall ?? 1);
    expect(terrainHeightAt(hitX - 1, 0)).toBeGreaterThan(20);
    expect(terrainHeightAt(hitX + 1, 0)).toBeLessThan(20);
  });

  it('bounces a diving fighter off the floor and a cliff, never leaving it inside rock', () => {
    const floor = resolveTerrainClearance(vec3(0, 1, 0), vec3(0, 1, 0), vec3(0, -60, -60));
    expect(floor.position.y).toBeGreaterThanOrEqual(PLANETARY_TUNING.terrainClearance);
    expect(floor.velocity.y).toBeGreaterThan(0);
    expect(floor.impactSpeed).toBeCloseTo(60, 6);

    const edge = TERRAIN_BOXES.find((b) => b.id === 'wall-l0-t0');
    if (edge === undefined) throw new Error('missing wall');
    const face = edge.center.x + edge.halfExtents.x;
    const cliff = resolveTerrainClearance(vec3(face - 1, 20, edge.center.z), vec3(face - 1, 20, edge.center.z), vec3(-90, 0, 0));
    expect(cliff.position.x).toBeGreaterThan(face);
    expect(cliff.velocity.x).toBeGreaterThan(0);
    expect(cliff.warning).toBe(true);
  });

  it('sweeps a fast step that would cut the padded corner of butte-a', () => {
    const butte = TERRAIN_BOXES.find((b) => b.id === 'butte-a-t0');
    if (butte === undefined) throw new Error('missing butte');
    const margin = PLANETARY_TUNING.terrainClearance;
    const padded = add(butte.halfExtents, vec3(margin, margin, margin));
    // One 152.7 m/s tick whose ends both sit outside the padded box while its middle cuts the corner.
    const from = vec3(-90.6, 20, 297.8);
    const to = vec3(-92.4, 20, 299.6);
    expect(segmentBoxEntry(from, to, butte.center, IDENTITY_QUAT, padded)).not.toBeNull();
    const swept = resolveTerrainClearance(from, to, vec3(-108, 0, 108));
    const shrunk = add(padded, vec3(-0.01, -0.01, -0.01));
    expect(segmentBoxEntry(from, swept.position, butte.center, IDENTITY_QUAT, shrunk)).toBeNull();
  });

  it('keeps the player out of a live relay instead of flying through it', () => {
    const relay = planetaryOf(planetaryWorld()).groundTargets.find((t) => t.id === 'relay-1');
    if (relay === undefined) throw new Error('missing relay');
    let world = planetaryWorld();
    const start = add(relay.position, vec3(0, 0, 60));
    world = { ...world, player: { ...world.player, position: start, velocity: vec3(0, 0, -110), orientation: quatLookAt(vec3(0, 0, -1)) } };
    let closest = Infinity;
    for (let tick = 0; tick < 90; tick += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
      closest = Math.min(closest, distance(world.player.position, relay.position));
    }
    expect(closest).toBeGreaterThanOrEqual(relay.hitRadius + PLANETARY_TUNING.terrainClearance - 0.01);
  });

  it('never pins the wingmate against butte-a while it tries to rejoin a player on the far side', () => {
    let world = planetaryWorld();
    const hold = { position: vec3(-120, 40, 150), velocity: vec3(0, 0, -1), orientation: quatLookAt(vec3(0, 0, -1)) };
    world = { ...world, wingmate: { ...world.wingmate, position: vec3(-150, 48, 345), velocity: vec3(0, 0, -60), orientation: quatLookAt(vec3(0, 0, -1)) } };
    let windowStart = world.wingmate.position;
    let slowestWindow = Infinity;
    for (let tick = 1; tick <= 600; tick += 1) {
      world = stepWorld({ ...world, player: { ...world.player, ...hold } }, NEUTRAL_INPUT, FIXED_DT);
      expect(insideAnyTerrace(world.wingmate.position)).toBe(false);
      if (tick % 120 === 0) {
        slowestWindow = Math.min(slowestWindow, distance(world.wingmate.position, windowStart));
        windowStart = world.wingmate.position;
      }
    }
    // Pressed into the face, it used to hold within a metre of one spot for the whole ten seconds.
    expect(slowestWindow).toBeGreaterThan(10);
  });

  it('scrapes the player for damage when they fly into the canyon floor', () => {
    let world = planetaryWorld();
    world = { ...world, player: { ...world.player, position: vec3(0, 5, 300), velocity: vec3(0, -70, -40), orientation: quatLookAt(normalize(vec3(0, -1, -0.6))) } };
    const before = world.player.energy.shieldCharge + world.player.hull;
    const { world: after, events } = step(world);
    expect(after.player.position.y).toBeGreaterThanOrEqual(PLANETARY_TUNING.terrainClearance);
    expect(after.player.energy.shieldCharge + after.player.hull).toBeLessThan(before);
    expect(events.some((e) => e.kind === 'player_damaged')).toBe(true);
    expect(planetaryOf(after).terrainWarning).toBe(true);
  });
});

describe('planetary ground battle', () => {
  it('starts in stage 1 with no air enemies and does not count as won', () => {
    const world = planetaryWorld();
    expect(world.sortie.id).toBe(PLANETARY_SORTIE_ID);
    expect(world.enemies).toHaveLength(0);
    expect(planetaryOf(world).stage.kind).toBe('ground_attack');
    const { world: later } = step(world, 30);
    expect(later.phase.kind).toBe('active');
  });

  it('keeps the Saturn sortie free of planetary state', () => {
    expect(createInitialWorld(DEFAULT_SORTIE_SEED, true).planetary).toBeNull();
  });

  it('lets terrain eat a bolt before it reaches a target hidden behind a butte', () => {
    let world = planetaryWorld();
    const butte = TERRAIN_BOXES.find((b) => b.id === 'butte-b-t0');
    if (butte === undefined) throw new Error('missing butte');
    const hidden = vec3(butte.center.x - butte.halfExtents.x - 15, 6, butte.center.z);
    world = withGround(world, (t, i) => (i === 0 ? { ...t, position: hidden } : t));
    const from = vec3(butte.center.x + butte.halfExtents.x + 40, 6, butte.center.z);
    world = { ...world, projectiles: [boltAt('pb-test', hidden, from)] };
    const { world: after, events } = step(world, 20);
    expect(planetaryOf(after).groundTargets[0]?.hull).toBe(GROUND_TARGET_SPECS.flak.hull);
    expect(events.some((e) => e.kind === 'hit_confirmed')).toBe(false);
    expect(after.projectiles.some((p) => p.id === 'pb-test')).toBe(false);
  });

  it('shields the siege gun until its relay falls', () => {
    let world = planetaryWorld();
    const gun = planetaryOf(world).groundTargets.find((t) => t.kind === 'artillery');
    const relay = planetaryOf(world).groundTargets.find((t) => t.kind === 'relay');
    if (gun === undefined || relay === undefined) throw new Error('missing targets');
    const from = add(gun.position, vec3(0, 40, 60));
    world = { ...world, projectiles: [boltAt('pb-gun', gun.position, from)] };
    const shielded = step(world, 10).world;
    expect(planetaryOf(shielded).groundTargets.find((t) => t.id === gun.id)?.hull).toBe(gun.maxHull);

    world = withGround(world, (t) => (t.id === relay.id ? { ...t, hull: 0 } : t));
    const open = step(world, 10).world;
    expect(planetaryOf(open).groundTargets.find((t) => t.id === gun.id)?.hull).toBe(0);
  });

  it('scrambles the air wave once half the ground targets are down', () => {
    let world = planetaryWorld();
    const threshold = PLANETARY_TUNING.airWaveThreshold;
    world = withGround(world, (t, i) => (i < threshold - 1 ? { ...t, hull: 0 } : t));
    world = { ...world, planetary: { ...planetaryOf(world), groundTargetsDestroyed: threshold - 1 } };
    const last = planetaryOf(world).groundTargets[threshold - 1];
    if (last === undefined) throw new Error('missing target');
    world = { ...world, projectiles: [boltAt('pb-last', last.position, add(last.position, vec3(0, 30, 40)))] };

    const { world: after, events } = step(world, 10);
    expect(events.some((e) => e.kind === 'ground_target_destroyed')).toBe(true);
    expect(events.filter((e) => e.kind === 'air_wave_inbound')).toHaveLength(1);
    expect(planetaryOf(after).stage.kind).toBe('air_superiority');
    expect(after.enemies.map((e) => e.id).sort()).toEqual(AIR_WAVE.map((w) => w.id).sort());
    expect(after.phase.kind).toBe('active');
  });

  it('wins only after both the ground targets and the air wave are destroyed', () => {
    let world = planetaryWorld(true);
    world = withGround(world, (t) => ({ ...t, hull: 0 }));
    const groundOnly = step(world).world;
    expect(groundOnly.phase.kind).toBe('active');

    const bothDone = step({ ...world, enemies: [] }).world;
    expect(bothDone.phase.kind).toBe('victory');
    if (bothDone.phase.kind === 'victory') {
      expect(bothDone.phase.subsystemsDestroyed).toBe(planetaryOf(world).groundTargetsDestroyed);
    }

    const airOnly = step({ ...world, enemies: [], planetary: planetaryOf(planetaryWorld(true)) }).world;
    expect(airOnly.phase.kind).toBe('active');
  });

  it('fires telegraphed flak above 40 m and holds fire when the player hugs the floor', () => {
    const base = planetaryWorld();
    const flak = planetaryOf(base).groundTargets[0];
    if (flak === undefined) throw new Error('missing flak');
    const hold = (y: number): WorldState => ({
      ...base,
      enemies: [],
      player: {
        ...base.player,
        position: vec3(flak.position.x + 10, y, flak.position.z + 400),
        velocity: vec3(0, 0, -64),
        orientation: quatLookAt(vec3(0, 0, -1)),
      },
    });
    const run = (y: number): { flak: number; charged: boolean; bursts: number } => {
      let world = hold(y);
      let shells = 0;
      let charged = false;
      let bursts = 0;
      for (let i = 0; i < 240; i += 1) {
        world = stepWorld({ ...world, player: { ...world.player, position: { ...world.player.position, z: flak.position.z + 400 } } }, NEUTRAL_INPUT, FIXED_DT);
        shells = Math.max(shells, world.projectiles.filter((p) => p.kind === 'flak').length);
        charged ||= (planetaryOf(world).groundTargets[0]?.charge ?? 0) > 0.5;
        bursts += world.events.filter((e) => e.kind === 'flak_burst').length;
      }
      return { flak: shells, charged, bursts };
    };
    const high = run(150);
    expect(high.flak).toBeGreaterThan(0);
    expect(high.charged).toBe(true);
    expect(high.bursts).toBeGreaterThan(0);
    const low = run(PLANETARY_TUNING.flakMinAltitude - 15);
    expect(low.flak).toBe(0);
  });

  it('marches the walkers down the road toward the outpost', () => {
    const world = planetaryWorld();
    const before = planetaryOf(world).groundTargets.filter((t) => t.kind === 'walker');
    const after = planetaryOf(step(world, 240).world).groundTargets.filter((t) => t.kind === 'walker');
    before.forEach((walker, i) => {
      const moved = after[i];
      expect(moved?.position.z ?? 0).toBeGreaterThan(walker.position.z + 10);
    });
  });

  it('gives an untouched outpost three to five minutes before the siege overruns it', () => {
    let world = planetaryWorld();
    let fellAt: number | null = null;
    for (let tick = 0; tick < 60 * 300 && fellAt === null; tick += 1) {
      // Park the player out of flak reach so only the ground war runs.
      world = stepWorld({ ...world, player: { ...world.player, position: vec3(0, 30, 1500), hull: world.player.maxHull } }, NEUTRAL_INPUT, FIXED_DT);
      if (world.phase.kind === 'failed') fellAt = tick / 60;
    }
    expect(world.phase.kind === 'failed' && world.phase.reason).toBe('FORWARD OUTPOST OVERRUN');
    expect(fellAt).toBeGreaterThan(180);
    expect(fellAt).toBeLessThan(300);
  });

  it('survives 60 seconds of randomized flight over the canyon with finite state and no ship inside rock', () => {
    let world = planetaryWorld();
    let seed = 0xc0ffee;
    let sawAirWave = false;
    const finite = (v: Vec3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    for (let tick = 0; tick < 3600; tick += 1) {
      const before = new Map([...world.enemies.map((e) => [e.id, e.position] as const), ['wingmate', world.wingmate.position] as const]);
      const r1 = nextRandom(seed);
      const r2 = nextRandom(r1.nextState);
      const r3 = nextRandom(r2.nextState);
      seed = r3.nextState;
      world = stepWorld(
        world,
        {
          ...NEUTRAL_INPUT,
          pitch: (r1.value - 0.55) * 1.6,
          yaw: (r2.value - 0.5) * 1.4,
          roll: r3.value > 0.8 ? 1 : r3.value < 0.2 ? -1 : 0,
          throttleDelta: r1.value > 0.6 ? 1 : 0,
          throttlePushEdge: tick % 150 === 0,
          firePrimary: r3.value > 0.4,
          fireMissile: tick % 90 === 0,
          fireMissilePressed: tick % 90 === 0,
        },
        FIXED_DT,
      );
      if (tick === 1200) {
        // Force the hand-off mid-run so both stages are exercised.
        world = withGround(world, (t, i) => (i < PLANETARY_TUNING.airWaveThreshold ? { ...t, hull: 0 } : t));
        world = { ...world, planetary: { ...planetaryOf(world), groundTargetsDestroyed: PLANETARY_TUNING.airWaveThreshold } };
      }
      const planetary = planetaryOf(world);
      sawAirWave ||= planetary.stage.kind === 'air_superiority';
      // No NPC may teleport over a ledge: the fastest one covers about 2.2 m per tick.
      for (const [id, pos] of [...world.enemies.map((e) => [e.id, e.position] as const), ['wingmate', world.wingmate.position] as const]) {
        const prev = before.get(id);
        if (prev !== undefined && world.tick > 1) expect(len(sub(pos, prev))).toBeLessThan(5);
      }
      expect(finite(world.player.position) && finite(world.player.velocity)).toBe(true);
      expect(insideAnyTerrace(world.player.position)).toBe(false);
      expect(world.player.position.y).toBeGreaterThan(0);
      expect(finite(world.wingmate.position)).toBe(true);
      for (const enemy of world.enemies) {
        expect(finite(enemy.position) && finite(enemy.velocity)).toBe(true);
        expect(enemy.position.y).toBeGreaterThanOrEqual(terrainHeightAt(enemy.position.x, enemy.position.z));
      }
      for (const target of planetary.groundTargets) {
        expect(finite(target.position)).toBe(true);
        expect(target.hull).toBeGreaterThanOrEqual(0);
      }
      for (const proj of world.projectiles) {
        expect(finite(proj.position) && len(proj.velocity) < 2000).toBe(true);
      }
      if (world.phase.kind !== 'active') {
        world = stepWorld(world, { ...NEUTRAL_INPUT, restartSortie: true }, FIXED_DT);
        expect(world.planetary).not.toBeNull();
      }
    }
    expect(sawAirWave).toBe(true);
  });
});
