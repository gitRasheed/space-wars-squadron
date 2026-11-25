import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  TRENCH_ARENA,
  TRENCH_CLEARANCE,
  TRENCH_COLD_GAP,
  TRENCH_DIMENSIONS,
  TRENCH_RIB_STATIONS,
  TRENCH_ROCK_FACET_JITTER,
} from '../sim/trenchLayout';
import type { ArenaRole, ArenaSolid } from '../sim/types';
import { celMat } from './celMaterial';
import { addStyledPart, glowMat } from './models';
import { RIM_PALETTE, SCENE_PALETTE, TRENCH_PALETTE } from './palette';

export interface TrenchRig {
  /** World-fixed level geometry, guide ribs and the cold gap beyond the exit. */
  readonly root: THREE.Group;
  readonly coreMeshes: ReadonlyMap<string, THREE.Mesh>;
  readonly coreLiveMaterial: THREE.Material;
  readonly coreDeadMaterial: THREE.Material;
}

function hash3(x: number, y: number, z: number): number {
  const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return h - Math.floor(h);
}

/** A collider's mesh in world space. Boxes match their collider exactly; rocks stay within the facet jitter. */
export function buildSolidGeometry(solid: ArenaSolid): THREE.BufferGeometry {
  if (solid.kind === 'box') {
    const h = solid.halfExtents;
    const geo = new THREE.BoxGeometry(h.x * 2, h.y * 2, h.z * 2);
    const q = solid.orientation;
    geo.applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    geo.translate(solid.center.x, solid.center.y, solid.center.z);
    return geo;
  }
  const geo = new THREE.IcosahedronGeometry(solid.radius, solid.radius > 120 ? 2 : 1);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Keyed on the vertex position, so faces sharing a corner move it together and never crack.
    const k = 1 + (hash3(Math.round(x * 10), Math.round(y * 10), Math.round(z * 10)) * 2 - 1) * TRENCH_ROCK_FACET_JITTER;
    pos.setXYZ(i, x * k + solid.center.x, y * k + solid.center.y, z * k + solid.center.z);
  }
  geo.computeVertexNormals();
  return geo;
}

const ROLE_COLOR: Readonly<Record<Exclude<ArenaRole, 'core'>, number>> = {
  wall: TRENCH_PALETTE.wall,
  rib: TRENCH_PALETTE.wallLit,
  gantry: TRENCH_PALETTE.wallLit,
  monolith: TRENCH_PALETTE.wall,
  rock: TRENCH_PALETTE.wall,
  pylon: TRENCH_PALETTE.pylon,
};

function materialKey(solid: ArenaSolid): string {
  if (solid.role === 'wall' && solid.kind === 'box' && Math.abs(solid.halfExtents.y) < Math.abs(solid.halfExtents.x)) {
    // Floor, ceiling and fracture plates sit a step darker than the side walls.
    return 'deck';
  }
  if (solid.role === 'rock' && solid.kind === 'sphere') {
    return solid.radius >= 200 ? 'rockDeep' : 'rock';
  }
  return solid.role;
}

function materialFor(key: string): THREE.Material {
  switch (key) {
    case 'deck':
      return celMat(TRENCH_PALETTE.wallDeep, { rimStrength: 0.12 });
    case 'rockDeep':
      return celMat(TRENCH_PALETTE.wallDeep, { rimColor: RIM_PALETTE.rock, rimStrength: 0.16 });
    case 'rock':
    case 'monolith':
      return celMat(TRENCH_PALETTE.wall, { rimColor: RIM_PALETTE.rock, rimStrength: 0.16 });
    case 'pylon':
      return celMat(TRENCH_PALETTE.pylon, { rimColor: RIM_PALETTE.hostile, rimStrength: 0.3 });
    default:
      return celMat(ROLE_COLOR[key as Exclude<ArenaRole, 'core'>], { rimStrength: 0.12 });
  }
}

/** Hard-edged cold strips on the mouth-facing face of every arch, so the ribcage recedes toward the gap. */
function buildGuideStrips(): THREE.BufferGeometry {
  const strip = 1.2;
  const proud = 0.25;
  const parts: THREE.BufferGeometry[] = [];
  const height = TRENCH_CLEARANCE.top - TRENCH_CLEARANCE.bottom;
  for (const station of TRENCH_RIB_STATIONS) {
    const z = station.z + TRENCH_DIMENSIONS.ribHalfDepth + proud / 2;
    for (const side of [-1, 1] as const) {
      const pillar = new THREE.BoxGeometry(strip, height, proud);
      pillar.translate(side * (TRENCH_CLEARANCE.halfWidth + strip / 2), (TRENCH_CLEARANCE.top + TRENCH_CLEARANCE.bottom) / 2, z);
      parts.push(pillar);
    }
    const beam = new THREE.BoxGeometry(TRENCH_CLEARANCE.halfWidth * 2 + strip * 2, strip, proud);
    beam.translate(0, TRENCH_CLEARANCE.top + strip / 2, z);
    parts.push(beam);
  }
  return mergeGeometries(parts);
}

/** The hero landmark: posterised cold light beyond the exit, three flat tiers and nothing else. */
function buildColdGap(): THREE.Group {
  const group = new THREE.Group();
  const tiers: readonly [number, number, number][] = [
    [900, TRENCH_PALETTE.coldGap, 0.34],
    [520, TRENCH_PALETTE.coldGap, 0.75],
    [240, TRENCH_PALETTE.coldGapCore, 1.35],
  ];
  tiers.forEach(([radius, color, boost], i) => {
    const material = glowMat(color, 1, { hdrBoost: boost });
    // Coplanar tiers: draw order, not depth, stacks them, and after the void sky so it can't paint over them.
    material.depthWrite = false;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 48), material);
    disc.position.set(TRENCH_COLD_GAP.center.x, TRENCH_COLD_GAP.center.y, TRENCH_COLD_GAP.center.z - 2100);
    disc.renderOrder = 2 + i;
    group.add(disc);
  });
  return group;
}

/** Void and stars; the renderer keeps it centred on the camera. */
export function buildTrenchSky(dotTexture: THREE.Texture): THREE.Group {
  const group = new THREE.Group();
  const voidMat = new THREE.MeshBasicMaterial({ color: TRENCH_PALETTE.void, side: THREE.BackSide, depthWrite: false });
  const voidSphere = new THREE.Mesh(new THREE.SphereGeometry(5400, 24, 16), voidMat);
  voidSphere.renderOrder = 1;
  group.add(voidSphere);

  const count = 900;
  const positions = new Float32Array(count * 3);
  let seed = 0x7e2c4a11;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i += 1) {
    const u = rand() * 2 - 1;
    const theta = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u) * 4600;
    positions.set([r * Math.cos(theta), u * 4600, r * Math.sin(theta)], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const stars = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ color: SCENE_PALETTE.dust, map: dotTexture, size: 13, transparent: true, opacity: 0.55, depthWrite: false }),
  );
  group.add(stars);
  return group;
}

export function buildTrenchLevel(): TrenchRig {
  const root = new THREE.Group();
  root.name = 'trench-level';

  const batches = new Map<string, THREE.BufferGeometry[]>();
  const coreMeshes = new Map<string, THREE.Mesh>();
  const coreLiveMaterial = glowMat(TRENCH_PALETTE.reactorCore, 1, { hdrBoost: 2.4 });
  const coreDeadMaterial = celMat(SCENE_PALETTE.destroyedSubsystem);
  for (const solid of TRENCH_ARENA) {
    if (solid.kind === 'sphere' && solid.reactorId !== null) {
      const core = addStyledPart(root, new THREE.IcosahedronGeometry(solid.radius, 1), coreLiveMaterial, {
        position: [solid.center.x, solid.center.y, solid.center.z],
      });
      coreMeshes.set(solid.reactorId, core);
      continue;
    }
    const key = materialKey(solid);
    const list = batches.get(key) ?? [];
    list.push(buildSolidGeometry(solid));
    batches.set(key, list);
  }
  for (const [key, parts] of batches) {
    // Spheres come out non-indexed and boxes indexed; merging needs one layout.
    const geo = mergeGeometries(parts.map((g) => (g.index === null ? g : g.toNonIndexed())));
    addStyledPart(root, geo, materialFor(key));
  }
  addStyledPart(root, buildGuideStrips(), glowMat(TRENCH_PALETTE.guideRib, 1, { hdrBoost: 1.6 }));
  root.add(buildColdGap());

  return { root, coreMeshes, coreLiveMaterial, coreDeadMaterial };
}
