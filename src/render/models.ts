import * as THREE from 'three';
import type { AsteroidState, EnemyKind } from '../sim/types';
import { SCENE_PALETTE, SUN_DIRECTION } from './palette';
import type { HullTextureSet } from './textures';

function createToonGradientRamp(): THREE.DataTexture {
  // 4-band stepped luminance ramp gives graphic cel-shaded tone breaks with zero muddy plastic shading.
  const bands = new Uint8Array([
    68, 68, 68, 255,
    132, 132, 132, 255,
    202, 202, 202, 255,
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
  return new THREE.MeshToonMaterial(params);
}

function glowMat(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
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

function createSweptWingGeometry(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, -1.65);
  shape.lineTo(6.6, -0.35);
  shape.lineTo(6.9, 1.05);
  shape.lineTo(0.8, 1.85);
  shape.lineTo(0, 1.5);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.24,
    bevelEnabled: true,
    bevelThickness: 0.08,
    bevelSize: 0.08,
    bevelSegments: 2,
  });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0.12, 0);
  scaleUvs(geo, 6.5);
  return geo;
}

function createFuselageGeometry(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, -11.2);
  shape.lineTo(0.85, -5.5);
  shape.lineTo(1.55, -0.6);
  shape.lineTo(1.65, 4.4);
  shape.lineTo(1.0, 5.2);
  shape.lineTo(-1.0, 5.2);
  shape.lineTo(-1.65, 4.4);
  shape.lineTo(-1.55, -0.6);
  shape.lineTo(-0.85, -5.5);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 1.05,
    bevelEnabled: true,
    bevelThickness: 0.36,
    bevelSize: 0.3,
    bevelSegments: 2,
  });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0.52, 0);
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
    depth: 0.32,
    bevelEnabled: true,
    bevelThickness: 0.14,
    bevelSize: 0.14,
    bevelSegments: 1,
  });
  geo.rotateY(Math.PI / 2);
  geo.translate(-0.16, 0, 0);
  scaleUvs(geo, 8.0);
  return geo;
}

export interface FighterMeshRig {
  readonly root: THREE.Group;
  readonly plumes: readonly THREE.Group[];
}

export function buildPlayerFighterMesh(
  stripeColor: number,
  textures: HullTextureSet,
): FighterMeshRig {
  const root = new THREE.Group();
  const hullMat = toonMat(0xffffff, { map: textures.fighterHull });
  const dorsalMat = toonMat(0xf5f0e6, { map: textures.fighterHull });
  const slateMat = toonMat(0x566078);
  const darkMat = toonMat(0x282d3d);
  const stripeMat = toonMat(stripeColor);
  const canopyMat = toonMat(0xffbe59, { emissive: 0x8a480a, emissiveIntensity: 0.5 });
  const outerPlumeMat = glowMat(0x56d8ff, 0.78);
  const innerPlumeMat = glowMat(0xffffff, 0.98);
  const navLightMat = glowMat(stripeColor);

  addStyledPart(root, createFuselageGeometry(), hullMat, { hullOutline: 1.035 });

  const dorsalDeck = new THREE.BoxGeometry(1.72, 0.34, 7.2);
  addStyledPart(root, dorsalDeck, dorsalMat, { position: [0, 0.78, 0.6], edgeAngle: 40 });

  const dorsalFin = new THREE.ConeGeometry(0.88, 4.8, 4);
  dorsalFin.rotateX(Math.PI / 2);
  addStyledPart(root, dorsalFin, stripeMat, {
    position: [0, 1.15, 2.3],
    scale: [0.55, 0.7, 1],
  });

  const canopyGeo = new THREE.OctahedronGeometry(1.18, 2);
  canopyGeo.scale(0.86, 0.62, 1.95);
  addStyledPart(root, canopyGeo, canopyMat, { position: [0, 1.1, -1.35] });

  const wingGeo = createSweptWingGeometry();
  const tipPodGeo = new THREE.CylinderGeometry(0.18, 0.26, 3.9, 8);
  tipPodGeo.rotateX(Math.PI / 2);

  const wingConfigs: readonly { side: number; angle: number }[] = [
    { side: 1, angle: 0.25 },
    { side: 1, angle: -0.25 },
    { side: -1, angle: -0.25 },
    { side: -1, angle: 0.25 },
  ];

  for (const cfg of wingConfigs) {
    const pivot = new THREE.Group();
    pivot.position.set(cfg.side * 1.15, 0, 1.6);
    pivot.rotation.z = cfg.angle;
    if (cfg.side < 0) {
      pivot.scale.x = -1;
    }

    addStyledPart(pivot, wingGeo, hullMat, { hullOutline: 1.04 });
    addStyledPart(pivot, new THREE.BoxGeometry(1.4, 0.34, 1.75), stripeMat, {
      position: [5.4, 0, 0.35],
    });
    addStyledPart(pivot, tipPodGeo, darkMat, { position: [6.75, 0, -1.2] });

    const muzzleRing = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.35, 8), navLightMat);
    muzzleRing.rotation.x = Math.PI / 2;
    muzzleRing.position.set(6.75, 0, -3.25);
    pivot.add(muzzleRing);

    root.add(pivot);
  }

  const plumes: THREE.Group[] = [];
  const nacelleGeo = new THREE.CylinderGeometry(0.72, 0.88, 3.2, 10);
  nacelleGeo.rotateX(Math.PI / 2);
  const nozzleGeo = new THREE.CylinderGeometry(0.56, 0.72, 1.35, 10);
  nozzleGeo.rotateX(Math.PI / 2);

  for (const side of [-1, 1] as const) {
    addStyledPart(root, nacelleGeo, slateMat, { position: [side * 1.32, 0.05, 3.8], hullOutline: 1.04 });
    addStyledPart(root, nozzleGeo, darkMat, { position: [side * 1.32, 0.05, 5.7] });

    const bellGlow = new THREE.Mesh(new THREE.CircleGeometry(0.55, 10), innerPlumeMat);
    bellGlow.position.set(side * 1.32, 0.05, 6.4);
    root.add(bellGlow);

    const plumeGroup = new THREE.Group();
    plumeGroup.position.set(side * 1.32, 0.05, 6.45);

    const outerCone = new THREE.Mesh(new THREE.ConeGeometry(0.64, 5.4, 9), outerPlumeMat);
    outerCone.rotation.x = Math.PI / 2;
    outerCone.position.set(0, 0, 2.7);
    plumeGroup.add(outerCone);

    const innerCone = new THREE.Mesh(new THREE.ConeGeometry(0.32, 3.4, 8), innerPlumeMat);
    innerCone.rotation.x = Math.PI / 2;
    innerCone.position.set(0, 0, 1.7);
    plumeGroup.add(innerCone);

    root.add(plumeGroup);
    plumes.push(plumeGroup);
  }

  return { root, plumes };
}

export interface CockpitRig {
  readonly root: THREE.Group;
  readonly throttleHandle: THREE.Group;
  readonly muzzleLeft: THREE.Group;
  readonly muzzleRight: THREE.Group;
  readonly flashLight: THREE.PointLight;
}

function buildMuzzleBurst(): THREE.Group {
  const burst = new THREE.Group();
  const coreMat = glowMat(0xfff9e0, 0.98);
  const haloMat = glowMat(0xffa436, 0.72);

  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.05, 0), coreMat);
  core.scale.set(1, 1, 2.2);
  burst.add(core);

  burst.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.03), haloMat));
  burst.add(new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.16, 0.03), haloMat));

  const streak = new THREE.Mesh(new THREE.ConeGeometry(0.038, 0.32, 6), haloMat);
  streak.rotation.x = -Math.PI / 2;
  streak.position.z = -0.16;
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
  const ledAmber = glowMat(0xf4b459);
  const ledCyan = glowMat(0x6be5ff);

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
  const hullMat = toonMat(0x616b85);
  const vaneMat = toonMat(0xffffff, { map: textures.solarVane });
  const rimMat = toonMat(0xc4cde0);
  const crimsonMat = toonMat(SCENE_PALETTE.hostileAccent, {
    emissive: SCENE_PALETTE.hostileEmissive,
    emissiveIntensity: 0.45,
  });
  const coreMat = glowMat(SCENE_PALETTE.hostileBolt);

  if (kind === 'raider') {
    addStyledPart(root, new THREE.IcosahedronGeometry(2.6, 1), hullMat, { hullOutline: 1.05 });

    addStyledPart(root, new THREE.BoxGeometry(1.9, 1.15, 0.7), crimsonMat, {
      position: [0, 0.1, -2.35],
    });

    const sparGeo = new THREE.CylinderGeometry(0.52, 0.64, 12.6, 8);
    sparGeo.rotateZ(Math.PI / 2);
    addStyledPart(root, sparGeo, rimMat, { hullOutline: 1.04 });

    const vaneGeo = createHexSolarVaneGeometry();
    for (const side of [-1, 1] as const) {
      const vaneGroup = new THREE.Group();
      vaneGroup.position.set(side * 6.3, 0, 0.15);
      vaneGroup.rotation.z = side * 0.15;

      addStyledPart(vaneGroup, vaneGeo, vaneMat, { hullOutline: 1.045 });
      addStyledPart(vaneGroup, new THREE.BoxGeometry(0.68, 1.1, 7.6), crimsonMat);
      addStyledPart(vaneGroup, new THREE.BoxGeometry(0.62, 6.2, 0.65), rimMat, {
        position: [0, 0, -3.55],
      });
      root.add(vaneGroup);
    }

    const core = new THREE.Mesh(new THREE.OctahedronGeometry(1.5, 0), coreMat);
    core.position.set(0, 0, 2.75);
    root.add(core);
  } else {
    const prowShape = new THREE.Shape();
    prowShape.moveTo(0, -10.5);
    prowShape.lineTo(4.2, -3.0);
    prowShape.lineTo(3.2, 5.2);
    prowShape.lineTo(-3.2, 5.2);
    prowShape.lineTo(-4.2, -3.0);
    prowShape.closePath();
    const hullGeo = new THREE.ExtrudeGeometry(prowShape, {
      depth: 2.1,
      bevelEnabled: true,
      bevelThickness: 0.55,
      bevelSize: 0.45,
      bevelSegments: 2,
    });
    hullGeo.rotateX(Math.PI / 2);
    hullGeo.translate(0, 1.05, 0);
    addStyledPart(root, hullGeo, hullMat, { hullOutline: 1.04 });

    addStyledPart(root, new THREE.OctahedronGeometry(2.1, 1), crimsonMat, {
      position: [0, 1.8, -1.5],
      scale: [1, 0.65, 1.4],
    });

    const boomGeo = new THREE.CylinderGeometry(1.1, 1.45, 9.5, 8);
    boomGeo.rotateX(Math.PI / 2);
    for (const side of [-1, 1] as const) {
      addStyledPart(root, boomGeo, vaneMat, {
        position: [side * 5.2, -0.35, 0.4],
        hullOutline: 1.04,
      });
      addStyledPart(root, new THREE.BoxGeometry(2.6, 0.35, 3.2), rimMat, {
        position: [side * 3.8, 0.2, 0.6],
      });
      const engine = new THREE.Mesh(new THREE.OctahedronGeometry(1.45, 0), coreMat);
      engine.position.set(side * 5.2, -0.35, 5.4);
      root.add(engine);
    }
  }

  return root;
}

export function buildFriendlyCarrierMesh(textures: HullTextureSet): THREE.Group {
  const root = new THREE.Group();
  const hullMat = toonMat(0xffffff, { map: textures.carrierHull });
  const deckMat = toonMat(0x525c73);
  const trimMat = toonMat(0x3a4254);
  const accentMat = toonMat(0xe59238);
  const bayLight = glowMat(0x8cf0ff);
  const bridgeLight = glowMat(0xffd278);
  const engineGlow = glowMat(0x6cd8ff);
  const plumeGlow = glowMat(0x52c7ff, 0.48);

  const hullProfile = new THREE.Shape();
  hullProfile.moveTo(0, -172);
  hullProfile.lineTo(32, -138);
  hullProfile.lineTo(38, 128);
  hullProfile.lineTo(26, 152);
  hullProfile.lineTo(-26, 152);
  hullProfile.lineTo(-38, 128);
  hullProfile.lineTo(-32, -138);
  hullProfile.closePath();

  const mainHullGeo = new THREE.ExtrudeGeometry(hullProfile, {
    depth: 30,
    bevelEnabled: true,
    bevelThickness: 6,
    bevelSize: 5,
    bevelSegments: 2,
  });
  mainHullGeo.rotateX(Math.PI / 2);
  mainHullGeo.translate(0, 15, 0);
  scaleUvs(mainHullGeo, 52);
  addStyledPart(root, mainHullGeo, hullMat, { edgeAngle: 35 });

  const upperDeckProfile = new THREE.Shape();
  upperDeckProfile.moveTo(0, -124);
  upperDeckProfile.lineTo(22, -96);
  upperDeckProfile.lineTo(24, 110);
  upperDeckProfile.lineTo(-24, 110);
  upperDeckProfile.lineTo(-22, -96);
  upperDeckProfile.closePath();
  const upperDeckGeo = new THREE.ExtrudeGeometry(upperDeckProfile, {
    depth: 11,
    bevelEnabled: true,
    bevelThickness: 3,
    bevelSize: 3,
    bevelSegments: 1,
  });
  upperDeckGeo.rotateX(Math.PI / 2);
  upperDeckGeo.translate(0, 29, 0);
  addStyledPart(root, upperDeckGeo, deckMat, { edgeAngle: 35 });

  for (let i = -3; i <= 2; i += 1) {
    const marker = new THREE.Mesh(new THREE.BoxGeometry(10, 1.2, 3.5), accentMat);
    marker.position.set(0, 32.8, i * 32 - 12);
    root.add(marker);
  }

  const bridgeBaseGeo = new THREE.CylinderGeometry(18, 25, 22, 6);
  bridgeBaseGeo.scale(0.82, 1, 1.25);
  addStyledPart(root, bridgeBaseGeo, hullMat, { position: [14, 41, 66], edgeAngle: 35 });

  const bridgeCrownGeo = new THREE.CylinderGeometry(17, 19, 10, 6);
  bridgeCrownGeo.scale(1.05, 1, 1.0);
  addStyledPart(root, bridgeCrownGeo, deckMat, { position: [14, 56, 64], edgeAngle: 35 });

  const bridgeGlass = new THREE.Mesh(new THREE.BoxGeometry(24, 4.2, 3), bridgeLight);
  bridgeGlass.position.set(14, 56, 46.5);
  root.add(bridgeGlass);

  addStyledPart(root, new THREE.CylinderGeometry(1.3, 2.2, 30, 8), accentMat, {
    position: [14, 75, 68],
  });
  addStyledPart(root, new THREE.BoxGeometry(20, 3.2, 2.2), hullMat, {
    position: [14, 86, 68],
  });

  const tankGeo = new THREE.CylinderGeometry(6.8, 6.8, 56, 10);
  tankGeo.rotateX(Math.PI / 2);
  for (const side of [-1, 1] as const) {
    addStyledPart(root, new THREE.BoxGeometry(3, 5.2, 220), accentMat, {
      position: [side * 42.5, 10, -6],
    });

    addStyledPart(root, new THREE.BoxGeometry(5, 15, 104), trimMat, {
      position: [side * 41.5, -3, -28],
    });
    const bay = new THREE.Mesh(new THREE.BoxGeometry(1.6, 10, 92), bayLight);
    bay.position.set(side * 44.1, -3, -28);
    root.add(bay);

    for (let t = -2; t <= 2; t += 1) {
      addStyledPart(root, new THREE.BoxGeometry(2.2, 15, 3.2), trimMat, {
        position: [side * 44.6, -3, -28 + t * 20],
      });
    }

    addStyledPart(root, tankGeo, deckMat, { position: [side * 42, -5, 74] });
  }

  const nozzleGeo = new THREE.CylinderGeometry(5.8, 7.6, 16, 10);
  nozzleGeo.rotateX(Math.PI / 2);
  for (const x of [-20, -7, 7, 20]) {
    addStyledPart(root, nozzleGeo, trimMat, { position: [x, 0, 160] });
    const glow = new THREE.Mesh(new THREE.CircleGeometry(5.5, 10), engineGlow);
    glow.position.set(x, 0, 168.5);
    root.add(glow);

    const plume = new THREE.Mesh(new THREE.ConeGeometry(5.4, 28, 8), plumeGlow);
    plume.rotation.x = Math.PI / 2;
    plume.position.set(x, 0, 182);
    root.add(plume);
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
  const hullMat = toonMat(0xffffff, {
    map: textures.frigateHull,
    emissive: 0x161026,
    emissiveIntensity: 0.35,
  });
  const armorMat = toonMat(0x7c6282, { emissive: 0x180f1d, emissiveIntensity: 0.25 });
  const crimsonAccent = toonMat(SCENE_PALETTE.frigateAccent, { emissive: 0x731420, emissiveIntensity: 0.5 });
  const trenchGlow = glowMat(SCENE_PALETTE.frigateGlow);
  const driveGlow = glowMat(0xff526b);

  const daggerShape = new THREE.Shape();
  daggerShape.moveTo(0, -135);
  daggerShape.lineTo(42, 48);
  daggerShape.lineTo(36, 126);
  daggerShape.lineTo(-36, 126);
  daggerShape.lineTo(-42, 48);
  daggerShape.closePath();

  const mainGeo = new THREE.ExtrudeGeometry(daggerShape, {
    depth: 22,
    bevelEnabled: true,
    bevelThickness: 6,
    bevelSize: 4,
    bevelSegments: 2,
  });
  mainGeo.rotateX(Math.PI / 2);
  mainGeo.translate(0, 11, 0);
  scaleUvs(mainGeo, 46);
  addStyledPart(root, mainGeo, hullMat, { edgeAngle: 35 });

  const dorsalSpine = new THREE.Shape();
  dorsalSpine.moveTo(0, -68);
  dorsalSpine.lineTo(16, -24);
  dorsalSpine.lineTo(14, 102);
  dorsalSpine.lineTo(-14, 102);
  dorsalSpine.lineTo(-16, -24);
  dorsalSpine.closePath();
  const spineGeo = new THREE.ExtrudeGeometry(dorsalSpine, {
    depth: 12,
    bevelEnabled: true,
    bevelThickness: 3,
    bevelSize: 2.5,
    bevelSegments: 1,
  });
  spineGeo.rotateX(Math.PI / 2);
  spineGeo.translate(0, 23, 0);
  addStyledPart(root, spineGeo, armorMat, { edgeAngle: 35 });

  addStyledPart(root, new THREE.BoxGeometry(34, 18, 28), armorMat, {
    position: [0, 32, 76],
    edgeAngle: 35,
  });
  addStyledPart(root, new THREE.BoxGeometry(4, 4.5, 165), crimsonAccent, { position: [-26, 7, 26] });
  addStyledPart(root, new THREE.BoxGeometry(4, 4.5, 165), crimsonAccent, { position: [26, 7, 26] });

  const bridgeSlit = new THREE.Mesh(new THREE.BoxGeometry(24, 3.6, 3), trenchGlow);
  bridgeSlit.position.set(0, 34, 60.5);
  root.add(bridgeSlit);

  for (const side of [-1, 1] as const) {
    const flankVent = new THREE.Mesh(new THREE.BoxGeometry(2.2, 4.5, 118), trenchGlow);
    flankVent.position.set(side * 37.5, 0, 52);
    root.add(flankVent);
  }

  for (const x of [-16, 0, 16]) {
    const drive = new THREE.Mesh(new THREE.BoxGeometry(11, 11, 4), driveGlow);
    drive.position.set(x, 0, 132);
    root.add(drive);
  }

  const shieldDome = addStyledPart(
    root,
    new THREE.IcosahedronGeometry(15, 2),
    toonMat(SCENE_PALETTE.shieldDome, { emissive: 0xd42288, emissiveIntensity: 0.95 }),
    { position: [0, 28, -32] },
  );

  const shieldRing = new THREE.Mesh(
    new THREE.TorusGeometry(20, 1.1, 8, 24),
    glowMat(0xff8ad8, 0.72),
  );
  shieldRing.position.set(0, 28, -32);
  shieldRing.rotation.x = Math.PI * 0.42;
  root.add(shieldRing);

  const clampCore = addStyledPart(
    root,
    new THREE.OctahedronGeometry(15, 1),
    toonMat(SCENE_PALETTE.clampCore, { emissive: 0xd6400e, emissiveIntensity: 0.95 }),
    { position: [0, -20, 62] },
  );

  for (const side of [-1, 1] as const) {
    addStyledPart(root, new THREE.BoxGeometry(6, 18, 12), armorMat, {
      position: [side * 20, -18, 62],
      rotation: [0, 0, side * 0.25],
    });
  }

  const subsystemMeshes = new Map<string, THREE.Mesh>([
    ['sub-shield-dome', shieldDome],
    ['sub-clamp-core', clampCore],
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
        vec3 duskGlow = vec3(0.32, 0.11, 0.04) * pow(sunAlign, 6.5);
        vec3 sunHalo = vec3(0.85, 0.45, 0.18) * pow(sunAlign, 48.0) * 0.65;
        vec3 sunCore = vec3(1.6, 1.25, 0.85) * smoothstep(0.9988, 0.9996, sunAlign);
        float belt = exp(-abs(vDir.y + vDir.x * 0.14) * 9.0);
        vec3 nebulaBand = vec3(0.045, 0.022, 0.055) * belt;

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

  const starPositions = new Float32Array(2200 * 3);
  let seed = 0x1337c0de;
  for (let i = 0; i < 2200; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const u = ((seed >>> 0) / 4294967296) * 2 - 1;
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const theta = ((seed >>> 0) / 4294967296) * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    const dist = 4600;
    starPositions[i * 3] = r * Math.cos(theta) * dist;
    starPositions[i * 3 + 1] = u * dist;
    starPositions[i * 3 + 2] = r * Math.sin(theta) * dist;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xdce6ff,
    map: dotTexture,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    size: 16,
    sizeAttenuation: true,
  });
  group.add(new THREE.Points(starGeo, starMat));

  return group;
}
