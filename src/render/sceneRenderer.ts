import * as THREE from 'three';
import { COMBAT_TUNING } from '../sim/combat';
import { add, forwardOf, scale } from '../sim/math';
import { FIXED_DT, type ExplosionState, type Quat, type Vec3, type WorldState } from '../sim/types';
import { FRIGATE_SUBSYSTEM_LAYOUT } from '../sim/world';
import { computeCameraPose } from './cameraPose';
import { celMat } from './celMaterial';
import {
  buildAsteroidMesh,
  buildCockpitRig,
  buildEnemyMesh,
  buildFriendlyCarrierMesh,
  buildHostileFrigateMesh,
  buildMissileMesh,
  buildOrbitalBackdrop,
  buildPlayerFighterMesh,
  createSoftDotTexture,
  ENEMY_SHIELD_BUBBLE,
  gaugeNeedleAngle,
  type CockpitRig,
  type FighterMeshRig,
  type HostileFrigateRig,
} from './models';
import { SCENE_PALETTE } from './palette';
import { CAMERA_CLIP, createStylizedPostPass } from './postProcess';
import { createHullTextureSet } from './textures';
import {
  createBlastShellBatch,
  createBoltBatch,
  createShieldShatterBatch,
  createShockRingBatch,
  createSparkPool,
} from './vfx';

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

interface EnemyVisual {
  readonly root: THREE.Group;
  readonly shield: THREE.Mesh | null;
  readonly shieldFlash: THREE.IUniform<number> | null;
  readonly trail: TrailLine;
}

interface MissileVisual {
  readonly root: THREE.Group;
  readonly trail: TrailLine;
}

const BOLT_LENGTH = 15;
// A cyan blast this large is a shield collapsing, not a shield hit.
const SHIELD_BREAK_RADIUS = 14;

const BOLT_TINTS = {
  friendly: new THREE.Color(SCENE_PALETTE.friendlyBolt).multiplyScalar(2.1),
  hostile: new THREE.Color(SCENE_PALETTE.hostileBolt).multiplyScalar(2.1),
  flame: new THREE.Color(SCENE_PALETTE.missileTrail).multiplyScalar(2.2),
} as const;

const BLAST_TINTS: Record<ExplosionState['tint'], THREE.Color> = {
  amber: new THREE.Color(SCENE_PALETTE.explosionAmber),
  emerald: new THREE.Color(SCENE_PALETTE.explosionEmerald),
  crimson: new THREE.Color(SCENE_PALETTE.explosionCrimson),
  cyan: new THREE.Color(SCENE_PALETTE.enemyShield),
};

function seedFromId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (Math.imul(hash, 31) + id.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) % 1024) / 1024;
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

function disposeObject3D(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  root.traverse((node) => {
    if (
      node instanceof THREE.Mesh ||
      node instanceof THREE.Line ||
      node instanceof THREE.LineSegments ||
      node instanceof THREE.Points
    ) {
      geometries.add(node.geometry as THREE.BufferGeometry);
      const mat = node.material as THREE.Material | THREE.Material[];
      for (const item of Array.isArray(mat) ? mat : [mat]) {
        materials.add(item);
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

  const dotTexture = createSoftDotTexture();
  const backdrop = buildOrbitalBackdrop(dotTexture, renderer);
  scene.add(backdrop);

  const cockpitRig: CockpitRig = buildCockpitRig();
  camera.add(cockpitRig.root);

  const wingmateRig: FighterMeshRig = buildPlayerFighterMesh(SCENE_PALETTE.wingmateStripe, textures);
  scene.add(wingmateRig.root);

  const carrierMesh = buildFriendlyCarrierMesh(textures);
  scene.add(carrierMesh);

  const frigateRig: HostileFrigateRig = buildHostileFrigateMesh(textures);
  scene.add(frigateRig.root);

  const asteroidMeshes = new Map<string, THREE.Group>();
  const enemyVisuals = new Map<string, EnemyVisual>();
  const missileVisuals = new Map<string, MissileVisual>();
  const burstExplosions = new Set<string>();

  const wingmateTrail = createTrail(SCENE_PALETTE.wingmateTrail, 34, 0.65);
  scene.add(wingmateTrail.line);

  const bolts = createBoltBatch();
  const blastShells = createBlastShellBatch();
  const shockRings = createShockRingBatch();
  const shieldShatters = createShieldShatterBatch();
  const sparks = createSparkPool();
  scene.add(bolts.mesh, blastShells.mesh, shockRings.mesh, shieldShatters.mesh, sparks.mesh);

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
  const scratchTail = new THREE.Vector3();
  const muzzleTipLeft = new THREE.Vector3();
  const muzzleTipRight = new THREE.Vector3();
  const exhaustVelocity = new THREE.Vector3();
  const scratchVelCam = new THREE.Vector3();
  const scratchCamInv = new THREE.Quaternion();
  const scratchRight = new THREE.Vector3();
  const scratchCamUp = new THREE.Vector3();
  const destroyedSubMat = celMat(SCENE_PALETTE.destroyedSubsystem);
  const initialSubMaterials = new Map<string, THREE.Material>();
  for (const [id, mesh] of frigateRig.subsystemMeshes) {
    if (!Array.isArray(mesh.material)) {
      initialSubMaterials.set(id, mesh.material);
    }
  }

  let lastTick = -1;
  let lastRenderTimeMs = 0;
  let shakeIntensity = 0;
  const charmSwing = { x: 0, z: 0, vx: 0, vz: 0 };

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
        disposeObject3D(mesh);
        asteroidMeshes.delete(id);
      }
    }
  }

  function disposeTrail(trail: TrailLine): void {
    scene.remove(trail.line);
    trail.line.geometry.dispose();
    (trail.line.material as THREE.Material).dispose();
  }

  function syncEnemies(world: WorldState, tickAdvanced: boolean): void {
    const activeIds = new Set<string>();
    for (const enemy of world.enemies) {
      activeIds.add(enemy.id);
      let visual = enemyVisuals.get(enemy.id);
      if (visual === undefined) {
        const root = buildEnemyMesh(enemy.kind, textures);
        const bubble = root.getObjectByName(ENEMY_SHIELD_BUBBLE);
        const shield: THREE.Mesh | null = bubble instanceof THREE.Mesh ? bubble : null;
        const shieldMat = shield?.material;
        visual = {
          root,
          shield,
          shieldFlash: shieldMat instanceof THREE.ShaderMaterial
            ? ((shieldMat.uniforms.uFlash as THREE.IUniform<number> | undefined) ?? null)
            : null,
          trail: createTrail(SCENE_PALETTE.enemyTrail, 30, 0.55),
        };
        enemyVisuals.set(enemy.id, visual);
        scene.add(root, visual.trail.line);
      }
      setPose(visual.root, enemy.position, enemy.orientation);

      if (visual.shield !== null && visual.shieldFlash !== null) {
        const flash = enemy.shieldHitFlash;
        visual.shield.visible = flash > 0.02;
        visual.shield.rotation.y = world.tick * 0.06;
        visual.shield.scale.setScalar(1 + (1 - flash) * 0.08);
        visual.shieldFlash.value = flash;
      }

      if (tickAdvanced) {
        pushTrailPoint(visual.trail, add(enemy.position, scale(forwardOf(enemy.orientation), -3.2)));
      }
    }
    for (const [id, visual] of enemyVisuals) {
      if (!activeIds.has(id)) {
        scene.remove(visual.root);
        disposeObject3D(visual.root);
        disposeTrail(visual.trail);
        enemyVisuals.delete(id);
      }
    }
  }

  function syncProjectiles(world: WorldState, tickAdvanced: boolean, emitExhaust: boolean): void {
    cockpitRig.muzzleLeft.getWorldPosition(muzzleTipLeft);
    cockpitRig.muzzleRight.getWorldPosition(muzzleTipRight);
    const flameFlicker = 0.8 + ((world.tick * 7) % 5) * 0.09;
    const activeMissiles = new Set<string>();
    bolts.begin();
    for (const proj of world.projectiles) {
      const { x, y, z } = proj.position;
      scratchDir.set(proj.velocity.x, proj.velocity.y, proj.velocity.z).normalize();

      if (proj.kind === 'bolt') {
        const reach = BOLT_LENGTH * 0.5;
        scratchTail.set(x, y, z).addScaledVector(scratchDir, -reach);
        // For its first two ticks a player bolt keeps its tail on the visible gun tip,
        // so the shot erupts out of the barrel with no air gap.
        if (proj.owner === 'player' && COMBAT_TUNING.boltTtl - proj.ttl <= FIXED_DT * 2.2) {
          scratchVec.set(x, y, z);
          scratchTail.copy(
            scratchVec.distanceToSquared(muzzleTipLeft) < scratchVec.distanceToSquared(muzzleTipRight)
              ? muzzleTipLeft
              : muzzleTipRight,
          );
        }
        const tint = proj.faction === 'friendly' ? BOLT_TINTS.friendly : BOLT_TINTS.hostile;
        bolts.push(
          x + scratchDir.x * reach, y + scratchDir.y * reach, z + scratchDir.z * reach,
          scratchTail.x, scratchTail.y, scratchTail.z,
          tint.r, tint.g, tint.b, proj.faction === 'friendly' ? 0.24 : 0.3,
        );
        continue;
      }

      activeMissiles.add(proj.id);
      let visual = missileVisuals.get(proj.id);
      if (visual === undefined) {
        visual = { root: buildMissileMesh(), trail: createTrail(SCENE_PALETTE.missileTrail, 22, 0.85) };
        missileVisuals.set(proj.id, visual);
        scene.add(visual.root, visual.trail.line);
      }
      visual.root.position.set(x, y, z);
      // lookAt aims +Z at its target; the missile's nose is -Z like every ship, so aim behind it.
      visual.root.lookAt(x - scratchDir.x, y - scratchDir.y, z - scratchDir.z);
      // It leaves the rail small and grows over the first tenth of a second, clear of the canopy.
      const age = COMBAT_TUNING.missileTtl - proj.ttl;
      visual.root.scale.setScalar(THREE.MathUtils.lerp(0.35, 1.5, THREE.MathUtils.smoothstep(age, 0, 0.18)));

      const nozzle = 1.3 * visual.root.scale.x;
      const flame = (1.3 + 3.2 * flameFlicker) * visual.root.scale.x;
      scratchTail.set(x, y, z).addScaledVector(scratchDir, -nozzle);
      bolts.push(
        scratchTail.x, scratchTail.y, scratchTail.z,
        scratchTail.x - scratchDir.x * flame, scratchTail.y - scratchDir.y * flame, scratchTail.z - scratchDir.z * flame,
        BOLT_TINTS.flame.r, BOLT_TINTS.flame.g, BOLT_TINTS.flame.b, 0.24 * visual.root.scale.x,
      );
      // Trail and exhaust shards wait until the missile is clear of the canopy:
      // a shard beside the camera fills a quarter of the view, and a trail from the rail cuts across it.
      const clear = age > 0.2;
      if (tickAdvanced && clear) {
        pushTrailPoint(visual.trail, proj.position);
      }
      if (emitExhaust && clear) {
        exhaustVelocity.copy(proj.velocity).multiplyScalar(0.55);
        sparks.emit(scratchTail, world.tick, SCENE_PALETTE.missileTrail, 4, 0.16, 0.38, exhaustVelocity);
      }
    }
    bolts.end();

    for (const [id, visual] of missileVisuals) {
      if (!activeMissiles.has(id)) {
        scene.remove(visual.root);
        disposeObject3D(visual.root);
        disposeTrail(visual.trail);
        missileVisuals.delete(id);
      }
    }
  }

  function syncExplosions(world: WorldState): void {
    blastShells.begin();
    shockRings.begin();
    shieldShatters.begin();
    for (const exp of world.explosions) {
      const { x, y, z } = exp.position;
      const tint = BLAST_TINTS[exp.tint];
      const t = THREE.MathUtils.clamp(exp.elapsed / Math.max(exp.duration, 0.01), 0, 1);
      const seed = seedFromId(exp.id);
      if (!burstExplosions.has(exp.id)) {
        burstExplosions.add(exp.id);
        // Sparks start when the blast did, even if this frame skipped ticks.
        sparks.burst(exp.position, world.tick - exp.elapsed / FIXED_DT, tint.getHex(), exp.radius);
      }

      if (exp.tint === 'cyan' && exp.radius >= SHIELD_BREAK_RADIUS) {
        shieldShatters.push(x, y, z, exp.radius * 0.52, t, seed, tint.r, tint.g, tint.b);
        shockRings.push(x, y, z, exp.radius * 1.2, t, seed, tint.r, tint.g, tint.b);
        continue;
      }
      blastShells.push(x, y, z, exp.radius, t, seed, tint.r, tint.g, tint.b);
      if (exp.radius > 15) {
        // Kills get a second, later-blooming lobe so the fireball is not one clean ball.
        const late = THREE.MathUtils.clamp(t * 1.3 - 0.14, 0, 1);
        const lobe = exp.radius * 0.34;
        blastShells.push(
          x + (seed - 0.5) * lobe, y + lobe * 0.8, z + (0.5 - seed) * lobe,
          exp.radius * 0.66, late, seed + 0.37, tint.r, tint.g, tint.b,
        );
      }
      shockRings.push(x, y, z, exp.radius * 1.35, t, seed, tint.r, tint.g, tint.b);
    }
    blastShells.end();
    shockRings.end();
    shieldShatters.end();

    if (burstExplosions.size > world.explosions.length) {
      const active = new Set(world.explosions.map((exp) => exp.id));
      for (const id of burstExplosions) {
        if (!active.has(id)) burstExplosions.delete(id);
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

  function updateCockpit(world: WorldState, dt: number): void {
    const player = world.player;
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
    cockpitRig.throttleHandle.position.z = player.energy.overdrive
      ? -0.98
      : -0.82 - Math.min(player.throttle, 1) * 0.12;

    // Reciprocating left/right gun barrels kick visibly back-and-forth on each alternating shot.
    cockpitRig.barrelLeft.position.z = player.recoilLeft * 0.28;
    cockpitRig.barrelRight.position.z = player.recoilRight * 0.28;

    const leftFlash = player.recoilLeft > 0.52;
    const rightFlash = player.recoilRight > 0.52;
    cockpitRig.muzzleLeft.visible = leftFlash;
    cockpitRig.muzzleRight.visible = rightFlash;
    cockpitRig.muzzleLeft.rotation.z = world.tick * 0.9;
    cockpitRig.muzzleRight.rotation.z = -world.tick * 0.9;
    cockpitRig.muzzleFlash.value = leftFlash || rightFlash ? 1 : 0;

    // Diegetic overheat feedback: gun tips glow cherry-hot as heat builds and vent curling plumes on lockout.
    const heat = 1 - Math.min(1, Math.max(0, player.energy.weaponCharge / 100));
    const overheated = player.energy.weaponState === 'overheated';
    const heatPulse = overheated ? 0.85 + 0.15 * Math.sin(world.tick * 0.35) : 1;
    cockpitRig.barrelHeatMat.uniforms.uEmissiveIntensity.value = overheated
      ? (1.1 + heat * 1.4) * heatPulse
      : heat > 0.35
        ? (heat - 0.35) * 1.35
        : 0;
    cockpitRig.heatVents.time.value = world.tick * FIXED_DT;
    cockpitRig.heatVents.heat.value = heat;
    for (const plume of cockpitRig.heatVents.plumes) {
      plume.visible = overheated;
    }

    cockpitRig.throttleNeedle.rotation.z = gaugeNeedleAngle(player.throttle / 1.2);
    cockpitRig.heatNeedle.rotation.z = gaugeNeedleAngle(heat);

    // Underdamped pendulum driven by yaw, roll and recoil.
    const swingTargetZ = THREE.MathUtils.clamp(player.angularVelocity.y * 0.5 + player.angularVelocity.z * 0.35, -0.9, 0.9);
    const swingTargetX = THREE.MathUtils.clamp(player.angularVelocity.x * 0.5 - player.recoilKick * 0.4, -0.9, 0.9);
    charmSwing.vz += ((swingTargetZ - charmSwing.z) * 46 - charmSwing.vz * 2.6) * dt;
    charmSwing.vx += ((swingTargetX - charmSwing.x) * 46 - charmSwing.vx * 2.6) * dt;
    charmSwing.z += charmSwing.vz * dt;
    charmSwing.x += charmSwing.vx * dt;
    cockpitRig.charm.rotation.set(charmSwing.x, 0, charmSwing.z);
  }

  function updateCamera(world: WorldState, dt: number): void {
    const pose = computeCameraPose(world.player, world.cameraMode);
    if (Math.abs(camera.fov - pose.targetFov) > 0.05) {
      const fovAlpha = 1 - Math.exp(-10 * dt);
      camera.fov += (pose.targetFov - camera.fov) * fovAlpha;
      camera.updateProjectionMatrix();
    }

    camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    if (pose.orientation !== null) {
      camera.quaternion.set(
        pose.orientation.x,
        pose.orientation.y,
        pose.orientation.z,
        pose.orientation.w,
      );
      updateCockpit(world, dt);
    }

    if (shakeIntensity > 0.005) {
      const amp = shakeIntensity * 0.14;
      const phase = world.tick * 1.73;
      scratchRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      scratchCamUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
      camera.position.addScaledVector(scratchRight, Math.sin(phase * 3.1) * amp);
      camera.position.addScaledVector(scratchCamUp, Math.cos(phase * 4.3) * amp);
    }
    camera.updateMatrixWorld();
  }

  // Sparks spit from the dash and ride along with the ship.
  function emitDamageSparks(world: WorldState): void {
    scratchVec.set(0, -0.55, -1.5).applyMatrix4(camera.matrixWorld);
    for (let i = 0; i < 12; i += 1) {
      sparks.emit(
        scratchVec, world.tick, i % 3 === 0 ? SCENE_PALETTE.explosionShardHighlight : SCENE_PALETTE.explosionCrimson,
        0.8 + Math.random() * 1.4, 0.01 + Math.random() * 0.01, 0.25 + Math.random() * 0.3, world.player.velocity,
      );
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
      burstExplosions.clear();
      shakeIntensity = 0;
      clearTrail(wingmateTrail);
      for (const visual of enemyVisuals.values()) {
        clearTrail(visual.trail);
      }
    }

    let playerHit = false;
    if (tickAdvanced) {
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
    }
    shakeIntensity *= Math.exp(-10 * dt);
    if (shakeIntensity < 0.004) {
      shakeIntensity = 0;
    }

    setPose(wingmateRig.root, world.wingmate.position, world.wingmate.orientation);
    setPose(carrierMesh, world.friendlyCarrier.position, world.friendlyCarrier.orientation);
    setPose(frigateRig.root, world.hostileFrigate.position, world.hostileFrigate.orientation);
    syncSubsystems(world);

    const plumeFlicker = 0.85 * (0.92 + ((world.tick * 13) % 7) * 0.03);
    for (const plume of wingmateRig.plumes) {
      plume.scale.set(1, 1, plumeFlicker);
    }
    if (tickAdvanced) {
      pushTrailPoint(
        wingmateTrail,
        add(world.wingmate.position, scale(forwardOf(world.wingmate.orientation), -4)),
      );
    }

    updateCamera(world, dt);
    if (playerHit) {
      emitDamageSparks(world);
    }
    backdrop.position.copy(camera.position);
    updateDustField(player.position);
    updateSpeedStreaks(world, dt);
    syncAsteroids(world);
    syncEnemies(world, tickAdvanced);
    syncProjectiles(world, tickAdvanced, emitExhaust);
    syncExplosions(world);
    if (tickAdvanced || tickReset) sparks.update(world.tick, camera.position);

    postPass.render(renderer, scene, camera);
  }

  function resize(width: number, height: number): void {
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    camera.aspect = safeWidth / safeHeight;
    camera.updateProjectionMatrix();
    postPass.resize(safeWidth, safeHeight);
    const internal = postPass.size();
    renderer.setSize(internal.width, internal.height, false);
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
    disposeObject3D(scene);
    destroyedSubMat.dispose();
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
