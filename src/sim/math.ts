import type { Quat, Vec3 } from './types';

export const ZERO_VEC: Vec3 = { x: 0, y: 0, z: 0 };
export const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lenSq(v: Vec3): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

export function len(v: Vec3): number {
  return Math.sqrt(lenSq(v));
}

export function distance(a: Vec3, b: Vec3): number {
  return len(sub(a, b));
}

export function normalize(v: Vec3): Vec3 {
  const magnitude = len(v);
  if (magnitude < 1e-6) {
    return { x: 0, y: 0, z: -1 };
  }
  return scale(v, 1 / magnitude);
}

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  const k = clamp(t, 0, 1);
  return {
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    z: a.z + (b.z - a.z) * k,
  };
}

export function normalizeQuat(q: Quat): Quat {
  const magnitude = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (magnitude < 1e-6) {
    return IDENTITY_QUAT;
  }
  return {
    x: q.x / magnitude,
    y: q.y / magnitude,
    z: q.z / magnitude,
    w: q.w / magnitude,
  };
}

export function quatFromAxisAngle(axis: Vec3, angleRadians: number): Quat {
  const unit = normalize(axis);
  const half = angleRadians * 0.5;
  const sinHalf = Math.sin(half);
  return {
    x: unit.x * sinHalf,
    y: unit.y * sinHalf,
    z: unit.z * sinHalf,
    w: Math.cos(half),
  };
}

export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatConjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function rotateVec3(q: Quat, v: Vec3): Vec3 {
  const qv: Vec3 = { x: q.x, y: q.y, z: q.z };
  const t = scale(cross(qv, v), 2);
  return add(add(v, scale(t, q.w)), cross(qv, t));
}

export function toLocalPoint(origin: Vec3, orientation: Quat, worldPoint: Vec3): Vec3 {
  return rotateVec3(quatConjugate(orientation), sub(worldPoint, origin));
}

export function forwardOf(q: Quat): Vec3 {
  return normalize(rotateVec3(q, { x: 0, y: 0, z: -1 }));
}

export function upOf(q: Quat): Vec3 {
  return normalize(rotateVec3(q, { x: 0, y: 1, z: 0 }));
}

export function rightOf(q: Quat): Vec3 {
  return normalize(rotateVec3(q, { x: 1, y: 0, z: 0 }));
}

export function quatLookAt(direction: Vec3, worldUp: Vec3 = { x: 0, y: 1, z: 0 }): Quat {
  const fwd = normalize(direction);
  let right = cross(fwd, worldUp);
  if (lenSq(right) < 1e-6) {
    right = cross(fwd, { x: 1, y: 0, z: 0 });
  }
  right = normalize(right);
  const up = normalize(cross(right, fwd));

  const m00 = right.x;
  const m01 = up.x;
  const m02 = -fwd.x;
  const m10 = right.y;
  const m11 = up.y;
  const m12 = -fwd.y;
  const m20 = right.z;
  const m21 = up.z;
  const m22 = -fwd.z;

  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return normalizeQuat({
      x: (m21 - m12) / s,
      y: (m02 - m20) / s,
      z: (m10 - m01) / s,
      w: 0.25 * s,
    });
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return normalizeQuat({
      x: 0.25 * s,
      y: (m01 + m10) / s,
      z: (m02 + m20) / s,
      w: (m21 - m12) / s,
    });
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return normalizeQuat({
      x: (m01 + m10) / s,
      y: 0.25 * s,
      z: (m12 + m21) / s,
      w: (m02 - m20) / s,
    });
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return normalizeQuat({
    x: (m02 + m20) / s,
    y: (m12 + m21) / s,
    z: 0.25 * s,
    w: (m10 - m01) / s,
  });
}

export function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  const k = clamp(t, 0, 1);
  let cosHalf = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  if (cosHalf < 0) {
    cosHalf = -cosHalf;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cosHalf > 0.9995) {
    return normalizeQuat({
      x: a.x + (bx - a.x) * k,
      y: a.y + (by - a.y) * k,
      z: a.z + (bz - a.z) * k,
      w: a.w + (bw - a.w) * k,
    });
  }
  const halfTheta = Math.acos(clamp(cosHalf, -1, 1));
  const sinHalf = Math.sin(halfTheta);
  const ratioA = Math.sin((1 - k) * halfTheta) / sinHalf;
  const ratioB = Math.sin(k * halfTheta) / sinHalf;
  return normalizeQuat({
    x: a.x * ratioA + bx * ratioB,
    y: a.y * ratioA + by * ratioB,
    z: a.z * ratioA + bz * ratioB,
    w: a.w * ratioA + bw * ratioB,
  });
}

export function solveInterceptTime(
  relPos: Vec3,
  relVel: Vec3,
  projectileSpeed: number,
  maxSeconds = 1.9,
): number | null {
  const s = Math.max(projectileSpeed, 1);
  const rDotR = dot(relPos, relPos);
  if (rDotR <= 1e-8) {
    return 0;
  }
  const a = dot(relVel, relVel) - s * s;
  const b = 2 * dot(relPos, relVel);
  const c = rDotR;

  let t: number | null = null;
  if (Math.abs(a) < 1e-6) {
    if (b < -1e-6) {
      t = -c / b;
    }
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sqrtDisc = Math.sqrt(disc);
      const t1 = (-b - sqrtDisc) / (2 * a);
      const t2 = (-b + sqrtDisc) / (2 * a);
      const pos1 = t1 > 0 ? t1 : Infinity;
      const pos2 = t2 > 0 ? t2 : Infinity;
      const best = Math.min(pos1, pos2);
      if (Number.isFinite(best)) {
        t = best;
      }
    }
  }

  if (t === null || t > maxSeconds) {
    return null;
  }
  return t;
}

export function computeLeadPoint(
  shooterPos: Vec3,
  shooterVel: Vec3,
  targetPos: Vec3,
  targetVel: Vec3,
  projectileSpeed: number,
  maxSeconds = 1.9,
): Vec3 | null {
  const relPos = sub(targetPos, shooterPos);
  const relVel = sub(targetVel, shooterVel);
  const timeToImpact = solveInterceptTime(relPos, relVel, projectileSpeed, maxSeconds);
  if (timeToImpact === null) {
    return null;
  }
  return add(targetPos, scale(relVel, timeToImpact));
}

export function nextRandom(state: number): { readonly nextState: number; readonly value: number } {
  // Mulberry32 step keeps sortie spawning deterministic across headless tests.
  const nextState = (state + 0x6d2b79f5) | 0;
  let mixed = Math.imul(nextState ^ (nextState >>> 15), 1 | nextState);
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
  const value = ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  return { nextState, value };
}

/** Fraction along a→b where the segment first enters the sphere, or null if it never does. */
export function segmentSphereEntry(a: Vec3, b: Vec3, center: Vec3, radius: number): number | null {
  const m = sub(a, center);
  const c = dot(m, m) - radius * radius;
  if (c <= 0) {
    return 0;
  }
  const d = sub(b, a);
  const dd = dot(d, d);
  const md = dot(m, d);
  if (dd < 1e-12 || md >= 0) {
    return null;
  }
  const disc = md * md - dd * c;
  if (disc < 0) {
    return null;
  }
  const t = (-md - Math.sqrt(disc)) / dd;
  return t <= 1 ? t : null;
}

export function segmentClosestApproach(
  a: Vec3,
  b: Vec3,
  point: Vec3,
): { readonly t: number; readonly distance: number } {
  const d = sub(b, a);
  const dd = dot(d, d);
  const t = dd < 1e-12 ? 0 : clamp(dot(sub(point, a), d) / dd, 0, 1);
  return { t, distance: distance(add(a, scale(d, t)), point) };
}

/** Slab test against an oriented box; returns the entry fraction along a→b, or null. */
export function segmentBoxEntry(
  a: Vec3,
  b: Vec3,
  origin: Vec3,
  orientation: Quat,
  halfExtents: Vec3,
): number | null {
  const la = toLocalPoint(origin, orientation, a);
  const lb = toLocalPoint(origin, orientation, b);
  let tMin = 0;
  let tMax = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const start = la[axis];
    const delta = lb[axis] - start;
    const half = halfExtents[axis];
    if (Math.abs(delta) < 1e-12) {
      if (Math.abs(start) > half) {
        return null;
      }
      continue;
    }
    const t1 = (-half - start) / delta;
    const t2 = (half - start) / delta;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) {
      return null;
    }
  }
  return tMin;
}
