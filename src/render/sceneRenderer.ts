import * as THREE from 'three';
import { add, forwardOf, rightOf, scale, upOf } from '../sim/math';
import type { Quat, Vec3, WorldState } from '../sim/types';
import {
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

function setPose(obj: THREE.Object3D, pos: Vec3, quat: Quat): void {
  obj.position.set(pos.x, pos.y, pos.z);
  obj.quaternion.set(quat.x, quat.y, quat.z, quat.w);
}

export function createSceneRenderer(canvas: HTMLCanvasElement): SceneRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.25, 12000);
  scene.add(camera);

  const sunLight = new THREE.DirectionalLight(0xffbe88, 2.5);
  sunLight.position.set(580, 240, -780);
  scene.add(sunLight);

  const rimLight = new THREE.DirectionalLight(0x7d94ff, 1.05);
  rimLight.position.set(-420, -180, 520);
  scene.add(rimLight);

  const ambientLight = new THREE.HemisphereLight(0x9473a6, 0x261a2e, 0.85);
  scene.add(ambientLight);

  const dotTexture = createSoftDotTexture();
  const backdrop = buildOrbitalBackdrop(dotTexture);
  scene.add(backdrop);

  const cockpitRig: CockpitRig = buildCockpitRig();
  camera.add(cockpitRig.root);

  const playerRig: FighterMeshRig = buildPlayerFighterMesh(0xe07b2f);
  scene.add(playerRig.root);

  const wingmateRig: FighterMeshRig = buildPlayerFighterMesh(0x4bc5e8);
  scene.add(wingmateRig.root);

  const carrierMesh = buildFriendlyCarrierMesh();
  scene.add(carrierMesh);

  const frigateRig: HostileFrigateRig = buildHostileFrigateMesh();
  scene.add(frigateRig.root);

  const enemyMeshes = new Map<string, THREE.Group>();
  const projectileMeshes = new Map<string, THREE.Mesh>();
  const explosionMeshes = new Map<string, { sphere: THREE.Mesh; ring: THREE.Mesh }>();

  const boltGeo = new THREE.BoxGeometry(0.42, 0.42, 12);
  const missileGeo = new THREE.ConeGeometry(0.65, 5.5, 5);
  missileGeo.rotateX(-Math.PI / 2);
  const friendlyBoltMat = new THREE.MeshBasicMaterial({ color: 0xffd273 });
  const hostileBoltMat = new THREE.MeshBasicMaterial({ color: 0x4dff9e });
  const missileMat = new THREE.MeshBasicMaterial({ color: 0xff6e40 });

  const explosionGeo = new THREE.IcosahedronGeometry(1, 1);
  const ringGeo = new THREE.RingGeometry(0.85, 1.08, 18);

  const dustCount = 190;
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
    color: 0xffdfb8,
    map: dotTexture,
    size: 1.4,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });
  const dustPoints = new THREE.Points(dustGeo, dustMat);
  scene.add(dustPoints);

  const streakCount = 48;
  const streakBase: { x: number; y: number; z: number }[] = [];
  const streakVertices = new Float32Array(streakCount * 6);
  for (let i = 0; i < streakCount; i += 1) {
    const angle = (i / streakCount) * Math.PI * 2;
    const radius = 14 + (i % 5) * 4.5;
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
  const destroyedSubMat = new THREE.MeshStandardMaterial({
    color: 0x1b1921,
    roughness: 0.95,
    flatShading: true,
  });
  const initialSubMaterials = new Map<string, THREE.Material>();
  for (const [id, mesh] of frigateRig.subsystemMeshes) {
    if (!Array.isArray(mesh.material)) {
      initialSubMaterials.set(id, mesh.material);
    }
  }

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
    const targetOpacity = boostKind === 'boosting' ? 0.34 : boostKind === 'drifting' ? 0.22 : 0;
    streakMat.opacity += (targetOpacity - streakMat.opacity) * 0.18;
    speedStreaks.visible = streakMat.opacity > 0.01;
    if (!speedStreaks.visible) {
      return;
    }
    const posAttr = streakGeo.getAttribute('position') as THREE.BufferAttribute;
    const travel = (world.tick * 4.8) % 90;
    const length = boostKind === 'boosting' ? 11 : 6;
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

  function syncEnemies(world: WorldState): void {
    const activeIds = new Set<string>();
    for (const enemy of world.enemies) {
      activeIds.add(enemy.id);
      let mesh = enemyMeshes.get(enemy.id);
      if (mesh === undefined) {
        mesh = buildEnemyMesh(enemy.kind);
        enemyMeshes.set(enemy.id, mesh);
        scene.add(mesh);
      }
      setPose(mesh, enemy.position, enemy.orientation);
    }
    for (const [id, mesh] of enemyMeshes) {
      if (!activeIds.has(id)) {
        scene.remove(mesh);
        enemyMeshes.delete(id);
      }
    }
  }

  function syncProjectiles(world: WorldState): void {
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
    }
    for (const [id, mesh] of projectileMeshes) {
      if (!activeIds.has(id)) {
        scene.remove(mesh);
        projectileMeshes.delete(id);
      }
    }
  }

  function syncExplosions(world: WorldState): void {
    const activeIds = new Set<string>();
    for (const exp of world.explosions) {
      activeIds.add(exp.id);
      let entry = explosionMeshes.get(exp.id);
      if (entry === undefined) {
        const color =
          exp.tint === 'crimson' ? 0xff4560 : exp.tint === 'emerald' ? 0x6bffb8 : 0xffb347;
        const sphereMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.9,
        });
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xfff0cc,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.85,
        });
        const sphere = new THREE.Mesh(explosionGeo, sphereMat);
        const ring = new THREE.Mesh(ringGeo, ringMat);
        scene.add(sphere);
        scene.add(ring);
        entry = { sphere, ring };
        explosionMeshes.set(exp.id, entry);
      }
      const t = exp.elapsed / Math.max(exp.duration, 0.01);
      const scaleRadius = Math.max(0.5, exp.radius * (0.25 + t * 0.95));
      entry.sphere.position.set(exp.position.x, exp.position.y, exp.position.z);
      entry.sphere.scale.setScalar(scaleRadius * (1 - t * 0.3));
      (entry.sphere.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t);

      entry.ring.position.set(exp.position.x, exp.position.y, exp.position.z);
      entry.ring.scale.setScalar(scaleRadius * 1.45);
      entry.ring.lookAt(camera.position);
      (entry.ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (1 - t) * 0.85);
    }
    for (const [id, entry] of explosionMeshes) {
      if (!activeIds.has(id)) {
        scene.remove(entry.sphere);
        scene.remove(entry.ring);
        (entry.sphere.material as THREE.Material).dispose();
        (entry.ring.material as THREE.Material).dispose();
        explosionMeshes.delete(id);
      }
    }
  }

  function render(world: WorldState): void {
    const player = world.player;
    setPose(playerRig.root, player.position, player.orientation);
    setPose(wingmateRig.root, world.wingmate.position, world.wingmate.orientation);
    setPose(carrierMesh, world.friendlyCarrier.position, world.friendlyCarrier.orientation);
    setPose(frigateRig.root, world.hostileFrigate.position, world.hostileFrigate.orientation);

    for (const subsys of world.hostileFrigate.subsystems) {
      const mesh = frigateRig.subsystemMeshes.get(subsys.id);
      if (mesh === undefined) {
        continue;
      }
      if (subsys.hull <= 0) {
        mesh.material = destroyedSubMat;
        mesh.scale.setScalar(0.55);
      } else {
        const originalMat = initialSubMaterials.get(subsys.id);
        if (originalMat !== undefined && mesh.material !== originalMat) {
          mesh.material = originalMat;
        }
        mesh.scale.setScalar(1);
      }
    }

    const boostKind = player.energy.boostMode.kind;
    const plumeScale = boostKind === 'boosting' ? 2.15 : boostKind === 'drifting' ? 1.45 : 0.92;
    for (const plume of playerRig.plumes) {
      plume.scale.set(1, 1, plumeScale);
    }

    const targetFov = boostKind === 'boosting' ? 80 : boostKind === 'drifting' ? 75 : 68;
    if (Math.abs(camera.fov - targetFov) > 0.1) {
      camera.fov += (targetFov - camera.fov) * 0.14;
      camera.updateProjectionMatrix();
    }

    const isCockpit = world.cameraMode === 'cockpit';
    cockpitRig.root.visible = isCockpit;
    playerRig.root.visible = !isCockpit;

    const fwd = forwardOf(player.orientation);
    const up = upOf(player.orientation);
    const right = rightOf(player.orientation);

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
        -player.angularVelocity.x * 0.026,
        player.recoilKick * 0.04,
      );
      cockpitRig.root.rotation.set(
        player.angularVelocity.x * 0.022,
        player.angularVelocity.y * 0.022,
        player.angularVelocity.z * 0.03,
      );
      const firingGlow = player.recoilKick > 0.5;
      cockpitRig.muzzleLeft.visible = firingGlow;
      cockpitRig.muzzleRight.visible = firingGlow;
      cockpitRig.muzzleLeft.rotation.z = world.tick * 0.9;
      cockpitRig.muzzleRight.rotation.z = -world.tick * 0.9;
      cockpitRig.flashLight.intensity = firingGlow ? 1.6 : 0;
    } else {
      const chasePos = add(
        add(player.position, scale(fwd, -26)),
        add(scale(up, 7.5), scale(right, -player.angularVelocity.y * 1.4)),
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
    syncEnemies(world);
    syncProjectiles(world);
    syncExplosions(world);

    camera.updateMatrixWorld();
    renderer.render(scene, camera);
  }

  function resize(width: number, height: number): void {
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    camera.aspect = safeWidth / safeHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(safeWidth, safeHeight, false);
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
    renderer.dispose();
  }

  return {
    render,
    resize,
    projectWorldPoint,
    destroy,
  };
}
