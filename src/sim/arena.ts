import { add, dot, lenSq, normalize, rotateVec3, scale, sub, toLocalPoint } from './math';
import type { ArenaRole, ArenaSolid, Quat, Vec3 } from './types';

export interface ArenaHit {
  /** Entry fraction along a→b; 0 when a already starts inside. */
  readonly t: number;
  /** Outward surface normal at the entry point. */
  readonly normal: Vec3;
  readonly solid: ArenaSolid;
}

export function arenaBox(
  id: string,
  role: ArenaRole,
  center: Vec3,
  halfExtents: Vec3,
  orientation: Quat = { x: 0, y: 0, z: 0, w: 1 },
): ArenaSolid {
  return { kind: 'box', id, role, center, halfExtents, orientation, bound: Math.sqrt(lenSq(halfExtents)) };
}

export function arenaSphere(id: string, role: ArenaRole, center: Vec3, radius: number, reactorId: string | null = null): ArenaSolid {
  return { kind: 'sphere', id, role, center, radius, bound: radius, reactorId };
}

/** A padded box grows by `pad` on every axis, so its corners sit `pad·√3` past the unpadded bound. */
function paddedReach(pad: number): number {
  return pad * Math.sqrt(3);
}

/** Cheap reject: the segment never comes within the padded solid's bounding sphere. */
function segmentMissesBound(a: Vec3, b: Vec3, solid: ArenaSolid, pad: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const mx = solid.center.x - a.x;
  const my = solid.center.y - a.y;
  const mz = solid.center.z - a.z;
  const dd = dx * dx + dy * dy + dz * dz;
  const t = dd < 1e-12 ? 0 : Math.min(1, Math.max(0, (mx * dx + my * dy + mz * dz) / dd));
  const ex = mx - dx * t;
  const ey = my - dy * t;
  const ez = mz - dz * t;
  const r = solid.bound + (solid.kind === 'box' ? paddedReach(pad) : pad);
  return ex * ex + ey * ey + ez * ez > r * r;
}

const BUCKET_SIZE = 40;

interface ArenaIndex {
  readonly minZ: number;
  readonly buckets: readonly (readonly ArenaSolid[])[];
  /** Solids too long to bucket usefully; always tested. */
  readonly spanning: readonly ArenaSolid[];
}

const indexCache = new WeakMap<readonly ArenaSolid[], ArenaIndex>();

/** Buckets solids by their z extent; memoised per layout array, which never changes. */
function indexOf(solids: readonly ArenaSolid[]): ArenaIndex {
  const cached = indexCache.get(solids);
  if (cached !== undefined) return cached;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const solid of solids) {
    minZ = Math.min(minZ, solid.center.z - solid.bound);
    maxZ = Math.max(maxZ, solid.center.z + solid.bound);
  }
  const count = Number.isFinite(minZ) ? Math.ceil((maxZ - minZ) / BUCKET_SIZE) + 1 : 0;
  const buckets: ArenaSolid[][] = Array.from({ length: count }, () => []);
  const spanning: ArenaSolid[] = [];
  for (const solid of solids) {
    const lo = Math.floor((solid.center.z - solid.bound - minZ) / BUCKET_SIZE);
    const hi = Math.floor((solid.center.z + solid.bound - minZ) / BUCKET_SIZE);
    if (hi - lo > 8) {
      spanning.push(solid);
      continue;
    }
    for (let i = lo; i <= hi; i += 1) buckets[i]?.push(solid);
  }
  const index = { minZ, buckets, spanning };
  indexCache.set(solids, index);
  return index;
}

/** Every solid whose z extent the segment's padded z range could touch, each once. */
function candidates(a: Vec3, b: Vec3, solids: readonly ArenaSolid[], pad: number, visit: (solid: ArenaSolid) => void): void {
  const index = indexOf(solids);
  for (const solid of index.spanning) visit(solid);
  const reach = paddedReach(pad);
  const lo = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - index.minZ) / BUCKET_SIZE));
  const hi = Math.min(index.buckets.length - 1, Math.floor((Math.max(a.z, b.z) + reach - index.minZ) / BUCKET_SIZE));
  if (lo === hi) {
    for (const solid of index.buckets[lo] ?? []) visit(solid);
    return;
  }
  const seen = new Set<ArenaSolid>();
  for (let i = lo; i <= hi; i += 1) {
    for (const solid of index.buckets[i] ?? []) {
      if (!seen.has(solid)) {
        seen.add(solid);
        visit(solid);
      }
    }
  }
}

function sweepBox(a: Vec3, b: Vec3, solid: Extract<ArenaSolid, { kind: 'box' }>, pad: number): Omit<ArenaHit, 'solid'> | null {
  const la = toLocalPoint(solid.center, solid.orientation, a);
  const lb = toLocalPoint(solid.center, solid.orientation, b);
  let tMin = 0;
  let tMax = 1;
  let entryAxis: 'x' | 'y' | 'z' | null = null;
  let entrySign = 0;
  for (const axis of ['x', 'y', 'z'] as const) {
    const start = la[axis];
    const delta = lb[axis] - start;
    const half = solid.halfExtents[axis] + pad;
    if (Math.abs(delta) < 1e-12) {
      if (Math.abs(start) > half) return null;
      continue;
    }
    const t1 = (-half - start) / delta;
    const t2 = (half - start) / delta;
    const near = Math.min(t1, t2);
    if (near > tMin) {
      tMin = near;
      entryAxis = axis;
      entrySign = delta > 0 ? -1 : 1;
    }
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) return null;
  }

  let localNormal: Vec3;
  if (entryAxis === null) {
    // Starts inside: leave through the nearest face.
    let best: 'x' | 'y' | 'z' = 'x';
    let bestDepth = Infinity;
    for (const axis of ['x', 'y', 'z'] as const) {
      const depth = solid.halfExtents[axis] + pad - Math.abs(la[axis]);
      if (depth < bestDepth) {
        bestDepth = depth;
        best = axis;
      }
    }
    const sign = la[best] >= 0 ? 1 : -1;
    localNormal = { x: best === 'x' ? sign : 0, y: best === 'y' ? sign : 0, z: best === 'z' ? sign : 0 };
  } else {
    localNormal = {
      x: entryAxis === 'x' ? entrySign : 0,
      y: entryAxis === 'y' ? entrySign : 0,
      z: entryAxis === 'z' ? entrySign : 0,
    };
  }
  return { t: tMin, normal: rotateVec3(solid.orientation, localNormal) };
}

function sweepSphere(a: Vec3, b: Vec3, solid: Extract<ArenaSolid, { kind: 'sphere' }>, pad: number): Omit<ArenaHit, 'solid'> | null {
  const radius = solid.radius + pad;
  const m = sub(a, solid.center);
  const c = dot(m, m) - radius * radius;
  if (c <= 0) {
    return { t: 0, normal: normalize(m) };
  }
  const d = sub(b, a);
  const dd = dot(d, d);
  const md = dot(m, d);
  if (dd < 1e-12 || md >= 0) return null;
  const disc = md * md - dd * c;
  if (disc < 0) return null;
  const t = (-md - Math.sqrt(disc)) / dd;
  if (t > 1) return null;
  return { t, normal: normalize(add(m, scale(d, t))) };
}

/** Earliest entry of the segment a→b into any solid grown by `pad`. */
export function sweepArena(a: Vec3, b: Vec3, solids: readonly ArenaSolid[], pad: number): ArenaHit | null {
  if (solids.length === 0) return null;
  let best: ArenaHit | null = null;
  candidates(a, b, solids, pad, (solid) => {
    if (segmentMissesBound(a, b, solid, pad)) return;
    const hit = solid.kind === 'box' ? sweepBox(a, b, solid, pad) : sweepSphere(a, b, solid, pad);
    if (hit !== null && (best === null || hit.t < best.t)) {
      best = { ...hit, solid };
    }
  });
  return best;
}

export function isInsideArena(point: Vec3, solids: readonly ArenaSolid[], pad: number): boolean {
  return sweepArena(point, point, solids, pad) !== null;
}

/** Pushes a point out of every solid it sits inside, nearest face first. */
export function pushOutOfArena(point: Vec3, solids: readonly ArenaSolid[], pad: number): Vec3 {
  let p = point;
  for (let pass = 0; pass < 3; pass += 1) {
    let moved = false;
    for (const solid of solids) {
      if (solid.kind === 'sphere') {
        const offset = sub(p, solid.center);
        const radius = solid.radius + pad;
        if (lenSq(offset) < radius * radius) {
          p = add(solid.center, scale(normalize(offset), radius + ARENA_SKIN));
          moved = true;
        }
        continue;
      }
      const local = toLocalPoint(solid.center, solid.orientation, p);
      const depth = {
        x: solid.halfExtents.x + pad - Math.abs(local.x),
        y: solid.halfExtents.y + pad - Math.abs(local.y),
        z: solid.halfExtents.z + pad - Math.abs(local.z),
      };
      if (depth.x <= 0 || depth.y <= 0 || depth.z <= 0) continue;
      const axis = depth.x <= depth.y && depth.x <= depth.z ? 'x' : depth.y <= depth.z ? 'y' : 'z';
      const pushed = { ...local, [axis]: Math.sign(local[axis] || 1) * (solid.halfExtents[axis] + pad + ARENA_SKIN) };
      p = add(solid.center, rotateVec3(solid.orientation, pushed));
      moved = true;
    }
    if (!moved) break;
  }
  return p;
}

export const ARENA_SKIN = 0.05;
const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };

export interface ArenaMove {
  readonly position: Vec3;
  readonly velocity: Vec3;
  /** Largest closing speed into a surface this move, m/s. */
  readonly impactSpeed: number;
  readonly contactPoint: Vec3 | null;
}

/**
 * Moves from→to, sliding along any surface it meets instead of passing through. Closing speed
 * into the surface is reflected by `restitution`, with at least `minSeparation` m/s left pointing
 * away so a pilot nosed into a wall is never pinned to it.
 */
export function moveThroughArena(
  from: Vec3,
  to: Vec3,
  velocity: Vec3,
  solids: readonly ArenaSolid[],
  pad: number,
  restitution: number,
  minSeparation: number,
): ArenaMove {
  if (solids.length === 0) {
    return { position: to, velocity, impactSpeed: 0, contactPoint: null };
  }
  let position = from;
  let remaining = sub(to, from);
  let vel = velocity;
  let impactSpeed = 0;
  let contactPoint: Vec3 | null = null;
  for (let i = 0; i < 4 && lenSq(remaining) > 1e-10; i += 1) {
    const hit = sweepArena(position, add(position, remaining), solids, pad);
    if (hit === null) {
      position = add(position, remaining);
      break;
    }
    const n = hit.normal;
    position = add(add(position, scale(remaining, hit.t)), scale(n, ARENA_SKIN));
    contactPoint = sub(position, scale(n, pad));
    const inward = -dot(vel, n);
    if (inward > 0) {
      impactSpeed = Math.max(impactSpeed, inward);
      vel = add(vel, scale(n, inward + Math.max(inward * restitution, minSeparation)));
    }
    const rest = scale(remaining, 1 - hit.t);
    remaining = sub(rest, scale(n, Math.min(0, dot(rest, n))));
  }
  const resolved = pushOutOfArena(position, solids, pad);
  // Where two padded solids overlap, pushing out of one can land inside the other; stay put instead.
  const settled = isInsideArena(resolved, solids, pad) && !isInsideArena(from, solids, pad) ? from : resolved;
  return { position: settled, velocity: vel, impactSpeed, contactPoint };
}

/**
 * Bends `goal` away from geometry the craft would meet within `lookahead` metres, along its nose
 * or along the goal itself. Nearer surfaces bend harder.
 */
export function steerClearOfArena(
  position: Vec3,
  forward: Vec3,
  goal: Vec3,
  lookahead: number,
  solids: readonly ArenaSolid[],
  pad: number,
): Vec3 {
  if (solids.length === 0) return goal;
  let steered = goal;
  for (const dir of [forward, goal]) {
    const hit = sweepArena(position, add(position, scale(dir, lookahead)), solids, pad);
    if (hit === null) continue;
    const n = hit.normal;
    const urgency = 1 - hit.t;
    steered = sub(steered, scale(n, Math.min(0, dot(steered, n))));
    // Head-on, nothing is left along the surface, so climb it rather than bounce straight back.
    if (lenSq(sub(steered, scale(n, dot(steered, n)))) < 0.09) {
      const climb = sub(WORLD_UP, scale(n, dot(WORLD_UP, n)));
      if (lenSq(climb) > 1e-6) steered = add(steered, scale(normalize(climb), 0.8));
    }
    steered = add(steered, scale(n, 0.4 + urgency * 2.4));
  }
  return normalize(steered);
}

export function hasLineOfSight(a: Vec3, b: Vec3, solids: readonly ArenaSolid[]): boolean {
  return sweepArena(a, b, solids, 0) === null;
}

/** World-space corner list of a box solid, for mesh/collider parity checks. */
export function boxCorners(solid: Extract<ArenaSolid, { kind: 'box' }>): readonly Vec3[] {
  const corners: Vec3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const local = { x: sx * solid.halfExtents.x, y: sy * solid.halfExtents.y, z: sz * solid.halfExtents.z };
        corners.push(add(solid.center, rotateVec3(solid.orientation, local)));
      }
    }
  }
  return corners;
}
