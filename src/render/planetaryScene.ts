import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  CLOUD_DECK,
  CONVOY_SLOTS,
  FORWARD_OUTPOST,
  GROUND_TARGET_PLACEMENTS,
  GROUND_TARGET_SPECS,
  TARGET_PAD_RADIUS,
  TERRAIN_BOXES,
  TERRAIN_EXTENT,
  WALKER_ROAD,
} from '../sim/planetaryLayout';
import type { GroundTargetKind, GroundTargetState, PlanetaryState, Vec3 } from '../sim/types';
import { celMat } from './celMaterial';
import { disposeObject3D } from './dispose';
import { addStyledPart, glowMat } from './models';
import { BIOME_CARDS, RIM_PALETTE, SCENE_PALETTE, SUNSET_PALETTE } from './palette';
import { createShieldBubble } from './vfx';

const AA_STEP = `
float aaStep(float edge, float value) {
  float w = fwidth(value) * 0.9 + 1e-4;
  return smoothstep(edge - w, edge + w, value);
}
`;

function linear(hex: number): THREE.Vector3 {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

const { sunDirection } = BIOME_CARDS.sunsetGroundSupport;
const SUN = new THREE.Vector3(sunDirection.x, sunDirection.y, sunDirection.z).normalize();

/** Four flat sky tiers that dip toward the sun, a flat halo, and the sun disc: the only thing here that blooms. */
function buildSky(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: SUN },
      uZenith: { value: linear(SUNSET_PALETTE.skyZenith) },
      uHigh: { value: linear(SUNSET_PALETTE.skyHigh) },
      uLow: { value: linear(SUNSET_PALETTE.skyLow) },
      uHorizon: { value: linear(SUNSET_PALETTE.skyHorizon) },
      uHalo: { value: linear(SUNSET_PALETTE.sunHalo) },
      uSun: { value: linear(SUNSET_PALETTE.sunDisc).multiplyScalar(2.6) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      uniform vec3 uZenith;
      uniform vec3 uHigh;
      uniform vec3 uLow;
      uniform vec3 uHorizon;
      uniform vec3 uHalo;
      uniform vec3 uSun;
      varying vec3 vDir;
      ${AA_STEP}
      void main() {
        vec3 d = normalize(vDir);
        float toward = max(dot(normalize(d.xz + vec2(1e-5)), normalize(uSunDir.xz)), 0.0);
        float h = d.y - 0.1 * toward * toward;
        vec3 color = uHorizon;
        color = mix(color, uLow, aaStep(0.07, h));
        color = mix(color, uHigh, aaStep(0.22, h));
        color = mix(color, uZenith, aaStep(0.46, h));
        float align = dot(d, uSunDir);
        color = mix(color, uHalo, aaStep(0.992, align));
        color = mix(color, uSun, aaStep(0.99935, align));
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(5400, 48, 24), mat);
  sky.renderOrder = 1;
  return sky;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return (state >>> 0) / 4294967296;
  };
}

/** Stepped slabs above the canyon: lit flanks toward the sun, violet undersides, no soft edges. */
function buildCloudDeck(): THREE.Mesh {
  const rand = seededRandom(0x5c10d);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 22; i += 1) {
    const radius = 150 + rand() * 230;
    const thickness = 16 + rand() * 20;
    const x = (rand() - 0.5) * 3600;
    const z = 1700 - rand() * 4600;
    const y = CLOUD_DECK.base + rand() * (CLOUD_DECK.top - CLOUD_DECK.base - 40);
    const slab = new THREE.CylinderGeometry(radius, radius * 1.08, thickness, 7, 1).toNonIndexed();
    slab.scale(1, 1, 0.55 + rand() * 0.4);
    slab.rotateY(rand() * Math.PI);
    slab.translate(x, y, z);
    parts.push(slab);
    const cap = new THREE.CylinderGeometry(radius * 0.55, radius * 0.6, thickness * 0.8, 6, 1).toNonIndexed();
    cap.rotateY(rand() * Math.PI);
    cap.translate(x + (rand() - 0.5) * radius * 0.5, y + thickness * 0.85, z + (rand() - 0.5) * radius * 0.3);
    parts.push(cap);
  }
  const geo = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  geo.computeVertexNormals();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: SUN },
      uLit: { value: linear(SUNSET_PALETTE.cloudLit) },
      uShadow: { value: linear(SUNSET_PALETTE.cloudShadow) },
    },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      uniform vec3 uLit;
      uniform vec3 uShadow;
      varying vec3 vNormal;
      ${AA_STEP}
      void main() {
        vec3 n = normalize(vNormal);
        float lit = aaStep(0.1, dot(n, uSunDir)) * (1.0 - aaStep(0.5, -n.y));
        vec3 color = mix(uShadow, mix(uShadow, uLit, 0.55), aaStep(-0.4, n.y));
        gl_FragColor = vec4(mix(color, uLit, lit), 1.0);
      }
    `,
  });
  return new THREE.Mesh(geo, mat);
}

const TIER_TONES = [SUNSET_PALETTE.mesaDark, SUNSET_PALETTE.mesaMid, SUNSET_PALETTE.mesaLight, SUNSET_PALETTE.mesaMid] as const;

function buildTerrain(): THREE.Group {
  const group = new THREE.Group();
  const width = TERRAIN_EXTENT.maxX - TERRAIN_EXTENT.minX;
  const depth = TERRAIN_EXTENT.maxZ - TERRAIN_EXTENT.minZ;
  const floor = new THREE.PlaneGeometry(width, depth);
  floor.rotateX(-Math.PI / 2);
  floor.translate((TERRAIN_EXTENT.minX + TERRAIN_EXTENT.maxX) * 0.5, 0, (TERRAIN_EXTENT.minZ + TERRAIN_EXTENT.maxZ) * 0.5);
  addStyledPart(group, floor, celMat(SUNSET_PALETTE.mesaMid, { rimStrength: 0 }));

  TIER_TONES.forEach((tone, tier) => {
    const boxes = TERRAIN_BOXES.filter((b) => b.tier === tier).map((b) => {
      const geo = new THREE.BoxGeometry(b.halfExtents.x * 2, b.halfExtents.y * 2, b.halfExtents.z * 2);
      geo.translate(b.center.x, b.center.y, b.center.z);
      return geo;
    });
    if (boxes.length === 0) return;
    const merged = mergeGeometries(boxes);
    for (const geo of boxes) geo.dispose();
    addStyledPart(group, merged, celMat(tone, { rimStrength: 0 }));
  });

  // The plateau carries on past the playable rim so the horizon is a mesa line, not a cliff into nothing.
  const outer = new THREE.Shape();
  outer.moveTo(-9000, -9000);
  outer.lineTo(9000, -9000);
  outer.lineTo(9000, 9000);
  outer.lineTo(-9000, 9000);
  const hole = new THREE.Path();
  hole.moveTo(TERRAIN_EXTENT.minX, -TERRAIN_EXTENT.maxZ);
  hole.lineTo(TERRAIN_EXTENT.minX, -TERRAIN_EXTENT.minZ);
  hole.lineTo(TERRAIN_EXTENT.maxX, -TERRAIN_EXTENT.minZ);
  hole.lineTo(TERRAIN_EXTENT.maxX, -TERRAIN_EXTENT.maxZ);
  outer.holes.push(hole);
  const plateau = new THREE.ShapeGeometry(outer);
  plateau.rotateX(-Math.PI / 2);
  plateau.translate(0, TERRAIN_EXTENT.plateauHeight, 0);
  group.add(new THREE.Mesh(plateau, celMat(SUNSET_PALETTE.mesaMid, { rimStrength: 0 })));

  const padMat = celMat(SUNSET_PALETTE.pad, { rimStrength: 0 });
  padMat.polygonOffset = true;
  padMat.polygonOffsetFactor = -2;
  padMat.polygonOffsetUnits = -4;
  const markMat = celMat(SUNSET_PALETTE.padMarking, { rimStrength: 0 });
  markMat.polygonOffset = true;
  markMat.polygonOffsetFactor = -3;
  markMat.polygonOffsetUnits = -6;
  for (const placement of GROUND_TARGET_PLACEMENTS) {
    const radius = TARGET_PAD_RADIUS[placement.kind];
    if (radius <= 0) continue;
    addStyledPart(group, new THREE.CylinderGeometry(radius, radius, 0.8, 16), padMat, { position: [placement.x, 0.4, placement.z] });
    addStyledPart(group, new THREE.RingGeometry(radius * 0.72, radius * 0.8, 16).rotateX(-Math.PI / 2), markMat, {
      position: [placement.x, 0.82, placement.z],
    });
  }
  const roadLength = WALKER_ROAD.maxZ - WALKER_ROAD.minZ;
  addStyledPart(group, new THREE.BoxGeometry(WALKER_ROAD.halfWidth * 2, 0.6, roadLength), padMat, {
    position: [0, 0.3, (WALKER_ROAD.minZ + WALKER_ROAD.maxZ) * 0.5],
  });
  return group;
}

interface GroundRig {
  readonly root: THREE.Group;
  readonly intact: THREE.Group;
  readonly wreck: THREE.Group;
  readonly turret: THREE.Object3D | null;
  readonly legs: readonly THREE.Object3D[];
  readonly charge: THREE.MeshBasicMaterial | null;
  readonly shield: { readonly mesh: THREE.Mesh; readonly flash: THREE.IUniform<number> } | null;
}

function hostileMats(): { readonly hull: THREE.Material; readonly plate: THREE.Material } {
  return {
    hull: celMat(SUNSET_PALETTE.hostileHull, { rimColor: RIM_PALETTE.hostile, rimStrength: 0.32 }),
    plate: celMat(SUNSET_PALETTE.hostilePlate, { rimColor: RIM_PALETTE.hostile, rimStrength: 0.32 }),
  };
}

function buildWreck(size: number, floorY: number): THREE.Group {
  const wreck = new THREE.Group();
  const mat = celMat(SUNSET_PALETTE.wreck, { rimStrength: 0 });
  const shards: readonly (readonly [number, number, number, number])[] = [
    [-0.35, 0.2, 0.1, 0.4],
    [0.3, -0.3, -0.5, 0.3],
    [0.05, 0.25, 0.9, 0.26],
  ];
  for (const [x, z, tilt, s] of shards) {
    addStyledPart(wreck, new THREE.BoxGeometry(size * s * 2, size * 0.18, size * s * 1.4), mat, {
      position: [x * size, floorY + size * 0.09, z * size],
      rotation: [tilt * 0.4, tilt, tilt * 0.3],
    });
  }
  wreck.visible = false;
  return wreck;
}

// Every ground body is built around its hit-sphere centre, so the marker, the hitbox and the mesh agree.
function buildGroundRig(kind: GroundTargetKind): GroundRig {
  const root = new THREE.Group();
  const intact = new THREE.Group();
  root.add(intact);
  const mats = hostileMats();
  const spec = GROUND_TARGET_SPECS[kind];
  const base = -spec.centerHeight;
  const glow = glowMat(SCENE_PALETTE.hostileAccent, 1, { hdrBoost: 2.4 });
  let turret: THREE.Object3D | null = null;
  const legs: THREE.Object3D[] = [];
  let charge: THREE.MeshBasicMaterial | null = null;
  let shield: GroundRig['shield'] = null;

  switch (kind) {
    case 'flak': {
      addStyledPart(intact, new THREE.CylinderGeometry(6.5, 7.5, 3, 6), mats.hull, { position: [0, base + 1.5, 0] });
      const head = new THREE.Group();
      head.position.set(0, base + 5, 0);
      intact.add(head);
      addStyledPart(head, new THREE.BoxGeometry(6, 3.4, 5.4), mats.plate);
      const pitch = new THREE.Group();
      pitch.position.set(0, 0.8, -1);
      head.add(pitch);
      charge = glowMat(SUNSET_PALETTE.flakCharge, 1, { hdrBoost: 0.2 });
      for (const side of [-1, 1]) {
        addStyledPart(pitch, new THREE.BoxGeometry(0.9, 0.9, 8), mats.hull, { position: [side * 1.5, 0, -4] });
        addStyledPart(pitch, new THREE.SphereGeometry(0.9, 8, 6), charge, { position: [side * 1.5, 0, -8.3] });
      }
      addStyledPart(head, new THREE.BoxGeometry(4.2, 0.5, 0.3), glow, { position: [0, 0.6, 2.75] });
      turret = head;
      break;
    }
    case 'walker': {
      addStyledPart(intact, new THREE.BoxGeometry(8, 4.6, 10), mats.plate, { position: [0, 2, 0] });
      addStyledPart(intact, new THREE.BoxGeometry(5, 2.4, 4), mats.hull, { position: [0, 3.6, 5.4] });
      addStyledPart(intact, new THREE.BoxGeometry(3.4, 0.7, 0.3), glow, { position: [0, 3.8, 7.45] });
      for (const [x, z] of [[-4.6, 3.4], [4.6, 3.4], [-4.6, -3.4], [4.6, -3.4]] as const) {
        const hip = new THREE.Group();
        hip.position.set(x, 0.8, z);
        intact.add(hip);
        addStyledPart(hip, new THREE.BoxGeometry(1.4, 11, 1.6), mats.hull, { position: [x > 0 ? 0.6 : -0.6, -5.6, 0], rotation: [0, 0, x > 0 ? -0.12 : 0.12] });
        legs.push(hip);
      }
      break;
    }
    case 'relay': {
      addStyledPart(intact, new THREE.CylinderGeometry(4.5, 6, 3, 6), mats.hull, { position: [0, base + 1.5, 0] });
      addStyledPart(intact, new THREE.CylinderGeometry(1.2, 2.4, 17, 4), mats.plate, { position: [0, base + 11, 0] });
      addStyledPart(intact, new THREE.TorusGeometry(4.2, 0.7, 6, 12), mats.hull, { position: [0, 2, 0], rotation: [Math.PI / 2, 0, 0] });
      addStyledPart(intact, new THREE.OctahedronGeometry(2.2), glowMat(SCENE_PALETTE.enemyShield, 1, { hdrBoost: 2.2 }), { position: [0, 6.5, 0] });
      break;
    }
    case 'artillery': {
      addStyledPart(intact, new THREE.BoxGeometry(16, 4, 16), mats.hull, { position: [0, base + 2, 0] });
      const head = new THREE.Group();
      head.position.set(0, base + 7, 0);
      intact.add(head);
      addStyledPart(head, new THREE.BoxGeometry(10, 5, 11), mats.plate);
      addStyledPart(head, new THREE.BoxGeometry(2.4, 2.4, 22), mats.hull, { position: [0, 3.4, 12], rotation: [-0.42, 0, 0] });
      charge = glowMat(SCENE_PALETTE.hostileAccent, 1, { hdrBoost: 0.2 });
      addStyledPart(head, new THREE.BoxGeometry(6, 0.8, 0.3), charge, { position: [0, 1.2, 5.6] });
      const bubble = createShieldBubble(17);
      bubble.mesh.position.set(0, 2, 0);
      root.add(bubble.mesh);
      shield = bubble;
      break;
    }
  }
  const wreck = buildWreck(spec.hitRadius, base);
  root.add(wreck);
  return { root, intact, wreck, turret, legs, charge, shield };
}

/** Intact ground target with no wreck or shield dome, for turntables. */
export function buildGroundTargetMesh(kind: GroundTargetKind): THREE.Group {
  const rig = buildGroundRig(kind);
  rig.root.remove(rig.wreck);
  if (rig.shield !== null) rig.root.remove(rig.shield.mesh);
  return rig.root;
}

function friendlyMats(): { readonly hull: THREE.Material; readonly trim: THREE.Material; readonly light: THREE.Material } {
  return {
    hull: celMat(SUNSET_PALETTE.friendlyHull, { rimColor: RIM_PALETTE.friendly, rimStrength: 0.22 }),
    trim: celMat(SUNSET_PALETTE.friendlyTrim, { rimColor: RIM_PALETTE.friendly, rimStrength: 0.22 }),
    light: glowMat(SUNSET_PALETTE.friendlyLight, 1, { hdrBoost: 2.2 }),
  };
}

function buildOutpost(): THREE.Group {
  const group = new THREE.Group();
  const mats = friendlyMats();
  const h = FORWARD_OUTPOST.halfExtents;
  addStyledPart(group, new THREE.BoxGeometry(h.x * 2, h.y * 1.4, h.z * 2), mats.hull, { position: [0, -h.y * 0.3, 0] });
  addStyledPart(group, new THREE.BoxGeometry(h.x * 1.1, h.y * 0.6, h.z * 1.2), mats.hull, { position: [-h.x * 0.25, h.y * 0.7, -h.z * 0.1] });
  addStyledPart(group, new THREE.BoxGeometry(h.x * 2 + 0.4, 1.6, h.z * 2 + 0.4), mats.trim, { position: [0, h.y * 0.1, 0] });
  addStyledPart(group, new THREE.CylinderGeometry(0.6, 0.9, 26, 5), mats.trim, { position: [h.x * 0.6, h.y + 10, h.z * 0.4] });
  for (const [x, z] of [[-h.x, -h.z], [h.x, -h.z], [-h.x, h.z], [h.x, h.z]] as const) {
    addStyledPart(group, new THREE.BoxGeometry(1.6, 1.6, 1.6), mats.light, { position: [x, h.y * 0.45, z] });
  }
  addStyledPart(group, new THREE.SphereGeometry(1.3, 8, 6), mats.light, { position: [h.x * 0.6, h.y + 23.5, h.z * 0.4] });
  return group;
}

function buildConvoyTank(): THREE.Group {
  const group = new THREE.Group();
  const mats = friendlyMats();
  addStyledPart(group, new THREE.BoxGeometry(9, 3.4, 14), mats.hull, { position: [0, 2.4, 0] });
  addStyledPart(group, new THREE.BoxGeometry(10, 1.6, 15), mats.trim, { position: [0, 0.9, 0] });
  addStyledPart(group, new THREE.BoxGeometry(5, 2.2, 5.5), mats.hull, { position: [0, 5.2, 1] });
  addStyledPart(group, new THREE.BoxGeometry(1, 1, 9), mats.trim, { position: [0, 5.4, -4.5] });
  addStyledPart(group, new THREE.BoxGeometry(5.2, 0.5, 0.3), mats.light, { position: [0, 3.2, 7.1] });
  return group;
}

export interface PlanetaryScene {
  /** World-fixed terrain, clouds, targets and friendlies. */
  readonly root: THREE.Group;
  /** Rides the camera so the dome never clips. */
  readonly sky: THREE.Mesh;
  readonly sync: (planetary: PlanetaryState, playerPosition: Vec3, tick: number) => void;
  readonly dispose: () => void;
}

export function createPlanetaryScene(): PlanetaryScene {
  const root = new THREE.Group();
  root.add(buildTerrain(), buildCloudDeck());
  const sky = buildSky();

  const outpost = buildOutpost();
  outpost.position.set(FORWARD_OUTPOST.position.x, FORWARD_OUTPOST.position.y, FORWARD_OUTPOST.position.z);
  root.add(outpost);
  const convoy = CONVOY_SLOTS.map(() => {
    const tank = buildConvoyTank();
    tank.rotation.y = Math.PI;
    root.add(tank);
    return tank;
  });

  const rigs = new Map<string, GroundRig>();
  for (const placement of GROUND_TARGET_PLACEMENTS) {
    const rig = buildGroundRig(placement.kind);
    rigs.set(placement.id, rig);
    root.add(rig.root);
  }

  const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const beam = new THREE.Line(
    beamGeo,
    new THREE.LineBasicMaterial({ color: new THREE.Color(SCENE_PALETTE.enemyShield).multiplyScalar(1.8), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  beam.frustumCulled = false;
  root.add(beam);

  const scratch = new THREE.Vector3();

  function aimTurret(rig: GroundRig, target: GroundTargetState, playerPosition: Vec3): void {
    if (rig.turret === null) return;
    if (target.kind === 'artillery') {
      rig.turret.rotation.y = Math.atan2(FORWARD_OUTPOST.position.x - target.position.x, FORWARD_OUTPOST.position.z - target.position.z);
      return;
    }
    scratch.set(playerPosition.x - target.position.x, playerPosition.y - target.position.y, playerPosition.z - target.position.z);
    rig.turret.rotation.y = Math.atan2(-scratch.x, -scratch.z);
    const pitch = rig.turret.children[1];
    if (pitch !== undefined) {
      pitch.rotation.x = THREE.MathUtils.clamp(Math.atan2(scratch.y, Math.hypot(scratch.x, scratch.z)), 0.1, 1.3);
    }
  }

  function sync(planetary: PlanetaryState, playerPosition: Vec3, tick: number): void {
    const byId = new Map(planetary.groundTargets.map((t) => [t.id, t]));
    let beamShown = false;
    for (const target of planetary.groundTargets) {
      const rig = rigs.get(target.id);
      if (rig === undefined) continue;
      rig.root.position.set(target.position.x, target.position.y, target.position.z);
      const alive = target.hull > 0;
      rig.intact.visible = alive;
      rig.wreck.visible = !alive;
      if (!alive) {
        if (rig.shield !== null) rig.shield.mesh.visible = false;
        continue;
      }
      if (target.kind === 'walker') {
        rig.root.rotation.y = target.heading;
        const stride = Math.sin(tick * 0.12 + target.id.length);
        rig.legs.forEach((leg, i) => {
          leg.rotation.x = (i % 3 === 0 ? 1 : -1) * stride * 0.32;
        });
      }
      aimTurret(rig, target, playerPosition);
      if (rig.charge !== null) {
        const boost = target.charge > 0 ? 0.6 + target.charge * 2.2 : 0.2;
        rig.charge.color.setHex(target.kind === 'flak' ? SUNSET_PALETTE.flakCharge : SCENE_PALETTE.hostileAccent).multiplyScalar(boost);
      }
      if (rig.shield !== null) {
        const relay = target.shieldedBy === null ? undefined : byId.get(target.shieldedBy);
        const shielded = relay !== undefined && relay.hull > 0;
        rig.shield.mesh.visible = shielded;
        rig.shield.flash.value = 0.32 + target.shieldHitFlash * 0.68;
        rig.shield.mesh.rotation.y = tick * 0.02;
        if (shielded) {
          beamShown = true;
          const positions = beamGeo.getAttribute('position') as THREE.BufferAttribute;
          positions.setXYZ(0, relay.position.x, relay.position.y + 6.5, relay.position.z);
          positions.setXYZ(1, target.position.x, target.position.y + 10, target.position.z);
          positions.needsUpdate = true;
        }
      }
    }
    beam.visible = beamShown;

    convoy.forEach((tank, i) => {
      const slot = CONVOY_SLOTS[i];
      if (slot === undefined) return;
      tank.position.set(slot.x, slot.y + Math.sin(tick * 0.2 + i) * 0.08, slot.z - planetary.convoyAdvance);
    });
  }

  function dispose(): void {
    root.removeFromParent();
    sky.removeFromParent();
    disposeObject3D([root, sky]);
  }

  return { root, sky, sync, dispose };
}
