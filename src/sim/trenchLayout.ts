import { arenaBox, arenaSphere } from './arena';
import { quatFromAxisAngle, quatMul, vec3 } from './math';
import type { ArenaSolid, Quat, ReactorState, Vec3 } from './types';

/**
 * Level 2: a fractured hollow asteroid with an industrial spine run through it. The run is along
 * -z from the mouth at +halfLength to the cold exit gap at -halfLength. Sim collision and the
 * render meshes are both built from the arrays below, so a wall you can see is a wall you hit.
 */
export const TRENCH_DIMENSIONS = {
  halfLength: 900,
  /** Inner faces of the smoothest wall slabs; slabs only ever step outward from here. */
  wallInnerX: 78,
  floorY: -51.5,
  ceilingY: 51.5,
  wallThickness: 30,
  slabThickness: 20,
  slabLength: 200,
  /** Ribs stand this far proud of the wall, so depth ink draws them at trench range. */
  ribProud: 8,
  ribHalfDepth: 3,
  ribSpacing: 72,
} as const;

const D = TRENCH_DIMENSIONS;

/** Clear rib-to-rib flight envelope: 140 m wide x 95 m tall. */
export const TRENCH_CLEARANCE = {
  halfWidth: D.wallInnerX - D.ribProud,
  bottom: D.floorY,
  top: D.ceilingY - D.ribProud,
} as const;

/** The far opening is the level's one hero landmark: a cold gap at the end of a warm trench. */
export const TRENCH_COLD_GAP = {
  center: vec3(0, 0, -D.halfLength),
  halfWidth: D.wallInnerX,
  halfHeight: D.ceilingY,
} as const;

// Deterministic strata: how far each 200 m slab steps back from the smoothest face.
const WALL_STEPS = [0, 3, 6, 3, 0, 6, 3, 0, 3] as const;
const FLOOR_STEPS = [0, 2, 0, 4, 2, 0, 2, 4, 0] as const;
const CEILING_STEPS = [2, 0, 4, 0, 2, 0, 0, 3, 0] as const;
/** Ceiling slabs left out: fractures open to the void above. */
const CEILING_FRACTURES = new Set([2, 4, 7]);

function slabCenterZ(index: number): number {
  return D.halfLength - D.slabLength * (index + 0.5);
}

function yawRoll(yaw: number, roll: number): Quat {
  return quatMul(quatFromAxisAngle(vec3(0, 1, 0), yaw), quatFromAxisAngle(vec3(0, 0, 1), roll));
}

function buildShell(): ArenaSolid[] {
  const solids: ArenaSolid[] = [];
  const wallHalfY = (D.ceilingY - D.floorY) / 2 + D.slabThickness + 6;
  WALL_STEPS.forEach((step, i) => {
    const z = slabCenterZ(i);
    const inner = D.wallInnerX + step;
    for (const side of [-1, 1] as const) {
      solids.push(
        arenaBox(
          `wall-${side < 0 ? 'l' : 'r'}-${i}`,
          'wall',
          vec3(side * (inner + D.wallThickness / 2), 0, z),
          vec3(D.wallThickness / 2, wallHalfY, D.slabLength / 2),
        ),
      );
    }
  });
  const spanHalfX = D.wallInnerX + 6 + D.wallThickness;
  FLOOR_STEPS.forEach((step, i) => {
    const top = D.floorY - step;
    solids.push(
      arenaBox(`floor-${i}`, 'wall', vec3(0, top - D.slabThickness / 2, slabCenterZ(i)), vec3(spanHalfX, D.slabThickness / 2, D.slabLength / 2)),
    );
  });
  CEILING_STEPS.forEach((step, i) => {
    if (CEILING_FRACTURES.has(i)) return;
    const bottom = D.ceilingY + step;
    solids.push(
      arenaBox(`ceiling-${i}`, 'wall', vec3(0, bottom + D.slabThickness / 2, slabCenterZ(i)), vec3(spanHalfX, D.slabThickness / 2, D.slabLength / 2)),
    );
  });
  // One broken plate leans into each fracture, so the opening reads as torn rather than cut.
  for (const i of CEILING_FRACTURES) {
    const side = i % 2 === 0 ? -1 : 1;
    solids.push(
      arenaBox(
        `fracture-plate-${i}`,
        'wall',
        vec3(side * 48, D.ceilingY + 16, slabCenterZ(i) + 40),
        vec3(44, 6, 46),
        yawRoll(0.22 * side, -0.32 * side),
      ),
    );
  }
  return solids;
}

export interface RibStation {
  readonly id: string;
  readonly z: number;
}

/** Evenly spaced arches from mouth to exit; their guide strips point down the run at the cold gap. */
export const TRENCH_RIB_STATIONS: readonly RibStation[] = Array.from(
  { length: Math.floor((2 * D.halfLength - 2 * 36) / D.ribSpacing) + 1 },
  (_, k) => ({ id: `rib-${k}`, z: D.halfLength - 36 - D.ribSpacing * k }),
);

function buildRibs(): ArenaSolid[] {
  const solids: ArenaSolid[] = [];
  const pillarOuter = D.wallInnerX + 8;
  const pillarHalfX = (pillarOuter - TRENCH_CLEARANCE.halfWidth) / 2;
  const pillarCenterX = (pillarOuter + TRENCH_CLEARANCE.halfWidth) / 2;
  const beamHalfY = 5;
  for (const station of TRENCH_RIB_STATIONS) {
    for (const side of [-1, 1] as const) {
      solids.push(
        arenaBox(
          `${station.id}-${side < 0 ? 'l' : 'r'}`,
          'rib',
          vec3(side * pillarCenterX, 0, station.z),
          vec3(pillarHalfX, (D.ceilingY - D.floorY) / 2, D.ribHalfDepth),
        ),
      );
    }
    solids.push(
      arenaBox(
        `${station.id}-beam`,
        'rib',
        vec3(0, TRENCH_CLEARANCE.top + beamHalfY, station.z),
        vec3(pillarOuter, beamHalfY, D.ribHalfDepth),
      ),
    );
  }
  return solids;
}

/** Wall-to-wall catwalks, alternately overhead and low, each a deliberate fly-under/over beat. */
export const TRENCH_GANTRIES: readonly { readonly id: string; readonly z: number; readonly bottom: number; readonly top: number }[] = [
  { id: 'gantry-1', z: 520, bottom: 16, top: 24 },
  { id: 'gantry-2', z: 120, bottom: -34, top: -26 },
  { id: 'gantry-3', z: -300, bottom: 18, top: 26 },
  // Carries the last conduit core slung under it.
  { id: 'gantry-4', z: -612, bottom: 30, top: 37 },
];

function buildGantries(): ArenaSolid[] {
  return TRENCH_GANTRIES.map((g) =>
    arenaBox(g.id, 'gantry', vec3(0, (g.bottom + g.top) / 2, g.z), vec3(D.wallInnerX + 8, (g.top - g.bottom) / 2, 4)),
  );
}

/** Tilted rock slabs standing against the walls: cover inside the run, never across its middle. */
function buildMonoliths(): ArenaSolid[] {
  const specs: readonly [number, number, number, number, number, number, number, number][] = [
    // x, y, z, half x, half y, half z, yaw, roll
    [-58, -25, 640, 9, 27, 16, 0.25, -0.08],
    [60, -22, 420, 8, 30, 14, -0.3, 0.1],
    [-60, -24, 10, 9, 28, 15, 0.2, 0.07],
    [58, -26, -420, 8, 26, 16, -0.22, -0.09],
    [-56, -20, -780, 9, 31, 14, 0.28, 0.1],
  ];
  return specs.map(([x, y, z, hx, hy, hz, yaw, roll], i) =>
    arenaBox(`monolith-${i}`, 'monolith', vec3(x, y, z), vec3(hx, hy, hz), yawRoll(yaw, roll)),
  );
}

/** Indestructible rock: the asteroid's fractured outer mass, framing the mouth and the cold gap. */
const ROCKS: readonly [number, number, number, number][] = [
  [-230, 10, 700, 130],
  [240, -40, 520, 140],
  [-250, 60, 150, 150],
  [260, 30, -80, 160],
  [-240, -60, -380, 140],
  [230, 70, -620, 130],
  [0, 220, 420, 150],
  [20, -230, -200, 160],
  [-10, 210, -500, 140],
  [-190, -90, 960, 90],
  [170, 110, 1000, 80],
  [-200, 80, -980, 100],
  [210, -70, -1000, 110],
  [-520, -120, 300, 220],
  [560, 140, -300, 240],
  [-480, 200, -850, 200],
  [500, -180, 850, 210],
];

/** Fraction of its radius a rock facet may sit off the collider sphere, in or out. */
export const TRENCH_ROCK_FACET_JITTER = 0.07;

function buildRocks(): ArenaSolid[] {
  return ROCKS.map(([x, y, z, r], i) => arenaSphere(`rock-${i}`, 'rock', vec3(x, y, z), r));
}

interface ReactorMount {
  readonly reactor: ReactorState;
  readonly pylon: { readonly center: Vec3; readonly halfExtents: Vec3 } | null;
}

const REACTOR_HULL = 220;
const CORE_RADIUS = 9;

function reactor(id: string, label: string, position: Vec3): ReactorState {
  return { id, label, position, radius: CORE_RADIUS, hull: REACTOR_HULL, maxHull: REACTOR_HULL };
}

/** Three conduit cores you have to fly into the spine to reach: floor-mounted, ceiling-hung, and slung under the last gantry. */
export const TRENCH_REACTOR_MOUNTS: readonly ReactorMount[] = [
  {
    reactor: reactor('reactor-a', 'CONDUIT CORE A', vec3(-44, -19, 300)),
    pylon: { center: vec3(-44, -40, 300), halfExtents: vec3(5, 11.5, 5) },
  },
  {
    reactor: reactor('reactor-b', 'CONDUIT CORE B', vec3(44, 15.5, -120)),
    pylon: { center: vec3(44, 38, -120), halfExtents: vec3(5, 13.5, 5) },
  },
  {
    reactor: reactor('reactor-c', 'CONDUIT CORE C', vec3(0, 21, -612)),
    pylon: null,
  },
];

export const TRENCH_REACTORS: readonly ReactorState[] = TRENCH_REACTOR_MOUNTS.map((m) => m.reactor);

function buildReactorMounts(): ArenaSolid[] {
  const solids: ArenaSolid[] = [];
  for (const mount of TRENCH_REACTOR_MOUNTS) {
    const r = mount.reactor;
    solids.push(arenaSphere(`${r.id}-core`, 'core', r.position, r.radius, r.id));
    if (mount.pylon !== null) {
      solids.push(arenaBox(`${r.id}-pylon`, 'pylon', mount.pylon.center, mount.pylon.halfExtents));
    }
  }
  return solids;
}

export const TRENCH_ARENA: readonly ArenaSolid[] = [
  ...buildShell(),
  ...buildRibs(),
  ...buildGantries(),
  ...buildMonoliths(),
  ...buildRocks(),
  ...buildReactorMounts(),
];

/** Interior guard posts: one raider holds station at each until the player closes in. */
export const TRENCH_PATROL_POSTS: readonly Vec3[] = [
  vec3(0, -10, 560),
  vec3(10, 5, 150),
  vec3(-15, -5, -330),
  vec3(0, -8, -720),
];
