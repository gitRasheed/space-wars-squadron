import * as THREE from 'three';
import { COCKPIT_GUN_LOCAL, FIGHTER_WEAPON_LAYOUT } from '../sim/combat';
import { SHIP_STATS } from '../sim/ships';
import type { AsteroidState, EnemyKind } from '../sim/types';
import { FRIGATE_SUBSYSTEM_LAYOUT } from '../sim/world';
import { celMat, type CelMaterial } from './celMaterial';
import { BIOME_CARDS, RIM_PALETTE, SCENE_PALETTE } from './palette';
import { INK_LAYER } from './postProcess';
import { createHeatVents, createShieldBubble, type HeatVents } from './vfx';
import type { HullTextureSet } from './textures';

export function glowMat(
  color: number,
  opacity = 1,
  options?: {
    readonly hdrBoost?: number;
    readonly additive?: boolean;
  },
): THREE.MeshBasicMaterial {
  const additive = options?.additive ?? false;
  const hdrBoost = options?.hdrBoost ?? 2.2;
  const boosted = new THREE.Color(color).multiplyScalar(hdrBoost);
  return new THREE.MeshBasicMaterial({
    color: boosted,
    transparent: additive || opacity < 1,
    opacity,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: !additive && opacity >= 1,
  });
}

export function addStyledPart(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  options?: {
    readonly position?: readonly [number, number, number];
    readonly rotation?: readonly [number, number, number];
    readonly scale?: readonly [number, number, number];
  },
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  if (options?.position !== undefined) {
    mesh.position.set(options.position[0], options.position[1], options.position[2]);
  }
  if (options?.rotation !== undefined) {
    mesh.rotation.set(options.rotation[0], options.rotation[1], options.rotation[2]);
  }
  if (options?.scale !== undefined) {
    mesh.scale.set(options.scale[0], options.scale[1], options.scale[2]);
  }
  // Solid parts feed the post pass's ink buffer; that one pass draws every outline and crease in the scene.
  if (!material.transparent) {
    mesh.layers.enable(INK_LAYER);
  }
  parent.add(mesh);
  return mesh;
}

export function createSoftDotTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.32, 'rgba(255, 240, 220, 0.72)');
    grad.addColorStop(1, 'rgba(255, 220, 180, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function scaleUvs(geo: THREE.BufferGeometry, tileWorldUnits: number): void {
  const uv = geo.getAttribute('uv');
  const inv = 1 / tileWorldUnits;
  for (let i = 0; i < uv.count; i += 1) {
    uv.setXY(i, uv.getX(i) * inv, uv.getY(i) * inv);
  }
  uv.needsUpdate = true;
}

interface TaperedBoxSpec {
  readonly frontWidth: number;
  readonly frontHeight: number;
  readonly backWidth: number;
  readonly backHeight: number;
  readonly length: number;
  readonly frontYOffset?: number;
  readonly backYOffset?: number;
  readonly uvTile?: number;
}

function createTaperedBoxGeometry(spec: TaperedBoxSpec): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(1, 1, spec.length);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const frontY = spec.frontYOffset ?? 0;
  const backY = spec.backYOffset ?? 0;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (z < 0) {
      pos.setXYZ(i, x * spec.frontWidth, y * spec.frontHeight + frontY, z);
    } else {
      pos.setXYZ(i, x * spec.backWidth, y * spec.backHeight + backY, z);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  if (spec.uvTile !== undefined && spec.uvTile > 0) {
    scaleUvs(geo, spec.uvTile);
  }
  return geo;
}

function createDiamondPrismGeometry(spec: TaperedBoxSpec): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(1, 1, spec.length, 4, 1).toNonIndexed();
  geo.rotateX(Math.PI / 2);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const frontY = spec.frontYOffset ?? 0;
  const backY = spec.backYOffset ?? 0;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (z < 0) {
      pos.setXYZ(i, x * (spec.frontWidth * 0.5), y * (spec.frontHeight * 0.5) + frontY, z);
    } else {
      pos.setXYZ(i, x * (spec.backWidth * 0.5), y * (spec.backHeight * 0.5) + backY, z);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  if (spec.uvTile !== undefined && spec.uvTile > 0) {
    scaleUvs(geo, spec.uvTile);
  }
  return geo;
}

function createSweptWingGeometry(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, -1.85);
  shape.lineTo(3.2, -0.94);
  shape.lineTo(5.6, 0.03);
  shape.lineTo(5.65, 1.13);
  shape.lineTo(3.6, 1.18);
  shape.lineTo(2.85, 1.7);
  shape.lineTo(0.45, 1.95);
  shape.lineTo(0, 1.75);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.38,
    bevelEnabled: true,
    bevelThickness: 0.12,
    bevelSize: 0.1,
    bevelSegments: 2,
  });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0.19, 0);
  scaleUvs(geo, 6.0);
  return geo;
}

function createDaggerSponsonGeometry(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, -1.6);
  shape.lineTo(4.1, -6.65);
  shape.lineTo(4.46, -6.15);
  shape.lineTo(3.92, -2.35);
  shape.lineTo(2.4, 3.6);
  shape.lineTo(0, 2.8);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.34,
    bevelEnabled: true,
    bevelThickness: 0.12,
    bevelSize: 0.1,
    bevelSegments: 1,
  });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0.17, 0);
  scaleUvs(geo, 6.0);
  return geo;
}

function createHexSolarVaneGeometry(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-2.1, -5.4);
  shape.lineTo(2.1, -5.4);
  shape.lineTo(4.0, -1.5);
  shape.lineTo(4.0, 1.5);
  shape.lineTo(2.1, 5.4);
  shape.lineTo(-2.1, 5.4);
  shape.lineTo(-4.0, 1.5);
  shape.lineTo(-4.0, -1.5);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.42,
    bevelEnabled: true,
    bevelThickness: 0.16,
    bevelSize: 0.16,
    bevelSegments: 1,
  });
  geo.rotateY(Math.PI / 2);
  geo.translate(-0.21, 0, 0);
  scaleUvs(geo, 8.0);
  return geo;
}

function createCowling(radius: number, depth: number, sides: number): THREE.LatheGeometry {
  const wall = [
    new THREE.Vector2(radius * 1.08, 0),
    new THREE.Vector2(radius, depth * 0.8),
    new THREE.Vector2(radius * 0.93, depth),
    new THREE.Vector2(radius * 0.75, depth),
    new THREE.Vector2(radius * 0.64, depth * 0.22),
  ];
  const geometry = new THREE.LatheGeometry(wall, sides);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

export interface FighterMeshRig {
  readonly root: THREE.Group;
  readonly plumes: readonly THREE.Group[];
  readonly muzzleLeft: THREE.Group;
  readonly muzzleRight: THREE.Group;
}

export function buildPlayerFighterMesh(
  stripeColor: number,
  textures: HullTextureSet,
): FighterMeshRig {
  const root = new THREE.Group();
  const hullMat = celMat(0xffffff, { map: textures.fighterHull });
  const ivoryMat = celMat(0xf4efe4, { panel: 1.05 });
  const warmPlateMat = celMat(0xe2d9ca, { panel: 1.05 });
  const slateMat = celMat(0x525c74, { panel: 1.05, gloss: 0.16 });
  const gunmetalMat = celMat(0x3f4860, { gloss: 0.2 });
  const darkMat = celMat(0x232838);
  const stripeMat = celMat(stripeColor);
  const canopyMat = celMat(0xffbe59, { emissive: 0x8a480a, emissiveIntensity: 0.55 });
  const outerPlumeMat = glowMat(0x56d8ff, 0.82, { hdrBoost: 2.3, additive: true });
  const innerPlumeMat = glowMat(0xffffff, 0.98, { hdrBoost: 2.9, additive: true });
  const navLightMat = glowMat(stripeColor, 1, { hdrBoost: 2.1 });

  // 1. Shortened, faceted diamond-section drooped prow (clean solid armor, no moustache stripe).
  addStyledPart(
    root,
    createDiamondPrismGeometry({
      frontWidth: 0.48,
      frontHeight: 0.38,
      backWidth: 2.55,
      backHeight: 1.52,
      length: 6.2,
      frontYOffset: -0.32,
      backYOffset: -0.02,
    }),
    ivoryMat,
    { position: [0, 0, -5.5] },
  );

  // Dark sensor tip cap.
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 0.3,
      frontHeight: 0.24,
      backWidth: 0.54,
      backHeight: 0.42,
      length: 0.72,
      frontYOffset: -0.04,
    }),
    darkMat,
    { position: [0, -0.34, -8.82] },
  );

  // Dorsal twin racing stripes tucked cleanly along the upper prow shoulders (not a front moustache).
  for (const side of [-1, 1] as const) {
    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 0.16,
        frontHeight: 0.12,
        backWidth: 0.28,
        backHeight: 0.16,
        length: 3.1,
        frontYOffset: -0.12,
      }),
      stripeMat,
      { position: [side * 0.42, 0.32, -5.0], rotation: [0, side * -0.14, side * -0.32] },
    );
  }

  // Sculpted ventral chin intake wedge with recessed dark throat.
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 0.86,
      frontHeight: 0.46,
      backWidth: 1.58,
      backHeight: 0.72,
      length: 3.8,
      frontYOffset: 0.08,
      backYOffset: -0.06,
    }),
    slateMat,
    { position: [0, -0.66, -3.45] },
  );
  addStyledPart(root, new THREE.BoxGeometry(0.67, 0.26, 0.12), darkMat, {
    position: [0, -0.58, -5.36],
  });
  for (const side of [-1, 1]) {
    addStyledPart(root, new THREE.BoxGeometry(0.14, 0.36, 0.48), ivoryMat, {
      position: [side * 0.38, -0.58, -5.29], rotation: [0, 0, side * -0.24],
    });
  }

  // 2. Raised tapered mid-fuselage turtledeck (clean solid armor plates — no stretched flank UV grid).
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 2.45,
      frontHeight: 1.52,
      backWidth: 3.25,
      backHeight: 1.88,
      length: 5.2,
      frontYOffset: 0.02,
      backYOffset: 0.16,
    }),
    warmPlateMat,
    { position: [0, 0, -0.1] },
  );

  for (const side of [-1, 1] as const) {
    // Cheek chines bridging the diamond prow into the mid-fuselage.
    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 0.34,
        frontHeight: 0.42,
        backWidth: 0.74,
        backHeight: 0.88,
        length: 4.8,
        frontYOffset: -0.1,
      }),
      ivoryMat,
      { position: [side * 1.18, -0.04, -2.3] },
    );

    // Stepped mid-flank armor plates for crisp cel-shaded value bands.
    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 0.28,
        frontHeight: 0.62,
        backWidth: 0.38,
        backHeight: 0.76,
        length: 3.6,
      }),
      ivoryMat,
      { position: [side * 1.54, 0.12, 0.45] },
    );

    // Orange aft shoulder armor plates (strong read in chase cam).
    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 0.62,
        frontHeight: 0.34,
        backWidth: 0.54,
        backHeight: 0.28,
        length: 2.5,
      }),
      stripeMat,
      { position: [side * 1.12, 0.94, 3.3], rotation: [0, 0, side * -0.22] },
    );
  }

  // 3. Tapered aft fuselage deck sloping cleanly to the engine transom.
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 3.2,
      frontHeight: 1.78,
      backWidth: 2.65,
      backHeight: 1.16,
      length: 3.5,
      frontYOffset: 0.14,
      backYOffset: -0.04,
    }),
    warmPlateMat,
    { position: [0, 0, 4.1] },
  );

  // Seated canopy turtledeck fairing + dark collar + golden canopy + astromech/sensor hump.
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 1.48,
      frontHeight: 0.44,
      backWidth: 1.84,
      backHeight: 0.62,
      length: 4.5,
      frontYOffset: -0.1,
      backYOffset: 0.04,
    }),
    ivoryMat,
    { position: [0, 0.92, -0.3] },
  );
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 1.12,
      frontHeight: 0.22,
      backWidth: 1.38,
      backHeight: 0.26,
      length: 2.75,
    }),
    darkMat,
    { position: [0, 1.08, -1.2] },
  );

  const canopyGeo = new THREE.OctahedronGeometry(1.06, 2);
  canopyGeo.scale(0.68, 0.54, 1.52);
  addStyledPart(root, canopyGeo, canopyMat, { position: [0, 1.24, -1.25] });

  for (const dz of [-0.68, 0.64]) {
    const section = Math.sqrt(1 - (dz / (1.06 * 1.52)) ** 2);
    const frame = new THREE.TorusGeometry(1, 0.062, 4, 12, Math.PI);
    frame.scale(0.74 * section, 0.59 * section, 1.8);
    addStyledPart(root, frame, gunmetalMat, { position: [0, 1.24, -1.25 + dz] });
  }

  const sensorDomeGeo = new THREE.CylinderGeometry(0.42, 0.52, 0.42, 8);
  addStyledPart(root, sensorDomeGeo, slateMat, { position: [0, 1.24, 1.1] });
  addStyledPart(root, new THREE.SphereGeometry(0.38, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), ivoryMat, {
    position: [0, 1.42, 1.1],
  });

  // Forward canards and a comms blade break up the dart outline.
  for (const side of [-1, 1] as const) {
    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 0.22, frontHeight: 0.07, backWidth: 1.25, backHeight: 0.12, length: 1.7,
      }),
      stripeMat,
      { position: [side * 1.5, -0.12, -3.3], rotation: [0, side * -0.5, side * -0.1] },
    );
  }
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 0.05, frontHeight: 0.12, backWidth: 0.07, backHeight: 0.85, length: 1.0, backYOffset: 0.36,
    }),
    gunmetalMat,
    { position: [0, 1.5, 2.1] },
  );

  // Swept orange center dorsal finlet.
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 0.26,
      frontHeight: 0.34,
      backWidth: 0.18,
      backHeight: 1.0,
      length: 2.8,
      frontYOffset: -0.18,
      backYOffset: 0.24,
    }),
    stripeMat,
    { position: [0, 1.14, 3.85] },
  );

  // 4. Muscular airfoil S-foils with thick root fairings and integrated wingtip cannon pods (no floating dots).
  const wingGeo = createSweptWingGeometry();
  const rootFairingGeo = createTaperedBoxGeometry({
    frontWidth: 1.1,
    frontHeight: 0.6,
    backWidth: 2.15,
    backHeight: 0.82,
    length: 4.2,
  });
  const tipPodGeo = new THREE.CylinderGeometry(0.32, 0.4, 2.65, 8);
  tipPodGeo.rotateX(Math.PI / 2);
  const barrelGeo = new THREE.CylinderGeometry(0.16, 0.22, 1.15, 8);
  barrelGeo.rotateX(Math.PI / 2);

  const wingConfigs: readonly { side: number; angle: number }[] = [
    { side: 1, angle: 0.24 },
    { side: 1, angle: -0.24 },
    { side: -1, angle: -0.24 },
    { side: -1, angle: 0.24 },
  ];

  for (const cfg of wingConfigs) {
    const pivot = new THREE.Group();
    pivot.position.set(cfg.side * 1.25, 0.04, 1.85);
    pivot.rotation.z = cfg.angle;
    if (cfg.side < 0) {
      pivot.scale.x = -1;
    }

    addStyledPart(pivot, rootFairingGeo, slateMat, { position: [0.95, 0, 0.15] });
    addStyledPart(pivot, wingGeo, hullMat);
    addStyledPart(
      pivot,
      createTaperedBoxGeometry({
        frontWidth: 0.53,
        frontHeight: 0.65,
        backWidth: 0.85,
        backHeight: 0.65,
        length: 1.36,
      }),
      stripeMat,
      { position: [4.45, 0, 0.46], rotation: [0, -0.2, 0] },
    );
    // Seated wingtip pod + visible gunmetal barrel + directly attached orange muzzle ring.
    addStyledPart(pivot, tipPodGeo, slateMat, { position: [5.58, 0, -0.05] });
    addStyledPart(pivot, barrelGeo, gunmetalMat, { position: [5.58, 0, -1.65] });

    const muzzleRing = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.34, 8), navLightMat);
    muzzleRing.rotation.x = Math.PI / 2;
    muzzleRing.position.set(5.58, 0, -2.18);
    pivot.add(muzzleRing);

    root.add(pivot);
  }

  // 5. Proud twin engine shroud housings + recessed dark nozzles + cyan inner glow discs.
  const plumes: THREE.Group[] = [];
  const shroudGeo = new THREE.CylinderGeometry(0.84, 1.02, 3.4, 10);
  shroudGeo.rotateX(Math.PI / 2);
  const nozzleGeo = createCowling(0.78, 1.15, 10);

  for (const side of [-1, 1] as const) {
    addStyledPart(root, shroudGeo, slateMat, {
      position: [side * 1.42, 0.04, 4.05],
    });
    addStyledPart(root, new THREE.BoxGeometry(0.45, 0.36, 2.2), ivoryMat, {
      position: [side * 1.42, 0.92, 3.85],
    });
    addStyledPart(root, nozzleGeo, darkMat, { position: [side * 1.42, 0.04, 5.6] });

    const recessRing = new THREE.Mesh(new THREE.RingGeometry(0.33, 0.54, 10), outerPlumeMat);
    recessRing.position.set(side * 1.42, 0.04, 5.96);
    root.add(recessRing);

    const bellGlow = new THREE.Mesh(new THREE.CircleGeometry(0.34, 10), innerPlumeMat);
    bellGlow.position.set(side * 1.42, 0.04, 5.97);
    root.add(bellGlow);

    const plumeGroup = new THREE.Group();
    plumeGroup.position.set(side * 1.42, 0.04, 6.0);

    const outerCone = new THREE.Mesh(new THREE.ConeGeometry(0.42, 5.2, 9), outerPlumeMat);
    outerCone.rotation.x = Math.PI / 2;
    outerCone.position.set(0, 0, 2.6);
    plumeGroup.add(outerCone);

    const innerCone = new THREE.Mesh(new THREE.ConeGeometry(0.32, 3.2, 8), innerPlumeMat);
    innerCone.rotation.x = Math.PI / 2;
    innerCone.position.set(0, 0, 1.6);
    plumeGroup.add(innerCone);

    root.add(plumeGroup);
    plumes.push(plumeGroup);
  }

  const muzzleLeft = buildMuzzleBurst(6.5);
  muzzleLeft.position.set(
    -FIGHTER_WEAPON_LAYOUT.muzzleX,
    FIGHTER_WEAPON_LAYOUT.muzzleY,
    -FIGHTER_WEAPON_LAYOUT.muzzleForward,
  );
  root.add(muzzleLeft);

  const muzzleRight = buildMuzzleBurst(6.5);
  muzzleRight.position.set(
    FIGHTER_WEAPON_LAYOUT.muzzleX,
    FIGHTER_WEAPON_LAYOUT.muzzleY,
    -FIGHTER_WEAPON_LAYOUT.muzzleForward,
  );
  root.add(muzzleRight);

  return { root, plumes, muzzleLeft, muzzleRight };
}

export interface CockpitRig {
  readonly root: THREE.Group;
  readonly throttleHandle: THREE.Group;
  readonly barrelLeft: THREE.Group;
  readonly barrelRight: THREE.Group;
  readonly muzzleLeft: THREE.Group;
  readonly muzzleRight: THREE.Group;
  /** Gun tips glow through `uEmissiveIntensity` as heat builds. */
  readonly barrelHeatMat: CelMaterial;
  readonly heatVents: HeatVents;
  /** 0..1 stepped flash light on every cockpit surface while a barrel fires. */
  readonly muzzleFlash: THREE.IUniform<number>;
  readonly throttleNeedle: THREE.Group;
  readonly heatNeedle: THREE.Group;
  readonly charm: THREE.Group;
  /** Each LED owns its material so the renderer can recolour it; `rung` counts up the strut from 0. */
  readonly strutLeds: readonly StrutLed[];
  /** One hidden light streak per canopy strut, for whatever grazes that side. */
  readonly strutGlints: { readonly left: StrutGlint; readonly right: StrutGlint };
}

export type StrutGlint = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

export interface StrutLed {
  readonly rung: number;
  readonly material: THREE.MeshBasicMaterial;
}

export const STRUT_LED_RUNGS = 4;
export const STRUT_LED_BOOST = 1.5;

/** Resting colour of a strut LED: the top rung of each strut is amber, the rest cyan. */
export function strutLedRestColor(rung: number): number {
  return rung === STRUT_LED_RUNGS - 1 ? SCENE_PALETTE.ledAmber : SCENE_PALETTE.ledCyan;
}

function buildMuzzleBurst(scale = 1): THREE.Group {
  const burst = new THREE.Group();
  const coreMat = glowMat(0xfff9e0, 0.98, { hdrBoost: 3.1, additive: true });
  const haloMat = glowMat(0xffa436, 0.85, { hdrBoost: 2.5, additive: true });

  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.05 * scale, 0), coreMat);
  core.scale.set(1, 1, 2.2);
  burst.add(core);

  burst.add(new THREE.Mesh(new THREE.BoxGeometry(0.2 * scale, 0.02 * scale, 0.03 * scale), haloMat));
  burst.add(new THREE.Mesh(new THREE.BoxGeometry(0.02 * scale, 0.16 * scale, 0.03 * scale), haloMat));

  const streak = new THREE.Mesh(new THREE.ConeGeometry(0.038 * scale, 0.32 * scale, 6), haloMat);
  streak.rotation.x = -Math.PI / 2;
  streak.position.z = -0.16 * scale;
  burst.add(streak);

  // Forward plasma lance bridges the first 16 ms frame so bolts visibly erupt straight out of the barrel tip.
  const lance = new THREE.Mesh(new THREE.BoxGeometry(0.032 * scale, 0.032 * scale, 2.4 * scale), coreMat);
  lance.position.z = -1.2 * scale;
  burst.add(lance);

  burst.visible = false;
  return burst;
}

const GAUGE_SWEEP = 2.2;

function buildDashGauge(needleColor: number, bezelMat: THREE.Material): {
  readonly gauge: THREE.Group;
  readonly needle: THREE.Group;
} {
  const gauge = new THREE.Group();
  const bezel = new THREE.CylinderGeometry(0.078, 0.088, 0.034, 12);
  bezel.rotateX(Math.PI / 2);
  addStyledPart(gauge, bezel, bezelMat);
  addStyledPart(gauge, new THREE.CircleGeometry(0.066, 12), new THREE.MeshBasicMaterial({ color: 0x0b1524 }), {
    position: [0, 0, 0.018],
  });
  const tickMat = glowMat(0xcfd8ee, 1, { hdrBoost: 0.55 });
  const redlineMat = glowMat(0xff5a48, 1, { hdrBoost: 1.1 });
  const tickGeo = new THREE.BoxGeometry(0.006, 0.016, 0.002);
  for (let i = 0; i < 7; i += 1) {
    const angle = GAUGE_SWEEP * (1 - i / 3);
    addStyledPart(gauge, tickGeo, i >= 5 ? redlineMat : tickMat, {
      position: [-Math.sin(angle) * 0.052, Math.cos(angle) * 0.052, 0.02],
      rotation: [0, 0, angle],
    });
  }
  const needle = new THREE.Group();
  needle.position.z = 0.024;
  addStyledPart(needle, new THREE.BoxGeometry(0.007, 0.056, 0.003), glowMat(needleColor, 1, { hdrBoost: 1.5 }), {
    position: [0, 0.02, 0],
  });
  addStyledPart(needle, new THREE.CircleGeometry(0.011, 8), bezelMat, { position: [0, 0, 0.002] });
  gauge.add(needle);
  return { gauge, needle };
}

/** Needle rotation for a 0..1 reading; the dial sweeps clockwise from lower left to lower right. */
export function gaugeNeedleAngle(reading: number): number {
  return GAUGE_SWEEP * (1 - 2 * Math.min(1, Math.max(0, reading)));
}

export function buildCockpitRig(): CockpitRig {
  const root = new THREE.Group();
  const muzzleFlash = { value: 0 };
  const interior = {
    emissive: 0x161c34, emissiveIntensity: 1, rimColor: 0x6f8fe0, rimStrength: 0.22, muzzleFlash,
  } as const;
  const frameMat = celMat(0x464e6c, { ...interior, panel: 0.17 });
  const bevelMat = celMat(0x7683a6, { ...interior, gloss: 0.2 });
  const barrelMat = celMat(0x4d5672, { ...interior, gloss: 0.26 });
  const accentMat = celMat(0xd98332, { emissive: 0x4f2304, emissiveIntensity: 0.3, muzzleFlash });
  const ledAmber = glowMat(SCENE_PALETTE.ledAmber, 1, { hdrBoost: STRUT_LED_BOOST });
  const ledCyan = glowMat(SCENE_PALETTE.ledCyan, 1, { hdrBoost: STRUT_LED_BOOST });
  const strutLeds: StrutLed[] = [];
  const glintGeo = new THREE.BoxGeometry(0.016, 0.34, 0.022);
  const strutGlints = {
    left: new THREE.Mesh(glintGeo, glowMat(SCENE_PALETTE.nearMissGlint)),
    right: new THREE.Mesh(glintGeo, glowMat(SCENE_PALETTE.nearMissGlint)),
  };

  const strutProfile = new THREE.BoxGeometry(0.048, 1.76, 0.1);
  const hazardGeo = new THREE.BoxGeometry(0.008, 0.028, 0.104);
  const strutLedGeo = new THREE.BoxGeometry(0.008, 0.02, 0.02);
  for (const side of [-1, 1] as const) {
    const strut = addStyledPart(root, strutProfile, frameMat, {
      position: [side * 1.24, 0.1, -1.1],
      rotation: [0, side * -0.18, side * 0.2],
    });
    addStyledPart(strut, new THREE.BoxGeometry(0.012, 1.68, 0.018), bevelMat, {
      position: [-side * 0.018, 0, 0.046],
    });
    addStyledPart(strut, new THREE.BoxGeometry(0.069, 0.1, 0.12), barrelMat, {
      position: [0, -0.18, 0],
    });
    for (let i = 0; i < 3; i += 1) {
      addStyledPart(strut, hazardGeo, accentMat, {
        position: [-side * 0.022, -0.36 - i * 0.055, 0],
        rotation: [side * 0.5, 0, 0],
      });
    }
    for (let rung = 0; rung < STRUT_LED_RUNGS; rung += 1) {
      const material = glowMat(strutLedRestColor(rung), 1, { hdrBoost: STRUT_LED_BOOST });
      strutLeds.push({ rung, material });
      addStyledPart(strut, strutLedGeo, material, {
        position: [-side * 0.024, 0.02 + rung * 0.045, -0.02],
      });
    }
    const glint = side < 0 ? strutGlints.left : strutGlints.right;
    glint.position.set(-side * 0.022, 0.44, 0.05);
    glint.visible = false;
    strut.add(glint);

    addStyledPart(root, new THREE.BoxGeometry(0.22, 0.13, 1.08), frameMat, {
      position: [side * 1.12, -0.72, -0.92],
      rotation: [0, 0, side * -0.16],
    });
  }

  const jacketGeo = new THREE.CylinderGeometry(0.03, 0.042, 1.08, 8);
  jacketGeo.rotateX(-Math.PI / 2);
  const finGeo = new THREE.CylinderGeometry(0.052, 0.052, 0.022, 8);
  finGeo.rotateX(Math.PI / 2);
  const brakeGeo = new THREE.CylinderGeometry(0.036, 0.04, 0.09, 6);
  brakeGeo.rotateX(Math.PI / 2);
  const gunTipGeo = new THREE.CylinderGeometry(0.016, 0.024, 0.24, 8);
  gunTipGeo.rotateX(Math.PI / 2);
  const barrelHeatMat = celMat(0x5c6682, { emissive: SCENE_PALETTE.barrelHot, emissiveIntensity: 0 });
  const heatVents = createHeatVents([-1, 1]);

  function buildBarrelAssembly(side: -1 | 1): { readonly barrel: THREE.Group; readonly muzzle: THREE.Group } {
    const barrel = new THREE.Group();
    barrel.position.set(side * COCKPIT_GUN_LOCAL.x, COCKPIT_GUN_LOCAL.y, 0);
    const jacketZ = -(COCKPIT_GUN_LOCAL.forward - 0.76);
    addStyledPart(barrel, jacketGeo, barrelMat, { position: [0, 0, jacketZ] });
    for (const dz of [0.3, 0.2, 0.1]) {
      addStyledPart(barrel, finGeo, bevelMat, { position: [0, 0, jacketZ + dz] });
    }
    addStyledPart(barrel, new THREE.BoxGeometry(0.014, 0.012, 0.62), accentMat, {
      position: [0, 0.04, jacketZ - 0.12],
    });
    addStyledPart(barrel, brakeGeo, bevelMat, { position: [0, 0, jacketZ - 0.5] });
    addStyledPart(barrel, gunTipGeo, barrelHeatMat, {
      position: [0, 0, -(COCKPIT_GUN_LOCAL.forward - 0.12)],
    });
    const muzzle = buildMuzzleBurst(1.15);
    muzzle.position.set(0, 0, -COCKPIT_GUN_LOCAL.forward);
    barrel.add(muzzle);

    const plume = heatVents.plumes[side < 0 ? 0 : 1];
    if (plume !== undefined) {
      plume.position.set(0, 0, -(COCKPIT_GUN_LOCAL.forward - 0.06));
      barrel.add(plume);
    }

    root.add(barrel);
    return { barrel, muzzle };
  }

  const leftGun = buildBarrelAssembly(-1);
  const rightGun = buildBarrelAssembly(1);

  addStyledPart(root, new THREE.BoxGeometry(2.26, 0.048, 0.11), frameMat, {
    position: [0, 0.93, -1.12],
  });

  const hoodShape = new THREE.Shape();
  hoodShape.moveTo(-1.14, -0.16);
  hoodShape.lineTo(-0.76, 0.09);
  hoodShape.lineTo(0.76, 0.09);
  hoodShape.lineTo(1.14, -0.16);
  hoodShape.closePath();
  const hoodGeo = new THREE.ExtrudeGeometry(hoodShape, {
    depth: 0.72,
    bevelEnabled: true,
    bevelThickness: 0.025,
    bevelSize: 0.025,
    bevelSegments: 2,
  });
  const hood = addStyledPart(root, hoodGeo, frameMat, {
    position: [0, -0.79, -1.48],
    rotation: [0.1, 0, 0],
  });

  // Dark scope glass seats the 2D radar and status bars in a physical instrument bay.
  addStyledPart(hood, new THREE.BoxGeometry(0.98, 0.012, 0.4), new THREE.MeshBasicMaterial({ color: 0x08121c }), {
    position: [0, 0.117, 0.24],
  });
  const trimGeo = new THREE.BoxGeometry(1.02, 0.02, 0.016);
  addStyledPart(hood, trimGeo, bevelMat, { position: [0, 0.122, 0.03] });
  addStyledPart(hood, trimGeo, accentMat, { position: [0, 0.122, 0.45] });
  for (const side of [-1, 1] as const) {
    addStyledPart(hood, new THREE.BoxGeometry(0.016, 0.02, 0.42), bevelMat, {
      position: [side * 0.5, 0.122, 0.24],
    });
  }

  const throttleGauge = buildDashGauge(0xffb04a, bevelMat);
  throttleGauge.gauge.position.set(-0.9, -0.6, -1.36);
  throttleGauge.gauge.rotation.set(-0.3, 0.42, 0);
  root.add(throttleGauge.gauge);
  const heatGauge = buildDashGauge(0x7deaff, bevelMat);
  heatGauge.gauge.position.set(0.9, -0.6, -1.36);
  heatGauge.gauge.rotation.set(-0.3, -0.42, 0);
  root.add(heatGauge.gauge);

  const annunciator = createTaperedBoxGeometry({
    frontWidth: 0.32, backWidth: 0.42, frontHeight: 0.034, backHeight: 0.08, length: 0.24,
  });
  const knobGeo = new THREE.CylinderGeometry(0.014, 0.018, 0.03, 6);
  for (const side of [-1, 1]) {
    const bank = addStyledPart(root, annunciator, bevelMat, {
      position: [side * 0.65, -0.7, -1.12], rotation: [-0.16, side * -0.09, 0],
    });
    addStyledPart(bank, new THREE.BoxGeometry(0.32, 0.014, 0.18), frameMat, {
      position: [0, 0.037, 0],
    });
    for (const x of [-0.09, 0, 0.09]) {
      addStyledPart(bank, new THREE.BoxGeometry(0.064, 0.014, 0.052), side < 0 ? ledAmber : ledCyan, {
        position: [x, 0.048, 0.022],
      });
      addStyledPart(bank, knobGeo, x === 0 ? accentMat : barrelMat, { position: [x, 0.05, -0.07] });
    }
  }

  const throttleHandle = new THREE.Group();
  throttleHandle.position.set(-1.04, -0.68, -0.84);
  throttleHandle.rotation.z = 0.24;
  addStyledPart(throttleHandle, new THREE.BoxGeometry(0.024, 0.08, 0.026), bevelMat, {
    position: [0, 0.032, 0],
  });
  addStyledPart(throttleHandle, new THREE.BoxGeometry(0.08, 0.028, 0.04), accentMat, {
    position: [0.01, 0.075, 0],
  });
  root.add(throttleHandle);

  // Lucky crystal on a cord: the renderer swings it with the ship's rotation.
  addStyledPart(root, new THREE.BoxGeometry(0.2, 0.012, 0.012), bevelMat, { position: [-1.1, 0.585, -1.16] });
  const charm = new THREE.Group();
  charm.position.set(-1.0, 0.58, -1.16);
  addStyledPart(charm, new THREE.BoxGeometry(0.004, 0.1, 0.004), barrelMat, { position: [0, -0.05, 0] });
  addStyledPart(charm, new THREE.OctahedronGeometry(0.008, 0), bevelMat, { position: [0, -0.1, 0] });
  addStyledPart(charm, new THREE.OctahedronGeometry(0.024, 0), celMat(0xffb347, {
    emissive: 0xc8641a, emissiveIntensity: 0.7, gloss: 0.5,
  }), { position: [0, -0.132, 0], scale: [0.72, 1.25, 0.72] });
  root.add(charm);

  // Faint canopy reflections past the gun tips, so frame and guns occlude them like real glazing.
  // Thin strips instead of one screen-sized quad: blending every pixel is expensive on integrated GPUs.
  const streakGeo = new THREE.PlaneGeometry(14, 1);
  for (const [offset, halfWidth, strength] of [[-1.03, 0.31, 0.026], [-0.4, 0.09, 0.042], [1.66, 0.2, 0.02]] as const) {
    const streak = new THREE.Mesh(
      streakGeo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { uStrength: { value: strength } },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform float uStrength;
          varying vec2 vUv;
          void main() {
            float across = 1.0 - abs(vUv.y * 2.0 - 1.0);
            float along = 0.45 + 0.55 * abs(vUv.x * 2.0 - 1.0);
            gl_FragColor = vec4(vec3(0.5, 0.78, 1.0), across * along * uStrength);
          }
        `,
      }),
    );
    streak.position.set(0.56 * offset, 0.83 * offset, -2.6);
    streak.rotation.z = -0.593;
    streak.scale.y = halfWidth * 2;
    root.add(streak);
  }

  return {
    root,
    throttleHandle,
    barrelLeft: leftGun.barrel,
    barrelRight: rightGun.barrel,
    muzzleLeft: leftGun.muzzle,
    muzzleRight: rightGun.muzzle,
    barrelHeatMat,
    heatVents,
    muzzleFlash,
    throttleNeedle: throttleGauge.needle,
    heatNeedle: heatGauge.needle,
    charm,
    strutLeds,
    strutGlints,
  };
}

export const ENEMY_SHIELD_BUBBLE = 'enemy-shield-bubble';

/** The shield shell sits just outside the sim's hit sphere, so the flare and the collapse match what was hit. */
export function enemyShieldRadius(kind: EnemyKind): number {
  return SHIP_STATS.enemies[kind].hitRadius * 1.18;
}

export function buildEnemyMesh(kind: EnemyKind, textures: HullTextureSet): THREE.Group {
  const root = new THREE.Group();
  const enemyRim = { rimColor: RIM_PALETTE.hostile, rimStrength: 0.5, panel: 1.3, gloss: 0.18 } as const;
  const hullMat = celMat(0x67708d, enemyRim);
  const darkSlateMat = celMat(0x2b3246, enemyRim);
  const gunmetalMat = celMat(0x3e4760, enemyRim);
  const vaneMat = celMat(0xffffff, { map: textures.solarVane, ...enemyRim });
  const rimMat = celMat(0xbcc6db, { rimColor: RIM_PALETTE.hostile, rimStrength: 0.3 });
  const crimsonMat = celMat(SCENE_PALETTE.hostileAccent, {
    emissive: SCENE_PALETTE.hostileEmissive,
    emissiveIntensity: 0.55,
    rimColor: 0xff8a96,
    rimStrength: 0.35,
  });
  const visorGlowMat = glowMat(0xff7850, 1, { hdrBoost: 2.2 });
  const coreMat = glowMat(SCENE_PALETTE.hostileBolt, 1, { hdrBoost: 2.8 });

  if (kind === 'raider') {
    addStyledPart(root, new THREE.IcosahedronGeometry(2.6, 1), hullMat);

    const socket = createCowling(1.32, 0.73, 6);
    addStyledPart(root, socket, darkSlateMat, {
      position: [0, -0.05, -2.12], rotation: [0, Math.PI, 0],
    });
    addStyledPart(root, new THREE.CircleGeometry(0.85, 6), crimsonMat, {
      position: [0, -0.05, -2.61], rotation: [0, Math.PI, 0],
    });
    addStyledPart(root, new THREE.BoxGeometry(0.86, 0.19, 0.06), visorGlowMat, {
      position: [0, -0.05, -2.65],
    });

    // Twin chin cannon nubs under the forward ball.
    const chinGunGeo = new THREE.CylinderGeometry(0.14, 0.22, 1.5, 6);
    chinGunGeo.rotateX(Math.PI / 2);
    for (const side of [-1, 1] as const) {
      addStyledPart(root, chinGunGeo, darkSlateMat, { position: [side * 0.72, -1.95, -1.65] });
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.2, 6), coreMat);
      tip.rotation.x = Math.PI / 2;
      tip.position.set(side * 0.72, -1.95, -2.42);
      root.add(tip);
    }

    // Tapered strut fairings + engineered metallic joint ring collar mid-span.
    const sparGeo = new THREE.CylinderGeometry(0.58, 0.66, 12.6, 8);
    sparGeo.rotateZ(Math.PI / 2);
    addStyledPart(root, sparGeo, gunmetalMat);

    const strutCollarGeo = new THREE.CylinderGeometry(0.82, 1.45, 2.2, 6);
    const jointRingGeo = new THREE.CylinderGeometry(0.92, 0.92, 0.55, 8);
    for (const side of [-1, 1] as const) {
      const collar = addStyledPart(root, strutCollarGeo, darkSlateMat, {
        position: [side * 3.05, 0, 0],
        rotation: [0, 0, side * (Math.PI / 2)],
      });
      collar.scale.set(0.85, 1, 1.2);
      addStyledPart(root, jointRingGeo, rimMat, {
        position: [side * 4.35, 0, 0],
        rotation: [0, 0, Math.PI / 2],
      });
    }

    // Sensor blades and forward vane prongs give the raider a predatory outline.
    const bladeGeo = createTaperedBoxGeometry({
      frontWidth: 0.14, frontHeight: 0.3, backWidth: 0.2, backHeight: 1.7, length: 2.8, backYOffset: 0.7,
    });
    addStyledPart(root, bladeGeo, crimsonMat, { position: [0, 2.55, 0.5] });
    addStyledPart(root, bladeGeo, darkSlateMat, { position: [0, -2.55, 0.5], rotation: [0, 0, Math.PI] });
    const prongGeo = createTaperedBoxGeometry({
      frontWidth: 0.16, frontHeight: 0.22, backWidth: 0.6, backHeight: 0.95, length: 3.4,
    });

    const vaneGeo = createHexSolarVaneGeometry();
    const outerHubGeo = new THREE.CylinderGeometry(1.55, 2.25, 0.75, 6);
    for (const side of [-1, 1] as const) {
      const vaneGroup = new THREE.Group();
      vaneGroup.position.set(side * 6.3, 0, 0.15);
      vaneGroup.rotation.z = side * 0.15;

      addStyledPart(vaneGroup, vaneGeo, gunmetalMat);
      addStyledPart(vaneGroup, vaneGeo, vaneMat, { scale: [1.16, 0.9, 0.89] });
      // Raised outer hexagonal hub boss so side-on views have unmistakable 3D depth.
      addStyledPart(vaneGroup, outerHubGeo, gunmetalMat, {
        position: [side * 0.45, 0, 0],
        rotation: [0, 0, side * (-Math.PI / 2)],
      });
      addStyledPart(vaneGroup, new THREE.BoxGeometry(0.95, 1.15, 7.2), crimsonMat);
      // Shortened vertical rim ribs sitting strictly inside the hex edges (zero edge poke-through).
      addStyledPart(vaneGroup, new THREE.BoxGeometry(0.8, 4.9, 0.65), rimMat, {
        position: [0, 0, -3.45],
      });
      addStyledPart(vaneGroup, new THREE.BoxGeometry(0.8, 4.9, 0.58), rimMat, {
        position: [0, 0, 3.45],
      });
      for (const tip of [-1, 1] as const) {
        addStyledPart(vaneGroup, prongGeo, rimMat, {
          position: [0, tip * 4.7, -3.5],
          rotation: [tip * 0.14, 0, 0],
        });
      }
      root.add(vaneGroup);
    }

    const aftShroud = createCowling(1.35, 1.3, 8);
    addStyledPart(root, aftShroud, gunmetalMat, { position: [0, 0, 2.02] });
    const core = new THREE.Mesh(new THREE.CircleGeometry(0.82, 8), coreMat);
    core.position.set(0, 0, 2.64);
    root.add(core);
  } else {
    // Enemy Interceptor: drooped diamond chisel dagger, stealth gunmetal thrusters, seated root cannons.
    addStyledPart(
      root,
      createDiamondPrismGeometry({
        frontWidth: 0.65,
        frontHeight: 0.44,
        backWidth: 4.4,
        backHeight: 1.78,
        length: 7.4,
        frontYOffset: -0.58,
        backYOffset: -0.04,
      }),
      hullMat,
      { position: [0, 0, -6.2] },
    );

    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 4.3,
        frontHeight: 1.75,
        backWidth: 5.8,
        backHeight: 2.15,
        length: 4.6,
        backYOffset: 0.14,
      }),
      hullMat,
      { position: [0, 0, -0.4] },
    );
    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 5.7,
        frontHeight: 2.05,
        backWidth: 3.4,
        backHeight: 1.38,
        length: 4.4,
        frontYOffset: 0.12,
        backYOffset: 0.04,
      }),
      darkSlateMat,
      { position: [0, 0, 3.9] },
    );

    // Raised tapered dorsal spine + wider-base armored tail fin + deeper ventral keel for hero-low readability.
    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 1.65,
        frontHeight: 0.68,
        backWidth: 2.35,
        backHeight: 1.1,
        length: 6.4,
        frontYOffset: -0.1,
        backYOffset: 0.14,
      }),
      darkSlateMat,
      { position: [0, 1.16, 0.9] },
    );
    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 0.62,
        frontHeight: 0.52,
        backWidth: 0.34,
        backHeight: 1.9,
        length: 3.8,
        frontYOffset: -0.35,
        backYOffset: 0.48,
      }),
      crimsonMat,
      { position: [0, 1.72, 4.0] },
    );
    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 0.45,
        frontHeight: 0.46,
        backWidth: 1.15,
        backHeight: 1.45,
        length: 7.2,
        frontYOffset: 0.18,
        backYOffset: -0.24,
      }),
      darkSlateMat,
      { position: [0, -1.22, -2.3] },
    );

    // Forward-mounted elongated crimson sensor-visor in a dark armored socket collar.
    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 1.25,
        frontHeight: 0.46,
        backWidth: 1.95,
        backHeight: 0.72,
        length: 3.6,
        frontYOffset: -0.14,
      }),
      darkSlateMat,
      { position: [0, 0.78, -3.55] },
    );
    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 0.92,
        frontHeight: 0.22,
        backWidth: 1.5,
        backHeight: 0.36,
        length: 2.55,
        frontYOffset: -0.06,
      }),
      visorGlowMat,
      { position: [0, 0.96, -3.85] },
    );

    addStyledPart(root, createTaperedBoxGeometry({
      frontWidth: 1.48, backWidth: 1.85, frontHeight: 0.1, backHeight: 0.32, length: 1.75,
    }), gunmetalMat, { position: [0, 1.28, -3.12], rotation: [-0.13, 0, 0] });

    const sponsonGeo = createDaggerSponsonGeometry();
    const shroudGeo = new THREE.CylinderGeometry(0.76, 0.98, 2.7, 8);
    shroudGeo.rotateX(Math.PI / 2);

    for (const side of [-1, 1] as const) {
      addStyledPart(
        root,
        createTaperedBoxGeometry({
          frontWidth: 0.48,
          frontHeight: 0.44,
          backWidth: 1.18,
          backHeight: 0.68,
          length: 4.5,
        }),
        crimsonMat,
        {
          position: [side * 2.15, 0.28, -2.75],
          rotation: [0, side * 0.24, side * -0.12],
        },
      );

      addStyledPart(root, new THREE.BoxGeometry(0.32, 0.68, 4.2), darkSlateMat, {
        position: [side * 2.7, 0.02, 0.3],
      });
      addStyledPart(
        root,
        createTaperedBoxGeometry({
          frontWidth: 0.2, frontHeight: 0.08, backWidth: 1.5, backHeight: 0.16, length: 2.3,
        }),
        crimsonMat,
        { position: [side * 1.75, -0.3, -6.1], rotation: [0, side * -0.55, side * 0.2] },
      );
      addStyledPart(root, new THREE.BoxGeometry(0.18, 0.16, 2.6), visorGlowMat, {
        position: [side * 2.82, 0.02, -0.2],
      });

      // Forward-swept outward-canted dagger sponson wing with thickened root fairing & seated root intake/cannon.
      const wingPivot = new THREE.Group();
      wingPivot.position.set(side * 2.45, 0.08, 0.85);
      wingPivot.rotation.z = side * -0.22;
      if (side < 0) {
        wingPivot.scale.x = -1;
      }

      addStyledPart(
        wingPivot,
        createTaperedBoxGeometry({
          frontWidth: 1.55,
          frontHeight: 1.05,
          backWidth: 1.85,
          backHeight: 0.86,
          length: 4.2,
        }),
        darkSlateMat,
        { position: [0.65, 0, 0.15] },
      );
      addStyledPart(wingPivot, sponsonGeo, gunmetalMat);
      addStyledPart(wingPivot, sponsonGeo, vaneMat, {
        position: [0.16, 0, -0.12], scale: [0.91, 1.12, 0.86],
      });
      addStyledPart(
        wingPivot,
        createTaperedBoxGeometry({
          frontWidth: 0.42,
          frontHeight: 0.62,
          backWidth: 0.56,
          backHeight: 0.62,
          length: 5.2,
        }),
        crimsonMat,
        { position: [2.25, 0.05, -2.3], rotation: [0, -0.52, 0] },
      );
      addStyledPart(wingPivot, new THREE.BoxGeometry(0.22, 0.22, 0.6), coreMat, { position: [4.24, 0.17, -6.2] });
      // Thickened stubby gun pod seated directly onto the wing root (no thin floating sticks).
      const rootGun = new THREE.CylinderGeometry(0.24, 0.32, 2.1, 8);
      rootGun.rotateX(Math.PI / 2);
      addStyledPart(wingPivot, rootGun, gunmetalMat, { position: [1.1, 0.02, -2.1] });

      root.add(wingPivot);

      // Stealth gunmetal engine housings + restrained mint inner glow (-25% size).
      addStyledPart(root, shroudGeo, gunmetalMat, {
        position: [side * 1.85, 0.06, 4.95],
      });
      const nozzleInner = createCowling(0.74, 0.84, 8);
      addStyledPart(root, nozzleInner, darkSlateMat, { position: [side * 1.85, 0.06, 6.04] });

      const engineGlow = new THREE.Mesh(new THREE.CircleGeometry(0.48, 8), coreMat);
      engineGlow.position.set(side * 1.85, 0.06, 6.38);
      root.add(engineGlow);
    }
  }

  const shieldBubble = createShieldBubble(enemyShieldRadius(kind)).mesh;
  shieldBubble.name = ENEMY_SHIELD_BUBBLE;
  root.add(shieldBubble);

  return root;
}

export function buildFriendlyCarrierMesh(textures: HullTextureSet): THREE.Group {
  const root = new THREE.Group();
  const hullMat = celMat(0xffffff, { map: textures.carrierHull });
  const ivoryArmorMat = celMat(0xf3ede0, { panel: 15 });
  const warmMidMat = celMat(0xd9cfbc, { panel: 15 });
  const slateKeelMat = celMat(0x465068, { panel: 15, gloss: 0.16 });
  const darkRecessMat = celMat(0x212736);
  const accentMat = celMat(0xe59238);
  const bayLight = glowMat(0xffd27a, 1, { hdrBoost: 2.0 });
  const bridgeLight = glowMat(0xffe092, 1, { hdrBoost: 2.2 });
  const windowLight = glowMat(0xffe6a8, 1, { hdrBoost: 1.8 });
  const engineGlow = glowMat(0x6cd8ff, 1, { hdrBoost: 2.6 });
  const plumeGlow = glowMat(0x52c7ff, 0.58, { hdrBoost: 2.2, additive: true });

  // 1. Solid armored raked bow prow (clean ivory armor — kills concave grid-wall illusion in ortho-front).
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 28,
      frontHeight: 18,
      backWidth: 74,
      backHeight: 34,
      length: 78,
      frontYOffset: 4,
      backYOffset: 0,
    }),
    warmMidMat,
    { position: [0, 0, -131] },
  );
  // Solid bow nose bumper cap + vertical armored prow rib so ortho-front reads unmistakably convex.
  addStyledPart(root, new THREE.BoxGeometry(28, 17, 6), slateKeelMat, {
    position: [0, 4, -170],
  });
  addStyledPart(root, new THREE.BoxGeometry(22, 4.5, 4), accentMat, {
    position: [0, 8, -173.2],
  });
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 22,
      frontHeight: 5,
      backWidth: 62,
      backHeight: 8,
      length: 74,
      frontYOffset: 1,
      backYOffset: 0,
    }),
    ivoryArmorMat,
    { position: [0, 17, -128] },
  );
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 14,
      frontHeight: 2.2,
      backWidth: 22,
      backHeight: 2.2,
      length: 30,
    }),
    accentMat,
    { position: [0, 21.6, -138] },
  );

  // Bow catapult prongs, port deck batteries and a comms dish act as scale landmarks.
  const bowProngGeo = createTaperedBoxGeometry({
    frontWidth: 2.2, frontHeight: 2.2, backWidth: 6, backHeight: 5.5, length: 30, backYOffset: -1,
  });
  for (const side of [-1, 1] as const) {
    addStyledPart(root, bowProngGeo, ivoryArmorMat, { position: [side * 10.5, 9, -184] });
    addStyledPart(root, new THREE.BoxGeometry(1.2, 1.2, 5), bayLight, { position: [side * 10.5, 9.6, -197] });
  }
  const deckBatteryGeo = createTaperedBoxGeometry({
    frontWidth: 5.5, frontHeight: 3, backWidth: 7.5, backHeight: 4.6, length: 9,
  });
  const deckBarrelGeo = new THREE.BoxGeometry(0.9, 0.9, 9);
  for (const z of [-66, -8, 62]) {
    const battery = addStyledPart(root, deckBatteryGeo, slateKeelMat, { position: [-27.5, 28.2, z] });
    for (const dx of [-1.5, 1.5]) {
      addStyledPart(battery, deckBarrelGeo, darkRecessMat, { position: [dx, 0.4, -8] });
    }
  }
  const dishGeo = new THREE.ConeGeometry(6.5, 3.4, 10);
  addStyledPart(root, dishGeo, ivoryArmorMat, { position: [21, 70.5, 56], rotation: [-2.2, 0, 0] });
  addStyledPart(root, new THREE.CylinderGeometry(0.5, 0.5, 6, 5), accentMat, {
    position: [21, 72.6, 58.8], rotation: [0.94, 0, 0],
  });

  // 2. Full-width mid-hull hangar block + raised ivory flight deck + flush dark runway strip + flush ventral keel.
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 76,
      frontHeight: 34,
      backWidth: 76,
      backHeight: 34,
      length: 186,
      uvTile: 0.25,
    }),
    hullMat,
    { position: [0, 0, -1] },
  );
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 64,
      frontHeight: 9,
      backWidth: 66,
      backHeight: 9,
      length: 184,
    }),
    ivoryArmorMat,
    { position: [0, 21.5, -1] },
  );
  // Recessed dark slate flight-deck runway strip breaking up the flat white top surface.
  addStyledPart(root, new THREE.BoxGeometry(24, 1.0, 182), slateKeelMat, {
    position: [-6, 26.2, -1],
  });

  // Flush tapered slate ventral keel merged cleanly into the mid-hull bottom (zero gap!).
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 44,
      frontHeight: 14,
      backWidth: 52,
      backHeight: 16,
      length: 214,
      frontYOffset: 2,
      backYOffset: 0,
    }),
    slateKeelMat,
    { position: [0, -19, -4] },
  );

  for (let i = -2; i <= 2; i += 1) {
    const marker = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.5, 10), accentMat);
    marker.position.set(-6, 26.82, i * 29 - 1);
    root.add(marker);
  }
  for (const side of [-1, 1] as const) {
    for (const z of [-80, 78]) {
      for (const offset of [4, 8]) {
        addStyledPart(root, new THREE.BoxGeometry(1.5, 0.48, 11), ivoryArmorMat, {
          position: [-6 + side * offset, 26.86, z],
        });
      }
    }
    const guide = new THREE.BoxGeometry(1.2, 0.6, 3.8);
    for (let z = -77; z <= 77; z += 22) {
      addStyledPart(root, guide, bayLight, { position: [-6 + side * 11.3, 26.85, z] });
    }
    addStyledPart(root, new THREE.BoxGeometry(3.2, 1.4, 178), accentMat, {
      position: [side * 30.5, 26.5, -1],
    });
  }

  // 3. Narrower stepped aft engine block.
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 70,
      frontHeight: 30,
      backWidth: 56,
      backHeight: 24,
      length: 66,
      frontYOffset: 0,
      backYOffset: 1,
    }),
    warmMidMat,
    { position: [0, 0, 123] },
  );

  // 4. Starboard-offset layered island superstructure with low-profile faceted radar dome (no lollipop).
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 20,
      frontHeight: 20,
      backWidth: 24,
      backHeight: 20,
      length: 62,
    }),
    ivoryArmorMat,
    { position: [21, 35, 34] },
  );
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 16,
      frontHeight: 14,
      backWidth: 18,
      backHeight: 14,
      length: 40,
    }),
    warmMidMat,
    { position: [21, 51, 38] },
  );
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 22,
      frontHeight: 9,
      backWidth: 20,
      backHeight: 9,
      length: 26,
    }),
    ivoryArmorMat,
    { position: [21, 62, 34] },
  );
  addStyledPart(root, new THREE.BoxGeometry(21.4, 3.2, 56), accentMat, {
    position: [21, 37, 34],
  });
  const bridgeFront = new THREE.Mesh(new THREE.BoxGeometry(19, 3.6, 2.2), bridgeLight);
  bridgeFront.position.set(21, 62, 20.6);
  root.add(bridgeFront);
  const bridgeFlanks = new THREE.Mesh(new THREE.BoxGeometry(23.2, 3.2, 16), bridgeLight);
  bridgeFlanks.position.set(21, 62, 30);
  root.add(bridgeFlanks);

  // Scale-cue lit deck window rows along island tiers and bow superstructure.
  for (let i = 0; i < 6; i += 1) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(21.8, 1.3, 3.4), windowLight);
    win.position.set(21, 41.8, 12 + i * 8.4);
    root.add(win);
  }
  for (let i = 0; i < 4; i += 1) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(17.8, 1.2, 3.0), windowLight);
    win.position.set(21, 51.4, 24 + i * 8.2);
    root.add(win);
  }

  // Clean low-profile sensor penthouse + offset radar dome & short mast.
  addStyledPart(root, new THREE.BoxGeometry(14, 5, 16), slateKeelMat, {
    position: [21, 69, 36],
  });
  addStyledPart(root, new THREE.SphereGeometry(4.2, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), ivoryArmorMat, {
    position: [21, 71, 31],
  });
  addStyledPart(root, new THREE.CylinderGeometry(0.95, 2.6, 17, 6), slateKeelMat, {
    position: [24, 78.5, 42],
  });

  addStyledPart(root, new THREE.BoxGeometry(13, 1.8, 2.1), ivoryArmorMat, {
    position: [24, 82.5, 42],
  });
  addStyledPart(root, new THREE.BoxGeometry(1.6, 10, 1.6), accentMat, {
    position: [19, 85.5, 42],
  });

  for (const zPos of [-42, 36] as const) {
    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 16,
        frontHeight: 6,
        backWidth: 16,
        backHeight: 6,
        length: 36,
      }),
      ivoryArmorMat,
      { position: [-42, 19, zPos] },
    );
    addStyledPart(root, new THREE.BoxGeometry(2.5, 2.6, 36), accentMat, {
      position: [-50.2, 21.5, zPos],
    });
  }

  // 5. Recessed flank hangar mouths (2 per side), bold orange hull band, and recessed hull trench with pipes.
  const conduitGeo = new THREE.CylinderGeometry(2.2, 2.2, 176, 8);
  conduitGeo.rotateX(Math.PI / 2);

  const gantry = new THREE.Shape();
  gantry.moveTo(-25, -10);
  gantry.lineTo(25, -10);
  gantry.lineTo(25, 7);
  gantry.lineTo(21, 10);
  gantry.lineTo(-21, 10);
  gantry.lineTo(-25, 7);
  gantry.closePath();
  const mouth = new THREE.Path();
  mouth.moveTo(-20, -6);
  mouth.lineTo(-20, 3);
  mouth.lineTo(-16, 6);
  mouth.lineTo(16, 6);
  mouth.lineTo(20, 3);
  mouth.lineTo(20, -6);
  mouth.closePath();
  gantry.holes.push(mouth);
  const gantryGeo = new THREE.ExtrudeGeometry(gantry, { depth: 6, bevelEnabled: false });

  for (const side of [-1, 1] as const) {
    addStyledPart(root, new THREE.BoxGeometry(3.5, 5.4, 216), accentMat, {
      position: [side * 39.2, 11, -10],
    });
    // Flank cabin window strips conveying capital-ship scale.
    for (let i = 0; i < 8; i += 1) {
      const flankWin = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.3, 4.8), windowLight);
      flankWin.position.set(side * 38.6, 15.2, -74 + i * 20);
      root.add(flankWin);
    }

    addStyledPart(root, new THREE.BoxGeometry(4.2, 6.2, 178), slateKeelMat, {
      position: [side * 37.6, -12, -2],
    });
    addStyledPart(root, conduitGeo, warmMidMat, {
      position: [side * 39.8, -12, -2],
    });

    for (const bayZ of [-48, 22] as const) {
      addStyledPart(root, gantryGeo, ivoryArmorMat, {
        position: [side * 37.5, -1, bayZ], rotation: [0, side * Math.PI / 2, 0],
      });
      // Keep hangar back-wall, light bar, and landing deck strictly non-coplanar to prevent z-fighting.
      addStyledPart(root, new THREE.BoxGeometry(1.0, 14.2, 43), darkRecessMat, {
        position: [side * 38.6, -1, bayZ],
      });
      addStyledPart(root, new THREE.BoxGeometry(1.0, 1.3, 28), bayLight, {
        position: [side * 40.0, 1.4, bayZ],
      });
      addStyledPart(root, new THREE.BoxGeometry(6.4, 2.0, 44), slateKeelMat, {
        position: [side * 42.6, -8.5, bayZ],
      });
    }
  }

  // 6. Aligned 4-thruster inline stern housing + faired dorsal stabilizer fins (no kickstand/drooping cones).
  addStyledPart(root, new THREE.BoxGeometry(56, 20, 14), slateKeelMat, {
    position: [0, 1, 158],
  });
  const shroudGeo = new THREE.CylinderGeometry(6.6, 8.2, 14, 10);
  shroudGeo.rotateX(Math.PI / 2);
  const nozzleGeo = new THREE.CylinderGeometry(5.4, 6.6, 6, 10);
  nozzleGeo.rotateX(Math.PI / 2);

  for (const x of [-19, -6.5, 6.5, 19] as const) {
    addStyledPart(root, shroudGeo, slateKeelMat, { position: [x, 1, 165] });
    addStyledPart(root, nozzleGeo, darkRecessMat, { position: [x, 1, 173] });

    const glow = new THREE.Mesh(new THREE.CircleGeometry(5.1, 10), engineGlow);
    glow.position.set(x, 1, 176.3);
    root.add(glow);

    const plume = new THREE.Mesh(new THREE.ConeGeometry(5.0, 28, 8), plumeGlow);
    plume.rotation.x = Math.PI / 2;
    plume.position.set(x, 1, 190);
    root.add(plume);
  }

  // Faired stern stabilizer fins tucked cleanly into the aft deck (no kickstand overhang).
  for (const side of [-1, 1] as const) {
    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 4.0,
        frontHeight: 16,
        backWidth: 3.0,
        backHeight: 28,
        length: 34,
        frontYOffset: 0,
        backYOffset: 6,
      }),
      ivoryArmorMat,
      { position: [side * 28, 12, 134], rotation: [0, 0, side * -0.15] },
    );
    addStyledPart(root, new THREE.BoxGeometry(3.4, 6, 28), accentMat, {
      position: [side * 29.5, 25, 138],
      rotation: [0, 0, side * -0.15],
    });
  }

  return root;
}

export interface HostileFrigateRig {
  readonly root: THREE.Group;
  readonly subsystemMeshes: ReadonlyMap<string, THREE.Mesh>;
  readonly shieldRing: THREE.Mesh;
}

export function buildHostileFrigateMesh(textures: HullTextureSet): HostileFrigateRig {
  const root = new THREE.Group();
  const frigateRim = { rimColor: RIM_PALETTE.hostile, rimStrength: 0.34, panel: 13, gloss: 0.18 } as const;
  const hullMat = celMat(0xffffff, {
    map: textures.frigateHull,
    emissive: 0x161026,
    emissiveIntensity: 0.3,
    ...frigateRim,
  });
  const hullPlateMat = celMat(0x4b4161, {
    emissive: 0x120c20,
    emissiveIntensity: 0.25,
    ...frigateRim,
  });
  const armorMat = celMat(0x745c82, {
    emissive: 0x180f1d,
    emissiveIntensity: 0.25,
    ...frigateRim,
  });
  const darkArmorMat = celMat(0x271e36, frigateRim);
  const crimsonAccent = celMat(SCENE_PALETTE.frigateAccent, {
    emissive: 0x731420,
    emissiveIntensity: 0.65,
    rimColor: 0xff8a96,
    rimStrength: 0.3,
  });
  const trenchGlow = glowMat(SCENE_PALETTE.frigateGlow, 1, { hdrBoost: 2.3 });
  const windowLight = glowMat(0xff8e9c, 1, { hdrBoost: 1.9 });
  const driveGlow = glowMat(0xff526b, 1, { hdrBoost: 2.6 });

  // 1. Sculpted 2-volume tapered dreadnought hull (raked prow + flared armored stern — no flat brick wall!).
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 12,
      frontHeight: 14,
      backWidth: 80,
      backHeight: 30,
      length: 178,
      frontYOffset: 6,
      backYOffset: 0,
    }),
    hullPlateMat,
    { position: [0, 2, -46] },
  );
  // Chisel armored bow ram cap (blunts any knife-edge dagger artifact in persp-front).
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 8,
      frontHeight: 11,
      backWidth: 16,
      backHeight: 15,
      length: 18,
    }),
    darkArmorMat,
    { position: [0, 8, -138] },
  );
  // Broad armored stern hull section carrying the mid-hull panel texture cleanly.
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 80,
      frontHeight: 30,
      backWidth: 68,
      backHeight: 28,
      length: 88,
      uvTile: 0.28,
    }),
    hullMat,
    { position: [0, 2, 85] },
  );

  // Flush ventral armored keel with recessed lower trench (smooth bow rake, no floating dagger point).
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 16,
      frontHeight: 6,
      backWidth: 50,
      backHeight: 18,
      length: 190,
      frontYOffset: 4,
      backYOffset: -2,
    }),
    darkArmorMat,
    { position: [0, -14, 24] },
  );

  // Stepped dorsal armor spine deck.
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 14,
      frontHeight: 10,
      backWidth: 36,
      backHeight: 14,
      length: 172,
    }),
    armorMat,
    { position: [0, 20, 22] },
  );

  // Spine blades and bow mandibles sharpen the dreadnought profile.
  const spineBladeGeo = createTaperedBoxGeometry({
    frontWidth: 1.6, frontHeight: 3, backWidth: 2.6, backHeight: 13, length: 17, backYOffset: 4.5,
  });
  for (const z of [0, 21, 42]) {
    addStyledPart(root, spineBladeGeo, crimsonAccent, { position: [0, 28, z] });
  }
  const mandibleGeo = createTaperedBoxGeometry({
    frontWidth: 1.4, frontHeight: 2.2, backWidth: 5, backHeight: 7, length: 38, frontYOffset: -1.5,
  });
  for (const side of [-1, 1] as const) {
    addStyledPart(root, mandibleGeo, armorMat, {
      position: [side * 9.5, 6.5, -146], rotation: [0, side * 0.12, 0],
    });
  }

  // 3-tier stepped armored conning tower with recessed crimson visor slit.
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 28,
      frontHeight: 16,
      backWidth: 36,
      backHeight: 18,
      length: 44,
    }),
    armorMat,
    { position: [0, 33, 78] },
  );
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 22,
      frontHeight: 12,
      backWidth: 24,
      backHeight: 12,
      length: 26,
    }),
    darkArmorMat,
    { position: [0, 46, 82] },
  );
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 34,
      frontHeight: 7,
      backWidth: 28,
      backHeight: 7,
      length: 18,
    }),
    armorMat,
    { position: [0, 54, 79] },
  );
  const bridgeSlit = new THREE.Mesh(new THREE.BoxGeometry(26, 2.8, 2.6), trenchGlow);
  bridgeSlit.position.set(0, 54, 69.2);
  root.add(bridgeSlit);

  addStyledPart(root, createTaperedBoxGeometry({
    frontWidth: 39, backWidth: 30, frontHeight: 2.8, backHeight: 5, length: 23,
  }), hullPlateMat, { position: [0, 57, 78] });

  const turret = createTaperedBoxGeometry({
    frontWidth: 8, backWidth: 12, frontHeight: 4, backHeight: 6, length: 13,
  });
  const barrels = new THREE.CylinderGeometry(1.05, 1.45, 15, 6);
  barrels.rotateX(-Math.PI / 2);
  for (const side of [-1, 1]) {
    for (const [x, y, z] of [[13, 15, -51], [26, 17, 48], [13, -20, 21]] as const) {
      const battery = addStyledPart(root, turret, armorMat, {
        position: [side * x, y, z], rotation: [0, -side * 0.5, y < 0 ? Math.PI : 0],
      });
      for (const dx of [-2.3, 2.3]) {
        addStyledPart(battery, barrels, hullPlateMat, { position: [dx, 0.7, -10] });
      }
    }
  }

  // Scale-cue conning tower & spine deck window rows.
  for (let i = 0; i < 4; i += 1) {
    const towerWin = new THREE.Mesh(new THREE.BoxGeometry(33.4, 1.3, 3.6), windowLight);
    towerWin.position.set(0, 35.5, 63 + i * 9.5);
    root.add(towerWin);
  }
  for (let i = 0; i < 6; i += 1) {
    const spineWin = new THREE.Mesh(new THREE.BoxGeometry(26 + i * 1.4, 1.1, 3.2), windowLight);
    spineWin.position.set(0, 21.5, -26 + i * 15);
    root.add(spineWin);
  }

  // Symmetric crimson hostile-fleet accent bands + recessed flank trench vents (strictly mirrored port & starboard).
  for (const side of [-1, 1] as const) {
    // Angled crimson shoulder warpaint tucked strictly flush along the tapered bow shoulders.
    addStyledPart(
      root,
      createTaperedBoxGeometry({
        frontWidth: 3.8,
        frontHeight: 4.5,
        backWidth: 5.2,
        backHeight: 5.5,
        length: 126,
      }),
      crimsonAccent,
      { position: [side * 21, 14, -8], rotation: [0, side * 0.19, 0] },
    );
    // Dark mid-hull recessed flank band breaking up the side silhouette.
    addStyledPart(root, new THREE.BoxGeometry(4.5, 8.5, 96), darkArmorMat, {
      position: [side * 37.5, 2, 74],
    });
    const flankVent = new THREE.Mesh(new THREE.BoxGeometry(2.0, 3.2, 82), trenchGlow);
    flankVent.position.set(side * 39.8, 2, 74);
    root.add(flankVent);
  }

  // Faired stern propulsion block + 3 proud armored thruster shrouds (integrated cleanly into stern hull).
  addStyledPart(root, new THREE.BoxGeometry(64, 24, 16), darkArmorMat, {
    position: [0, 2, 130],
  });
  const driveShroudGeo = new THREE.CylinderGeometry(8.2, 10.6, 18, 8);
  driveShroudGeo.rotateX(Math.PI / 2);
  for (const x of [-20, 0, 20]) {
    addStyledPart(root, driveShroudGeo, darkArmorMat, { position: [x, 2, 138] });
    const drive = new THREE.Mesh(new THREE.CircleGeometry(6.8, 8), driveGlow);
    drive.position.set(x, 2, 147.3);
    root.add(drive);
  }

  // Seat targetable shield dome from shared sim layout so visual mesh and hitbox cannot drift.
  const domePos = FRIGATE_SUBSYSTEM_LAYOUT.shieldDome.localOffset;
  const domeCollar = new THREE.CylinderGeometry(16.5, 19.5, 9, 6);
  addStyledPart(root, domeCollar, darkArmorMat, {
    position: [domePos.x, domePos.y - 4, domePos.z],
  });

  for (const side of [-1, 1]) {
    addStyledPart(root, createTaperedBoxGeometry({
      frontWidth: 3.5, backWidth: 5.5, frontHeight: 6, backHeight: 13, length: 18,
    }), armorMat, {
      position: [domePos.x + side * 15, domePos.y - 1, domePos.z + 1],
      rotation: [0, side * 0.12, side * -0.24],
    });
  }

  const shieldDome = addStyledPart(
    root,
    new THREE.IcosahedronGeometry(12.5, 2),
    celMat(SCENE_PALETTE.shieldDome, { emissive: 0xd42288, emissiveIntensity: 1.4 }),
    { position: [domePos.x, domePos.y, domePos.z] },
  );

  const shieldRing = new THREE.Mesh(
    new THREE.TorusGeometry(15.2, 1.15, 8, 24),
    glowMat(0xff8ad8, 0.85, { hdrBoost: 2.3, additive: true }),
  );
  shieldRing.position.set(domePos.x, domePos.y - 0.5, domePos.z);
  shieldRing.rotation.x = Math.PI * 0.5;
  root.add(shieldRing);

  // Integrated ventral clamp-core housing anchored directly to shared sim layout.
  const clampPos = FRIGATE_SUBSYSTEM_LAYOUT.clampCore.localOffset;
  addStyledPart(
    root,
    createTaperedBoxGeometry({
      frontWidth: 28,
      frontHeight: 16,
      backWidth: 34,
      backHeight: 18,
      length: 44,
    }),
    armorMat,
    { position: [clampPos.x, clampPos.y + 7, clampPos.z] },
  );
  const clampCore = addStyledPart(
    root,
    new THREE.OctahedronGeometry(13.5, 1),
    celMat(SCENE_PALETTE.clampCore, { emissive: 0xd6400e, emissiveIntensity: 1.4 }),
    { position: [clampPos.x, clampPos.y, clampPos.z] },
  );

  for (const side of [-1, 1] as const) {
    addStyledPart(root, createTaperedBoxGeometry({
      frontWidth: 6, backWidth: 9, frontHeight: 12, backHeight: 25, length: 28,
      frontYOffset: 4, backYOffset: -2,
    }), darkArmorMat, {
      position: [clampPos.x + side * 18, clampPos.y + 2, clampPos.z],
      rotation: [0, 0, side * -0.26],
    });
  }

  const subsystemMeshes = new Map<string, THREE.Mesh>([
    [FRIGATE_SUBSYSTEM_LAYOUT.shieldDome.id, shieldDome],
    [FRIGATE_SUBSYSTEM_LAYOUT.clampCore.id, clampCore],
  ]);

  return { root, subsystemMeshes, shieldRing };
}

/** Lock-on missile, nose along -Z: slim enough that a launch beside the cockpit never fills the view. */
export function buildMissileMesh(): THREE.Group {
  const root = new THREE.Group();
  const bodyMat = celMat(0xf1eadc, { rimColor: RIM_PALETTE.friendly, rimStrength: 0.4, gloss: 0.3 });
  const bandMat = celMat(SCENE_PALETTE.missile, { emissive: SCENE_PALETTE.missile, emissiveIntensity: 0.5 });
  const darkMat = celMat(0x2a3044);

  const body = new THREE.CylinderGeometry(0.2, 0.2, 2.6, 8);
  body.rotateX(Math.PI / 2);
  addStyledPart(root, body, bodyMat);
  const nose = new THREE.ConeGeometry(0.2, 0.9, 8);
  nose.rotateX(-Math.PI / 2);
  addStyledPart(root, nose, bandMat, { position: [0, 0, -1.75] });
  const collar = new THREE.CylinderGeometry(0.215, 0.215, 0.3, 8);
  collar.rotateX(Math.PI / 2);
  addStyledPart(root, collar, bandMat, { position: [0, 0, 0.55] });
  const fin = createTaperedBoxGeometry({
    frontWidth: 0.04, frontHeight: 0.3, backWidth: 0.04, backHeight: 1.1, length: 0.9,
  });
  addStyledPart(root, fin, darkMat, { position: [0, 0, 0.95] });
  addStyledPart(root, fin, darkMat, { position: [0, 0, 0.95], rotation: [0, 0, Math.PI / 2] });

  const nozzle = new THREE.Mesh(
    new THREE.CircleGeometry(0.17, 8),
    glowMat(SCENE_PALETTE.missileTrail, 1, { hdrBoost: 2.8 }),
  );
  nozzle.position.z = 1.31;
  root.add(nozzle);
  return root;
}

export function buildAsteroidMesh(
  asteroid: AsteroidState,
  textures: HullTextureSet,
): THREE.Group {
  const group = new THREE.Group();
  const map =
    asteroid.tint === 'ice'
      ? textures.asteroidIce
      : asteroid.tint === 'ochre'
        ? textures.asteroidOchre
        : textures.asteroidSlate;

  const geo = new THREE.IcosahedronGeometry(asteroid.radius, 1);
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  const frequency = 2.7 / asteroid.radius;
  for (let i = 0; i < posAttr.count; i += 1) {
    const vx = posAttr.getX(i);
    const vy = posAttr.getY(i);
    const vz = posAttr.getZ(i);
    const warp = 1 + 0.2 * Math.sin(vx * frequency + asteroid.rotation.x * 4)
      * Math.cos(vy * frequency + asteroid.rotation.y * 4) + 0.09 * Math.sin(vz * frequency);
    posAttr.setXYZ(i, vx * warp, vy * warp * 0.78, vz * warp);
  }
  geo.computeVertexNormals();

  addStyledPart(group, geo, celMat(0xffffff, { map, rimColor: RIM_PALETTE.rock, rimStrength: 0.2 }));
  group.position.set(asteroid.position.x, asteroid.position.y, asteroid.position.z);
  group.rotation.set(asteroid.rotation.x, asteroid.rotation.y, asteroid.rotation.z);
  return group;
}

const AA_STEP_GLSL = `
float aaStep(float threshold, float value) {
  float w = fwidth(value) * 0.9 + 1e-4;
  return smoothstep(threshold - w, threshold + w, value);
}
`;

function createSparkleTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    const half = size / 2;
    ctx.translate(half, half);
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, half * 0.34);
    core.addColorStop(0, 'rgba(255, 255, 255, 1)');
    core.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = core;
    ctx.fillRect(-half, -half, size, size);
    for (let arm = 0; arm < 4; arm += 1) {
      const ray = ctx.createLinearGradient(0, 0, half, 0);
      ray.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
      ray.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = ray;
      ctx.beginPath();
      ctx.moveTo(0, -1.6);
      ctx.lineTo(half, 0);
      ctx.lineTo(0, 1.6);
      ctx.fill();
      ctx.rotate(Math.PI / 2);
    }
  }
  return new THREE.CanvasTexture(canvas);
}

// Everything in the sky except the sun disc: gradient, dusk glow and the tiered nebula.
const SKY_BODY_GLSL = `
uniform vec3 uSunDir;

float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * noise3(p);
    p = p * 2.03 + 11.7;
    amp *= 0.5;
  }
  return sum;
}

// Three soft-edged tiers read as painted cloud cels; the wide edges cannot alias.
float tiers(float n, float base) {
  return (smoothstep(base, base + 0.035, n) + smoothstep(base + 0.1, base + 0.135, n)
    + smoothstep(base + 0.2, base + 0.235, n)) / 3.0;
}

vec3 skyBody(vec3 dir) {
  float y = clamp(dir.y, -1.0, 1.0);
  vec3 zenith = vec3(0.005, 0.008, 0.026);
  vec3 horizon = vec3(0.028, 0.016, 0.044);
  vec3 nadir = vec3(0.006, 0.005, 0.018);
  vec3 base = y >= 0.0
    ? mix(horizon, zenith, pow(y, 0.55))
    : mix(horizon, nadir, pow(-y, 0.65));

  float sunAlign = max(dot(dir, uSunDir), 0.0);
  vec3 duskGlow = vec3(0.30, 0.10, 0.035) * pow(sunAlign, 13.5);
  vec3 sunHalo = vec3(0.88, 0.46, 0.18) * pow(sunAlign, 54.0) * 0.65;

  float latitude = dir.y + dir.x * 0.14 + 0.045 * sin(dir.z * 5.0);
  float belt = 1.0 - smoothstep(0.035, 0.3, abs(latitude));
  float farBank = 1.0 - smoothstep(0.02, 0.1, abs(latitude + 0.14));
  float drift = fbm(dir * 2.4 + 3.0);
  float wisps = fbm(dir * 5.2 - 7.0);
  vec3 nebula = vec3(0.045, 0.02, 0.07) * tiers(drift + belt * 0.22, 0.52)
    + vec3(0.075, 0.022, 0.06) * tiers(wisps * 0.6 + drift * 0.4 + belt * 0.2, 0.62) * belt
    + vec3(0.01, 0.045, 0.06) * tiers(drift * 0.5 + wisps * 0.5, 0.56) * (1.0 - belt) * 0.7
    + vec3(0.011, 0.014, 0.03) * farBank;
  return base + duskGlow + sunHalo + nebula;
}
`;

// Depth is pinned to the far plane: the sky draws last for early-z, and must still sit behind distant ships.
const SKY_VERTEX_GLSL = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = (projectionMatrix * modelViewMatrix * vec4(position, 1.0)).xyww;
}
`;

// Eight noise octaves per sky pixel cost more than the rest of the frame on integrated GPUs, so the sky body
// is rendered once into a cube map. Square-root encoding keeps the dark gradients smooth in 8 bits.
function bakeSkyBody(
  renderer: THREE.WebGLRenderer,
  skyGeo: THREE.BufferGeometry,
  sunDir: THREE.Vector3,
): THREE.WebGLCubeRenderTarget {
  const target = new THREE.WebGLCubeRenderTarget(768, { generateMipmaps: false });
  const bakeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uSunDir: { value: sunDir } },
    vertexShader: SKY_VERTEX_GLSL,
    fragmentShader: `
      varying vec3 vDir;
      ${SKY_BODY_GLSL}
      void main() {
        gl_FragColor = vec4(sqrt(skyBody(normalize(vDir))), 1.0);
      }
    `,
  });
  const bakeScene = new THREE.Scene();
  bakeScene.add(new THREE.Mesh(skyGeo, bakeMat));
  new THREE.CubeCamera(1, 6000, target).update(renderer, bakeScene);
  bakeMat.dispose();
  return target;
}

/** Pass the renderer to bake the sky body once; without it the sky computes its noise per pixel. */
export function buildOrbitalBackdrop(
  dotTexture: THREE.CanvasTexture,
  renderer?: THREE.WebGLRenderer,
): THREE.Group {
  const group = new THREE.Group();
  // Keep the star off to the far right flank so it rim-lights ships cleanly without glaring in the player's eyes.
  const sun = BIOME_CARDS.saturnOrbit.sunDirection;
  const sunDir = new THREE.Vector3(sun.x, sun.y, sun.z).normalize();

  const skyGeo = new THREE.SphereGeometry(5400, 36, 24);
  const skyBake = renderer === undefined ? null : bakeSkyBody(renderer, skyGeo, sunDir);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: sunDir },
      uSkyBody: { value: skyBake?.texture ?? null },
    },
    vertexShader: SKY_VERTEX_GLSL,
    fragmentShader: `
      varying vec3 vDir;
      ${skyBake === null
        ? SKY_BODY_GLSL
        : `uniform vec3 uSunDir;
           uniform samplerCube uSkyBody;
           vec3 skyBody(vec3 dir) {
             vec3 encoded = textureCube(uSkyBody, dir).rgb;
             return encoded * encoded;
           }`}

      void main() {
        vec3 dir = normalize(vDir);
        vec3 color = skyBody(dir);
        float sunAlign = dot(dir, uSunDir);
        if (sunAlign > 0.97) {
          vec3 sunRight = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
          vec3 sunUp = cross(sunRight, uSunDir);
          float spoke = pow(abs(cos(atan(dot(dir, sunUp), dot(dir, sunRight)) * 3.0)), 18.0);
          color += vec3(1.0, 0.62, 0.3) * spoke * pow(sunAlign, 220.0) * 0.55
            + vec3(0.5, 0.2, 0.08) * (smoothstep(0.9952, 0.9956, sunAlign) + smoothstep(0.9974, 0.9978, sunAlign)) * 0.22
            + vec3(2.2, 1.7, 1.15) * smoothstep(0.9988, 0.9996, sunAlign);
        }
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  skyMat.addEventListener('dispose', () => {
    skyBake?.dispose();
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = 1;
  group.add(sky);

  const planetPos = new THREE.Vector3(-1950, -480, -3400);
  const planetRadius = 820;
  const ringInner = 1040;
  const ringOuter = 1580;
  const ringEuler = new THREE.Euler(Math.PI * 0.46, 0.18, 0);
  const ringUniforms = {
    uSunDir: { value: sunDir },
    uPlanetRadius: { value: planetRadius },
    uRingNormal: { value: new THREE.Vector3(0, 0, 1).applyEuler(ringEuler) },
    uRingSpan: { value: new THREE.Vector2(ringInner, ringOuter) },
  };
  const ringDensityGlsl = `
    uniform vec2 uRingSpan;
    ${AA_STEP_GLSL}
    // x: ringlet brightness, y: opacity. Shared so the shadow on the planet matches the rings exactly.
    vec2 ringDensity(float radius) {
      float t = (radius - uRingSpan.x) / (uRingSpan.y - uRingSpan.x);
      if (t <= 0.0 || t >= 1.0) return vec2(0.0);
      float footprint = fwidth(t);
      float cassini = smoothstep(0.015, 0.04 + footprint, abs(t - 0.62) + footprint * 0.5)
        * smoothstep(0.006, 0.02 + footprint, abs(t - 0.27) + footprint * 0.5);
      float ringlets = 0.5 + 0.5 * aaStep(0.0, sin(t * 40.0 + sin(t * 9.0) * 2.0));
      float edgeFade = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.9, 1.0, t));
      return vec2(ringlets, edgeFade * cassini * (0.4 + 0.34 * ringlets));
    }
  `;

  const planetGeo = new THREE.SphereGeometry(planetRadius, 48, 36);
  const planetMat = new THREE.ShaderMaterial({
    uniforms: ringUniforms,
    vertexShader: `
      varying vec3 vLocal;
      varying vec3 vWorldPos;
      void main() {
        vLocal = normalize(position);
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      uniform vec3 uRingNormal;
      uniform float uPlanetRadius;
      varying vec3 vLocal;
      varying vec3 vWorldPos;
      ${ringDensityGlsl}
      void main() {
        vec3 normal = normalize(vLocal);
        float lat = normal.y + sin(normal.x * 6.0 + normal.y * 9.0) * 0.012 + sin(normal.z * 11.0) * 0.007;
        float band = sin(lat * 21.0) * 0.5 + 0.5 + 0.22 * sin(lat * 47.0 + 1.3);
        vec3 albedo = vec3(0.1, 0.07, 0.15);
        albedo = mix(albedo, vec3(0.24, 0.13, 0.17), aaStep(0.26, band));
        albedo = mix(albedo, vec3(0.42, 0.25, 0.16), aaStep(0.52, band));
        albedo = mix(albedo, vec3(0.62, 0.46, 0.31), aaStep(0.82, band));
        vec2 storm = vec2(atan(normal.z, normal.x) - 0.75, (normal.y + 0.3) * 3.4);
        albedo = mix(albedo, vec3(0.74, 0.3, 0.16), 1.0 - aaStep(0.11, length(storm)));

        float ndl = dot(normal, uSunDir);
        float lit = 0.035 + 0.42 * aaStep(-0.05, ndl) + 0.5 * aaStep(0.05, ndl);

        vec3 local = normal * uPlanetRadius;
        float travel = -dot(local, uRingNormal) / dot(uSunDir, uRingNormal);
        float ringShadow = travel > 0.0 ? ringDensity(length(local + uSunDir * travel)).y : 0.0;
        lit *= 1.0 - 0.5 * ringShadow;

        float fresnel = pow(1.0 - max(dot(normal, normalize(cameraPosition - vWorldPos)), 0.0), 3.0);
        vec3 haze = vec3(0.5, 0.3, 0.34) * fresnel * (0.12 + 0.6 * aaStep(-0.05, ndl));
        gl_FragColor = vec4(albedo * lit * 0.88 + vec3(0.006, 0.005, 0.016) + haze, 1.0);
      }
    `,
  });
  const planet = new THREE.Mesh(planetGeo, planetMat);
  planet.position.copy(planetPos);
  group.add(planet);

  const ringGeo = new THREE.RingGeometry(ringInner, ringOuter, 96);
  const ringMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    uniforms: ringUniforms,
    vertexShader: `
      varying vec3 vLocalPos;
      varying vec3 vOffsetFromPlanet;
      void main() {
        vLocalPos = position;
        vOffsetFromPlanet = (modelMatrix * vec4(position, 1.0)).xyz - (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      uniform float uPlanetRadius;
      varying vec3 vLocalPos;
      varying vec3 vOffsetFromPlanet;
      ${ringDensityGlsl}
      void main() {
        vec2 density = ringDensity(length(vLocalPos.xy));
        float proj = dot(vOffsetFromPlanet, uSunDir);
        vec3 perp = vOffsetFromPlanet - uSunDir * proj;
        float inShadow = (proj < 0.0) ? (1.0 - smoothstep(uPlanetRadius * 0.94, uPlanetRadius * 1.04, length(perp))) : 0.0;

        vec3 litColor = mix(vec3(0.3, 0.17, 0.26), vec3(0.78, 0.58, 0.4), density.x);
        vec3 color = mix(litColor, vec3(0.015, 0.012, 0.03), inShadow * 0.9);
        gl_FragColor = vec4(color, density.y);
      }
    `,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.copy(planetPos);
  ring.rotation.copy(ringEuler);
  group.add(ring);

  const moonMat = new THREE.ShaderMaterial({
    uniforms: { uSunDir: { value: sunDir } },
    vertexShader: `
      varying vec3 vNormalLocal;
      void main() {
        vNormalLocal = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      varying vec3 vNormalLocal;
      ${AA_STEP_GLSL}
      void main() {
        vec3 normal = normalize(vNormalLocal);
        float ndl = dot(normal, uSunDir);
        float crater = aaStep(0.3, sin(normal.x * 9.0 + 1.0) * sin(normal.y * 8.0) * sin(normal.z * 7.0 + 2.0));
        vec3 albedo = mix(vec3(0.32, 0.4, 0.46), vec3(0.2, 0.26, 0.34), crater);
        gl_FragColor = vec4(albedo * (0.05 + 0.4 * aaStep(-0.05, ndl) + 0.5 * aaStep(0.4, ndl)), 1.0);
      }
    `,
  });
  const moon = new THREE.Mesh(new THREE.SphereGeometry(74, 20, 14), moonMat);
  moon.position.set(-1300, 950, -3600);
  group.add(moon);

  const starCount = 2200;
  const starPositions = new Float32Array(starCount * 3);
  const starColors = new Float32Array(starCount * 3);
  let seed = 0x1337c0de;
  const nextRand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  for (let i = 0; i < starCount; i += 1) {
    const u = nextRand() * 2 - 1;
    const theta = nextRand() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    const dist = 4600;
    starPositions[i * 3] = r * Math.cos(theta) * dist;
    starPositions[i * 3 + 1] = u * dist;
    starPositions[i * 3 + 2] = r * Math.sin(theta) * dist;

    // Power-law brightness + subtle stellar tint (amber, blue-white, neutral, pale lavender).
    const mag = 0.28 + Math.pow(nextRand(), 2.4) * 0.82;
    const tintRoll = nextRand();
    if (tintRoll < 0.18) {
      starColors[i * 3] = 1.0 * mag;
      starColors[i * 3 + 1] = 0.8 * mag;
      starColors[i * 3 + 2] = 0.58 * mag;
    } else if (tintRoll < 0.45) {
      starColors[i * 3] = 0.72 * mag;
      starColors[i * 3 + 1] = 0.86 * mag;
      starColors[i * 3 + 2] = 1.0 * mag;
    } else if (tintRoll < 0.62) {
      starColors[i * 3] = 0.88 * mag;
      starColors[i * 3 + 1] = 0.78 * mag;
      starColors[i * 3 + 2] = 1.0 * mag;
    } else {
      starColors[i * 3] = 0.96 * mag;
      starColors[i * 3 + 1] = 0.95 * mag;
      starColors[i * 3 + 2] = 0.98 * mag;
    }
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xffffff,
    vertexColors: true,
    map: dotTexture,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    size: 17,
    sizeAttenuation: true,
  });
  group.add(new THREE.Points(starGeo, starMat));

  // Sparse cross-glint stars so the field reads as hand-placed.
  const sparkleTexture = createSparkleTexture();
  const sparkleCount = 64;
  const sparklePositions = new Float32Array(sparkleCount * 3);
  const sparkleColors = new Float32Array(sparkleCount * 3);
  for (let i = 0; i < sparkleCount; i += 1) {
    const u = nextRand() * 2 - 1;
    const theta = nextRand() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    sparklePositions.set([r * Math.cos(theta) * 4500, u * 4500, r * Math.sin(theta) * 4500], i * 3);
    const mag = 0.55 + nextRand() * 0.75;
    const warm = nextRand() < 0.4;
    sparkleColors.set(warm ? [mag, 0.8 * mag, 0.6 * mag] : [0.75 * mag, 0.9 * mag, mag], i * 3);
  }
  const sparkleGeo = new THREE.BufferGeometry();
  sparkleGeo.setAttribute('position', new THREE.BufferAttribute(sparklePositions, 3));
  sparkleGeo.setAttribute('color', new THREE.BufferAttribute(sparkleColors, 3));
  const sparkleMat = new THREE.PointsMaterial({
    vertexColors: true,
    map: sparkleTexture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    size: 104,
    sizeAttenuation: true,
  });
  sparkleMat.addEventListener('dispose', () => {
    sparkleTexture.dispose();
  });
  group.add(new THREE.Points(sparkleGeo, sparkleMat));

  return group;
}
