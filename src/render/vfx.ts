import * as THREE from 'three';
import { FIXED_DT, type Vec3 } from '../sim/types';
import { CEL_STEP_GLSL } from './celMaterial';
import { SCENE_PALETTE } from './palette';

export interface FxBatch {
  readonly mesh: THREE.Mesh;
  readonly begin: () => void;
  /** One instance; values follow the batch's attribute layout in order. */
  readonly push: (...values: number[]) => void;
  readonly end: () => void;
}

// Immediate-mode instancing: the renderer rewrites every instance each frame straight from world state,
// so there is no per-entity mesh to create, track or dispose.
function createFxBatch(
  base: THREE.BufferGeometry,
  material: THREE.ShaderMaterial,
  capacity: number,
  layout: readonly (readonly [name: string, size: number])[],
): FxBatch {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  for (const [name, attribute] of Object.entries(base.attributes)) {
    geometry.setAttribute(name, attribute);
  }
  const attributes = layout.map(([name, size]) => {
    const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attribute);
    return attribute;
  });
  geometry.instanceCount = 0;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  let count = 0;

  return {
    mesh,
    begin: () => {
      count = 0;
    },
    push: (...values) => {
      if (count >= capacity) return;
      let cursor = 0;
      for (const attribute of attributes) {
        for (let i = 0; i < attribute.itemSize; i += 1) {
          attribute.array[count * attribute.itemSize + i] = values[cursor] ?? 0;
          cursor += 1;
        }
      }
      count += 1;
    },
    end: () => {
      geometry.instanceCount = count;
      mesh.visible = count > 0;
      if (count > 0) {
        for (const attribute of attributes) attribute.needsUpdate = true;
      }
    },
  };
}

function fxMaterial(vertexShader: string, fragmentShader: string, side: THREE.Side = THREE.FrontSide): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    side,
    transparent: true,
    depthWrite: false,
  });
}

/**
 * Bolts and exhaust flames as view-aligned capsules: a white-hot core in a flat coloured sheath.
 * Layout: aHead xyz, aTail xyz, aTint rgb + half-width in metres.
 * Width is clamped to a band of view angle, so a bolt leaving the muzzle beside the camera stays a thin lance
 * and a bolt 500 m out stays wider than a pixel.
 */
export function createBoltBatch(capacity = 256): FxBatch {
  const quad = new THREE.PlaneGeometry(1, 1);
  const material = fxMaterial(
    `
    attribute vec3 aHead;
    attribute vec3 aTail;
    attribute vec4 aTint;
    varying vec2 vCapsule;
    varying float vSpan;
    varying float vNear;
    varying vec3 vTint;

    void main() {
      vec3 head = (viewMatrix * vec4(aHead, 1.0)).xyz;
      vec3 tail = (viewMatrix * vec4(aTail, 1.0)).xyz;
      vec3 ray = normalize(mix(tail, head, 0.5));
      vec3 axis = head - tail;
      vec3 across = cross(axis, ray);
      float acrossLength = length(across);
      across = acrossLength > 1e-5 ? across / acrossLength : vec3(1.0, 0.0, 0.0);
      vec3 along = cross(ray, across);

      float end = position.y + 0.5;
      vec3 p = mix(tail, head, end);
      float dist = length(p);
      float halfWidth = clamp(aTint.w, dist * 0.0024, dist * 0.009);
      p += across * (position.x * 2.0 * halfWidth) + along * ((end * 2.0 - 1.0) * halfWidth);

      vSpan = acrossLength / halfWidth;
      vCapsule = vec2(position.x * 2.0, end * (vSpan + 2.0) - 1.0);
      vNear = dist;
      vTint = aTint.rgb;
      gl_Position = projectionMatrix * vec4(p, 1.0);
    }
    `,
    `
    varying vec2 vCapsule;
    varying float vSpan;
    varying float vNear;
    varying vec3 vTint;

    void main() {
      float onAxis = clamp(vCapsule.y, 0.0, vSpan);
      float taper = mix(0.22, 1.0, pow(onAxis / max(vSpan, 1e-3), 0.55));
      float d = length(vec2(vCapsule.x, vCapsule.y - onAxis)) / taper;
      float aa = fwidth(d);
      float sheath = 1.0 - smoothstep(1.0 - aa, 1.0, d);
      float core = 1.0 - smoothstep(0.44 - aa, 0.44 + aa, d);
      vec3 color = mix(vTint, vec3(3.4, 3.3, 3.0), core);
      gl_FragColor = vec4(color, sheath * smoothstep(0.35, 1.3, vNear));
    }
    `,
    THREE.DoubleSide,
  );
  const batch = createFxBatch(quad, material, capacity, [['aHead', 3], ['aTail', 3], ['aTint', 4]]);
  batch.mesh.renderOrder = 3;
  return batch;
}

const VALUE_NOISE_GLSL = `
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float valueNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
`;

const BLAST_LAYOUT = [['aCenter', 4], ['aFx', 2], ['aTint', 3]] as const;

/**
 * Fireballs as flat-banded shells: white-hot heart, faction-coloured body, dark smoke lip.
 * They burn away along a hard noise threshold instead of fading. Layout: aCenter xyz + radius, aFx progress + seed, aTint rgb.
 */
export function createBlastShellBatch(capacity = 64): FxBatch {
  const material = fxMaterial(
    `
    attribute vec4 aCenter;
    attribute vec2 aFx;
    attribute vec3 aTint;
    varying vec3 vDir;
    varying vec3 vViewNormal;
    varying vec3 vViewPosition;
    varying vec2 vFx;
    varying vec3 vTint;
    ${VALUE_NOISE_GLSL}

    void main() {
      float grow = mix(0.3, 1.0, 1.0 - pow(1.0 - aFx.x, 3.0));
      float lump = 0.8 + 0.4 * valueNoise(position * 1.7 + aFx.y * 13.0);
      // A blast never grows past a fixed share of its distance to the camera, so a point-blank kill cannot swallow the view.
      float radius = min(aCenter.w * grow, length((viewMatrix * vec4(aCenter.xyz, 1.0)).xyz) * 0.42) * lump;
      vec4 view = viewMatrix * vec4(aCenter.xyz + position * radius, 1.0);
      vDir = position;
      vViewNormal = mat3(viewMatrix) * position;
      vViewPosition = view.xyz;
      vFx = aFx;
      vTint = aTint;
      gl_Position = projectionMatrix * view;
    }
    `,
    `
    varying vec3 vDir;
    varying vec3 vViewNormal;
    varying vec3 vViewPosition;
    varying vec2 vFx;
    varying vec3 vTint;
    ${CEL_STEP_GLSL}
    ${VALUE_NOISE_GLSL}

    void main() {
      float t = vFx.x;
      float facing = max(dot(normalize(vViewNormal), normalize(-vViewPosition)), 0.0);
      float puff = valueNoise(vDir * 2.6 + vFx.y * 31.0) * 0.65 + valueNoise(vDir * 5.8 - vFx.y * 17.0) * 0.35;
      float body = puff * 0.75 + facing * 0.45;
      float alive = celStep(mix(0.08, 1.12, t * t), body);
      float heat = (puff * 1.05 + facing * 0.3) * (1.3 - t * 1.15);
      vec3 color = vTint * vec3(0.16, 0.12, 0.2) + vec3(0.03, 0.025, 0.06);
      color = mix(color, vTint * 2.1, celStep(0.34, heat));
      color = mix(color, vec3(3.3, 3.0, 2.5), celStep(0.74, heat));
      gl_FragColor = vec4(color, alive);
    }
    `,
  );
  const batch = createFxBatch(new THREE.IcosahedronGeometry(1, 3), material, capacity, BLAST_LAYOUT);
  batch.mesh.renderOrder = 1;
  return batch;
}

/** Camera-facing shock rings with hard inner and outer edges; they thin out to nothing rather than fade. Same layout as shells. */
export function createShockRingBatch(capacity = 64): FxBatch {
  const material = fxMaterial(
    `
    attribute vec4 aCenter;
    attribute vec2 aFx;
    attribute vec3 aTint;
    varying vec2 vDisc;
    varying float vProgress;
    varying float vReach;
    varying vec3 vTint;

    void main() {
      vec4 view = viewMatrix * vec4(aCenter.xyz, 1.0);
      // Distance to the blast in ring radii: a ring sweeping over the camera thins out and fades instead of filling the view.
      vReach = length(view.xyz) / aCenter.w;
      view.xy += position.xy * (aCenter.w * 2.0);
      vDisc = position.xy * 2.0;
      vProgress = aFx.x;
      vTint = aTint;
      gl_Position = projectionMatrix * view;
    }
    `,
    `
    varying vec2 vDisc;
    varying float vProgress;
    varying float vReach;
    varying vec3 vTint;
    ${CEL_STEP_GLSL}

    void main() {
      float r = length(vDisc);
      float front = mix(0.14, 0.97, 1.0 - pow(1.0 - vProgress, 4.0));
      float thickness = min(mix(0.13, 0.0, vProgress), vReach * 0.03);
      float band = celStep(front - thickness, r) * (1.0 - celStep(front, r));
      gl_FragColor = vec4(mix(vTint, vec3(1.0), 0.45) * 2.6, band * smoothstep(0.35, 1.1, vReach));
    }
    `,
    THREE.DoubleSide,
  );
  const batch = createFxBatch(new THREE.PlaneGeometry(1, 1), material, capacity, BLAST_LAYOUT);
  batch.mesh.renderOrder = 2;
  return batch;
}

function createGeodesicGeometry(radius: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(radius, 1);
  const position = geometry.getAttribute('position');
  const bary = new Float32Array(position.count * 3);
  const centroid = new Float32Array(position.count * 3);
  for (let tri = 0; tri < position.count; tri += 3) {
    const cx = (position.getX(tri) + position.getX(tri + 1) + position.getX(tri + 2)) / 3;
    const cy = (position.getY(tri) + position.getY(tri + 1) + position.getY(tri + 2)) / 3;
    const cz = (position.getZ(tri) + position.getZ(tri + 1) + position.getZ(tri + 2)) / 3;
    for (let corner = 0; corner < 3; corner += 1) {
      const i = (tri + corner) * 3;
      bary[i + corner] = 1;
      centroid[i] = cx;
      centroid[i + 1] = cy;
      centroid[i + 2] = cz;
    }
  }
  geometry.setAttribute('aBary', new THREE.BufferAttribute(bary, 3));
  geometry.setAttribute('aCentroid', new THREE.BufferAttribute(centroid, 3));
  return geometry;
}

// Lattice lines hold a constant pixel width, so the geodesic pattern survives at combat range.
const LATTICE_GLSL = `
float lattice(vec3 bary, float pixels) {
  float edge = min(bary.x, min(bary.y, bary.z));
  float w = fwidth(edge);
  return 1.0 - smoothstep(w * pixels, w * (pixels + 1.0), edge);
}
`;

/**
 * Shield collapse: every geodesic facet breaks off, tumbles outward and winks out on its own clock.
 * Same layout as shells; aCenter.w is the dome radius the shards start from.
 */
export function createShieldShatterBatch(capacity = 12): FxBatch {
  const material = fxMaterial(
    `
    attribute vec3 aBary;
    attribute vec3 aCentroid;
    attribute vec4 aCenter;
    attribute vec2 aFx;
    attribute vec3 aTint;
    varying vec3 vBary;
    varying vec2 vShard;
    varying vec3 vTint;

    void main() {
      float t = aFx.x;
      float seed = fract(sin(dot(aCentroid, vec3(12.9898, 78.233, 37.719)) + aFx.y) * 43758.5453);
      vec3 out3 = normalize(aCentroid);
      vec3 hinge = normalize(cross(out3, vec3(0.31, 0.9, 0.3)));
      vec3 local = (position - aCentroid) * (1.0 - t * (0.35 + 0.4 * seed));
      float angle = t * (2.0 + seed * 6.0);
      local = local * cos(angle) + cross(hinge, local) * sin(angle) + hinge * dot(hinge, local) * (1.0 - cos(angle));
      float fly = 1.0 + (1.0 - pow(1.0 - t, 2.5)) * (0.7 + seed * 1.1);
      vec3 world = aCenter.xyz + (aCentroid * fly + local) * aCenter.w;
      vBary = aBary;
      vShard = vec2(t, seed);
      vTint = aTint;
      gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
    }
    `,
    `
    varying vec3 vBary;
    varying vec2 vShard;
    varying vec3 vTint;
    ${CEL_STEP_GLSL}
    ${LATTICE_GLSL}

    void main() {
      float rim = lattice(vBary, 1.4);
      float flash = 1.0 - celStep(0.14, vShard.x);
      vec3 color = mix(vTint * 1.5, vec3(2.6, 3.2, 3.4), max(rim, flash));
      float alive = 1.0 - celStep(0.42 + 0.55 * vShard.y, vShard.x);
      gl_FragColor = vec4(color, alive * mix(0.62, 1.0, max(rim, flash)));
    }
    `,
    THREE.DoubleSide,
  );
  const batch = createFxBatch(createGeodesicGeometry(1), material, capacity, BLAST_LAYOUT);
  batch.mesh.renderOrder = 2;
  return batch;
}

export interface ShieldBubble {
  readonly mesh: THREE.Mesh;
  readonly flash: THREE.IUniform<number>;
}

/** Hit-flare dome around a shielded enemy: geodesic lattice, hard fresnel ring, faint fill. Hidden until `flash` rises. */
export function createShieldBubble(radius: number): ShieldBubble {
  const flash = { value: 0 };
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uFlash: flash,
      uFill: { value: new THREE.Color(SCENE_PALETTE.enemyShield).multiplyScalar(1.5) },
      uEdge: { value: new THREE.Color(SCENE_PALETTE.enemyShieldEdge).multiplyScalar(2.6) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec3 aBary;
      varying vec3 vBary;
      varying vec3 vNormal;
      varying vec3 vViewPosition;

      void main() {
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        vBary = aBary;
        vNormal = normalMatrix * normalize(position);
        vViewPosition = view.xyz;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: `
      uniform float uFlash;
      uniform vec3 uFill;
      uniform vec3 uEdge;
      varying vec3 vBary;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      ${CEL_STEP_GLSL}
      ${LATTICE_GLSL}

      void main() {
        float fresnel = 1.0 - max(dot(normalize(vNormal), normalize(-vViewPosition)), 0.0);
        float ring = celStep(0.6, fresnel);
        float wire = lattice(vBary, 1.1);
        float line = max(ring, wire);
        gl_FragColor = vec4(mix(uFill * 0.22, uEdge, line) * uFlash, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(createGeodesicGeometry(radius), material);
  mesh.visible = false;
  return { mesh, flash };
}

export interface HeatVents {
  readonly plumes: readonly THREE.Mesh[];
  readonly time: THREE.IUniform<number>;
  readonly heat: THREE.IUniform<number>;
}

const WISPS_PER_PLUME = 3;

/** Vent plumes for a locked-out gun: thin ribbons that curl upward and taper to a point. One plume per barrel tip. */
export function createHeatVents(sides: readonly (-1 | 1)[]): HeatVents {
  const time = { value: 0 };
  const heat = { value: 0 };
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: time,
      uHeat: heat,
      uWarm: { value: new THREE.Color(SCENE_PALETTE.heatWisp) },
      uCool: { value: new THREE.Color(SCENE_PALETTE.heatWispCool) },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: `
      attribute vec2 aWisp;
      uniform float uTime;
      varying vec2 vRibbon;
      varying float vLife;

      void main() {
        float life = fract(uTime * 0.55 + aWisp.x);
        float along = position.y + 0.5;
        float lift = life * 0.2 + along * (0.07 + life * 0.13);
        float sway = sin(along * 4.6 + uTime * 3.4 + aWisp.x * 19.0) * 0.022 * (0.25 + along);
        float width = 0.03 * pow(sin(along * 3.14159), 0.7) * sin(life * 3.14159);
        vec3 p = vec3(
          aWisp.y * (0.015 + lift * 0.28) + sway + position.x * 2.0 * width,
          0.03 + lift,
          lift * 0.5
        );
        vRibbon = vec2(position.x * 2.0, along);
        vLife = life;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uHeat;
      uniform vec3 uWarm;
      uniform vec3 uCool;
      varying vec2 vRibbon;
      varying float vLife;
      ${CEL_STEP_GLSL}

      void main() {
        float across = 1.0 - abs(vRibbon.x);
        float body = celStep(0.1, across);
        vec3 color = mix(uCool, uWarm, celStep(0.5, across) * (1.0 - celStep(0.55, vLife)));
        gl_FragColor = vec4(color, body * (0.5 + 0.35 * uHeat));
      }
    `,
  });
  const ribbon = new THREE.PlaneGeometry(1, 1, 1, 10);
  const plumes = sides.map((side) => {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = ribbon.index;
    geometry.setAttribute('position', ribbon.getAttribute('position'));
    const wisps = new Float32Array(WISPS_PER_PLUME * 2);
    for (let i = 0; i < WISPS_PER_PLUME; i += 1) {
      wisps[i * 2] = i / WISPS_PER_PLUME + (side > 0 ? 0.17 : 0);
      wisps[i * 2 + 1] = side * (0.6 + 0.4 * i);
    }
    geometry.setAttribute('aWisp', new THREE.InstancedBufferAttribute(wisps, 2));
    geometry.instanceCount = WISPS_PER_PLUME;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    return mesh;
  });
  return { plumes, time, heat };
}

export interface SparkPool {
  readonly mesh: THREE.InstancedMesh;
  readonly emit: (origin: Vec3, tick: number, tint: number, speed: number, size: number, lifetime: number, drift?: Vec3) => void;
  readonly burst: (origin: Vec3, tick: number, tint: number, radius: number, drift?: Vec3) => void;
  /** Shard width is capped as a view angle from `eye`, so one flying past the canopy never fills the view. */
  readonly update: (tick: number, eye: THREE.Vector3) => void;
  readonly clear: () => void;
}

const SPARK_MAX_VIEW_ANGLE = 0.02;

export function createSparkPool(): SparkPool {
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

  function update(tick: number, eye: THREE.Vector3): void {
    let count = 0;
    for (let i = 0; i < capacity; i++) {
      const spark = slots[i];
      if (spark === undefined) continue;
      const age = (tick - spark.born) * FIXED_DT;
      if (age < 0 || age >= spark.lifetime) continue;
      pose.position.copy(spark.origin).addScaledVector(spark.velocity, age);
      const fade = 1 - age / spark.lifetime;
      const size = fade * Math.min(1, (pose.position.distanceTo(eye) * SPARK_MAX_VIEW_ANGLE) / spark.width);
      pose.quaternion.copy(spark.rotation);
      pose.scale.set(spark.width * size, spark.width * size, spark.length * size);
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
