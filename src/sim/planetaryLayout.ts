import { IDENTITY_QUAT, segmentBoxEntry, vec3 } from './math';
import type { GroundTargetKind, Vec3 } from './types';

/**
 * Sunset canyon layout shared by the sim (collision, hit tests, AI) and the renderer (meshes, pads),
 * so what you see is exactly what you hit. The terrain is a floor plane at y = 0 plus axis-aligned
 * terrace boxes: every ledge is a vertical step, which the ink pass reads as a depth edge.
 */
export interface TerrainBox {
  readonly id: string;
  readonly center: Vec3;
  readonly halfExtents: Vec3;
  /** Strata index from the canyon floor up; the renderer picks the band tone from it. */
  readonly tier: number;
}

export const TERRACE_HEIGHTS = [45, 90, 135, 185] as const;
const TERRACE_SETBACKS = [0, 70, 150, 260] as const;
const TERRAIN_OUTER_X = 2600;
const WALL_SEGMENT_LENGTH = 400;
const WALL_FIRST_Z = 1700;
const WALL_SEGMENTS = 10;
const END_WALL_NEAR_Z = { north: 1800, south: -2300 } as const;
const END_WALL_STEP = 80;
const END_WALL_DEPTH = 900;
// Neighbouring boxes overlap so their shared faces never sit coplanar and flicker.
const SEAM_OVERLAP = 3;

function box(id: string, minX: number, maxX: number, minZ: number, maxZ: number, height: number, tier: number): TerrainBox {
  return {
    id,
    center: vec3((minX + maxX) * 0.5, height * 0.5, (minZ + maxZ) * 0.5),
    halfExtents: vec3((maxX - minX) * 0.5, height * 0.5, (maxZ - minZ) * 0.5),
    tier,
  };
}

/** Inner edge of each canyon wall; it steps per segment so the valley bends and the next stretch stays hidden. */
export function wallInnerEdge(segment: number, side: 'left' | 'right'): number {
  return side === 'left'
    ? -(230 + 70 * Math.sin(segment * 1.7 + 0.4))
    : 230 + 70 * Math.sin(segment * 1.3 + 2.1);
}

function buildTerrain(): readonly TerrainBox[] {
  const boxes: TerrainBox[] = [];
  for (let k = 0; k < WALL_SEGMENTS; k += 1) {
    const maxZ = WALL_FIRST_Z - k * WALL_SEGMENT_LENGTH + SEAM_OVERLAP;
    const minZ = maxZ - WALL_SEGMENT_LENGTH - SEAM_OVERLAP * 2;
    const left = wallInnerEdge(k, 'left');
    const right = wallInnerEdge(k, 'right');
    TERRACE_HEIGHTS.forEach((height, tier) => {
      const setback = TERRACE_SETBACKS[tier] ?? 0;
      boxes.push(box(`wall-l${k}-t${tier}`, -TERRAIN_OUTER_X, left - setback, minZ, maxZ, height, tier));
      boxes.push(box(`wall-r${k}-t${tier}`, right + setback, TERRAIN_OUTER_X, minZ, maxZ, height, tier));
    });
  }
  TERRACE_HEIGHTS.forEach((height, tier) => {
    const north = END_WALL_NEAR_Z.north + tier * END_WALL_STEP;
    const south = END_WALL_NEAR_Z.south - tier * END_WALL_STEP;
    boxes.push(box(`end-n-t${tier}`, -TERRAIN_OUTER_X, TERRAIN_OUTER_X, north, north + END_WALL_DEPTH, height, tier));
    boxes.push(box(`end-s-t${tier}`, -TERRAIN_OUTER_X, TERRAIN_OUTER_X, south - END_WALL_DEPTH, south, height, tier));
  });
  // Buttes on the canyon floor, kept clear of the walker road and the target pads.
  const buttes = [
    { id: 'butte-a', x: -150, z: 250, half: [55, 45], top: [30, 26], heights: [55, 100] },
    { id: 'butte-b', x: -125, z: -420, half: [55, 45], top: [30, 26], heights: [60, 105] },
    { id: 'butte-c', x: 135, z: -1050, half: [50, 50], top: [28, 30], heights: [50, 95] },
  ] as const;
  for (const butte of buttes) {
    boxes.push(box(`${butte.id}-t0`, butte.x - butte.half[0], butte.x + butte.half[0], butte.z - butte.half[1], butte.z + butte.half[1], butte.heights[0], 0));
    boxes.push(box(`${butte.id}-t1`, butte.x - butte.top[0], butte.x + butte.top[0], butte.z - butte.top[1], butte.z + butte.top[1], butte.heights[1], 1));
  }
  return boxes;
}

export const TERRAIN_BOXES: readonly TerrainBox[] = buildTerrain();

export const TERRAIN_EXTENT = {
  minX: -TERRAIN_OUTER_X,
  maxX: TERRAIN_OUTER_X,
  minZ: END_WALL_NEAR_Z.south - (TERRACE_HEIGHTS.length - 1) * END_WALL_STEP - END_WALL_DEPTH,
  maxZ: END_WALL_NEAR_Z.north + (TERRACE_HEIGHTS.length - 1) * END_WALL_STEP + END_WALL_DEPTH,
  plateauHeight: TERRACE_HEIGHTS[TERRACE_HEIGHTS.length - 1],
} as const;

/** Ground height under (x, z): the canyon floor, or the top of the tallest terrace standing there. */
export function terrainHeightAt(x: number, z: number): number {
  let height = 0;
  for (const b of TERRAIN_BOXES) {
    if (Math.abs(x - b.center.x) <= b.halfExtents.x && Math.abs(z - b.center.z) <= b.halfExtents.z) {
      height = Math.max(height, b.center.y + b.halfExtents.y);
    }
  }
  return height;
}

function overlapsBox(min: Vec3, max: Vec3, b: TerrainBox): boolean {
  return (
    max.x >= b.center.x - b.halfExtents.x && min.x <= b.center.x + b.halfExtents.x &&
    max.y >= b.center.y - b.halfExtents.y && min.y <= b.center.y + b.halfExtents.y &&
    max.z >= b.center.z - b.halfExtents.z && min.z <= b.center.z + b.halfExtents.z
  );
}

/** Earliest fraction along a → b where the segment enters the floor or a terrace, or null if it stays clear. */
export function segmentTerrainEntry(a: Vec3, b: Vec3): number | null {
  let best: number | null = null;
  if (b.y <= 0) {
    best = a.y <= 0 ? 0 : a.y / (a.y - b.y);
  }
  const min = vec3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
  const max = vec3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));
  for (const terrace of TERRAIN_BOXES) {
    if (!overlapsBox(min, max, terrace)) continue;
    const t = segmentBoxEntry(a, b, terrace.center, IDENTITY_QUAT, terrace.halfExtents);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

export interface GroundTargetSpec {
  readonly label: string;
  readonly hull: number;
  readonly hitRadius: number;
  /** Height of the hit sphere's centre above the pad; the mesh is built around the same point. */
  readonly centerHeight: number;
  readonly killCall: string;
}

export const GROUND_TARGET_SPECS: Readonly<Record<GroundTargetKind, GroundTargetSpec>> = {
  flak: { label: 'FLAK', hull: 54, hitRadius: 7.5, centerHeight: 5, killCall: 'Flak battery down! Sky is opening up.' },
  walker: { label: 'WALKER', hull: 72, hitRadius: 8.5, centerHeight: 11, killCall: 'Walker down! Convoy, push up!' },
  relay: { label: 'SHIELD RELAY', hull: 90, hitRadius: 8, centerHeight: 12, killCall: 'Relay is down, the gun is naked. Hit it!' },
  artillery: { label: 'SIEGE GUN', hull: 140, hitRadius: 11, centerHeight: 8, killCall: 'Siege gun destroyed! Outpost is breathing again.' },
};

export interface GroundTargetPlacement {
  readonly id: string;
  readonly kind: GroundTargetKind;
  readonly x: number;
  readonly z: number;
  /** Phase offset (s) so batteries never fire in lockstep. */
  readonly phase: number;
  readonly shieldedBy: string | null;
}

export const GROUND_TARGET_PLACEMENTS: readonly GroundTargetPlacement[] = [
  { id: 'flak-1', kind: 'flak', x: -125, z: -200, phase: 0.0, shieldedBy: null },
  { id: 'flak-2', kind: 'flak', x: 125, z: -600, phase: 0.9, shieldedBy: null },
  { id: 'flak-3', kind: 'flak', x: -125, z: -980, phase: 1.7, shieldedBy: null },
  { id: 'walker-1', kind: 'walker', x: 0, z: -720, phase: 0.0, shieldedBy: null },
  { id: 'walker-2', kind: 'walker', x: -24, z: -800, phase: 0.5, shieldedBy: null },
  { id: 'walker-3', kind: 'walker', x: 24, z: -780, phase: 1.1, shieldedBy: null },
  { id: 'relay-1', kind: 'relay', x: 110, z: -1300, phase: 0.0, shieldedBy: null },
  { id: 'siege-gun', kind: 'artillery', x: -20, z: -1480, phase: 2.0, shieldedBy: 'relay-1' },
];

/** Flat pads in the lightest terrain tone under each fixed target, so dark bodies read on light ground. */
export const TARGET_PAD_RADIUS: Readonly<Record<GroundTargetKind, number>> = {
  flak: 22,
  walker: 0,
  relay: 22,
  artillery: 32,
};

/** The walkers march on this light road toward the outpost; it doubles as their pad and as a leading line. */
export const WALKER_ROAD = { halfWidth: 45, minZ: -840, maxZ: 640 } as const;

export const FORWARD_OUTPOST = {
  id: 'outpost-grit',
  name: 'FWD OUTPOST GRIT',
  position: vec3(0, 12, 700),
  halfExtents: vec3(44, 12, 30),
  hull: 600,
} as const;

/** Friendly armor parked ahead of the outpost; it rolls forward as the ground targets fall. */
export const CONVOY_SLOTS: readonly Vec3[] = [
  vec3(-28, 0, 610),
  vec3(28, 0, 600),
  vec3(-28, 0, 560),
  vec3(28, 0, 550),
];
export const CONVOY_MAX_ADVANCE = 420;

export const CLOUD_DECK = { base: 560, top: 660 } as const;

export const PLANETARY_TUNING = {
  terrainClearance: 4,
  terrainWarnAltitude: 26,
  terrainLookAheadSeconds: 1.1,
  terrainRestitution: 0.35,
  terrainMinBounceSpeed: 18,
  terrainDamageThreshold: 12,
  terrainDamagePerSpeed: 0.42,
  npcMinAltitude: 24,
  flakRange: 1000,
  /** Below this height over a battery it cannot depress far enough to track you. */
  flakMinAltitude: 40,
  flakChargeSeconds: 0.6,
  flakCycleSeconds: 2.6,
  flakShellSpeed: 330,
  flakProximityFuse: 14,
  flakBurstRadius: 26,
  flakBurstDamage: 18,
  walkerSpeed: 9,
  walkerStopDistance: 170,
  walkerFireRange: 520,
  walkerFireInterval: 1.6,
  walkerBoltDamage: 9,
  artilleryInterval: 6.5,
  artilleryShellSpeed: 320,
  artilleryDamage: 26,
  /** Destroyed ground targets needed before the air wave scrambles. */
  airWaveThreshold: Math.ceil(GROUND_TARGET_PLACEMENTS.length / 2),
} as const;

export const AIR_WAVE = [
  { id: 'raider-w1', callsign: 'DUSK-1', kind: 'raider', position: vec3(-160, 760, -900), phase: 0.6 },
  { id: 'raider-w2', callsign: 'DUSK-2', kind: 'raider', position: vec3(40, 800, -1000), phase: 2.4 },
  { id: 'raider-w3', callsign: 'DUSK-3', kind: 'raider', position: vec3(200, 740, -880), phase: 4.1 },
  { id: 'striker-w1', callsign: 'HAMMER-1', kind: 'striker', position: vec3(0, 820, -1150), phase: 5.0 },
] as const;

export const PLAYER_START = { position: vec3(0, 130, 1150), speed: 64 } as const;
export const WINGMATE_START = vec3(-34, 138, 1172);
