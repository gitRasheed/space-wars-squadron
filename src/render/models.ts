import * as THREE from 'three';
import { FIGHTER_WEAPON_LAYOUT } from '../sim/combat';
import type { AsteroidState, EnemyKind } from '../sim/types';
import { FRIGATE_SUBSYSTEM_LAYOUT } from '../sim/world';
import { SCENE_PALETTE, SUN_DIRECTION } from './palette';
import type { HullTextureSet } from './textures';

function createToonGradientRamp(): THREE.DataTexture {
  // 4-band stepped luminance ramp with deep shadow floor for crisp cel-shaded tone breaks.
  const bands = new Uint8Array([
    26, 26, 26, 255,
    102, 102, 102, 255,
    188, 188, 188, 255,
    255, 255, 255, 255,
  ]);
  const tex = new THREE.DataTexture(bands, 4, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const TOON_RAMP = createToonGradientRamp();
const INK_SHELL_MAT = new THREE.MeshBasicMaterial({
  color: SCENE_PALETTE.inkOutline,
  side: THREE.BackSide,
});
const SUBTLE_EDGE_MAT = new THREE.LineBasicMaterial({
  color: SCENE_PALETTE.subtleEdge,
  transparent: true,
  opacity: 0.48,
});

export const SHARED_MODEL_MATERIALS: ReadonlySet<THREE.Material> = new Set([
  INK_SHELL_MAT,
  SUBTLE_EDGE_MAT,
]);

function toonMat(
  color: number,
  options?: {
    readonly map?: THREE.Texture;
    readonly emissive?: number;
    readonly emissiveIntensity?: number;
    readonly rimColor?: number;
    readonly rimStrength?: number;
  },
): THREE.MeshToonMaterial {
  const params: THREE.MeshToonMaterialParameters = {
    color,
    emissive: options?.emissive ?? 0x000000,
    emissiveIntensity: options?.emissiveIntensity ?? 0,
    gradientMap: TOON_RAMP,
  };
  if (options?.map !== undefined) {
    params.map = options.map;
  }
  const mat = new THREE.MeshToonMaterial(params);
  const rimStrength = options?.rimStrength ?? 0.18;
  if (rimStrength > 0) {
    const rimColor = new THREE.Color(options?.rimColor ?? 0x7c96d8);
    mat.customProgramCacheKey = () => 'sws-toon-rim-v1';
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uRimColor = { value: rimColor };
      shader.uniforms.uRimStrength = { value: rimStrength };
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'uniform float opacity;',
          'uniform float opacity;\nuniform vec3 uRimColor;\nuniform float uRimStrength;',
        )
        .replace(
          '#include <opaque_fragment>',
          `float swsRimDot = 1.0 - max(dot(normalize(normal), normalize(vViewPosition)), 0.0);
          float swsRimBand = smoothstep(0.52, 0.72, pow(swsRimDot, 2.0));
          outgoingLight += uRimColor * (swsRimBand * uRimStrength);
          #include <opaque_fragment>`,
        );
    };
  }
  return mat;
}

function glowMat(
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

function addStyledPart(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  options?: {
    readonly position?: readonly [number, number, number];
    readonly rotation?: readonly [number, number, number];
    readonly scale?: readonly [number, number, number];
    readonly edgeAngle?: number;
    readonly hullOutline?: number;
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

  if (options?.edgeAngle !== undefined) {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, options.edgeAngle),
      SUBTLE_EDGE_MAT,
    );
    mesh.add(edges);
  }

  if (options?.hullOutline !== undefined && options.hullOutline > 1) {
    const shell = new THREE.Mesh(geometry, INK_SHELL_MAT);
    shell.scale.setScalar(options.hullOutline);
    mesh.add(shell);
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

function createDiamondPrismGeometry(spec: TaperedBoxSpec): THREE.CylinderGeometry {
  const geo = new THREE.CylinderGeometry(1, 1, spec.length, 4, 1);
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
  shape.lineTo(5.5, -0.5);
  shape.lineTo(5.65, 0.95);
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
  shape.lineTo(3.8, -6.2);
  shape.lineTo(4.4, -5.2);
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
  const hullMat = toonMat(0xffffff, { map: textures.fighterHull });
  const ivoryMat = toonMat(0xf4efe4);
  const warmPlateMat = toonMat(0xe2d9ca);
  const slateMat = toonMat(0x525c74);
  const gunmetalMat = toonMat(0x3f4860);
  const darkMat = toonMat(0x232838);
  const stripeMat = toonMat(stripeColor);
  const canopyMat = toonMat(0xffbe59, { emissive: 0x8a480a, emissiveIntensity: 0.55 });
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
    { position: [0, 0, -5.5], hullOutline: 1.035 },
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
    { position: [0, -0.66, -3.45], hullOutline: 1.04 },
  );
  addStyledPart(root, new THREE.BoxGeometry(0.66, 0.28, 0.24), darkMat, {
    position: [0, -0.58, -5.36],
  });

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
    { position: [0, 0, -0.1], hullOutline: 1.035 },
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
      { position: [side * 1.18, -0.04, -2.3], edgeAngle: 40 },
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
      { position: [side * 1.54, 0.12, 0.45], edgeAngle: 40 },
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
    { position: [0, 0, 4.1], hullOutline: 1.035 },
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
    { position: [0, 0.92, -0.3], edgeAngle: 40 },
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

  const sensorDomeGeo = new THREE.CylinderGeometry(0.42, 0.52, 0.42, 8);
  addStyledPart(root, sensorDomeGeo, slateMat, { position: [0, 1.24, 1.1] });
  addStyledPart(root, new THREE.SphereGeometry(0.38, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), ivoryMat, {
    position: [0, 1.42, 1.1],
  });

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
    { position: [0, 1.14, 3.85], hullOutline: 1.04 },
  );

  // 4. Muscular airfoil S-foils with thick root fairings and integrated wingtip cannon pods (no floating dots).
  const wingGeo = createSweptWingGeometry();
  const rootFairingGeo = createTaperedBoxGeometry({
    frontWidth: 2.3,
    frontHeight: 0.88,
    backWidth: 2.4,
    backHeight: 0.72,
    length: 3.3,
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
    addStyledPart(pivot, wingGeo, hullMat, { hullOutline: 1.04 });
    addStyledPart(
      pivot,
      createTaperedBoxGeometry({
        frontWidth: 1.35,
        frontHeight: 0.54,
        backWidth: 1.15,
        backHeight: 0.54,
        length: 1.7,
      }),
      stripeMat,
      { position: [4.45, 0, 0.28] },
    );
    // Seated wingtip pod + visible gunmetal barrel + directly attached orange muzzle ring.
    addStyledPart(pivot, tipPodGeo, slateMat, { position: [5.58, 0, -0.05], hullOutline: 1.04 });
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
  const nozzleGeo = new THREE.CylinderGeometry(0.62, 0.82, 1.25, 10);
  nozzleGeo.rotateX(Math.PI / 2);

  for (const side of [-1, 1] as const) {
    addStyledPart(root, shroudGeo, slateMat, {
      position: [side * 1.42, 0.04, 4.05],
      hullOutline: 1.045,
    });
    addStyledPart(root, new THREE.BoxGeometry(0.45, 0.36, 2.2), ivoryMat, {
      position: [side * 1.42, 0.92, 3.85],
    });
    addStyledPart(root, nozzleGeo, darkMat, { position: [side * 1.42, 0.04, 6.0] });

    const recessRing = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.62, 10), outerPlumeMat);
    recessRing.position.set(side * 1.42, 0.04, 6.64);
    root.add(recessRing);

    const bellGlow = new THREE.Mesh(new THREE.CircleGeometry(0.44, 10), innerPlumeMat);
    bellGlow.position.set(side * 1.42, 0.04, 6.66);
    root.add(bellGlow);

    const plumeGroup = new THREE.Group();
    plumeGroup.position.set(side * 1.42, 0.04, 6.7);

    const outerCone = new THREE.Mesh(new THREE.ConeGeometry(0.64, 5.2, 9), outerPlumeMat);
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
  readonly muzzleLeft: THREE.Group;
  readonly muzzleRight: THREE.Group;
  readonly flashLight: THREE.PointLight;
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

  burst.visible = false;
  return burst;
}

export function buildCockpitRig(): CockpitRig {
  const root = new THREE.Group();
  const frameMat = toonMat(0x2d3245);
  const bevelMat = toonMat(0x5c6682);
  const barrelMat = toonMat(0x424a62);
  const accentMat = toonMat(0xd98332, { emissive: 0x4f2304, emissiveIntensity: 0.3 });
  const ledAmber = glowMat(0xf4b459, 1, { hdrBoost: 1.5 });
  const ledCyan = glowMat(0x6be5ff, 1, { hdrBoost: 1.5 });

  const cockpitFill = new THREE.PointLight(0x88a8ff, 0.45, 4.0);
  cockpitFill.position.set(0, -0.25, -0.45);
  root.add(cockpitFill);

  const flashLight = new THREE.PointLight(0xffbb55, 0, 5.5);
  flashLight.position.set(0, -0.2, -1.9);
  root.add(flashLight);

  const strutProfile = new THREE.BoxGeometry(0.048, 1.76, 0.1);
  for (const side of [-1, 1] as const) {
    addStyledPart(root, strutProfile, frameMat, {
      position: [side * 1.24, 0.1, -1.1],
      rotation: [0, side * -0.18, side * 0.2],
      edgeAngle: 35,
    });

    const highlight = new THREE.Mesh(new THREE.BoxGeometry(0.012, 1.68, 0.018), bevelMat);
    highlight.position.set(side * 1.21, 0.1, -1.045);
    highlight.rotation.set(0, side * -0.18, side * 0.2);
    root.add(highlight);

    addStyledPart(root, new THREE.BoxGeometry(0.22, 0.13, 1.08), frameMat, {
      position: [side * 1.12, -0.72, -0.92],
      rotation: [0, 0, side * -0.16],
    });

    const gunShroud = new THREE.CylinderGeometry(0.02, 0.044, 1.05, 8);
    gunShroud.rotateX(Math.PI / 2);
    addStyledPart(root, gunShroud, barrelMat, {
      position: [side * 0.99, -0.54, -1.56],
    });

    const gunTip = new THREE.CylinderGeometry(0.014, 0.02, 0.2, 8);
    gunTip.rotateX(Math.PI / 2);
    addStyledPart(root, gunTip, bevelMat, {
      position: [side * 0.99, -0.54, -2.18],
    });
  }

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
  addStyledPart(root, hoodGeo, frameMat, {
    position: [0, -0.79, -1.48],
    rotation: [0.1, 0, 0],
    edgeAngle: 35,
  });

  for (let i = -2; i <= 2; i += 1) {
    const led = new THREE.Mesh(
      new THREE.BoxGeometry(0.028, 0.012, 0.012),
      i === 0 ? ledCyan : ledAmber,
    );
    led.position.set(i * 0.14, -0.665, -0.76);
    root.add(led);
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

  const muzzleLeft = buildMuzzleBurst();
  muzzleLeft.position.set(-0.99, -0.54, -2.32);
  root.add(muzzleLeft);

  const muzzleRight = buildMuzzleBurst();
  muzzleRight.position.set(0.99, -0.54, -2.32);
  root.add(muzzleRight);

  return { root, throttleHandle, muzzleLeft, muzzleRight, flashLight };
}

export function buildEnemyMesh(kind: EnemyKind, textures: HullTextureSet): THREE.Group {
  const root = new THREE.Group();
  const enemyRim = { rimColor: 0x92aaf6, rimStrength: 0.42 } as const;
  const hullMat = toonMat(0x5a6580, enemyRim);
  const darkSlateMat = toonMat(0x2b3246, enemyRim);
  const gunmetalMat = toonMat(0x3e4760, enemyRim);
  const vaneMat = toonMat(0xffffff, { map: textures.solarVane, ...enemyRim });
  const rimMat = toonMat(0xbcc6db, { rimColor: 0xcbd8ff, rimStrength: 0.25 });
  const crimsonMat = toonMat(SCENE_PALETTE.hostileAccent, {
    emissive: SCENE_PALETTE.hostileEmissive,
    emissiveIntensity: 0.55,
    rimColor: 0xff8a96,
    rimStrength: 0.35,
  });
  const visorGlowMat = glowMat(0xff4a60, 1, { hdrBoost: 2.6 });
  const coreMat = glowMat(SCENE_PALETTE.hostileBolt, 1, { hdrBoost: 2.8 });

  if (kind === 'raider') {
    addStyledPart(root, new THREE.IcosahedronGeometry(2.6, 1), hullMat, { hullOutline: 1.05 });

    // Sunk hexagonal viewport bezel + recessed crimson lens (no top-of-ball clipping in ortho-top).
    const bezelGeo = new THREE.CylinderGeometry(1.22, 1.42, 0.45, 6);
    bezelGeo.rotateX(Math.PI / 2);
    addStyledPart(root, bezelGeo, darkSlateMat, { position: [0, -0.05, -2.25] });
    const lensGeo = new THREE.CylinderGeometry(0.82, 0.94, 0.25, 6);
    lensGeo.rotateX(Math.PI / 2);
    addStyledPart(root, lensGeo, crimsonMat, { position: [0, -0.05, -2.38] });

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
    addStyledPart(root, sparGeo, gunmetalMat, { hullOutline: 1.04 });

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

    const vaneGeo = createHexSolarVaneGeometry();
    const outerHubGeo = new THREE.CylinderGeometry(1.55, 2.25, 0.75, 6);
    for (const side of [-1, 1] as const) {
      const vaneGroup = new THREE.Group();
      vaneGroup.position.set(side * 6.3, 0, 0.15);
      vaneGroup.rotation.z = side * 0.15;

      addStyledPart(vaneGroup, vaneGeo, vaneMat, { hullOutline: 1.045 });
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
      root.add(vaneGroup);
    }

    const aftShroud = new THREE.CylinderGeometry(1.08, 1.32, 1.1, 8);
    aftShroud.rotateX(Math.PI / 2);
    addStyledPart(root, aftShroud, darkSlateMat, { position: [0, 0, 2.35] });
    const core = new THREE.Mesh(new THREE.CircleGeometry(0.82, 8), coreMat);
    core.position.set(0, 0, 2.92);
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
      { position: [0, 0, -6.2], hullOutline: 1.04 },
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
      { position: [0, 0, -0.4], hullOutline: 1.04 },
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
      { position: [0, 0, 3.9], hullOutline: 1.04 },
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
      { position: [0, 1.16, 0.9], edgeAngle: 40 },
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
      { position: [0, 1.72, 4.0], hullOutline: 1.04 },
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
      { position: [0, -1.22, -2.3], hullOutline: 1.04 },
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
      addStyledPart(wingPivot, sponsonGeo, vaneMat, { hullOutline: 1.045 });
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
      // Thickened stubby gun pod seated directly onto the wing root (no thin floating sticks).
      const rootGun = new THREE.CylinderGeometry(0.24, 0.32, 2.1, 8);
      rootGun.rotateX(Math.PI / 2);
      addStyledPart(wingPivot, rootGun, gunmetalMat, { position: [1.1, 0.02, -2.1] });

      root.add(wingPivot);

      // Stealth gunmetal engine housings + restrained mint inner glow (-25% size).
      addStyledPart(root, shroudGeo, gunmetalMat, {
        position: [side * 1.85, 0.06, 4.95],
        hullOutline: 1.04,
      });
      const nozzleInner = new THREE.CylinderGeometry(0.58, 0.74, 0.7, 8);
      nozzleInner.rotateX(Math.PI / 2);
      addStyledPart(root, nozzleInner, darkSlateMat, { position: [side * 1.85, 0.06, 6.2] });

      const engineGlow = new THREE.Mesh(new THREE.CircleGeometry(0.48, 8), coreMat);
      engineGlow.position.set(side * 1.85, 0.06, 6.58);
      root.add(engineGlow);
    }
  }

  return root;
}

export function buildFriendlyCarrierMesh(textures: HullTextureSet): THREE.Group {
  const root = new THREE.Group();
  const hullMat = toonMat(0xffffff, { map: textures.carrierHull });
  const ivoryArmorMat = toonMat(0xf3ede0);
  const warmMidMat = toonMat(0xd9cfbc);
  const slateKeelMat = toonMat(0x465068);
  const darkRecessMat = toonMat(0x212736);
  const accentMat = toonMat(0xe59238);
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
    { position: [0, 0, -131], edgeAngle: 35 },
  );
  // Solid bow nose bumper cap + vertical armored prow rib so ortho-front reads unmistakably convex.
  addStyledPart(root, new THREE.BoxGeometry(28, 17, 6), slateKeelMat, {
    position: [0, 4, -170],
    edgeAngle: 35,
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
    { position: [0, 17, -128], edgeAngle: 35 },
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
    { position: [0, 0, -1], edgeAngle: 35 },
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
    { position: [0, 21.5, -1], edgeAngle: 35 },
  );
  // Recessed dark slate flight-deck runway strip breaking up the flat white top surface.
  addStyledPart(root, new THREE.BoxGeometry(24, 1.0, 206), slateKeelMat, {
    position: [-6, 26.2, -16],
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
    { position: [0, -19, -4], edgeAngle: 35 },
  );

  for (let i = -3; i <= 2; i += 1) {
    const marker = new THREE.Mesh(new THREE.BoxGeometry(8.5, 1.3, 12), accentMat);
    marker.position.set(-6, 26.9, i * 32 - 8);
    root.add(marker);
  }
  for (const side of [-1, 1] as const) {
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
    { position: [0, 0, 123], edgeAngle: 35 },
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
    { position: [21, 35, 34], edgeAngle: 35 },
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
    { position: [21, 51, 38], edgeAngle: 35 },
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
    { position: [21, 62, 34], edgeAngle: 35 },
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
  addStyledPart(root, new THREE.BoxGeometry(2.2, 10, 2.2), accentMat, {
    position: [24, 75, 42],
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
      { position: [-42, 19, zPos], edgeAngle: 35 },
    );
    addStyledPart(root, new THREE.BoxGeometry(2.5, 2.6, 36), accentMat, {
      position: [-50.2, 21.5, zPos],
    });
  }

  // 5. Recessed flank hangar mouths (2 per side), bold orange hull band, and recessed hull trench with pipes.
  const conduitGeo = new THREE.CylinderGeometry(2.2, 2.2, 176, 8);
  conduitGeo.rotateX(Math.PI / 2);

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
      addStyledPart(root, new THREE.BoxGeometry(5.6, 18.5, 48), ivoryArmorMat, {
        position: [side * 38.2, -1, bayZ],
      });
      addStyledPart(root, new THREE.BoxGeometry(4.4, 12.6, 40), darkRecessMat, {
        position: [side * 39.6, -1, bayZ],
      });
      const bayStrip = new THREE.Mesh(new THREE.BoxGeometry(1.4, 4.2, 36), bayLight);
      bayStrip.position.set(side * 41.4, -3.4, bayZ);
      root.add(bayStrip);
      addStyledPart(root, new THREE.BoxGeometry(2.2, 2.4, 42), accentMat, {
        position: [side * 41.2, 6.4, bayZ],
      });
    }
  }

  // 6. Aligned 4-thruster inline stern housing + faired dorsal stabilizer fins (no kickstand/drooping cones).
  addStyledPart(root, new THREE.BoxGeometry(56, 20, 14), slateKeelMat, {
    position: [0, 1, 158],
    edgeAngle: 35,
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
      { position: [side * 28, 12, 134], rotation: [0, 0, side * -0.15], edgeAngle: 35 },
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
  const frigateRim = { rimColor: 0xa68ce8, rimStrength: 0.34 } as const;
  const hullMat = toonMat(0xffffff, {
    map: textures.frigateHull,
    emissive: 0x161026,
    emissiveIntensity: 0.3,
    ...frigateRim,
  });
  const hullPlateMat = toonMat(0x4b4161, {
    emissive: 0x120c20,
    emissiveIntensity: 0.25,
    ...frigateRim,
  });
  const armorMat = toonMat(0x745c82, {
    emissive: 0x180f1d,
    emissiveIntensity: 0.25,
    ...frigateRim,
  });
  const darkArmorMat = toonMat(0x271e36, frigateRim);
  const crimsonAccent = toonMat(SCENE_PALETTE.frigateAccent, {
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
    { position: [0, 2, -46], edgeAngle: 35 },
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
    { position: [0, 8, -138], edgeAngle: 35 },
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
    { position: [0, 2, 85], edgeAngle: 35 },
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
    { position: [0, -14, 24], edgeAngle: 35 },
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
    { position: [0, 20, 22], edgeAngle: 35 },
  );

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
    { position: [0, 33, 78], edgeAngle: 35 },
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
    { position: [0, 46, 82], edgeAngle: 35 },
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
    { position: [0, 54, 79], edgeAngle: 35 },
  );
  const bridgeSlit = new THREE.Mesh(new THREE.BoxGeometry(26, 2.8, 2.6), trenchGlow);
  bridgeSlit.position.set(0, 54, 69.2);
  root.add(bridgeSlit);

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
    edgeAngle: 35,
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
    edgeAngle: 35,
  });

  const shieldDome = addStyledPart(
    root,
    new THREE.IcosahedronGeometry(12.5, 2),
    toonMat(SCENE_PALETTE.shieldDome, { emissive: 0xd42288, emissiveIntensity: 1.4 }),
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
    { position: [clampPos.x, clampPos.y + 7, clampPos.z], edgeAngle: 35 },
  );
  const clampCore = addStyledPart(
    root,
    new THREE.OctahedronGeometry(13.5, 1),
    toonMat(SCENE_PALETTE.clampCore, { emissive: 0xd6400e, emissiveIntensity: 1.4 }),
    { position: [clampPos.x, clampPos.y, clampPos.z] },
  );

  for (const side of [-1, 1] as const) {
    addStyledPart(root, new THREE.BoxGeometry(7, 22, 24), darkArmorMat, {
      position: [clampPos.x + side * 18, clampPos.y + 4, clampPos.z],
      rotation: [0, 0, side * 0.18],
    });
  }

  const subsystemMeshes = new Map<string, THREE.Mesh>([
    [FRIGATE_SUBSYSTEM_LAYOUT.shieldDome.id, shieldDome],
    [FRIGATE_SUBSYSTEM_LAYOUT.clampCore.id, clampCore],
  ]);

  return { root, subsystemMeshes, shieldRing };
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

  const geo = new THREE.IcosahedronGeometry(asteroid.radius, 2);
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < posAttr.count; i += 1) {
    const vx = posAttr.getX(i);
    const vy = posAttr.getY(i);
    const vz = posAttr.getZ(i);
    const warp =
      1 +
      0.16 * Math.sin(vx * 0.14 + asteroid.rotation.x * 4) *
        Math.cos(vy * 0.16 + asteroid.rotation.y * 4) +
      0.09 * Math.sin(vz * 0.2);
    posAttr.setXYZ(i, vx * warp, vy * warp * 0.78, vz * warp);
  }
  geo.computeVertexNormals();

  addStyledPart(group, geo, toonMat(0xffffff, { map }), { hullOutline: 1.03 });
  group.position.set(asteroid.position.x, asteroid.position.y, asteroid.position.z);
  group.rotation.set(asteroid.rotation.x, asteroid.rotation.y, asteroid.rotation.z);
  return group;
}

export function buildOrbitalBackdrop(dotTexture: THREE.CanvasTexture): THREE.Group {
  const group = new THREE.Group();
  // Keep the star off to the far right flank so it rim-lights ships cleanly without glaring in the player's eyes.
  const sunDir = new THREE.Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).normalize();

  const skyGeo = new THREE.SphereGeometry(5400, 36, 24);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: sunDir },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      varying vec3 vDir;
      void main() {
        float y = clamp(vDir.y, -1.0, 1.0);
        vec3 zenith = vec3(0.005, 0.008, 0.026);
        vec3 horizon = vec3(0.028, 0.016, 0.044);
        vec3 nadir = vec3(0.006, 0.005, 0.018);
        vec3 base = y >= 0.0
          ? mix(horizon, zenith, pow(y, 0.55))
          : mix(horizon, nadir, pow(-y, 0.65));

        float sunAlign = max(dot(normalize(vDir), uSunDir), 0.0);
        vec3 duskGlow = vec3(0.30, 0.10, 0.035) * pow(sunAlign, 13.5);
        vec3 sunHalo = vec3(0.88, 0.46, 0.18) * pow(sunAlign, 54.0) * 0.65;
        vec3 sunCore = vec3(2.2, 1.7, 1.15) * smoothstep(0.9988, 0.9996, sunAlign);
        float belt = exp(-abs(vDir.y + vDir.x * 0.14) * 9.0);
        float beltStep = floor(belt * 4.0) / 4.0;
        vec3 nebulaBand = vec3(0.048, 0.024, 0.062) * beltStep;

        vec3 color = base + duskGlow + sunHalo + nebulaBand + sunCore;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  group.add(new THREE.Mesh(skyGeo, skyMat));

  const planetPos = new THREE.Vector3(-1950, -480, -3400);
  const planetRadius = 820;
  const planetGeo = new THREE.SphereGeometry(planetRadius, 40, 32);
  const planetMat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDir },
    },
    vertexShader: `
      varying vec3 vLocal;
      varying vec3 vWorldNormal;
      void main() {
        vLocal = normalize(position);
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      varying vec3 vLocal;
      varying vec3 vWorldNormal;
      void main() {
        float lat = vLocal.y;
        float band = sin(lat * 18.0 + sin(vLocal.x * 5.0) * 0.25) * 0.5 + 0.5;
        float stepped = floor(band * 4.0) / 4.0;
        vec3 c1 = vec3(0.06, 0.045, 0.11);
        vec3 c2 = vec3(0.18, 0.11, 0.15);
        vec3 c3 = vec3(0.36, 0.22, 0.17);
        vec3 albedo = mix(c1, c2, stepped);
        albedo = mix(albedo, c3, smoothstep(0.55, 0.85, stepped) * 0.65);

        float lit = smoothstep(-0.12, 0.42, dot(vWorldNormal, uSunDir));
        vec3 night = vec3(0.008, 0.007, 0.02);
        vec3 rim = vec3(0.42, 0.24, 0.16) * pow(1.0 - max(dot(vWorldNormal, vec3(0.0, 0.0, 1.0)), 0.0), 3.5) * lit * 0.45;
        gl_FragColor = vec4(mix(night, albedo, lit) + rim, 1.0);
      }
    `,
  });
  const planet = new THREE.Mesh(planetGeo, planetMat);
  planet.position.copy(planetPos);
  group.add(planet);

  const ringGeo = new THREE.RingGeometry(1040, 1580, 96);
  const ringMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: sunDir },
      uPlanetRadius: { value: planetRadius },
    },
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
      void main() {
        float r = length(vLocalPos.xy);
        float t = clamp((r - 1040.0) / (1580.0 - 1040.0), 0.0, 1.0);
        float cassiniGap = smoothstep(0.015, 0.04, abs(t - 0.62));
        float bands = 0.65 + 0.35 * sin(t * 58.0);
        float edgeFade = smoothstep(0.0, 0.12, t) * smoothstep(1.0, 0.86, t);

        float proj = dot(vOffsetFromPlanet, uSunDir);
        vec3 perp = vOffsetFromPlanet - uSunDir * proj;
        float inShadow = (proj < 0.0) ? (1.0 - smoothstep(uPlanetRadius * 0.94, uPlanetRadius * 1.04, length(perp))) : 0.0;

        vec3 litColor = mix(vec3(0.14, 0.11, 0.19), vec3(0.32, 0.22, 0.18), bands);
        vec3 color = mix(litColor, vec3(0.015, 0.012, 0.03), inShadow * 0.9);
        float alpha = edgeFade * cassiniGap * (0.24 + 0.14 * bands);
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.copy(planetPos);
  ring.rotation.x = Math.PI * 0.46;
  ring.rotation.y = 0.18;
  group.add(ring);

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

  return group;
}
