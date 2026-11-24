import * as THREE from 'three';
import { COCKPIT_GUN_LOCAL, COMBAT_TUNING } from '../sim/combat';
import { add, forwardOf, scale } from '../sim/math';
import { FIXED_DT, type Quat, type Vec3, type WorldState } from '../sim/types';
import { FRIGATE_SUBSYSTEM_LAYOUT } from '../sim/world';
import { computeCameraPose } from './cameraPose';
import {
  buildAsteroidMesh,
  buildCockpitRig,
  buildEnemyMesh,
  buildFriendlyCarrierMesh,
  buildHostileFrigateMesh,
  buildOrbitalBackdrop,
  buildPlayerFighterMesh,
  createSoftDotTexture,
  SHARED_MODEL_MATERIALS,
  type CockpitRig,
  type FighterMeshRig,
  type HostileFrigateRig,
} from './models';
import { LIGHT_PALETTE, SCENE_PALETTE, SUN_DIRECTION } from './palette';
import { CAMERA_CLIP, createStylizedPostPass } from './postProcess';
import { createHullTextureSet } from './textures';

export interface ProjectedPoint {
  readonly x: number;
  readonly y: number;
  readonly inFront: boolean;
}

export interface SceneRenderer {
  readonly render: (world: WorldState) => void;
  readonly resize: (width: number, height: number) => void;
  readonly projectWorldPoint: (point: Vec3, width: number, height: number) => ProjectedPoint;
  readonly destroy: () => void;
}

interface TrailLine {
  readonly line: THREE.Line;
  readonly maxPoints: number;
}

interface ExplosionVisual {
  readonly sphere: THREE.Mesh;
  readonly ring: THREE.Mesh;
}

function setPose(obj: THREE.Object3D, pos: Vec3, quat: Quat): void {
  obj.position.set(pos.x, pos.y, pos.z);
  obj.quaternion.set(quat.x, quat.y, quat.z, quat.w);
}

function createTrail(color: number, maxPoints: number, opacity: number): TrailLine {
  const geo = new THREE.BufferGeometry();
  const positions = new THREE.Float32BufferAttribute(maxPoints * 3, 3).setUsage(THREE.DynamicDrawUsage);
  const colors = new THREE.Float32BufferAttribute(maxPoints * 3, 3);
  for (let i = 0; i < maxPoints; i++) {
    const fade = (1 - i / (maxPoints - 1)) ** 2;
    colors.setXYZ(i, fade, fade, fade);
  }
  geo.setAttribute('position', positions);
  geo.setAttribute('color', colors);
  geo.setDrawRange(0, 0);
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(1.95),
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  return {
    line,
    maxPoints,
  };
}

function pushTrailPoint(trail: TrailLine, point: Vec3): void {
  const geometry = trail.line.geometry;
  const count = Math.min(geometry.drawRange.count + 1, trail.maxPoints);
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  positions.array.copyWithin(3, 0, (count - 1) * 3);
  positions.setXYZ(0, point.x, point.y, point.z);
  positions.needsUpdate = true;
  geometry.setDrawRange(0, count);
}

function clearTrail(trail: TrailLine): void {
  trail.line.geometry.setDrawRange(0, 0);
}

function createSparkPool() {
  const capacity = 384;
  const mesh = new THREE.InstancedMesh(
    new THREE.OctahedronGeometry(1),
    new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
    capacity,
  );
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const slots = Array.from({ length: capacity }, () => ({
    origin: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    rotation: new THREE.Quaternion(),
    color: new THREE.Color(),
    born: 0,
    lifetime: 0,
    width: 0,
    length: 0,
  }));
  const pose = new THREE.Object3D();
  const axis = new THREE.Vector3(0, 0, 1);
  const direction = new THREE.Vector3();
  const light = new THREE.Color();
  const colors = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  mesh.instanceColor = colors.setUsage(THREE.DynamicDrawUsage);
  let cursor = 0;

  function emit(
    origin: Vec3,
    tick: number,
    tint: number,
    speed: number,
    size: number,
    lifetime: number,
    drift?: Vec3,
  ): void {
    const spark = slots[cursor];
    if (spark === undefined) throw new RangeError('Spark pool cursor outside capacity');
    cursor = (cursor + 1) % capacity;
    direction.randomDirection();
    spark.origin.copy(origin);
    spark.velocity.copy(direction).multiplyScalar(speed);
    if (drift) spark.velocity.add(drift);
    spark.rotation.setFromUnitVectors(axis, direction);
    spark.color.setHex(tint).multiplyScalar(2 + Math.random());
    spark.born = tick;
    spark.lifetime = lifetime;
    spark.width = size;
    spark.length = size * (2 + 4 * Math.random());
  }

  function burst(origin: Vec3, tick: number, tint: number, radius: number, drift?: Vec3): void {
    const count = Math.min(48, Math.round(6 + radius));
    for (let i = 0; i < count; i++) {
      const size = (0.18 + 0.038 * radius) * (0.6 + Math.random());
      emit(
        origin, tick, i % 3 === 0 ? SCENE_PALETTE.explosionShardHighlight : tint,
        radius * (2 + 3 * Math.random()), size, 0.25 + size * 0.24 + Math.random() * 0.3, drift,
      );
    }
  }

  function update(tick: number): void {
    let count = 0;
    for (let i = 0; i < capacity; i++) {
      const spark = slots[i];
      if (spark === undefined) continue;
      const age = (tick - spark.born) * FIXED_DT;
      if (age < 0 || age >= spark.lifetime) continue;
      const fade = 1 - age / spark.lifetime;
      pose.position.copy(spark.origin).addScaledVector(spark.velocity, age);
      pose.quaternion.copy(spark.rotation);
      pose.scale.set(spark.width * fade, spark.width * fade, spark.length * fade);
      pose.updateMatrix();
      mesh.setMatrixAt(count, pose.matrix);
      mesh.setColorAt(count, light.copy(spark.color).multiplyScalar(fade));
      count++;
    }
    mesh.count = count;
    if (count > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      colors.needsUpdate = true;
    }
  }

  function clear(): void {
    for (const spark of slots) spark.lifetime = 0;
    mesh.count = 0;
  }

  return { mesh, emit, burst, update, clear };
}

function disposeObject3D(
  root: THREE.Object3D,
  sharedGeometries: ReadonlySet<THREE.BufferGeometry>,
  sharedMaterials: ReadonlySet<THREE.Material>,
): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  root.traverse((node) => {
    if (
      node instanceof THREE.Mesh ||
      node instanceof THREE.Line ||
      node instanceof THREE.LineSegments ||
      node instanceof THREE.Points
    ) {
      const geo = node.geometry as THREE.BufferGeometry;
      if (!sharedGeometries.has(geo)) {
        geometries.add(geo);
      }
      const mat = node.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) {
        for (const item of mat) {
          if (!sharedMaterials.has(item)) {
            materials.add(item);
          }
        }
      } else if (!sharedMaterials.has(mat)) {
        materials.add(mat);
      }
    }
  });

  for (const geo of geometries) {
    geo.dispose();
  }
  for (const mat of materials) {
    mat.dispose();
  }
}

export function createSceneRenderer(canvas: HTMLCanvasElement): SceneRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
  });

  const postPass = createStylizedPostPass();
  const textures = createHullTextureSet();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(68, 16 / 9, CAMERA_CLIP.near, CAMERA_CLIP.far);
  scene.add(camera);

  const sunLight = new THREE.DirectionalLight(LIGHT_PALETTE.sunColor, LIGHT_PALETTE.sunIntensity);
  sunLight.position.set(SUN_DIRECTION.x * 1000, SUN_DIRECTION.y * 1000, SUN_DIRECTION.z * 1000);
  scene.add(sunLight);

  const rimLight = new THREE.DirectionalLight(LIGHT_PALETTE.rimColor, LIGHT_PALETTE.rimIntensity);
  rimLight.position.set(-520, 120, 480);
  scene.add(rimLight);

  const ambientLight = new THREE.HemisphereLight(
    LIGHT_PALETTE.hemiSky,
    LIGHT_PALETTE.hemiGround,
    LIGHT_PALETTE.hemiIntensity,
  );
  scene.add(ambientLight);

  const dotTexture = createSoftDotTexture();
  const backdrop = buildOrbitalBackdrop(dotTexture);
  scene.add(backdrop);

  const cockpitRig: CockpitRig = buildCockpitRig();
  camera.add(cockpitRig.root);

  const playerRig: FighterMeshRig = buildPlayerFighterMesh(SCENE_PALETTE.playerStripe, textures);
  scene.add(playerRig.root);

  const wingmateRig: FighterMeshRig = buildPlayerFighterMesh(SCENE_PALETTE.wingmateStripe, textures);
  scene.add(wingmateRig.root);

  const carrierMesh = buildFriendlyCarrierMesh(textures);
  scene.add(carrierMesh);

  const frigateRig: HostileFrigateRig = buildHostileFrigateMesh(textures);
  scene.add(frigateRig.root);

  const asteroidMeshes = new Map<string, THREE.Group>();
  const enemyMeshes = new Map<string, THREE.Group>();
  const enemyTrails = new Map<string, TrailLine>();
  const projectileMeshes = new Map<string, THREE.Mesh>();
  const missileTrails = new Map<string, TrailLine>();
  const explosionVisuals = new Map<string, ExplosionVisual>();

  const playerLeftTrail = createTrail(SCENE_PALETTE.friendlyTrail, 28, 0.72);
  const playerRightTrail = createTrail(SCENE_PALETTE.friendlyTrail, 28, 0.72);
  const wingmateTrail = createTrail(SCENE_PALETTE.wingmateTrail, 34, 0.65);
  scene.add(playerLeftTrail.line);
  scene.add(playerRightTrail.line);
  scene.add(wingmateTrail.line);

  const boltGeo = new THREE.BoxGeometry(0.45, 0.45, 13);
  const missileGeo = new THREE.ConeGeometry(0.7, 5.8, 5);
  missileGeo.rotateX(-Math.PI / 2);
  const friendlyBoltMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(SCENE_PALETTE.friendlyBolt).multiplyScalar(2.6),
  });
  const hostileBoltMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(SCENE_PALETTE.hostileBolt).multiplyScalar(2.6),
  });
  const missileMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(SCENE_PALETTE.missile).multiplyScalar(2.4),
  });

  const explosionGeo = new THREE.IcosahedronGeometry(1, 1);
  const ringGeo = new THREE.RingGeometry(0.84, 1.08, 20);
  const sparks = createSparkPool();
  scene.add(sparks.mesh);

  const dustCount = 150;
  const dustPositions = new Float32Array(dustCount * 3);
  const dustBox = 280;
  let dustSeed = 0x99aabb;
  for (let i = 0; i < dustCount; i += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      dustSeed = (Math.imul(dustSeed, 1664525) + 1013904223) | 0;
      dustPositions[i * 3 + axis] = (((dustSeed >>> 0) / 4294967296) - 0.5) * dustBox;
    }
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  const dustMat = new THREE.PointsMaterial({
    color: SCENE_PALETTE.dust,
    map: dotTexture,
    size: 1.25,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  const dustPoints = new THREE.Points(dustGeo, dustMat);
  dustPoints.frustumCulled = false;
  scene.add(dustPoints);

  const streakCount = 46;
  const streakBase: { x: number; y: number; z: number }[] = [];
  const streakVertices = new Float32Array(streakCount * 6);
  for (let i = 0; i < streakCount; i += 1) {
    const angle = (i / streakCount) * Math.PI * 2;
    const radius = 13 + (i % 5) * 4.5;
    const z = -12 - ((i * 19) % 90);
    streakBase.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z });
  }
  const streakGeo = new THREE.BufferGeometry();
  streakGeo.setAttribute('position', new THREE.BufferAttribute(streakVertices, 3));
  const streakColors = new THREE.Float32BufferAttribute(streakCount * 6, 3);
  for (let i = 0; i < streakCount; i++) {
    streakColors.setXYZ(i * 2, 1, 1, 1);
    streakColors.setXYZ(i * 2 + 1, 0.04, 0.04, 0.04);
  }
  streakGeo.setAttribute('color', streakColors);
  const streakMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    color: new THREE.Color(SCENE_PALETTE.streakBoost).multiplyScalar(1.9),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const speedStreaks = new THREE.LineSegments(streakGeo, streakMat);
  speedStreaks.frustumCulled = false;
  camera.add(speedStreaks);

  const scratchVec = new THREE.Vector3();
  const scratchDir = new THREE.Vector3();
  const exhaustVelocity = new THREE.Vector3();
  const exhaustOrigin = new THREE.Vector3();
  const scratchVelCam = new THREE.Vector3();
  const scratchCamInv = new THREE.Quaternion();
  const scratchRight = new THREE.Vector3();
  const scratchCamUp = new THREE.Vector3();
  const destroyedSubMat = new THREE.MeshToonMaterial({ color: SCENE_PALETTE.destroyedSubsystem });
  const initialSubMaterials = new Map<string, THREE.Material>();
  for (const [id, mesh] of frigateRig.subsystemMeshes) {
    if (!Array.isArray(mesh.material)) {
      initialSubMaterials.set(id, mesh.material);
    }
  }

  const sharedGeometries = new Set<THREE.BufferGeometry>([
    boltGeo,
    missileGeo,
    explosionGeo,
    ringGeo,
    dustGeo,
    streakGeo,
  ]);
  const sharedMaterials = new Set<THREE.Material>([
    ...SHARED_MODEL_MATERIALS,
    friendlyBoltMat,
    hostileBoltMat,
    missileMat,
    destroyedSubMat,
    dustMat,
    streakMat,
  ]);

  let lastTick = -1;
  let lastPlayerIntegrity = 0;
  let lastRenderTimeMs = 0;
  let shakeIntensity = 0;

  function updateDustField(center: Vec3): void {
    const posAttr = dustGeo.getAttribute('position') as THREE.BufferAttribute;
    const half = dustBox * 0.5;
    for (let i = 0; i < dustCount; i += 1) {
      let x = posAttr.getX(i);
      let y = posAttr.getY(i);
      let z = posAttr.getZ(i);
      if (x - center.x > half) x -= dustBox;
      if (x - center.x < -half) x += dustBox;
      if (y - center.y > half) y -= dustBox;
      if (y - center.y < -half) y += dustBox;
      if (z - center.z > half) z -= dustBox;
      if (z - center.z < -half) z += dustBox;
      posAttr.setXYZ(i, x, y, z);
    }
    posAttr.needsUpdate = true;
  }

  function updateSpeedStreaks(world: WorldState, dt: number): void {
    const overdrive = world.player.energy.overdrive;
    const targetOpacity = overdrive ? 0.52 : 0;
    const alpha = 1 - Math.exp(-12 * dt);
    streakMat.opacity += (targetOpacity - streakMat.opacity) * alpha;
    speedStreaks.visible = streakMat.opacity > 0.01;
    if (!speedStreaks.visible) {
      return;
    }
    streakMat.color.setHex(SCENE_PALETTE.streakBoost).multiplyScalar(1.9);

    scratchCamInv.copy(camera.quaternion).invert();
    scratchVelCam
      .set(world.player.velocity.x, world.player.velocity.y, world.player.velocity.z)
      .applyQuaternion(scratchCamInv);
    const speed = scratchVelCam.length();
    if (speed > 1e-3) {
      scratchVelCam.divideScalar(speed);
    } else {
      scratchVelCam.set(0, 0, -1);
    }

    const posAttr = streakGeo.getAttribute('position') as THREE.BufferAttribute;
    const travel = (world.tick * 5.2) % 90;
    const length = 14;
    for (let i = 0; i < streakCount; i += 1) {
      const base = streakBase[i];
      if (base === undefined) {
        continue;
      }
      // Particles rush past the camera opposite to camera-space velocity.
      let sx = base.x - scratchVelCam.x * travel;
      let sy = base.y - scratchVelCam.y * travel;
      let sz = base.z - scratchVelCam.z * travel;
      sx = ((((sx + 45) % 90) + 90) % 90) - 45;
      sy = ((((sy + 45) % 90) + 90) % 90) - 45;
      sz = -(((((-sz - 4) % 90) + 90) % 90) + 4);
      posAttr.setXYZ(i * 2, sx, sy, sz);
      posAttr.setXYZ(
        i * 2 + 1,
        sx + scratchVelCam.x * length,
        sy + scratchVelCam.y * length,
        sz + scratchVelCam.z * length,
      );
    }
    posAttr.needsUpdate = true;
  }

  function syncAsteroids(world: WorldState): void {
    const activeIds = new Set<string>();
    for (const ast of world.asteroids) {
      activeIds.add(ast.id);
      if (!asteroidMeshes.has(ast.id)) {
        const mesh = buildAsteroidMesh(ast, textures);
        asteroidMeshes.set(ast.id, mesh);
        scene.add(mesh);
      }
    }
    for (const [id, mesh] of asteroidMeshes) {
      if (!activeIds.has(id)) {
        scene.remove(mesh);
        disposeObject3D(mesh, sharedGeometries, sharedMaterials);
        asteroidMeshes.delete(id);
      }
    }
  }

  function syncEnemies(world: WorldState, tickAdvanced: boolean): void {
    const activeIds = new Set<string>();
    for (const enemy of world.enemies) {
      activeIds.add(enemy.id);
      let mesh = enemyMeshes.get(enemy.id);
      if (mesh === undefined) {
        mesh = buildEnemyMesh(enemy.kind, textures);
        enemyMeshes.set(enemy.id, mesh);
        scene.add(mesh);
      }
      setPose(mesh, enemy.position, enemy.orientation);

      const shieldBubble = mesh.getObjectByName('enemy-shield-bubble');
      if (shieldBubble instanceof THREE.Mesh) {
        const flash = enemy.shieldHitFlash;
        shieldBubble.visible = flash > 0.02;
        if (shieldBubble.visible) {
          shieldBubble.rotation.y = world.tick * 0.06;
          shieldBubble.scale.setScalar(1 + (1 - flash) * 0.08);
          const shellMat = shieldBubble.material as THREE.MeshBasicMaterial;
          shellMat.opacity = flash * 0.42;
          const wireChild = shieldBubble.children[0];
          if (wireChild instanceof THREE.LineSegments) {
            (wireChild.material as THREE.LineBasicMaterial).opacity = flash * 0.85;
          }
        }
      }

      let trail = enemyTrails.get(enemy.id);
      if (trail === undefined) {
        trail = createTrail(SCENE_PALETTE.enemyTrail, 30, 0.55);
        enemyTrails.set(enemy.id, trail);
        scene.add(trail.line);
      }
      if (tickAdvanced) {
        const tail = add(enemy.position, scale(forwardOf(enemy.orientation), -3.2));
        pushTrailPoint(trail, tail);
      }
    }
    for (const [id, mesh] of enemyMeshes) {
      if (!activeIds.has(id)) {
        scene.remove(mesh);
        disposeObject3D(mesh, sharedGeometries, sharedMaterials);
        enemyMeshes.delete(id);
      }
    }
    for (const [id, trail] of enemyTrails) {
      if (!activeIds.has(id)) {
        scene.remove(trail.line);
        trail.line.geometry.dispose();
        (trail.line.material as THREE.Material).dispose();
        enemyTrails.delete(id);
      }
    }
  }

  function syncProjectiles(world: WorldState, tickAdvanced: boolean, emitExhaust: boolean): void {
    const activeIds = new Set<string>();
    for (const proj of world.projectiles) {
      activeIds.add(proj.id);
      let mesh = projectileMeshes.get(proj.id);
      if (mesh === undefined) {
        const mat =
          proj.kind === 'missile'
            ? missileMat
            : proj.faction === 'friendly'
              ? friendlyBoltMat
              : hostileBoltMat;
        mesh = new THREE.Mesh(proj.kind === 'missile' ? missileGeo : boltGeo, mat);
        projectileMeshes.set(proj.id, mesh);
        scene.add(mesh);
      }
      mesh.position.set(proj.position.x, proj.position.y, proj.position.z);
      scratchDir.set(proj.velocity.x, proj.velocity.y, proj.velocity.z).normalize();
      // On a player bolt's spawn tick, bridge its tail directly into the cockpit muzzle tip
      // so the laser visually erupts out of the gun barrel with zero air gap.
      if (proj.kind === 'bolt' && proj.owner === 'player') {
        const age = COMBAT_TUNING.boltTtl - proj.ttl;
        if (age <= FIXED_DT * 2.2) {
          const pullBack = age <= FIXED_DT * 1.2 ? 4.4 : 1.6;
          mesh.position.addScaledVector(scratchDir, -pullBack);
        }
      }
      mesh.lookAt(
        mesh.position.x + scratchDir.x,
        mesh.position.y + scratchDir.y,
        mesh.position.z + scratchDir.z,
      );

      if (proj.kind === 'missile') {
        let trail = missileTrails.get(proj.id);
        if (trail === undefined) {
          trail = createTrail(SCENE_PALETTE.missileTrail, 22, 0.85);
          missileTrails.set(proj.id, trail);
          scene.add(trail.line);
        }
        if (tickAdvanced) {
          pushTrailPoint(trail, proj.position);
        }
        if (emitExhaust) {
          exhaustOrigin.copy(proj.position).addScaledVector(scratchDir, -3);
          exhaustVelocity.copy(proj.velocity).multiplyScalar(0.55);
          sparks.emit(exhaustOrigin, world.tick, SCENE_PALETTE.missileTrail, 4, 0.28, 0.38, exhaustVelocity);
        }
      }
    }
    for (const [id, mesh] of projectileMeshes) {
      if (!activeIds.has(id)) {
        scene.remove(mesh);
        projectileMeshes.delete(id);
      }
    }
    for (const [id, trail] of missileTrails) {
      if (!activeIds.has(id)) {
        scene.remove(trail.line);
        trail.line.geometry.dispose();
        (trail.line.material as THREE.Material).dispose();
        missileTrails.delete(id);
      }
    }
  }

  function syncExplosions(world: WorldState): void {
    const activeIds = new Set<string>();
    for (const exp of world.explosions) {
      activeIds.add(exp.id);
      let entry = explosionVisuals.get(exp.id);
      if (entry === undefined) {
        const color =
          exp.tint === 'cyan'
            ? 0x58ecff
            : exp.tint === 'crimson'
              ? SCENE_PALETTE.explosionCrimson
              : exp.tint === 'emerald'
                ? SCENE_PALETTE.explosionEmerald
                : SCENE_PALETTE.explosionAmber;
        const sphereMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(color).multiplyScalar(2.6),
          transparent: true,
          opacity: 0.94,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const ringMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(
            exp.tint === 'cyan' ? 0x8ef6ff : SCENE_PALETTE.explosionRing,
          ).multiplyScalar(2.8),
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const sphere = new THREE.Mesh(explosionGeo, sphereMat);
        const ring = new THREE.Mesh(ringGeo, ringMat);
        scene.add(sphere);
        scene.add(ring);

        // Hit and subsystem events share this explosion's impact position, even across skipped ticks.
        sparks.burst(exp.position, world.tick - exp.elapsed / FIXED_DT, color, exp.radius);
        entry = { sphere, ring };
        explosionVisuals.set(exp.id, entry);
      }
      const t = exp.elapsed / Math.max(exp.duration, 0.01);
      const scaleRadius = Math.max(0.5, exp.radius * (0.25 + t * 0.95));
      entry.sphere.position.set(exp.position.x, exp.position.y, exp.position.z);
      entry.sphere.scale.setScalar(scaleRadius * (1 - t * 0.35));
      const sphereMat = entry.sphere.material as THREE.MeshBasicMaterial;
      if (exp.tint === 'cyan') {
        sphereMat.color.setHex(t < 0.25 ? 0xe0fcff : 0x48e4ff).multiplyScalar(t < 0.25 ? 3.0 : 2.3);
      } else if (t < 0.22) {
        sphereMat.color.setHex(0xfff8e8).multiplyScalar(3.1);
      } else if (t < 0.58) {
        sphereMat.color
          .setHex(
            exp.tint === 'emerald' ? SCENE_PALETTE.explosionEmerald : SCENE_PALETTE.explosionAmber,
          )
          .multiplyScalar(2.5);
      } else {
        sphereMat.color
          .setHex(
            exp.tint === 'emerald'
              ? SCENE_PALETTE.explosionEmerald
              : SCENE_PALETTE.explosionCrimson,
          )
          .multiplyScalar(1.65);
      }
      sphereMat.opacity = Math.max(0, 1 - t);

      entry.ring.position.set(exp.position.x, exp.position.y, exp.position.z);
      entry.ring.scale.setScalar(scaleRadius * 1.55);
      entry.ring.lookAt(camera.position);
      (entry.ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (1 - t) * 0.88);
    }
    for (const [id, entry] of explosionVisuals) {
      if (!activeIds.has(id)) {
        scene.remove(entry.sphere);
        scene.remove(entry.ring);
        (entry.sphere.material as THREE.Material).dispose();
        (entry.ring.material as THREE.Material).dispose();
        explosionVisuals.delete(id);
      }
    }
  }

  function syncSubsystems(world: WorldState): void {
    let shieldAlive = false;
    for (const subsys of world.hostileFrigate.subsystems) {
      const mesh = frigateRig.subsystemMeshes.get(subsys.id);
      if (mesh === undefined) {
        continue;
      }
      if (subsys.hull <= 0) {
        mesh.material = destroyedSubMat;
        mesh.scale.setScalar(0.55);
      } else {
        if (subsys.id === FRIGATE_SUBSYSTEM_LAYOUT.shieldDome.id) {
          shieldAlive = true;
        }
        const originalMat = initialSubMaterials.get(subsys.id);
        if (originalMat !== undefined && mesh.material !== originalMat) {
          mesh.material = originalMat;
        }
        mesh.scale.setScalar(1);
      }
    }
    frigateRig.shieldRing.visible = shieldAlive;
    frigateRig.shieldRing.rotation.z = world.tick * 0.035;
  }

  function updateCamera(world: WorldState, dt: number): void {
    const player = world.player;
    const overdrive = player.energy.overdrive;
    const pose = computeCameraPose(player, world.cameraMode);
    if (Math.abs(camera.fov - pose.targetFov) > 0.05) {
      const fovAlpha = 1 - Math.exp(-10 * dt);
      camera.fov += (pose.targetFov - camera.fov) * fovAlpha;
      camera.updateProjectionMatrix();
    }

    cockpitRig.root.visible = true;
    playerRig.root.visible = false;
    playerLeftTrail.line.visible = false;
    playerRightTrail.line.visible = false;

    camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    if (pose.orientation !== null) {
      camera.quaternion.set(
        pose.orientation.x,
        pose.orientation.y,
        pose.orientation.z,
        pose.orientation.w,
      );
      cockpitRig.root.position.set(
        -player.angularVelocity.y * 0.03,
        -player.angularVelocity.x * 0.025,
        player.recoilKick * 0.028,
      );
      cockpitRig.root.rotation.set(
        player.angularVelocity.x * 0.022,
        player.angularVelocity.y * 0.022,
        player.angularVelocity.z * 0.032,
      );
      const throttleZ = overdrive ? -0.98 : -0.82 - Math.min(player.throttle, 1) * 0.12;
      cockpitRig.throttleHandle.position.z = throttleZ;

      // Reciprocating left/right gun barrels kick visibly back-and-forth on each alternating shot.
      cockpitRig.barrelLeft.position.z = player.recoilLeft * 0.28;
      cockpitRig.barrelRight.position.z = player.recoilRight * 0.28;

      const leftFlash = player.recoilLeft > 0.52;
      const rightFlash = player.recoilRight > 0.52;
      cockpitRig.muzzleLeft.visible = leftFlash;
      cockpitRig.muzzleRight.visible = rightFlash;
      if (leftFlash) {
        cockpitRig.muzzleLeft.rotation.z = world.tick * 0.9;
      }
      if (rightFlash) {
        cockpitRig.muzzleRight.rotation.z = -world.tick * 0.9;
      }
      cockpitRig.flashLight.intensity = leftFlash || rightFlash ? 2.1 : 0;

      // Diegetic overheat feedback: gun tips glow cherry-hot as heat builds and vent rising smoke on lockout.
      const heat = 1 - Math.min(1, Math.max(0, player.energy.weaponCharge / 100));
      const overheated = player.energy.weaponState === 'overheated';
      const heatPulse = overheated ? 0.85 + 0.15 * Math.sin(world.tick * 0.35) : 1;
      cockpitRig.barrelHeatMat.emissiveIntensity = overheated
        ? (1.1 + heat * 1.4) * heatPulse
        : heat > 0.35
          ? (heat - 0.35) * 1.35
          : 0;

      const smokeTime = world.tick * FIXED_DT * 1.45;
      for (const puff of cockpitRig.overheatPuffs) {
        puff.mesh.visible = overheated;
        if (!overheated) continue;
        const cycle = (smokeTime + puff.phase) % 1;
        const driftX = puff.side * (0.04 + cycle * 0.16) + Math.sin(smokeTime * 5 + puff.phase * 12) * 0.025;
        const riseY = 0.04 + cycle * 0.42;
        const backZ = -(COCKPIT_GUN_LOCAL.forward - 0.25) + cycle * 0.55;
        puff.mesh.position.set(driftX, riseY, backZ);
        puff.mesh.rotation.set(cycle * 3.2, cycle * 2.4, puff.phase * 6);
        puff.mesh.scale.setScalar(0.65 + cycle * 2.1);
        const mat = puff.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.sin(cycle * Math.PI) * (0.28 + heat * 0.36);
      }
    }

    if (shakeIntensity > 0.005) {
      const amp = shakeIntensity * 0.14;
      const phase = world.tick * 1.73;
      scratchRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      scratchCamUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
      camera.position.addScaledVector(scratchRight, Math.sin(phase * 3.1) * amp);
      camera.position.addScaledVector(scratchCamUp, Math.cos(phase * 4.3) * amp);
    }
  }

  function render(world: WorldState): void {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : 0;
    const rawDt = lastRenderTimeMs > 0 ? (nowMs - lastRenderTimeMs) / 1000 : 1 / 60;
    lastRenderTimeMs = nowMs;
    const dt = Math.min(Math.max(rawDt, 1 / 240), 0.05);

    const player = world.player;
    const tickReset = world.tick < lastTick;
    const tickAdvanced = world.tick > lastTick;
    const emitExhaust = Math.floor(world.tick / 3) > Math.floor(lastTick / 3);
    lastTick = world.tick;
    if (tickReset) {
      sparks.clear();
      shakeIntensity = 0;
      clearTrail(playerLeftTrail);
      clearTrail(playerRightTrail);
      clearTrail(wingmateTrail);
      for (const trail of enemyTrails.values()) {
        clearTrail(trail);
      }
    }

    const integrity = player.hull + player.energy.shieldCharge;
    if (tickAdvanced) {
      let playerHit = integrity < lastPlayerIntegrity;
      for (const evt of world.events) {
        if (evt.kind === 'player_damaged') {
          playerHit = true;
          shakeIntensity = Math.min(1, shakeIntensity + 0.55);
        } else if (evt.kind === 'subsystem_destroyed') {
          shakeIntensity = Math.min(1, shakeIntensity + 0.65);
        } else if (evt.kind === 'shield_broken') {
          shakeIntensity = Math.min(1, shakeIntensity + 0.28);
        } else if (evt.kind === 'hit_confirmed') {
          shakeIntensity = Math.min(1, shakeIntensity + (evt.isKill ? 0.34 : 0.12));
        } else if (evt.kind === 'cannon_fired' && evt.faction === 'friendly') {
          shakeIntensity = Math.min(1, shakeIntensity + 0.065);
        }
      }
      if (playerHit) {
        sparks.burst(player.position, world.tick, SCENE_PALETTE.explosionCrimson, 8, player.velocity);
      }
    }
    lastPlayerIntegrity = integrity;
    shakeIntensity *= Math.exp(-10 * dt);
    if (shakeIntensity < 0.004) {
      shakeIntensity = 0;
    }

    setPose(playerRig.root, player.position, player.orientation);
    setPose(wingmateRig.root, world.wingmate.position, world.wingmate.orientation);
    setPose(carrierMesh, world.friendlyCarrier.position, world.friendlyCarrier.orientation);
    setPose(frigateRig.root, world.hostileFrigate.position, world.hostileFrigate.orientation);
    syncSubsystems(world);

    const flicker = 0.92 + ((world.tick * 13) % 7) * 0.03;
    const plumeScale = (player.energy.overdrive ? 1.78 : 0.85) * flicker;
    for (const plume of playerRig.plumes) {
      plume.scale.set(1, 1, plumeScale);
    }

    if (tickAdvanced) {
      pushTrailPoint(
        wingmateTrail,
        add(world.wingmate.position, scale(forwardOf(world.wingmate.orientation), -4)),
      );
    }

    updateCamera(world, dt);
    backdrop.position.copy(camera.position);
    updateDustField(player.position);
    updateSpeedStreaks(world, dt);
    syncAsteroids(world);
    syncEnemies(world, tickAdvanced);
    syncProjectiles(world, tickAdvanced, emitExhaust);
    syncExplosions(world);
    if (tickAdvanced || tickReset) sparks.update(world.tick);

    camera.updateMatrixWorld();
    renderer.setRenderTarget(postPass.target);
    renderer.render(scene, camera);
    postPass.renderToScreen(renderer);
  }

  function resize(width: number, height: number): void {
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    camera.aspect = safeWidth / safeHeight;
    camera.updateProjectionMatrix();
    postPass.resize(safeWidth, safeHeight);
    renderer.setSize(postPass.target.width, postPass.target.height, false);
  }

  function projectWorldPoint(point: Vec3, width: number, height: number): ProjectedPoint {
    scratchVec.set(point.x, point.y, point.z);
    scratchVec.project(camera);
    const inFront = scratchVec.z >= -1 && scratchVec.z <= 1;
    return {
      x: (scratchVec.x * 0.5 + 0.5) * width,
      y: (-scratchVec.y * 0.5 + 0.5) * height,
      inFront,
    };
  }

  function destroy(): void {
    sparks.mesh.dispose();
    disposeObject3D(scene, sharedGeometries, sharedMaterials);
    for (const geo of sharedGeometries) {
      geo.dispose();
    }
    for (const mat of sharedMaterials) {
      if (!SHARED_MODEL_MATERIALS.has(mat)) {
        mat.dispose();
      }
    }
    for (const mat of initialSubMaterials.values()) {
      mat.dispose();
    }
    dotTexture.dispose();
    textures.dispose();
    postPass.destroy();
    renderer.dispose();
  }

  return {
    render,
    resize,
    projectWorldPoint,
    destroy,
  };
}
