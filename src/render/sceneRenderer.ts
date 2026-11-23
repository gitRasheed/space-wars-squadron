import * as THREE from 'three';
import { add, forwardOf, rightOf, scale, upOf } from '../sim/math';
import type { Quat, Vec3, WorldState } from '../sim/types';
import {
  buildAsteroidMesh,
  buildCockpitRig,
  buildEnemyMesh,
  buildFriendlyCarrierMesh,
  buildHostileFrigateMesh,
  buildOrbitalBackdrop,
  buildPlayerFighterMesh,
  createSoftDotTexture,
  type CockpitRig,
  type FighterMeshRig,
  type HostileFrigateRig,
} from './models';
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
    color,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  return {
    line: new THREE.Line(geo, mat),
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

  const sunLight = new THREE.DirectionalLight(0xffcb99, 2.4);
  sunLight.position.set(840, 180, -510);
  scene.add(sunLight);

  const rimLight = new THREE.DirectionalLight(0x6b88ff, 1.05);
  rimLight.position.set(-520, 120, 480);
  scene.add(rimLight);

  const ambientLight = new THREE.HemisphereLight(0x7c88b8, 0x1b172c, 0.78);
  scene.add(ambientLight);

  const dotTexture = createSoftDotTexture();
  const backdrop = buildOrbitalBackdrop(dotTexture);
  scene.add(backdrop);

  const cockpitRig: CockpitRig = buildCockpitRig();
  camera.add(cockpitRig.root);

  const playerRig: FighterMeshRig = buildPlayerFighterMesh(0xe88332, textures);
  scene.add(playerRig.root);

  const wingmateRig: FighterMeshRig = buildPlayerFighterMesh(0x4bc5e8, textures);
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

  const playerLeftTrail = createTrail(0x88e8ff, 28, 0.72);
  const playerRightTrail = createTrail(0x88e8ff, 28, 0.72);
  const wingmateTrail = createTrail(0x52d4ff, 34, 0.65);
  scene.add(playerLeftTrail.line);
  scene.add(playerRightTrail.line);
  scene.add(wingmateTrail.line);

  const boltGeo = new THREE.BoxGeometry(0.45, 0.45, 13);
  const missileGeo = new THREE.ConeGeometry(0.7, 5.8, 5);
  missileGeo.rotateX(-Math.PI / 2);
  const friendlyBoltMat = new THREE.MeshBasicMaterial({ color: 0xffe07d });
  const hostileBoltMat = new THREE.MeshBasicMaterial({ color: 0x5dffb3 });
  const missileMat = new THREE.MeshBasicMaterial({ color: 0xff7740 });

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
    color: 0xd4e2ff,
    map: dotTexture,
    size: 1.25,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  const dustPoints = new THREE.Points(dustGeo, dustMat);
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
    color: 0xa6e8ff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const speedStreaks = new THREE.LineSegments(streakGeo, streakMat);
  camera.add(speedStreaks);

  const scratchVec = new THREE.Vector3();
  const scratchDir = new THREE.Vector3();
  const scratchUp = new THREE.Vector3(0, 1, 0);
  const destroyedSubMat = new THREE.MeshToonMaterial({ color: 0x1b1922 });
  const initialSubMaterials = new Map<string, THREE.Material>();
  for (const [id, mesh] of frigateRig.subsystemMeshes) {
    if (!Array.isArray(mesh.material)) {
      initialSubMaterials.set(id, mesh.material);
    }
  }

  let lastTick = -1;

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

  function updateSpeedStreaks(world: WorldState): void {
    const boostKind = world.player.energy.boostMode.kind;
    const targetOpacity = boostKind === 'boosting' ? 0.38 : boostKind === 'drifting' ? 0.28 : 0;
    streakMat.opacity += (targetOpacity - streakMat.opacity) * 0.2;
    speedStreaks.visible = streakMat.opacity > 0.01;
    if (!speedStreaks.visible) {
      return;
    }
    streakMat.color.setHex(boostKind === 'drifting' ? 0x5dffdb : 0xa6e8ff);
    const posAttr = streakGeo.getAttribute('position') as THREE.BufferAttribute;
    const travel = (world.tick * 5.2) % 90;
    const length = boostKind === 'boosting' ? 13 : 7;
    for (let i = 0; i < streakCount; i += 1) {
      const base = streakBase[i];
      if (base === undefined) {
        continue;
      }
      let z = base.z + travel;
      if (z > -4) {
        z -= 90;
      }
      posAttr.setXYZ(i * 2, base.x, base.y, z);
      posAttr.setXYZ(i * 2 + 1, base.x, base.y, z - length);
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
        trail = createTrail(0x5dffb3, 30, 0.55);
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
          trail = createTrail(0xffaa55, 22, 0.85);
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
          exp.tint === 'crimson' ? 0xff4560 : exp.tint === 'emerald' ? 0x6bffb8 : 0xffb84d;
        const sphereMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.94,
        });
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xfff3d4,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.88,
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
            color: i % 2 === 0 ? color : 0xffe8b0,
            transparent: true,
            opacity: 0.95,
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
      (entry.sphere.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t);

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

  function render(world: WorldState): void {
    const tickReset = world.tick < lastTick;
    const tickAdvanced = world.tick > lastTick;
    lastTick = world.tick;
    if (tickReset) {
      clearTrail(playerLeftTrail);
      clearTrail(playerRightTrail);
      clearTrail(wingmateTrail);
      for (const trail of enemyTrails.values()) {
        clearTrail(trail);
      }
    }

    const player = world.player;
    setPose(playerRig.root, player.position, player.orientation);
    setPose(wingmateRig.root, world.wingmate.position, world.wingmate.orientation);
    setPose(carrierMesh, world.friendlyCarrier.position, world.friendlyCarrier.orientation);
    setPose(frigateRig.root, world.hostileFrigate.position, world.hostileFrigate.orientation);

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
        if (subsys.id === 'sub-shield-dome') {
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

    const boostKind = player.energy.boostMode.kind;
    const flicker = 0.92 + ((world.tick * 13) % 7) * 0.03;
    const plumeScale =
      (boostKind === 'boosting' ? 2.25 : boostKind === 'drifting' ? 1.5 : 0.95) * flicker;
    for (const plume of playerRig.plumes) {
      plume.scale.set(1, 1, plumeScale);
    }

    const targetFov = boostKind === 'boosting' ? 82 : boostKind === 'drifting' ? 76 : 68;
    if (Math.abs(camera.fov - targetFov) > 0.1) {
      camera.fov += (targetFov - camera.fov) * 0.16;
      camera.updateProjectionMatrix();
    }

    const isCockpit = world.cameraMode === 'cockpit';
    cockpitRig.root.visible = isCockpit;
    playerRig.root.visible = !isCockpit;
    playerLeftTrail.line.visible = !isCockpit;
    playerRightTrail.line.visible = !isCockpit;

    const fwd = forwardOf(player.orientation);
    const up = upOf(player.orientation);
    const right = rightOf(player.orientation);

    if (tickAdvanced) {
      const tipLeft = add(add(player.position, scale(right, -6.8)), scale(fwd, -1.5));
      const tipRight = add(add(player.position, scale(right, 6.8)), scale(fwd, -1.5));
      pushTrailPoint(playerLeftTrail, tipLeft);
      pushTrailPoint(playerRightTrail, tipRight);
      pushTrailPoint(
        wingmateTrail,
        add(world.wingmate.position, scale(forwardOf(world.wingmate.orientation), -4)),
      );
    }

    if (isCockpit) {
      const eyePos = add(add(player.position, scale(up, 1.35)), scale(fwd, 1.8));
      camera.position.set(eyePos.x, eyePos.y, eyePos.z);
      camera.quaternion.set(
        player.orientation.x,
        player.orientation.y,
        player.orientation.z,
        player.orientation.w,
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

      const firingGlow = player.recoilKick > 0.5;
      cockpitRig.muzzleLeft.visible = firingGlow;
      cockpitRig.muzzleRight.visible = firingGlow;
      cockpitRig.muzzleLeft.rotation.z = world.tick * 0.9;
      cockpitRig.muzzleRight.rotation.z = -world.tick * 0.9;
      cockpitRig.flashLight.intensity = firingGlow ? 1.8 : 0;
    } else {
      const chaseDist = boostKind === 'boosting' ? 27 : 23;
      const chasePos = add(
        add(player.position, scale(fwd, -chaseDist)),
        add(scale(up, 9.4), scale(right, -player.angularVelocity.y * 1.3)),
      );
      const lookPos = add(player.position, scale(fwd, 36));
      camera.position.set(chasePos.x, chasePos.y, chasePos.z);
      scratchUp.set(up.x, up.y, up.z);
      camera.up.copy(scratchUp);
      camera.lookAt(lookPos.x, lookPos.y, lookPos.z);
    }

    backdrop.position.copy(camera.position);
    updateDustField(player.position);
    updateSpeedStreaks(world);
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
