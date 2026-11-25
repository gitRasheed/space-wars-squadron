import * as THREE from 'three';
import { CEL_SHADING, RIM_PALETTE, SUN_DIRECTION } from './palette';

export function glslVec3(values: readonly [number, number, number]): string {
  return `vec3(${values.map((v) => v.toFixed(4)).join(', ')})`;
}

function glslDirection(x: number, y: number, z: number): string {
  const length = Math.hypot(x, y, z);
  return glslVec3([x / length, y / length, z / length]);
}

const SUN_GLSL = glslDirection(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z);
// Skylight arrives from above on the side away from the sun.
const BOUNCE_GLSL = glslDirection(-SUN_DIRECTION.x, 0.6, -SUN_DIRECTION.z);

// A band edge widened by one pixel of its own gradient: crisp, but it never crawls.
export const CEL_STEP_GLSL = `
float celStep(float edge, float value) {
  float w = fwidth(value) * 0.75 + 0.0015;
  return smoothstep(edge - w, edge + w, value);
}
`;

const CEL_VERTEX = `
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vSunView;
varying vec3 vBounceView;
varying vec3 vLocal;
varying vec3 vLocalNormal;
varying vec2 vUv;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = -mvPosition.xyz;
  vNormal = normalMatrix * normal;
  vSunView = (viewMatrix * vec4(${SUN_GLSL}, 0.0)).xyz;
  vBounceView = (viewMatrix * vec4(${BOUNCE_GLSL}, 0.0)).xyz;
  vLocal = position;
  vLocalNormal = normal;
  vUv = uv;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const CEL_FRAGMENT = `
uniform vec3 uAlbedo;
uniform vec3 uEmissive;
uniform float uEmissiveIntensity;
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform float uPanelSize;
uniform float uGloss;
#ifdef USE_MAP
uniform sampler2D uMap;
#endif
#ifdef USE_MUZZLE_FLASH
uniform float uMuzzleFlash;
#endif

varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vSunView;
varying vec3 vBounceView;
varying vec3 vLocal;
varying vec3 vLocalNormal;
varying vec2 vUv;

${CEL_STEP_GLSL}

float plateHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float plateTone(vec2 cell) {
  return floor(plateHash(cell) * 3.0);
}

// Staggered armor plates projected along the dominant local axis, so untextured parts get seams without UVs.
vec3 plating() {
  vec3 an = abs(vLocalNormal);
  vec2 p = an.x >= an.y && an.x >= an.z ? vLocal.zy : (an.y >= an.z ? vLocal.zx : vLocal.xy);
  p /= uPanelSize * vec2(2.4, 1.0);
  vec2 fw = fwidth(p);
  float fade = 1.0 - smoothstep(0.04, 0.16, max(fw.x, fw.y));
  if (fade <= 0.0) return vec3(1.0);
  p.x += plateHash(vec2(floor(p.y), 7.0));
  vec2 cell = floor(p);
  vec2 f = fract(p);
  float tone = plateTone(cell);
  vec2 width = vec2(0.008, 0.02);
  vec2 aa = fw * 1.5;
  float seam = 1.0 - smoothstep(width.y, width.y + aa.y, min(f.y, 1.0 - f.y));
  // A butt joint only shows where neighbouring plates differ in tone, so equal neighbours merge into long strakes.
  float jointEdge = min(f.x, 1.0 - f.x);
  if (jointEdge < width.x + aa.x) {
    float neighbour = plateTone(cell + vec2(f.x < 0.5 ? -1.0 : 1.0, 0.0));
    seam = max(seam, step(0.5, abs(tone - neighbour)) * (1.0 - smoothstep(width.x, width.x + aa.x, jointEdge)));
  }
  float lip = (1.0 - smoothstep(width.y * 2.8, width.y * 2.8 + aa.y, 1.0 - f.y)) * (1.0 - seam);
  vec3 plate = vec3(0.96 + 0.035 * tone);
  plate = mix(plate, vec3(1.14), lip * 0.5);
  plate = mix(plate, vec3(0.46, 0.48, 0.6), seam * 0.7);
  return mix(vec3(1.0), plate, fade);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vViewPosition);
  vec3 sun = normalize(vSunView);

  vec3 albedo = uAlbedo;
  #ifdef USE_MAP
  albedo *= texture2D(uMap, vUv).rgb;
  #endif
  vec3 plate = uPanelSize > 0.0 ? plating() : vec3(1.0);
  albedo *= plate;

  float ndl = dot(n, sun);
  vec3 band = mix(${glslVec3(CEL_SHADING.shadow)}, ${glslVec3(CEL_SHADING.bounce)}, celStep(${CEL_SHADING.bounceEdge.toFixed(3)}, dot(n, normalize(vBounceView))));
  band = mix(band, ${glslVec3(CEL_SHADING.base)}, celStep(${CEL_SHADING.shadowEdge.toFixed(3)}, ndl));
  band = mix(band, ${glslVec3(CEL_SHADING.highlight)}, celStep(${CEL_SHADING.highlightEdge.toFixed(3)}, ndl));
  vec3 color = albedo * band;

  float rim = celStep(${CEL_SHADING.rimEdge.toFixed(3)}, 1.0 - max(dot(n, v), 0.0));
  color += uRimColor * (rim * uRimStrength);

  float glint = celStep(0.5, pow(max(dot(n, normalize(sun + v)), 0.0), 40.0));
  color += ${glslVec3(CEL_SHADING.glint)} * (glint * uGloss) * (0.3 + 0.7 * albedo);

  #ifdef USE_MUZZLE_FLASH
  // The cockpit rides the camera, so the flash sits at a fixed view-space point between the gun tips.
  vec3 toFlash = vec3(0.0, -0.2, -1.9) + vViewPosition;
  float reach = dot(n, normalize(toFlash)) / (1.0 + dot(toFlash, toFlash) * 0.35);
  color += albedo * ${glslVec3(CEL_SHADING.muzzleFlash)} * (uMuzzleFlash * (celStep(0.08, reach) * 0.55 + celStep(0.3, reach) * 0.45));
  #endif

  color += uEmissive * uEmissiveIntensity * plate;

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface CelOptions {
  readonly map?: THREE.Texture | undefined;
  readonly emissive?: number;
  readonly emissiveIntensity?: number;
  readonly rimColor?: number;
  readonly rimStrength?: number;
  /** Armor plate height in local units; 0 leaves the albedo flat. */
  readonly panel?: number;
  readonly gloss?: number;
  /** Shared uniform driving the cockpit's stepped muzzle-flash light. */
  readonly muzzleFlash?: THREE.IUniform<number>;
}

export interface CelMaterial extends THREE.ShaderMaterial {
  readonly uniforms: {
    readonly uEmissiveIntensity: THREE.IUniform<number>;
    readonly [name: string]: THREE.IUniform;
  };
}

/** The one material every lit hull, rock and cockpit part uses: three bands, a stepped rim, a hard glint. */
export function celMat(color: number, options: CelOptions = {}): CelMaterial {
  const defines: Record<string, string> = {};
  const uniforms: Record<string, THREE.IUniform> = {
    uAlbedo: { value: new THREE.Color(color) },
    uEmissive: { value: new THREE.Color(options.emissive ?? 0x000000) },
    uEmissiveIntensity: { value: options.emissiveIntensity ?? 0 },
    uRimColor: { value: new THREE.Color(options.rimColor ?? RIM_PALETTE.neutral) },
    uRimStrength: { value: options.rimStrength ?? 0.18 },
    uPanelSize: { value: options.panel ?? 0 },
    uGloss: { value: options.gloss ?? 0.1 },
  };
  if (options.map !== undefined) {
    defines.USE_MAP = '';
    uniforms.uMap = { value: options.map };
  }
  if (options.muzzleFlash !== undefined) {
    defines.USE_MUZZLE_FLASH = '';
    uniforms.uMuzzleFlash = options.muzzleFlash;
  }
  return new THREE.ShaderMaterial({
    defines,
    uniforms,
    vertexShader: CEL_VERTEX,
    fragmentShader: CEL_FRAGMENT,
  }) as CelMaterial;
}
