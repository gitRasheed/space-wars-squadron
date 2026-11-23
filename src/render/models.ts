import * as THREE from 'three';
import type { EnemyKind } from '../sim/types';

function flatMat(color: number, emissive = 0x000000, emissiveIntensity = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity,
    roughness: 0.56,
    metalness: 0.32,
    flatShading: true,
  });
}

function glowMat(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
  });
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

export interface FighterMeshRig {
  readonly root: THREE.Group;
  readonly plumes: readonly THREE.Group[];
}

export function buildPlayerFighterMesh(stripeColor: number): FighterMeshRig {
  const root = new THREE.Group();
  const hullMat = flatMat(0xdad6cc);
  const slateMat = flatMat(0x4b5163);
  const darkMat = flatMat(0x2d303d);
  const stripeMat = flatMat(stripeColor);
  const canopyMat = flatMat(0xffb852, 0x8a480a, 0.55);
  const canopyRimMat = flatMat(0xf4d299, 0x52340f, 0.25);
  const outerPlumeMat = glowMat(0x5ad8ff, 0.72);
  const innerPlumeMat = glowMat(0xf5fdff, 0.95);
  const navLightMat = glowMat(stripeColor);

  const fuselage = new THREE.Mesh(new THREE.BoxGeometry(2.5, 1.45, 9.4), hullMat);
  root.add(fuselage);

  const upperDeck = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.42, 7.6), slateMat);
  upperDeck.position.set(0, 0.85, 0.3);
  root.add(upperDeck);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.38, 5.4, 4), hullMat);
  nose.rotation.x = -Math.PI / 2;
  nose.rotation.y = Math.PI / 4;
  nose.position.set(0, -0.05, -7.2);
  root.add(nose);

  const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.82, 3.1), canopyMat);
  canopy.position.set(0, 1.12, -1.2);
  root.add(canopy);

  const canopyRim = new THREE.Mesh(new THREE.BoxGeometry(1.58, 0.16, 3.35), canopyRimMat);
  canopyRim.position.set(0, 0.78, -1.2);
  root.add(canopyRim);

  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.62, 4.1), stripeMat);
  spine.position.set(0, 1.15, 2.5);
  root.add(spine);

  const wingGeo = new THREE.BoxGeometry(6.9, 0.24, 2.45);
  const leadingGeo = new THREE.BoxGeometry(6.8, 0.16, 0.42);
  const tipGeo = new THREE.BoxGeometry(1.25, 0.34, 2.7);
  const gunGeo = new THREE.CylinderGeometry(0.11, 0.17, 4.1, 6);

  const wingConfigs: readonly { side: number; angle: number }[] = [
    { side: 1, angle: 0.24 },
    { side: 1, angle: -0.24 },
    { side: -1, angle: -0.24 },
    { side: -1, angle: 0.24 },
  ];

  for (const cfg of wingConfigs) {
    const pivot = new THREE.Group();
    pivot.position.set(cfg.side * 1.15, 0, 1.4);
    pivot.rotation.z = cfg.angle;

    const blade = new THREE.Mesh(wingGeo, hullMat);
    blade.position.set(cfg.side * 3.35, 0, 0);
    pivot.add(blade);

    const leadEdge = new THREE.Mesh(leadingGeo, slateMat);
    leadEdge.position.set(cfg.side * 3.35, 0.04, -1.22);
    pivot.add(leadEdge);

    const tip = new THREE.Mesh(tipGeo, stripeMat);
    tip.position.set(cfg.side * 6.55, 0, 0);
    pivot.add(tip);

    const gun = new THREE.Mesh(gunGeo, darkMat);
    gun.rotation.x = Math.PI / 2;
    gun.position.set(cfg.side * 6.65, 0, -2.15);
    pivot.add(gun);

    const nav = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.45), navLightMat);
    nav.position.set(cfg.side * 7.22, 0, 0.2);
    pivot.add(nav);

    root.add(pivot);
  }

  const plumes: THREE.Group[] = [];
  for (const side of [-1, 1] as const) {
    const cowling = new THREE.Mesh(new THREE.CylinderGeometry(0.76, 0.86, 2.4, 8), slateMat);
    cowling.rotation.x = Math.PI / 2;
    cowling.position.set(side * 1.18, -0.05, 4.5);
    root.add(cowling);

    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.72, 1.4, 8), darkMat);
    bell.rotation.x = Math.PI / 2;
    bell.position.set(side * 1.18, -0.05, 5.75);
    root.add(bell);

    const bellGlow = new THREE.Mesh(new THREE.CircleGeometry(0.54, 8), innerPlumeMat);
    bellGlow.position.set(side * 1.18, -0.05, 6.48);
    root.add(bellGlow);

    const plumeGroup = new THREE.Group();
    plumeGroup.position.set(side * 1.18, -0.05, 6.5);

    const outerCone = new THREE.Mesh(new THREE.ConeGeometry(0.62, 5.0, 7), outerPlumeMat);
    outerCone.rotation.x = Math.PI / 2;
    outerCone.position.set(0, 0, 2.5);
    plumeGroup.add(outerCone);

    const innerCone = new THREE.Mesh(new THREE.ConeGeometry(0.32, 3.1, 6), innerPlumeMat);
    innerCone.rotation.x = Math.PI / 2;
    innerCone.position.set(0, 0, 1.55);
    plumeGroup.add(innerCone);

    root.add(plumeGroup);
    plumes.push(plumeGroup);
  }

  return { root, plumes };
}

export interface CockpitRig {
  readonly root: THREE.Group;
  readonly muzzleLeft: THREE.Group;
  readonly muzzleRight: THREE.Group;
  readonly flashLight: THREE.PointLight;
}

function buildMuzzleBurst(): THREE.Group {
  const burst = new THREE.Group();
  const coreMat = glowMat(0xfff6d6, 0.96);
  const haloMat = glowMat(0xffa63d, 0.65);

  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.06, 0), coreMat);
  core.scale.set(1, 1, 2.4);
  burst.add(core);

  const spikeH = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.025, 0.04), haloMat);
  burst.add(spikeH);

  const spikeV = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.2, 0.04), haloMat);
  burst.add(spikeV);

  const streak = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.36, 5), haloMat);
  streak.rotation.x = -Math.PI / 2;
  streak.position.z = -0.18;
  burst.add(streak);

  burst.visible = false;
  return burst;
}

export function buildCockpitRig(): CockpitRig {
  const root = new THREE.Group();
  const frameMat = flatMat(0x2a2e3e);
  const bevelMat = flatMat(0x4b536b);
  const barrelMat = flatMat(0x3a4052);
  const ledAmber = glowMat(0xf4b459);
  const ledCyan = glowMat(0x6be5ff);

  const cockpitFill = new THREE.PointLight(0xffb76b, 0.55, 3.8);
  cockpitFill.position.set(0, -0.35, -0.55);
  root.add(cockpitFill);

  const flashLight = new THREE.PointLight(0xffbb55, 0, 5);
  flashLight.position.set(0, -0.2, -1.9);
  root.add(flashLight);

  for (const side of [-1, 1] as const) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.048, 1.72, 0.1), frameMat);
    strut.position.set(side * 1.18, 0.1, -1.12);
    strut.rotation.z = side * 0.22;
    strut.rotation.y = side * -0.18;
    root.add(strut);

    const innerTrim = new THREE.Mesh(new THREE.BoxGeometry(0.014, 1.66, 0.024), bevelMat);
    innerTrim.position.set(side * 1.152, 0.1, -1.07);
    innerTrim.rotation.z = side * 0.22;
    innerTrim.rotation.y = side * -0.18;
    root.add(innerTrim);

    const sideSill = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 1.05), frameMat);
    sideSill.position.set(side * 1.06, -0.68, -0.92);
    sideSill.rotation.z = side * -0.18;
    root.add(sideSill);

    const gunShroud = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.048, 1.08, 6), barrelMat);
    gunShroud.rotation.x = Math.PI / 2;
    gunShroud.position.set(side * 0.96, -0.52, -1.56);
    root.add(gunShroud);

    const gunTip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.022, 0.18, 6), bevelMat);
    gunTip.rotation.x = Math.PI / 2;
    gunTip.position.set(side * 0.96, -0.52, -2.18);
    root.add(gunTip);
  }

  const topBow = new THREE.Mesh(new THREE.BoxGeometry(2.12, 0.055, 0.12), frameMat);
  topBow.position.set(0, 0.89, -1.14);
  root.add(topBow);

  const topTrim = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.014, 0.025), bevelMat);
  topTrim.position.set(0, 0.86, -1.08);
  root.add(topTrim);

  const dashHood = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.28, 0.84), frameMat);
  dashHood.position.set(0, -0.78, -1.16);
  dashHood.rotation.x = 0.12;
  root.add(dashHood);

  const dashBevel = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.028, 0.06), bevelMat);
  dashBevel.position.set(0, -0.635, -0.79);
  root.add(dashBevel);

  for (let i = -2; i <= 2; i += 1) {
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.012, 0.012), i === 0 ? ledCyan : ledAmber);
    led.position.set(i * 0.18, -0.62, -0.76);
    root.add(led);
  }

  const muzzleLeft = buildMuzzleBurst();
  muzzleLeft.position.set(-0.96, -0.52, -2.32);
  root.add(muzzleLeft);

  const muzzleRight = buildMuzzleBurst();
  muzzleRight.position.set(0.96, -0.52, -2.32);
  root.add(muzzleRight);

  return { root, muzzleLeft, muzzleRight, flashLight };
}

export function buildEnemyMesh(kind: EnemyKind): THREE.Group {
  const root = new THREE.Group();
  const hullMat = flatMat(0x474e63);
  const plateMat = flatMat(0x252a38);
  const leadEdgeMat = flatMat(0xaeb7cc);
  const crimsonMat = flatMat(0xe04349, 0x5c1116, 0.4);
  const coreMat = glowMat(0x5dffb3);

  if (kind === 'raider') {
    const pod = new THREE.Mesh(new THREE.OctahedronGeometry(2.7, 0), hullMat);
    root.add(pod);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(1.75, 1.15, 0.65), crimsonMat);
    visor.position.set(0, 0.15, -2.35);
    root.add(visor);

    const spar = new THREE.Mesh(new THREE.BoxGeometry(12.2, 0.78, 1.25), leadEdgeMat);
    root.add(spar);

    const vaneGeo = new THREE.BoxGeometry(0.46, 9.6, 6.8);
    const frontEdgeGeo = new THREE.BoxGeometry(0.62, 9.7, 0.72);
    const trimGeo = new THREE.BoxGeometry(0.6, 1.2, 6.9);
    for (const side of [-1, 1] as const) {
      const vane = new THREE.Mesh(vaneGeo, plateMat);
      vane.position.set(side * 6.1, 0, 0.2);
      vane.rotation.z = side * 0.16;
      root.add(vane);

      const frontEdge = new THREE.Mesh(frontEdgeGeo, leadEdgeMat);
      frontEdge.position.set(side * 6.1, 0, -3.15);
      frontEdge.rotation.z = side * 0.16;
      root.add(frontEdge);

      const stripe = new THREE.Mesh(trimGeo, crimsonMat);
      stripe.position.set(side * 6.16, 0, 0.2);
      stripe.rotation.z = side * 0.16;
      root.add(stripe);
    }

    const core = new THREE.Mesh(new THREE.OctahedronGeometry(1.35, 0), coreMat);
    core.position.set(0, 0, 2.75);
    root.add(core);
  } else {
    const body = new THREE.Mesh(new THREE.BoxGeometry(5.8, 2.6, 10.6), hullMat);
    root.add(body);

    const prow = new THREE.Mesh(new THREE.ConeGeometry(3.5, 5.4, 4), crimsonMat);
    prow.rotation.x = -Math.PI / 2;
    prow.rotation.y = Math.PI / 4;
    prow.position.set(0, 0, -7.9);
    root.add(prow);

    for (const side of [-1, 1] as const) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(2.7, 4.3, 8.4), plateMat);
      pod.position.set(side * 5.4, -0.5, 0.8);
      pod.rotation.z = side * 0.22;
      root.add(pod);

      const edge = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.65, 8.5), leadEdgeMat);
      edge.position.set(side * 5.4, 1.45, 0.8);
      edge.rotation.z = side * 0.22;
      root.add(edge);

      const engine = new THREE.Mesh(new THREE.BoxGeometry(1.65, 1.65, 1.2), coreMat);
      engine.position.set(side * 2.0, 0, 5.7);
      root.add(engine);
    }
  }

  return root;
}

export function buildFriendlyCarrierMesh(): THREE.Group {
  const root = new THREE.Group();
  const hullMat = flatMat(0x7c8596);
  const darkMat = flatMat(0x3a4152);
  const accentMat = flatMat(0xd98a36);
  const bayLight = glowMat(0x88ebff);
  const bridgeLight = glowMat(0xffcc70);
  const engineGlow = glowMat(0x6cd8ff);
  const plumeGlow = glowMat(0x52c7ff, 0.45);

  const mainHull = new THREE.Mesh(new THREE.BoxGeometry(74, 34, 290), hullMat);
  root.add(mainHull);

  const prow = new THREE.Mesh(new THREE.ConeGeometry(44, 52, 4), darkMat);
  prow.rotation.x = -Math.PI / 2;
  prow.rotation.y = Math.PI / 4;
  prow.scale.set(1.1, 0.52, 1);
  prow.position.set(0, 0, -170);
  root.add(prow);

  const deckSpine = new THREE.Mesh(new THREE.BoxGeometry(44, 14, 230), darkMat);
  deckSpine.position.set(0, 22, -10);
  root.add(deckSpine);

  const bridgeBase = new THREE.Mesh(new THREE.BoxGeometry(28, 26, 46), hullMat);
  bridgeBase.position.set(16, 36, 68);
  root.add(bridgeBase);

  const bridgeCrown = new THREE.Mesh(new THREE.BoxGeometry(34, 12, 34), darkMat);
  bridgeCrown.position.set(16, 53, 66);
  root.add(bridgeCrown);

  const bridgeGlass = new THREE.Mesh(new THREE.BoxGeometry(28, 5, 3), bridgeLight);
  bridgeGlass.position.set(16, 53, 48.5);
  root.add(bridgeGlass);

  const mast = new THREE.Mesh(new THREE.BoxGeometry(3.2, 32, 3.2), accentMat);
  mast.position.set(16, 74, 72);
  root.add(mast);

  const dish = new THREE.Mesh(new THREE.BoxGeometry(16, 3.5, 2.5), hullMat);
  dish.position.set(16, 86, 72);
  root.add(dish);

  for (let i = -3; i <= 3; i += 1) {
    const rib = new THREE.Mesh(new THREE.BoxGeometry(82, 38, 9), darkMat);
    rib.position.set(0, 0, i * 38);
    root.add(rib);
  }

  for (const side of [-1, 1] as const) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.6, 5, 240), accentMat);
    stripe.position.set(side * 38.2, 12, 0);
    root.add(stripe);

    const bayFrame = new THREE.Mesh(new THREE.BoxGeometry(3.5, 16, 102), darkMat);
    bayFrame.position.set(side * 37.5, -3, -30);
    root.add(bayFrame);

    const bay = new THREE.Mesh(new THREE.BoxGeometry(1.5, 10.5, 92), bayLight);
    bay.position.set(side * 39.2, -3, -30);
    root.add(bay);
  }

  for (const x of [-22, -8, 8, 22]) {
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 7, 16, 6), darkMat);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(x, 0, 152);
    root.add(nozzle);

    const glow = new THREE.Mesh(new THREE.CircleGeometry(5.2, 6), engineGlow);
    glow.position.set(x, 0, 160.5);
    root.add(glow);

    const plume = new THREE.Mesh(new THREE.ConeGeometry(5.2, 26, 6), plumeGlow);
    plume.rotation.x = Math.PI / 2;
    plume.position.set(x, 0, 173);
    root.add(plume);
  }

  return root;
}

export interface HostileFrigateRig {
  readonly root: THREE.Group;
  readonly subsystemMeshes: ReadonlyMap<string, THREE.Mesh>;
}

export function buildHostileFrigateMesh(): HostileFrigateRig {
  const root = new THREE.Group();
  const hullMat = flatMat(0x3a3448);
  const armorMat = flatMat(0x5a4254);
  const crimsonAccent = flatMat(0xcf3845);
  const driveGlow = glowMat(0xff4c65);

  const wedge = new THREE.Mesh(new THREE.ConeGeometry(46, 250, 4), hullMat);
  wedge.rotation.x = -Math.PI / 2;
  wedge.rotation.y = Math.PI / 4;
  wedge.scale.set(1.05, 0.56, 1);
  root.add(wedge);

  const spine = new THREE.Mesh(new THREE.BoxGeometry(24, 18, 170), armorMat);
  spine.position.set(0, 14, 18);
  root.add(spine);

  const tower = new THREE.Mesh(new THREE.BoxGeometry(34, 24, 26), armorMat);
  tower.position.set(0, 30, 68);
  root.add(tower);

  const stripeLeft = new THREE.Mesh(new THREE.BoxGeometry(4, 5, 190), crimsonAccent);
  stripeLeft.position.set(-22, 6, 12);
  root.add(stripeLeft);

  const stripeRight = new THREE.Mesh(new THREE.BoxGeometry(4, 5, 190), crimsonAccent);
  stripeRight.position.set(22, 6, 12);
  root.add(stripeRight);

  for (const x of [-16, 0, 16]) {
    const drive = new THREE.Mesh(new THREE.BoxGeometry(11, 11, 4), driveGlow);
    drive.position.set(x, 0, 126);
    root.add(drive);
  }

  const shieldDome = new THREE.Mesh(
    new THREE.IcosahedronGeometry(15, 1),
    flatMat(0xff52b8, 0xc7207e, 0.9),
  );
  shieldDome.position.set(0, 28, -32);
  root.add(shieldDome);

  const clampCore = new THREE.Mesh(
    new THREE.OctahedronGeometry(15, 0),
    flatMat(0xff8038, 0xc73d0c, 0.9),
  );
  clampCore.position.set(0, -20, 62);
  root.add(clampCore);

  const subsystemMeshes = new Map<string, THREE.Mesh>([
    ['sub-shield-dome', shieldDome],
    ['sub-clamp-core', clampCore],
  ]);

  return { root, subsystemMeshes };
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
        vec3 zenith = vec3(0.035, 0.045, 0.12);
        vec3 horizon = vec3(0.22, 0.10, 0.20);
        vec3 nadir = vec3(0.05, 0.035, 0.10);
        vec3 base = y >= 0.0
          ? mix(horizon, zenith, pow(y, 0.55))
          : mix(horizon, nadir, pow(-y, 0.65));

        float sunAlign = max(dot(normalize(vDir), uSunDir), 0.0);
        vec3 duskGlow = vec3(0.95, 0.42, 0.18) * pow(sunAlign, 4.5) * 0.62;
        vec3 sunCore = vec3(1.0, 0.92, 0.74) * smoothstep(0.9968, 0.9992, sunAlign);
        float belt = exp(-abs(vDir.y + vDir.x * 0.18) * 7.5);
        vec3 nebulaBand = vec3(0.48, 0.19, 0.25) * belt * 0.24;

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
        float band = sin(lat * 22.0 + sin(vLocal.x * 6.0) * 0.45) * 0.5 + 0.5;
        float fine = sin(lat * 52.0) * 0.5 + 0.5;
        vec3 c1 = vec3(0.32, 0.12, 0.22);
        vec3 c2 = vec3(0.76, 0.36, 0.22);
        vec3 c3 = vec3(0.93, 0.66, 0.46);
        vec3 albedo = mix(c1, c2, band);
        albedo = mix(albedo, c3, fine * 0.35);

        float lit = smoothstep(-0.18, 0.38, dot(vWorldNormal, uSunDir));
        vec3 night = vec3(0.045, 0.03, 0.085);
        vec3 rim = vec3(0.98, 0.56, 0.31) * pow(1.0 - max(dot(vWorldNormal, vec3(0.0, 0.0, 1.0)), 0.0), 3.0) * lit * 0.38;
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

        vec3 litColor = mix(vec3(0.68, 0.42, 0.44), vec3(0.95, 0.69, 0.48), bands);
        vec3 color = mix(litColor, vec3(0.08, 0.06, 0.14), inShadow * 0.85);
        float alpha = edgeFade * cassiniGap * (0.45 + 0.55 * innerGap) * (0.28 + 0.18 * bands);
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
