import * as THREE from 'three';
import type { AsteroidState, EnemyKind } from '../sim/types';

function createToonGradientRamp(): THREE.DataTexture {
  // 4-band stepped luminance ramp gives graphic cel-shaded tone breaks with zero smooth plastic shading.
  const bands = new Uint8Array([
    52, 52, 52, 255,
    118, 118, 118, 255,
    194, 194, 194, 255,
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
const INK_LINE_MAT = new THREE.LineBasicMaterial({ color: 0x0b0a14 });
const INK_SHELL_MAT = new THREE.MeshBasicMaterial({
  color: 0x0a0914,
  side: THREE.BackSide,
});

function toonMat(color: number, emissive = 0x000000, emissiveIntensity = 0): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({
    color,
    emissive,
    emissiveIntensity,
    gradientMap: TOON_RAMP,
  });
}

function glowMat(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
  });
}

function addInkedPart(
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

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, options?.edgeAngle ?? 24),
    INK_LINE_MAT,
  );
  mesh.add(edges);

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

function createSweptWingGeometry(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, -1.6);
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
    bevelSegments: 1,
  });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0.12, 0);
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
    bevelThickness: 0.34,
    bevelSize: 0.28,
    bevelSegments: 1,
  });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0.52, 0);
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
  return geo;
}

export interface FighterMeshRig {
  readonly root: THREE.Group;
  readonly plumes: readonly THREE.Group[];
}

export function buildPlayerFighterMesh(stripeColor: number): FighterMeshRig {
  const root = new THREE.Group();
  const hullMat = toonMat(0xe5dfd3);
  const slateMat = toonMat(0x525a70);
  const darkMat = toonMat(0x282c3a);
  const stripeMat = toonMat(stripeColor);
  const canopyMat = toonMat(0xffbe59, 0x8a480a, 0.55);
  const outerPlumeMat = glowMat(0x56d8ff, 0.78);
  const innerPlumeMat = glowMat(0xffffff, 0.98);
  const navLightMat = glowMat(stripeColor);

  addInkedPart(root, createFuselageGeometry(), hullMat, { hullOutline: 1.045, edgeAngle: 35 });

  const dorsalDeck = new THREE.BoxGeometry(1.72, 0.34, 7.2);
  addInkedPart(root, dorsalDeck, toonMat(0xf4eee0), {
    position: [0, 0.78, 0.6],
    edgeAngle: 38,
  });

  const dorsalFin = new THREE.ConeGeometry(0.9, 4.8, 4);
  dorsalFin.rotateX(Math.PI / 2);
  addInkedPart(root, dorsalFin, stripeMat, {
    position: [0, 1.15, 2.3],
    scale: [0.55, 0.7, 1],
  });

  const canopyGeo = new THREE.OctahedronGeometry(1.18, 1);
  canopyGeo.scale(0.86, 0.62, 1.95);
  addInkedPart(root, canopyGeo, canopyMat, {
    position: [0, 1.1, -1.35],
    edgeAngle: 42,
  });

  const wingGeo = createSweptWingGeometry();
  const tipPodGeo = new THREE.CylinderGeometry(0.18, 0.26, 3.9, 6);
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

    addInkedPart(pivot, wingGeo, hullMat, { hullOutline: 1.05, edgeAngle: 48 });

    const stripeGeo = new THREE.BoxGeometry(1.4, 0.34, 1.75);
    addInkedPart(pivot, stripeGeo, stripeMat, { position: [5.4, 0, 0.35], edgeAngle: 48 });

    addInkedPart(pivot, tipPodGeo, darkMat, { position: [6.75, 0, -1.2], edgeAngle: 42 });

    const muzzleRing = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.35, 6), navLightMat);
    muzzleRing.rotation.x = Math.PI / 2;
    muzzleRing.position.set(6.75, 0, -3.25);
    pivot.add(muzzleRing);

    root.add(pivot);
  }

  const plumes: THREE.Group[] = [];
  const nacelleGeo = new THREE.CylinderGeometry(0.72, 0.88, 3.2, 8);
  nacelleGeo.rotateX(Math.PI / 2);
  const nozzleGeo = new THREE.CylinderGeometry(0.56, 0.72, 1.35, 8);
  nozzleGeo.rotateX(Math.PI / 2);

  for (const side of [-1, 1] as const) {
    addInkedPart(root, nacelleGeo, slateMat, { position: [side * 1.32, 0.05, 3.8], hullOutline: 1.05 });
    addInkedPart(root, nozzleGeo, darkMat, { position: [side * 1.32, 0.05, 5.7] });

    const bellGlow = new THREE.Mesh(new THREE.CircleGeometry(0.55, 8), innerPlumeMat);
    bellGlow.position.set(side * 1.32, 0.05, 6.4);
    root.add(bellGlow);

    const plumeGroup = new THREE.Group();
    plumeGroup.position.set(side * 1.32, 0.05, 6.45);

    const outerCone = new THREE.Mesh(new THREE.ConeGeometry(0.64, 5.4, 7), outerPlumeMat);
    outerCone.rotation.x = Math.PI / 2;
    outerCone.position.set(0, 0, 2.7);
    plumeGroup.add(outerCone);

    const innerCone = new THREE.Mesh(new THREE.ConeGeometry(0.32, 3.4, 6), innerPlumeMat);
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
  const haloMat = glowMat(0xffa436, 0.7);

  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.055, 0), coreMat);
  core.scale.set(1, 1, 2.2);
  burst.add(core);

  burst.add(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.022, 0.03), haloMat));
  burst.add(new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.18, 0.03), haloMat));

  const streak = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.34, 5), haloMat);
  streak.rotation.x = -Math.PI / 2;
  streak.position.z = -0.17;
  burst.add(streak);

  burst.visible = false;
  return burst;
}

export function buildCockpitRig(): CockpitRig {
  const root = new THREE.Group();
  const frameMat = toonMat(0x32374a);
  const bevelMat = toonMat(0x636c88);
  const accentMat = toonMat(0xd98332, 0x5c2c06, 0.3);
  const ledAmber = glowMat(0xf4b459);
  const ledCyan = glowMat(0x6be5ff);

  const cockpitFill = new THREE.PointLight(0xffb76b, 0.9, 4.5);
  cockpitFill.position.set(0, -0.25, -0.45);
  root.add(cockpitFill);

  const flashLight = new THREE.PointLight(0xffbb55, 0, 5.5);
  flashLight.position.set(0, -0.2, -1.9);
  root.add(flashLight);

  const strutProfile = new THREE.BoxGeometry(0.055, 1.76, 0.11);
  for (const side of [-1, 1] as const) {
    addInkedPart(root, strutProfile, frameMat, {
      position: [side * 1.22, 0.1, -1.1],
      rotation: [0, side * -0.18, side * 0.2],
    });

    const highlight = new THREE.Mesh(new THREE.BoxGeometry(0.015, 1.68, 0.02), bevelMat);
    highlight.position.set(side * 1.186, 0.1, -1.045);
    highlight.rotation.set(0, side * -0.18, side * 0.2);
    root.add(highlight);

    addInkedPart(root, new THREE.BoxGeometry(0.24, 0.14, 1.08), frameMat, {
      position: [side * 1.1, -0.7, -0.92],
      rotation: [0, 0, side * -0.16],
    });
  }

  addInkedPart(root, new THREE.BoxGeometry(2.24, 0.055, 0.12), frameMat, {
    position: [0, 0.92, -1.12],
  });

  const hoodShape = new THREE.Shape();
  hoodShape.moveTo(-1.12, -0.16);
  hoodShape.lineTo(-0.78, 0.12);
  hoodShape.lineTo(0.78, 0.12);
  hoodShape.lineTo(1.12, -0.16);
  hoodShape.closePath();
  const hoodGeo = new THREE.ExtrudeGeometry(hoodShape, {
    depth: 0.72,
    bevelEnabled: true,
    bevelThickness: 0.025,
    bevelSize: 0.025,
    bevelSegments: 1,
  });
  addInkedPart(root, hoodGeo, frameMat, {
    position: [0, -0.76, -1.48],
    rotation: [0.1, 0, 0],
  });

  addInkedPart(root, new THREE.BoxGeometry(1.48, 0.026, 0.05), bevelMat, {
    position: [0, -0.635, -0.78],
  });

  for (let i = -2; i <= 2; i += 1) {
    const led = new THREE.Mesh(
      new THREE.BoxGeometry(0.032, 0.014, 0.014),
      i === 0 ? ledCyan : ledAmber,
    );
    led.position.set(i * 0.16, -0.618, -0.76);
    root.add(led);
  }

  const barrelMat = toonMat(0x4a526a);
  for (const side of [-1, 1] as const) {
    const gunShroud = new THREE.CylinderGeometry(0.022, 0.048, 1.05, 6);
    gunShroud.rotateX(Math.PI / 2);
    addInkedPart(root, gunShroud, barrelMat, {
      position: [side * 0.98, -0.52, -1.56],
      edgeAngle: 40,
    });

    const gunTip = new THREE.CylinderGeometry(0.015, 0.022, 0.2, 6);
    gunTip.rotateX(Math.PI / 2);
    addInkedPart(root, gunTip, bevelMat, {
      position: [side * 0.98, -0.52, -2.18],
      edgeAngle: 40,
    });
  }

  const throttleHandle = new THREE.Group();
  throttleHandle.position.set(-1.02, -0.66, -0.84);
  throttleHandle.rotation.z = 0.24;
  addInkedPart(throttleHandle, new THREE.BoxGeometry(0.026, 0.09, 0.028), bevelMat, {
    position: [0, 0.035, 0],
  });
  addInkedPart(throttleHandle, new THREE.BoxGeometry(0.085, 0.03, 0.044), accentMat, {
    position: [0.01, 0.082, 0],
  });
  root.add(throttleHandle);

  const muzzleLeft = buildMuzzleBurst();
  muzzleLeft.position.set(-0.98, -0.52, -2.32);
  root.add(muzzleLeft);

  const muzzleRight = buildMuzzleBurst();
  muzzleRight.position.set(0.98, -0.52, -2.32);
  root.add(muzzleRight);

  return { root, throttleHandle, muzzleLeft, muzzleRight, flashLight };
}

export function buildEnemyMesh(kind: EnemyKind): THREE.Group {
  const root = new THREE.Group();
  const hullMat = toonMat(0x525a72);
  const plateMat = toonMat(0x272c3c);
  const rimMat = toonMat(0xc4cde0);
  const crimsonMat = toonMat(0xe6454f, 0x6b1218, 0.45);
  const coreMat = glowMat(0x5dffb3);

  if (kind === 'raider') {
    addInkedPart(root, new THREE.IcosahedronGeometry(2.6, 0), hullMat, { hullOutline: 1.06 });

    addInkedPart(root, new THREE.BoxGeometry(1.9, 1.15, 0.7), crimsonMat, {
      position: [0, 0.1, -2.35],
    });

    const sparGeo = new THREE.CylinderGeometry(0.52, 0.64, 12.6, 6);
    sparGeo.rotateZ(Math.PI / 2);
    addInkedPart(root, sparGeo, rimMat, { hullOutline: 1.05 });

    const vaneGeo = createHexSolarVaneGeometry();
    for (const side of [-1, 1] as const) {
      const vaneGroup = new THREE.Group();
      vaneGroup.position.set(side * 6.3, 0, 0.15);
      vaneGroup.rotation.z = side * 0.15;

      addInkedPart(vaneGroup, vaneGeo, plateMat, { hullOutline: 1.055 });

      addInkedPart(vaneGroup, new THREE.BoxGeometry(0.68, 1.1, 7.6), crimsonMat, {
        position: [0, 0, 0],
      });
      addInkedPart(vaneGroup, new THREE.BoxGeometry(0.62, 6.2, 0.65), rimMat, {
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
      bevelSegments: 1,
    });
    hullGeo.rotateX(Math.PI / 2);
    hullGeo.translate(0, 1.05, 0);
    addInkedPart(root, hullGeo, hullMat, { hullOutline: 1.05 });

    addInkedPart(root, new THREE.OctahedronGeometry(2.1, 0), crimsonMat, {
      position: [0, 1.8, -1.5],
      scale: [1, 0.65, 1.4],
    });

    const boomGeo = new THREE.CylinderGeometry(1.1, 1.45, 9.5, 6);
    boomGeo.rotateX(Math.PI / 2);
    for (const side of [-1, 1] as const) {
      addInkedPart(root, boomGeo, plateMat, {
        position: [side * 5.2, -0.35, 0.4],
        hullOutline: 1.05,
      });
      addInkedPart(root, new THREE.BoxGeometry(2.6, 0.35, 3.2), rimMat, {
        position: [side * 3.8, 0.2, 0.6],
      });
      const engine = new THREE.Mesh(new THREE.OctahedronGeometry(1.45, 0), coreMat);
      engine.position.set(side * 5.2, -0.35, 5.4);
      root.add(engine);
    }
  }

  return root;
}

export function buildFriendlyCarrierMesh(): THREE.Group {
  const root = new THREE.Group();
  const hullMat = toonMat(0x8893a8);
  const deckMat = toonMat(0x475066);
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
    bevelThickness: 5,
    bevelSize: 4,
    bevelSegments: 1,
  });
  mainHullGeo.rotateX(Math.PI / 2);
  mainHullGeo.translate(0, 15, 0);
  addInkedPart(root, mainHullGeo, hullMat, { edgeAngle: 22 });

  addInkedPart(root, new THREE.BoxGeometry(44, 12, 232), deckMat, { position: [0, 24, -8] });

  for (let i = -3; i <= 2; i += 1) {
    const marker = new THREE.Mesh(new THREE.BoxGeometry(10, 1.2, 3.5), accentMat);
    marker.position.set(0, 30.6, i * 32 - 12);
    root.add(marker);
  }

  addInkedPart(root, new THREE.BoxGeometry(28, 24, 48), hullMat, { position: [18, 38, 66] });
  addInkedPart(root, new THREE.BoxGeometry(36, 12, 34), deckMat, { position: [18, 55, 64] });
  const bridgeGlass = new THREE.Mesh(new THREE.BoxGeometry(29, 4.8, 3), bridgeLight);
  bridgeGlass.position.set(18, 55, 46.5);
  root.add(bridgeGlass);

  addInkedPart(root, new THREE.CylinderGeometry(1.4, 2.2, 34, 6), accentMat, {
    position: [18, 76, 70],
  });
  addInkedPart(root, new THREE.BoxGeometry(22, 3.6, 2.4), hullMat, {
    position: [18, 88, 70],
  });

  const tankGeo = new THREE.CylinderGeometry(7, 7, 56, 8);
  tankGeo.rotateX(Math.PI / 2);
  for (const side of [-1, 1] as const) {
    addInkedPart(root, new THREE.BoxGeometry(3, 5.5, 224), accentMat, {
      position: [side * 42, 11, -6],
    });

    addInkedPart(root, new THREE.BoxGeometry(5, 16, 104), deckMat, {
      position: [side * 41, -3, -28],
    });
    const bay = new THREE.Mesh(new THREE.BoxGeometry(1.6, 10.5, 92), bayLight);
    bay.position.set(side * 43.6, -3, -28);
    root.add(bay);

    for (let t = -2; t <= 2; t += 1) {
      addInkedPart(root, new THREE.BoxGeometry(2.2, 16, 3.2), deckMat, {
        position: [side * 44.2, -3, -28 + t * 20],
      });
    }

    addInkedPart(root, tankGeo, deckMat, { position: [side * 42, -5, 74] });
  }

  const nozzleGeo = new THREE.CylinderGeometry(5.8, 7.6, 16, 8);
  nozzleGeo.rotateX(Math.PI / 2);
  for (const x of [-20, -7, 7, 20]) {
    addInkedPart(root, nozzleGeo, deckMat, { position: [x, 0, 160] });
    const glow = new THREE.Mesh(new THREE.CircleGeometry(5.5, 8), engineGlow);
    glow.position.set(x, 0, 168.5);
    root.add(glow);

    const plume = new THREE.Mesh(new THREE.ConeGeometry(5.4, 28, 7), plumeGlow);
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

export function buildHostileFrigateMesh(): HostileFrigateRig {
  const root = new THREE.Group();
  const hullMat = toonMat(0x6b5f82, 0x161124, 0.35);
  const armorMat = toonMat(0x8d6c86, 0x1e1320, 0.3);
  const crimsonAccent = toonMat(0xf04d5c, 0x731420, 0.5);
  const trenchGlow = glowMat(0xff6b7a);
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
    bevelSegments: 1,
  });
  mainGeo.rotateX(Math.PI / 2);
  mainGeo.translate(0, 11, 0);
  addInkedPart(root, mainGeo, hullMat, { edgeAngle: 20 });

  addInkedPart(root, new THREE.BoxGeometry(24, 15, 148), armorMat, { position: [0, 17, 28] });
  addInkedPart(root, new THREE.BoxGeometry(36, 20, 28), armorMat, { position: [0, 32, 76] });
  addInkedPart(root, new THREE.BoxGeometry(4, 4.5, 165), crimsonAccent, { position: [-26, 7, 26] });
  addInkedPart(root, new THREE.BoxGeometry(4, 4.5, 165), crimsonAccent, { position: [26, 7, 26] });

  const bridgeSlit = new THREE.Mesh(new THREE.BoxGeometry(26, 3.6, 3), trenchGlow);
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

  const shieldDome = addInkedPart(
    root,
    new THREE.IcosahedronGeometry(15, 1),
    toonMat(0xff5ec0, 0xd42288, 0.95),
    { position: [0, 28, -32], edgeAngle: 18 },
  );

  const shieldRing = new THREE.Mesh(
    new THREE.TorusGeometry(20, 1.2, 6, 18),
    glowMat(0xff8ad8, 0.72),
  );
  shieldRing.position.set(0, 28, -32);
  shieldRing.rotation.x = Math.PI * 0.42;
  root.add(shieldRing);

  const clampCore = addInkedPart(
    root,
    new THREE.OctahedronGeometry(15, 0),
    toonMat(0xff843b, 0xd6400e, 0.95),
    { position: [0, -20, 62], edgeAngle: 15 },
  );

  for (const side of [-1, 1] as const) {
    addInkedPart(root, new THREE.BoxGeometry(6, 18, 12), armorMat, {
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

export function buildAsteroidMesh(asteroid: AsteroidState): THREE.Group {
  const group = new THREE.Group();
  const color =
    asteroid.tint === 'ice' ? 0xc2b2d4 : asteroid.tint === 'ochre' ? 0xb87456 : 0x5d6278;

  const geo = new THREE.IcosahedronGeometry(asteroid.radius, 1);
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < posAttr.count; i += 1) {
    const vx = posAttr.getX(i);
    const vy = posAttr.getY(i);
    const vz = posAttr.getZ(i);
    const warp =
      1 +
      0.18 * Math.sin(vx * 0.17 + asteroid.rotation.x * 4) *
        Math.cos(vy * 0.19 + asteroid.rotation.y * 4) +
      0.1 * Math.sin(vz * 0.23);
    posAttr.setXYZ(i, vx * warp, vy * warp * 0.76, vz * warp);
  }
  geo.computeVertexNormals();

  addInkedPart(group, geo, toonMat(color), { edgeAngle: 20, hullOutline: 1.035 });
  group.position.set(asteroid.position.x, asteroid.position.y, asteroid.position.z);
  group.rotation.set(asteroid.rotation.x, asteroid.rotation.y, asteroid.rotation.z);
  return group;
}

export function buildOrbitalBackdrop(dotTexture: THREE.CanvasTexture): THREE.Group {
  const group = new THREE.Group();
  const sunDir = new THREE.Vector3(0.58, 0.24, -0.78).normalize();

  const skyGeo = new THREE.SphereGeometry(5400, 32, 20);
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
        vec3 zenith = vec3(0.035, 0.045, 0.13);
        vec3 horizon = vec3(0.24, 0.11, 0.23);
        vec3 nadir = vec3(0.05, 0.035, 0.11);
        vec3 base = y >= 0.0
          ? mix(horizon, zenith, pow(y, 0.55))
          : mix(horizon, nadir, pow(-y, 0.65));

        float sunAlign = max(dot(normalize(vDir), uSunDir), 0.0);
        vec3 duskGlow = vec3(0.98, 0.44, 0.18) * pow(sunAlign, 4.2) * 0.66;
        vec3 sunCore = vec3(1.0, 0.94, 0.78) * smoothstep(0.9968, 0.9992, sunAlign);
        float belt = exp(-abs(vDir.y + vDir.x * 0.18) * 7.5);
        vec3 nebulaBand = vec3(0.52, 0.20, 0.27) * belt * 0.26;

        vec3 color = base + duskGlow + nebulaBand + sunCore;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  group.add(new THREE.Mesh(skyGeo, skyMat));

  const planetPos = new THREE.Vector3(-1480, -420, -2950);
  const planetRadius = 980;
  const planetGeo = new THREE.SphereGeometry(planetRadius, 36, 28);
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
        float band = floor((sin(lat * 20.0 + sin(vLocal.x * 6.0) * 0.4) * 0.5 + 0.5) * 4.0) / 4.0;
        vec3 c1 = vec3(0.32, 0.12, 0.24);
        vec3 c2 = vec3(0.78, 0.36, 0.22);
        vec3 c3 = vec3(0.96, 0.68, 0.46);
        vec3 albedo = mix(c1, c2, band);
        albedo = mix(albedo, c3, step(0.62, band) * 0.45);

        float litRaw = dot(vWorldNormal, uSunDir);
        float lit = smoothstep(-0.14, 0.32, litRaw);
        lit = floor(lit * 4.0 + 0.5) / 4.0;
        vec3 night = vec3(0.045, 0.03, 0.09);
        vec3 rim = vec3(0.99, 0.58, 0.32) * pow(1.0 - max(dot(vWorldNormal, vec3(0.0, 0.0, 1.0)), 0.0), 3.0) * lit * 0.44;
        gl_FragColor = vec4(mix(night, albedo, lit) + rim, 1.0);
      }
    `,
  });
  const planet = new THREE.Mesh(planetGeo, planetMat);
  planet.position.copy(planetPos);
  group.add(planet);

  const ringGeo = new THREE.RingGeometry(1260, 2140, 84);
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
        float t = clamp((r - 1260.0) / (2140.0 - 1260.0), 0.0, 1.0);
        float cassiniGap = smoothstep(0.02, 0.05, abs(t - 0.58));
        float innerGap = smoothstep(0.01, 0.025, abs(t - 0.24));
        float bands = 0.65 + 0.35 * sin(t * 48.0);
        float edgeFade = smoothstep(0.0, 0.08, t) * smoothstep(1.0, 0.88, t);

        float proj = dot(vOffsetFromPlanet, uSunDir);
        vec3 perp = vOffsetFromPlanet - uSunDir * proj;
        float inShadow = (proj < 0.0) ? (1.0 - smoothstep(uPlanetRadius * 0.94, uPlanetRadius * 1.05, length(perp))) : 0.0;

        vec3 litColor = mix(vec3(0.68, 0.42, 0.46), vec3(0.96, 0.70, 0.48), bands);
        vec3 color = mix(litColor, vec3(0.08, 0.06, 0.14), inShadow * 0.85);
        float alpha = edgeFade * cassiniGap * (0.45 + 0.55 * innerGap) * (0.3 + 0.18 * bands);
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.copy(planetPos);
  ring.rotation.x = Math.PI * 0.43;
  ring.rotation.y = 0.26;
  group.add(ring);

  const starPositions = new Float32Array(1800 * 3);
  let seed = 0x1337c0de;
  for (let i = 0; i < 1800; i += 1) {
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
    color: 0xffe9cc,
    map: dotTexture,
    transparent: true,
    depthWrite: false,
    size: 16,
    sizeAttenuation: true,
  });
  group.add(new THREE.Points(starGeo, starMat));

  return group;
}
