import * as THREE from 'three';
import { add, forwardOf, rightOf, scale } from '../sim/math';
import type { Quat, Vec3, WorldState } from '../sim/types';
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
import { createStylizedPostPass } from './postProcess';
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
  readonly points: Vec3[];
  readonly maxPoints: number;
}

interface ExplosionVisual {
  readonly sphere: THREE.Mesh;
  readonly ring: THREE.Mesh;
  readonly shards: readonly { readonly mesh: THREE.Mesh; readonly dir: Vec3 }[];
}

function setPose(obj: THREE.Object3D, pos: Vec3, quat: Quat): void {
  obj.position.set(pos.x, pos.y, pos.z);
  obj.quaternion.set(quat.x, quat.y, quat.z, quat.w);
}

function createTrail(color: number, maxPoints: number, opacity: number): TrailLine {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxPoints * 3), 3));
  geo.setDrawRange(0, 0);
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(1.65),
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  return {
    line,
    points: [],
    maxPoints,
  };
}

function pushTrailPoint(trail: TrailLine, point: Vec3): void {
  trail.points.push(point);
  if (trail.points.length > trail.maxPoints) {
    trail.points.shift();
  }
  const attr = trail.line.geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < trail.points.length; i += 1) {
    const p = trail.points[i];
    if (p !== undefined) {
      attr.setXYZ(i, p.x, p.y, p.z);
    }
  }
  attr.needsUpdate = true;
  trail.line.geometry.setDrawRange(0, trail.points.length);
}

function clearTrail(trail: TrailLine): void {
  trail.points.length = 0;
  trail.line.geometry.setDrawRange(0, 0);
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
  renderer.setPixelRatio(1);

  const postPass = createStylizedPostPass();
  const textures = createHullTextureSet();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.25, 12000);
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
  const shardGeo = new THREE.OctahedronGeometry(0.6, 0);

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
  const streakMat = new THREE.LineBasicMaterial({
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
  const scratchVelCam = new THREE.Vector3();
  const scratchCamInv = new THREE.Quaternion();
  const scratchBankEuler = new THREE.Euler();
  const scratchBankQuat = new THREE.Quaternion();
  const scratchUp = new THREE.Vector3(0, 1, 0);
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
    shardGeo,
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
    const boostKind = world.player.energy.boostMode.kind;
    const targetOpacity = boostKind === 'boosting' ? 0.52 : boostKind === 'drifting' ? 0.42 : 0;
    const alpha = 1 - Math.exp(-12 * dt);
    streakMat.opacity += (targetOpacity - streakMat.opacity) * alpha;
    speedStreaks.visible = streakMat.opacity > 0.01;
    if (!speedStreaks.visible) {
      return;
    }
    streakMat.color
      .setHex(boostKind === 'drifting' ? SCENE_PALETTE.streakDrift : SCENE_PALETTE.streakBoost)
      .multiplyScalar(1.9);

    // Transform actual ship velocity into camera space so snap-turn drift streaks flow along real drift vector.
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
    const length = boostKind === 'boosting' ? 14 : 9.5;
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

  function syncProjectiles(world: WorldState, tickAdvanced: boolean): void {
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
      mesh.lookAt(
        proj.position.x + scratchDir.x,
        proj.position.y + scratchDir.y,
        proj.position.z + scratchDir.z,
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
          exp.tint === 'crimson'
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
          color: new THREE.Color(SCENE_PALETTE.explosionRing).multiplyScalar(2.8),
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

        const shardCount = exp.radius > 14 ? 10 : 0;
        const shards: { readonly mesh: THREE.Mesh; readonly dir: Vec3 }[] = [];
        for (let i = 0; i < shardCount; i += 1) {
          const phi = (i / shardCount) * Math.PI * 2;
          const elev = ((i % 3) - 1) * 0.55;
          const dir: Vec3 = {
            x: Math.cos(phi),
            y: elev,
            z: Math.sin(phi),
          };
          const shardMat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(
              i % 2 === 0 ? color : SCENE_PALETTE.explosionShardHighlight,
            ).multiplyScalar(2.4),
            transparent: true,
            opacity: 0.95,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          });
          const mesh = new THREE.Mesh(shardGeo, shardMat);
          scene.add(mesh);
          shards.push({ mesh, dir });
        }

        entry = { sphere, ring, shards };
        explosionVisuals.set(exp.id, entry);
      }
      const t = exp.elapsed / Math.max(exp.duration, 0.01);
      const scaleRadius = Math.max(0.5, exp.radius * (0.25 + t * 0.95));
      entry.sphere.position.set(exp.position.x, exp.position.y, exp.position.z);
      entry.sphere.scale.setScalar(scaleRadius * (1 - t * 0.35));
      const sphereMat = entry.sphere.material as THREE.MeshBasicMaterial;
      if (t < 0.22) {
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

      for (const shard of entry.shards) {
        const dist = exp.radius * 2.1 * t;
        shard.mesh.position.set(
          exp.position.x + shard.dir.x * dist,
          exp.position.y + shard.dir.y * dist,
          exp.position.z + shard.dir.z * dist,
        );
        shard.mesh.rotation.set(t * 7, t * 5, t * 4);
        shard.mesh.scale.setScalar(Math.max(0.2, (1 - t) * 2.6));
        (shard.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t);
      }
    }
    for (const [id, entry] of explosionVisuals) {
      if (!activeIds.has(id)) {
        scene.remove(entry.sphere);
        scene.remove(entry.ring);
        (entry.sphere.material as THREE.Material).dispose();
        (entry.ring.material as THREE.Material).dispose();
        for (const shard of entry.shards) {
          scene.remove(shard.mesh);
          (shard.mesh.material as THREE.Material).dispose();
        }
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
    const boostKind = player.energy.boostMode.kind;
    const pose = computeCameraPose(player, world.cameraMode);
    if (Math.abs(camera.fov - pose.targetFov) > 0.05) {
      const fovAlpha = 1 - Math.exp(-10 * dt);
      camera.fov += (pose.targetFov - camera.fov) * fovAlpha;
      camera.updateProjectionMatrix();
    }

    const isCockpit = world.cameraMode === 'cockpit';
    cockpitRig.root.visible = isCockpit;
    playerRig.root.visible = !isCockpit;
    playerLeftTrail.line.visible = !isCockpit;
    playerRightTrail.line.visible = !isCockpit;

    const firingGlow = player.recoilKick > 0.35;
    playerRig.muzzleLeft.visible = !isCockpit && firingGlow;
    playerRig.muzzleRight.visible = !isCockpit && firingGlow;
    if (firingGlow) {
      playerRig.muzzleLeft.rotation.z = world.tick * 0.9;
      playerRig.muzzleRight.rotation.z = -world.tick * 0.9;
    }

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
        player.recoilKick * 0.038,
      );
      cockpitRig.root.rotation.set(
        player.angularVelocity.x * 0.022,
        player.angularVelocity.y * 0.022,
        player.angularVelocity.z * 0.032,
      );
      const throttleZ = boostKind === 'boosting' ? -0.96 : -0.82 - player.throttle * 0.12;
      cockpitRig.throttleHandle.position.z = throttleZ;

      cockpitRig.muzzleLeft.visible = firingGlow;
      cockpitRig.muzzleRight.visible = firingGlow;
      cockpitRig.muzzleLeft.rotation.z = world.tick * 0.9;
      cockpitRig.muzzleRight.rotation.z = -world.tick * 0.9;
      cockpitRig.flashLight.intensity = firingGlow ? 1.8 : 0;
    } else if (pose.lookAt !== null) {
      scratchUp.set(pose.up.x, pose.up.y, pose.up.z);
      camera.up.copy(scratchUp);
      camera.lookAt(pose.lookAt.x, pose.lookAt.y, pose.lookAt.z);
    }

    if (shakeIntensity > 0.005) {
      const amp = shakeIntensity * (isCockpit ? 0.14 : 0.45);
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

    const tickReset = world.tick < lastTick;
    const tickAdvanced = world.tick > lastTick;
    lastTick = world.tick;
    if (tickReset) {
      shakeIntensity = 0;
      clearTrail(playerLeftTrail);
      clearTrail(playerRightTrail);
      clearTrail(wingmateTrail);
      for (const trail of enemyTrails.values()) {
        clearTrail(trail);
      }
    }

    if (tickAdvanced) {
      for (const evt of world.events) {
        if (evt.kind === 'player_damaged') {
          shakeIntensity = Math.min(1, shakeIntensity + 0.55);
        } else if (evt.kind === 'subsystem_destroyed') {
          shakeIntensity = Math.min(1, shakeIntensity + 0.65);
        } else if (evt.kind === 'hit_confirmed') {
          shakeIntensity = Math.min(1, shakeIntensity + (evt.isKill ? 0.34 : 0.12));
        } else if (evt.kind === 'cannon_fired' && evt.faction === 'friendly') {
          shakeIntensity = Math.min(1, shakeIntensity + 0.045);
        }
      }
    }
    shakeIntensity *= Math.exp(-10 * dt);
    if (shakeIntensity < 0.004) {
      shakeIntensity = 0;
    }

    const player = world.player;
    setPose(playerRig.root, player.position, player.orientation);
    if (world.cameraMode === 'chase') {
      // Visual-only chase-cam roll/pitch banking gives the fighter lively weight without affecting sim aim.
      const bankRoll = Math.max(-0.34, Math.min(0.34, -player.angularVelocity.y * 0.28));
      const bankPitch = Math.max(-0.16, Math.min(0.16, player.angularVelocity.x * 0.12));
      scratchBankEuler.set(bankPitch, 0, bankRoll);
      scratchBankQuat.setFromEuler(scratchBankEuler);
      playerRig.root.quaternion.multiply(scratchBankQuat);
    }
    setPose(wingmateRig.root, world.wingmate.position, world.wingmate.orientation);
    setPose(carrierMesh, world.friendlyCarrier.position, world.friendlyCarrier.orientation);
    setPose(frigateRig.root, world.hostileFrigate.position, world.hostileFrigate.orientation);
    syncSubsystems(world);

    const boostKind = player.energy.boostMode.kind;
    const flicker = 0.92 + ((world.tick * 13) % 7) * 0.03;
    const plumeScale =
      (boostKind === 'boosting' ? 1.78 : boostKind === 'drifting' ? 1.28 : 0.82) * flicker;
    for (const plume of playerRig.plumes) {
      plume.scale.set(1, 1, plumeScale);
    }

    if (tickAdvanced) {
      const fwd = forwardOf(player.orientation);
      const right = rightOf(player.orientation);
      const tipLeft = add(add(player.position, scale(right, -6.8)), scale(fwd, -1.5));
      const tipRight = add(add(player.position, scale(right, 6.8)), scale(fwd, -1.5));
      pushTrailPoint(playerLeftTrail, tipLeft);
      pushTrailPoint(playerRightTrail, tipRight);
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
    syncProjectiles(world, tickAdvanced);
    syncExplosions(world);

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
    renderer.setSize(safeWidth, safeHeight, false);
    postPass.resize(safeWidth, safeHeight);
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
