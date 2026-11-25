import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectGlbSource } from './glbHeader.js';
import {
  bundleBrowserEntry,
  DEFAULT_TIMEOUT_MS,
  validateTimeout,
  WEBGL_SWIFTSHADER_FLAGS,
  withHarnessPage,
  withTimeout,
} from './harness.js';
import type { AssetMetrics, CaptureSettings, GlbSourceInfo, StyleCard, ViewMetrics } from './types.js';

export { DEFAULT_TIMEOUT_MS };

export const DEFAULT_CAPTURE: CaptureSettings = {
  tileWidth: 420,
  tileHeight: 315,
  zoom: 1,
  zoomOrtho: false,
  lighting: 'studio',
};

export interface BrowserSessionOptions {
  readonly assetPath: string;
  readonly card: StyleCard | null;
  readonly renderSheet: boolean;
  readonly timeoutMs?: number;
  readonly contactSheetPath?: string;
  readonly capture?: CaptureSettings;
  /** Directory for one PNG per view (`<view-id>.png`); omit to skip. */
  readonly viewsDir?: string;
  /** Black-on-white ortho-top and ortho-front mask sheet; omit to skip. */
  readonly silhouetteSheetPath?: string;
}

export interface BrowserSessionResult {
  readonly metrics: AssetMetrics;
  readonly views: readonly ViewMetrics[];
  readonly consoleErrors: readonly string[];
  readonly viewPaths: readonly string[];
}

function buildRuntimeEntrySource(factoryImportPath: string | null): string {
  const importLine =
    factoryImportPath !== null
      ? `import * as UserFactory from ${JSON.stringify(factoryImportPath)};`
      : `const UserFactory = null;`;

  return `
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { deltaE76, hexSrgbToLinearRgb, linearRgbToLabD65, linearRgbToHexSrgb } from './color.js';
import { DEFAULT_SHADER_COLOR_UNIFORMS } from './evaluate.js';
${importLine}

const MAX_REPORTED_COLORS = 48;
const MAX_SHAPE_POINTS = 60000;

function axisVec(name, fallback) {
  switch (name) {
    case '+X': return new THREE.Vector3(1, 0, 0);
    case '-X': return new THREE.Vector3(-1, 0, 0);
    case '+Y': return new THREE.Vector3(0, 1, 0);
    case '-Y': return new THREE.Vector3(0, -1, 0);
    case '+Z': return new THREE.Vector3(0, 0, 1);
    case '-Z': return new THREE.Vector3(0, 0, -1);
    default: return fallback.clone();
  }
}

function isObjectVisibleInHierarchy(obj) {
  let cur = obj;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

// Mirrors WebGLRenderer: InstancedMesh.count wins; otherwise instanceCount is clamped by the instanced
// attributes the shader reads, and an unclamped Infinity reaches GL as 0 instances.
function drawnInstances(mesh, spans) {
  if (mesh.isInstancedMesh) return mesh.count;
  const geo = mesh.geometry;
  if (!geo.isInstancedBufferGeometry) return 1;
  const read = new Set();
  for (const s of spans) {
    if (typeof s.material.vertexShader === 'string') for (const id of s.material.vertexShader.split(/[^A-Za-z0-9_]+/)) read.add(id);
  }
  let max = Infinity;
  for (const [name, attr] of Object.entries(geo.attributes)) {
    const data = attr.isInterleavedBufferAttribute ? attr.data : attr;
    if (!attr.isInstancedBufferAttribute && !data.isInstancedInterleavedBuffer) continue;
    if (!read.has(name)) continue;
    max = Math.min(max, data.meshPerAttribute * data.count);
  }
  const n = Math.min(geo.instanceCount, max);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function activeSpansForMesh(mesh) {
  const geo = mesh.geometry;
  const pos = geo && geo.getAttribute('position');
  if (!pos) return [];
  const idx = geo.index;
  const total = idx ? idx.count : pos.count;
  const drStart = Math.max(0, geo.drawRange.start);
  const drEnd = Math.min(total, drStart + geo.drawRange.count);
  if (drEnd - drStart < 3) return [];

  const spans = [];
  if (Array.isArray(mesh.material)) {
    const groups = geo.groups || [];
    for (const g of groups) {
      const start = Math.max(drStart, g.start);
      const end = Math.min(drEnd, g.start + g.count);
      if (end - start < 3) continue;
      const mat = mesh.material[g.materialIndex];
      if (!mat || mat.visible === false) continue;
      const triCount = Math.floor((end - start) / 3);
      if (triCount <= 0) continue;
      spans.push({ start, end: start + triCount * 3, triCount, material: mat });
    }
    return spans;
  }

  const mat = mesh.material;
  if (!mat || mat.visible === false) return [];
  const triCount = Math.floor((drEnd - drStart) / 3);
  if (triCount <= 0) return [];
  spans.push({ start: drStart, end: drStart + triCount * 3, triCount, material: mat });
  return spans;
}

function collectTexturesFromUniformValue(val, outSet, seen) {
  if (!val || typeof val !== 'object' || seen.has(val)) return;
  if (val.isTexture) {
    outSet.add(val);
    return;
  }
  if (
    val.isObject3D ||
    val.isMaterial ||
    val.isBufferGeometry ||
    val.isVector2 ||
    val.isVector3 ||
    val.isVector4 ||
    val.isMatrix3 ||
    val.isMatrix4 ||
    val.isColor
  ) {
    return;
  }
  seen.add(val);
  if (Array.isArray(val)) {
    for (const item of val) {
      collectTexturesFromUniformValue(item, outSet, seen);
    }
    return;
  }
  if (Object.getPrototypeOf(val) === Object.prototype) {
    for (const nested of Object.values(val)) {
      collectTexturesFromUniformValue(nested, outSet, seen);
    }
  }
}

function collectMaterialTextures(mat, outSet) {
  for (const val of Object.values(mat)) {
    if (val && typeof val === 'object' && val.isTexture) {
      outSet.add(val);
    }
  }
  if (mat.uniforms && typeof mat.uniforms === 'object') {
    const seen = new Set();
    for (const uniform of Object.values(mat.uniforms)) {
      if (uniform && typeof uniform === 'object' && 'value' in uniform) {
        collectTexturesFromUniformValue(uniform.value, outSet, seen);
      }
    }
  }
}

function materialHasUniformTexture(mat) {
  if (!mat.uniforms || typeof mat.uniforms !== 'object') return false;
  const found = new Set();
  const seen = new Set();
  for (const uniform of Object.values(mat.uniforms)) {
    if (uniform && typeof uniform === 'object' && 'value' in uniform) {
      collectTexturesFromUniformValue(uniform.value, found, seen);
      if (found.size > 0) return true;
    }
  }
  return false;
}

const DEFAULT_SHADER_EMISSIVE_UNIFORMS = ['uEmissive', 'uEmissiveIntensity'];

// Uniform values are linear like Material.color; a Vector3 is read as linear rgb.
function uniformRgb(mat, name) {
  const v = mat.uniforms[name]?.value;
  if (v?.isColor) return v.clone();
  if (v?.isVector3) return new THREE.Color(v.x, v.y, v.z);
  return null;
}

function shaderUniformColors(mat, card) {
  if (!mat.uniforms || typeof mat.uniforms !== 'object') return null;
  let base = null;
  for (const name of (card && card.shaderColorUniforms) || DEFAULT_SHADER_COLOR_UNIFORMS) {
    base = uniformRgb(mat, name);
    if (base) break;
  }
  if (!base) return null;
  const [colorName, intensityName] = (card && card.shaderEmissiveUniforms) || DEFAULT_SHADER_EMISSIVE_UNIFORMS;
  const emission = uniformRgb(mat, colorName);
  const intensity = mat.uniforms[intensityName]?.value;
  if (emission && typeof intensity === 'number') emission.multiplyScalar(intensity);
  return { base, emission };
}

function inspectRoot(root, inputKind, glbSource, card) {
  root.updateMatrixWorld(true);

  const uniqueGeos = new Set();
  const effectiveMaterials = new Set();
  const effectiveTextures = new Set();
  const activeMeshEntries = [];
  let hiddenMeshCount = 0;
  let trianglesByOccurrence = 0;
  let lineSegmentsCount = 0;
  let lineVerticesCount = 0;

  const worldBox = new THREE.Box3();
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const instMat = new THREE.Matrix4();
  const combinedMat = new THREE.Matrix4();
  const instColor = new THREE.Color();

  root.traverse((obj) => {
    if (obj.isLineSegments || obj.isLine) {
      if (isObjectVisibleInHierarchy(obj)) {
        lineSegmentsCount += 1;
        const pos = obj.geometry && obj.geometry.getAttribute('position');
        if (pos) lineVerticesCount += pos.count;
      }
      return;
    }
    if (!obj.isMesh) return;
    if (!isObjectVisibleInHierarchy(obj)) {
      hiddenMeshCount += 1;
      return;
    }
    const spans = activeSpansForMesh(obj);
    const drawn = spans.length === 0 ? 0 : drawnInstances(obj, spans);
    if (drawn <= 0) {
      hiddenMeshCount += 1;
      return;
    }
    // Only InstancedMesh carries per-instance matrices and colors; geometry instancing places copies in the shader.
    const instances = obj.isInstancedMesh ? drawn : 1;
    activeMeshEntries.push({ mesh: obj, spans, instances });
    uniqueGeos.add(obj.geometry);
    for (const span of spans) {
      trianglesByOccurrence += span.triCount * drawn;
      effectiveMaterials.add(span.material);
      collectMaterialTextures(span.material, effectiveTextures);
    }
  });

  // Compute exact world bounds from vertices referenced by active spans only.
  const worldPoints = [];
  for (const entry of activeMeshEntries) {
    const { mesh, spans, instances } = entry;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const idx = geo.index;
    const referencedVerts = new Set();
    for (const span of spans) {
      for (let i = span.start; i < span.end; i += 1) {
        referencedVerts.add(idx ? idx.getX(i) : i);
      }
    }
    for (let inst = 0; inst < instances; inst += 1) {
      if (mesh.isInstancedMesh) {
        mesh.getMatrixAt(inst, instMat);
        combinedMat.multiplyMatrices(mesh.matrixWorld, instMat);
      } else {
        combinedMat.copy(mesh.matrixWorld);
      }
      for (const vi of referencedVerts) {
        vA.fromBufferAttribute(pos, vi).applyMatrix4(combinedMat);
        worldBox.expandByPoint(vA);
        worldPoints.push(vA.x, vA.y, vA.z);
      }
    }
  }

  let trianglesUnique = 0;
  let positionVerticesUnique = 0;
  for (const geo of uniqueGeos) {
    const pos = geo.getAttribute('position');
    const idx = geo.index;
    const total = idx ? idx.count : (pos ? pos.count : 0);
    const start = Math.max(0, geo.drawRange.start);
    const count = Math.min(total - start, geo.drawRange.count);
    trianglesUnique += Math.max(0, Math.floor(count / 3));
    if (pos) positionVerticesUnique += pos.count;
  }

  const hasBounds = !worldBox.isEmpty();
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  if (hasBounds) {
    worldBox.getSize(size);
    worldBox.getCenter(center);
  }
  const maxExtent = hasBounds ? Math.max(size.x, size.y, size.z) : 0;
  const boundingRadius = hasBounds ? size.length() * 0.5 : 0;
  // Scale-relative degeneracy floor with no artificial minimum floor so tiny valid geometry is preserved.
  const minArea = maxExtent > 0 ? Math.pow(maxExtent * 1e-6, 2) : 0;

  let degenerateTriangles = 0;
  for (const entry of activeMeshEntries) {
    const { mesh, spans, instances } = entry;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const idx = geo.index;
    for (let inst = 0; inst < instances; inst += 1) {
      if (mesh.isInstancedMesh) {
        mesh.getMatrixAt(inst, instMat);
        combinedMat.multiplyMatrices(mesh.matrixWorld, instMat);
      } else {
        combinedMat.copy(mesh.matrixWorld);
      }
      for (const span of spans) {
        for (let i = span.start; i + 2 < span.end; i += 3) {
          const i0 = idx ? idx.getX(i) : i;
          const i1 = idx ? idx.getX(i + 1) : i + 1;
          const i2 = idx ? idx.getX(i + 2) : i + 2;
          vA.fromBufferAttribute(pos, i0).applyMatrix4(combinedMat);
          vB.fromBufferAttribute(pos, i1).applyMatrix4(combinedMat);
          vC.fromBufferAttribute(pos, i2).applyMatrix4(combinedMat);
          e1.subVectors(vB, vA);
          e2.subVectors(vC, vA);
          cross.crossVectors(e1, e2);
          if (0.5 * cross.length() <= minArea) {
            degenerateTriangles += 1;
          }
        }
      }
    }
  }

  const palEntries = card && card.palette
    ? Object.entries(card.palette).map(([role, hex]) => {
        const lin = hexSrgbToLinearRgb(hex);
        return { role, hex, lab: linearRgbToLabD65(lin[0], lin[1], lin[2]) };
      })
    : [];
  const hasPalette = palEntries.length > 0;

  let assessedMeshes = 0;
  let texturedMeshes = 0;
  let shaderMeshes = 0;
  let shaderUniformMeshes = 0;
  let sampledCorners = 0;
  let maxDelta = 0;
  let worst = null;
  const colorSamples = new Map();

  const evalLinearColor = (meshName, lr, lg, lb) => {
    sampledCorners += 1;
    const hexSrgb = linearRgbToHexSrgb(lr, lg, lb);
    let entry = colorSamples.get(hexSrgb);
    if (!entry) {
      let bestRole = null;
      let bestHex = null;
      let bestD = null;
      if (hasPalette) {
        const lab = linearRgbToLabD65(lr, lg, lb);
        bestD = Infinity;
        for (const p of palEntries) {
          const d = deltaE76(lab, p.lab);
          if (d < bestD) {
            bestD = d;
            bestRole = p.role;
            bestHex = p.hex;
          }
        }
      }
      entry = { hexSrgb, samples: 0, meshes: new Set(), nearestRole: bestRole, nearestHex: bestHex, deltaE76: bestD };
      colorSamples.set(hexSrgb, entry);
    }
    entry.samples += 1;
    entry.meshes.add(meshName);
    if (entry.deltaE76 !== null && entry.deltaE76 > maxDelta) {
      maxDelta = entry.deltaE76;
      worst = {
        meshName,
        hexSrgb,
        nearestRole: entry.nearestRole,
        nearestHex: entry.nearestHex,
        deltaE76: entry.deltaE76,
      };
    }
  };

  for (const entry of activeMeshEntries) {
    const { mesh, spans, instances } = entry;
    const geo = mesh.geometry;
    const colorAttr = geo.getAttribute('color');
    const idx = geo.index;
    const meshName = mesh.name || 'unnamed';
    let meshHadTextured = false;
    let meshHadShader = false;
    let meshHadShaderUniform = false;
    let meshHadAssessed = false;

    for (const span of spans) {
      const mat = span.material;
      const emission = mat.emissive?.clone().multiplyScalar(mat.emissiveIntensity);
      const hasEmissiveTexture = mat.emissiveMap?.isTexture && emission &&
        (emission.r !== 0 || emission.g !== 0 || emission.b !== 0);
      const hasColorTexture =
        mat.map?.isTexture || hasEmissiveTexture ||
        (Boolean(mat.isShaderMaterial) && materialHasUniformTexture(mat));
      if (hasColorTexture) {
        meshHadTextured = true;
        continue;
      }
      let baseColor = mat.color;
      let addColor = emission;
      if (mat.isShaderMaterial && !mat.color) {
        const shaded = shaderUniformColors(mat, card);
        // A shader with no known color uniform computes its output in GLSL, so its authored color is unknowable here.
        if (shaded === null) {
          meshHadShader = true;
          continue;
        }
        meshHadShaderUniform = true;
        baseColor = shaded.base;
        addColor = shaded.emission;
      }
      meshHadAssessed = true;
      const matR = baseColor ? baseColor.r : 1;
      const matG = baseColor ? baseColor.g : 1;
      const matB = baseColor ? baseColor.b : 1;
      const sample = (r, g, b) => evalLinearColor(meshName,
        THREE.MathUtils.clamp(r + (addColor?.r ?? 0), 0, 1),
        THREE.MathUtils.clamp(g + (addColor?.g ?? 0), 0, 1),
        THREE.MathUtils.clamp(b + (addColor?.b ?? 0), 0, 1),
      );
      const useVertexColors = Boolean(mat.vertexColors) && Boolean(colorAttr);
      const hasInstColor = Boolean(mesh.isInstancedMesh && mesh.instanceColor);

      for (let inst = 0; inst < instances; inst += 1) {
        let ir = 1, ig = 1, ib = 1;
        if (hasInstColor) {
          mesh.getColorAt(inst, instColor);
          ir = instColor.r;
          ig = instColor.g;
          ib = instColor.b;
        }
        if (useVertexColors) {
          const seen = new Set();
          for (let i = span.start; i < span.end; i += 1) {
            const vi = idx ? idx.getX(i) : i;
            if (seen.has(vi)) continue;
            seen.add(vi);
            sample(
              matR * ir * colorAttr.getX(vi),
              matG * ig * colorAttr.getY(vi),
              matB * ib * colorAttr.getZ(vi),
            );
          }
        } else {
          sample(matR * ir, matG * ig, matB * ib);
        }
      }
    }

    if (meshHadTextured) texturedMeshes += 1;
    if (meshHadShader) shaderMeshes += 1;
    if (meshHadShaderUniform) shaderUniformMeshes += 1;
    if (meshHadAssessed) assessedMeshes += 1;
  }

  const unassessed = texturedMeshes + shaderMeshes;
  const colors = [...colorSamples.values()]
    .sort((a, b) => b.samples - a.samples || (b.deltaE76 ?? 0) - (a.deltaE76 ?? 0) || a.hexSrgb.localeCompare(b.hexSrgb))
    .slice(0, MAX_REPORTED_COLORS)
    .map((c) => ({ ...c, meshes: [...c.meshes].sort().slice(0, 4) }));
  const palette = {
    status: !hasPalette
      ? 'skipped_no_palette'
      : unassessed > 0 && assessedMeshes > 0
        ? 'partial_textured'
        : unassessed > 0
          ? 'unassessed_textured'
          : 'assessed',
    assessedMeshes,
    texturedMeshes,
    shaderMeshes,
    shaderUniformMeshes,
    sampledCorners,
    distinctColors: colorSamples.size,
    maxDeltaE76: hasPalette && sampledCorners > 0 ? maxDelta : null,
    worstViolation: worst,
    colors,
  };

  return {
    metrics: {
      inputKind,
      glbSource,
      trianglesByOccurrence,
      trianglesUnique,
      positionVerticesUnique,
      lineSegmentsCount,
      lineVerticesCount,
      effectiveMaterials: effectiveMaterials.size,
      effectiveTextures: effectiveTextures.size,
      degenerateTriangles,
      visibleMeshCount: activeMeshEntries.length,
      hiddenMeshCount,
      worldBounds: hasBounds
        ? {
            min: { x: worldBox.min.x, y: worldBox.min.y, z: worldBox.min.z },
            max: { x: worldBox.max.x, y: worldBox.max.y, z: worldBox.max.z },
            size: { x: size.x, y: size.y, z: size.z },
            center: { x: center.x, y: center.y, z: center.z },
            maxExtent,
            boundingRadius,
          }
        : null,
      palette,
      shape: hasBounds ? measureShape(worldPoints, worldBox, card) : null,
    },
    worldBox: hasBounds ? worldBox : null,
    center,
    boundingRadius,
  };
}

function axisIndex(v) {
  const ax = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  return ax[0] >= ax[1] && ax[0] >= ax[2] ? 0 : ax[1] >= ax[2] ? 1 : 2;
}

// Length runs along the card's front axis, width across it, height along +Y (or Z for a Y-facing asset).
function measureShape(points, box, card) {
  const geometry = (card && card.geometry) || {};
  const lengthAxis = axisIndex(axisVec(card && card.frontAxis, new THREE.Vector3(0, 0, 1)));
  const heightAxis = lengthAxis === 1 ? 2 : 1;
  const widthAxis = 3 - lengthAxis - heightAxis;
  const names = ['x', 'y', 'z'];
  const min = [box.min.x, box.min.y, box.min.z];
  const max = [box.max.x, box.max.y, box.max.z];
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const maxExtent = Math.max(size[0], size[1], size[2]);
  const length = size[lengthAxis];
  const width = size[widthAxis];
  const height = size[heightAxis];
  const ratio = (a, b) => (b > 0 ? a / b : null);

  const n = points.length / 3;
  const stride = Math.max(1, Math.ceil(n / MAX_SHAPE_POINTS));

  const symFraction = geometry.symmetryToleranceFraction ?? 0.01;
  const symTol = Math.max(symFraction * maxExtent, 1e-12);
  const planeCoord = (min[widthAxis] + max[widthAxis]) * 0.5;
  const cellKey = (x, y, z) => Math.floor(x / symTol) + ',' + Math.floor(y / symTol) + ',' + Math.floor(z / symTol);
  // Index every point; only the queries are strided, so a sampled vertex can always find its mirror.
  const grid = new Map();
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    const key = cellKey(points[o], points[o + 1], points[o + 2]);
    let cell = grid.get(key);
    if (!cell) {
      cell = [];
      grid.set(key, cell);
    }
    cell.push(o);
  }
  let sampled = 0;
  let matched = 0;
  const q = [0, 0, 0];
  for (let i = 0; i < n; i += stride) {
    const o = i * 3;
    q[0] = points[o];
    q[1] = points[o + 1];
    q[2] = points[o + 2];
    q[widthAxis] = 2 * planeCoord - q[widthAxis];
    sampled += 1;
    const cx = Math.floor(q[0] / symTol);
    const cy = Math.floor(q[1] / symTol);
    const cz = Math.floor(q[2] / symTol);
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx += 1) {
      for (let dy = -1; dy <= 1 && !found; dy += 1) {
        for (let dz = -1; dz <= 1 && !found; dz += 1) {
          const cell = grid.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
          if (!cell) continue;
          for (const c of cell) {
            if (Math.hypot(points[c] - q[0], points[c + 1] - q[1], points[c + 2] - q[2]) <= symTol) {
              found = true;
              break;
            }
          }
        }
      }
    }
    if (found) matched += 1;
  }

  const groundFraction = geometry.groundToleranceFraction ?? 0.01;
  const groundTol = groundFraction * maxExtent;
  let fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    if (points[o + 1] > box.min.y + groundTol) continue;
    fx0 = Math.min(fx0, points[o]);
    fx1 = Math.max(fx1, points[o]);
    fz0 = Math.min(fz0, points[o + 2]);
    fz1 = Math.max(fz1, points[o + 2]);
  }
  const groundArea = size[0] * size[2];
  const footprint = groundArea > 0 && fx1 >= fx0 ? ((fx1 - fx0) * (fz1 - fz0)) / groundArea : null;

  return {
    lengthAxis: names[lengthAxis],
    widthAxis: names[widthAxis],
    heightAxis: names[heightAxis],
    length,
    width,
    height,
    lengthToWidth: ratio(length, width),
    heightToLength: ratio(height, length),
    groundOffset: box.min.y,
    groundFootprintRatio: footprint,
    groundToleranceFraction: groundFraction,
    mirror: {
      planeAxis: names[widthAxis],
      planeCoord,
      planeOffsetFraction: maxExtent > 0 ? Math.abs(planeCoord) / maxExtent : 0,
      matchRatio: sampled > 0 ? matched / sampled : 1,
      sampledPoints: sampled,
      toleranceFraction: symFraction,
    },
  };
}

function boxCorners(box) {
  const { min, max } = box;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}

// Presets change lights and tone mapping only, so cameras, background, and gates stay comparable.
function addLightingRig(scene, preset, radius, renderer) {
  const at = (x, y, z) => new THREE.Vector3(x, y, z).multiplyScalar(radius * 4);
  const directional = (color, intensity, pos) => {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.copy(pos);
    scene.add(light);
  };
  if (preset === 'cel') {
    // Hard warm key, cool rim, and a violet-to-blue sky fill with no tone mapping, as stylized toon games light ships.
    renderer.toneMapping = THREE.NoToneMapping;
    directional(0xffdfbd, 2.4, at(0.9, 1.2, 1.1));
    directional(0x6b88ff, 1.05, at(-1.1, 0.5, -1.4));
    scene.add(new THREE.HemisphereLight(0x7c88b8, 0x1b172c, 0.78));
    return;
  }
  if (preset === 'dramatic') {
    // Low raking key from one side and a faint opposite rim leave deep form shadows.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    directional(0xffd2a0, 3.4, at(1.6, 0.35, 0.2));
    directional(0x5a78ff, 0.9, at(-1.2, 0.9, -1.0));
    scene.add(new THREE.HemisphereLight(0x5a6488, 0x0a0812, 0.25));
    return;
  }
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  directional(0xfff1dc, 2.2, at(1.2, 1.5, 1.0));
  directional(0x7ca2ff, 1.0, at(-1.3, 0.7, -1.1));
  scene.add(new THREE.HemisphereLight(0xaab8e0, 0x242038, 0.85));
}

const SILHOUETTE_VIEWS = ['ortho-top', 'ortho-front'];

function silhouetteSheet(silhouettes, tileW, tileH, labelH) {
  const canvas = document.createElement('canvas');
  canvas.width = SILHOUETTE_VIEWS.length * tileW;
  canvas.height = labelH + tileH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#d0d0d0';
  ctx.fillRect(0, 0, canvas.width, labelH);
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'left';
  SILHOUETTE_VIEWS.forEach((id, i) => {
    ctx.putImageData(silhouettes.get(id), i * tileW, labelH);
    ctx.fillText(id, i * tileW + 10, 17);
  });
  return canvas.toDataURL('image/png');
}

function renderContactSheet(root, worldBox, center, radius, card, capture) {
  const tileW = capture.tileWidth;
  const tileH = capture.tileHeight;
  const cols = 3;
  const rows = 3;
  const labelH = 26;

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(tileW, tileH, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const safeRadius = Math.max(radius, 1e-6);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x161926);
  scene.add(root);
  addLightingRig(scene, capture.lighting, safeRadius, renderer);

  const front = axisVec(card && card.frontAxis, new THREE.Vector3(0, 0, 1)).normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(worldUp, front).normalize();
  if (right.lengthSq() < 0.01) right.set(1, 0, 0);
  const topUp = axisVec(card && card.topUpAxis, front.clone().negate()).normalize();
  if (Math.abs(topUp.dot(worldUp)) > 0.999) {
    throw new Error('topUpAxis cannot be parallel to +Y/-Y for ortho-top view');
  }

  const dirFromAzEl = (azDeg, elDeg) => {
    const az = (azDeg * Math.PI) / 180;
    const el = (elDeg * Math.PI) / 180;
    const horiz = front.clone().multiplyScalar(Math.cos(az)).addScaledVector(right, Math.sin(az));
    return horiz.multiplyScalar(Math.cos(el)).addScaledVector(worldUp, Math.sin(el)).normalize();
  };

  const viewDefs = [
    { id: 'persp-front', dir: dirFromAzEl(0, 10), up: worldUp, ortho: false },
    { id: 'persp-three-quarter', dir: dirFromAzEl(38, 22), up: worldUp, ortho: false },
    { id: 'persp-right', dir: dirFromAzEl(90, 10), up: worldUp, ortho: false },
    { id: 'persp-back', dir: dirFromAzEl(180, 10), up: worldUp, ortho: false },
    { id: 'persp-left', dir: dirFromAzEl(270, 10), up: worldUp, ortho: false },
    { id: 'persp-hero-low', dir: dirFromAzEl(-36, -12), up: worldUp, ortho: false },
    { id: 'ortho-front', dir: dirFromAzEl(0, 0), up: worldUp, ortho: true },
    { id: 'ortho-right', dir: dirFromAzEl(90, 0), up: worldUp, ortho: true },
    { id: 'ortho-top', dir: new THREE.Vector3(0, 1, 0), up: topUp, ortho: true },
  ];

  const sheetCanvas = document.createElement('canvas');
  sheetCanvas.width = cols * tileW;
  sheetCanvas.height = rows * (tileH + labelH);
  const ctx = sheetCanvas.getContext('2d');
  ctx.fillStyle = '#0d101a';
  ctx.fillRect(0, 0, sheetCanvas.width, sheetCanvas.height);

  const mask = (color, side) => new THREE.MeshBasicMaterial({ color, side, toneMapped: false });
  const doubleMask = mask(0xff0000, THREE.DoubleSide);
  const frontMask = mask(0xffff00, THREE.FrontSide);
  const exemptMask = mask(0xffffff, THREE.DoubleSide);
  const gl = renderer.getContext();
  const pixelBuf = new Uint8Array(tileW * tileH * 4);
  const aspect = tileW / tileH;
  const vFovDeg = 40;
  const tanHalfV = Math.tan(((vFovDeg * Math.PI) / 180) * 0.5);
  const tanHalfH = tanHalfV * aspect;
  const corners = worldBox ? boxCorners(worldBox) : [];

  const maskObjects = [];
  root.traverseVisible((obj) => {
    if (!obj.material) return;
    const maskFor = (material, frontPass) => {
      if (!material?.visible) return material;
      if (!obj.isMesh || material.side !== THREE.FrontSide) return exemptMask;
      return frontPass ? frontMask : doubleMask;
    };
    const materialsFor = (frontPass) => Array.isArray(obj.material)
      ? obj.material.map(mat => maskFor(mat, frontPass))
      : maskFor(obj.material, frontPass);
    maskObjects.push({
      obj, original: obj.material, double: materialsFor(false), front: materialsFor(true),
      instanceColor: obj.instanceColor,
    });
  });

  const views = [];
  const viewImages = [];
  const silhouettes = new Map();

  for (let idx = 0; idx < viewDefs.length; idx += 1) {
    const def = viewDefs[idx];
    const camZ = def.dir.clone().normalize();
    const camX = new THREE.Vector3().crossVectors(def.up, camZ).normalize();
    const camY = new THREE.Vector3().crossVectors(camZ, camX).normalize();

    let maxX = safeRadius;
    let maxY = safeRadius;
    let maxZ = safeRadius;
    if (corners.length > 0) {
      maxX = 0;
      maxY = 0;
      maxZ = 0;
      for (const c of corners) {
        const rel = c.clone().sub(center);
        maxX = Math.max(maxX, Math.abs(rel.dot(camX)));
        maxY = Math.max(maxY, Math.abs(rel.dot(camY)));
        maxZ = Math.max(maxZ, Math.abs(rel.dot(camZ)));
      }
      maxX = Math.max(maxX, safeRadius * 0.05);
      maxY = Math.max(maxY, safeRadius * 0.05);
      maxZ = Math.max(maxZ, safeRadius * 0.05);
    }

    const pad = 1.24;
    let cam;
    if (def.ortho) {
      const halfH = Math.max(maxY, maxX / aspect) * pad;
      const halfW = halfH * aspect;
      const dist = maxZ * 3 + safeRadius;
      cam = new THREE.OrthographicCamera(
        -halfW,
        halfW,
        halfH,
        -halfH,
        Math.max(dist - maxZ * 2.5, safeRadius * 1e-4),
        dist + maxZ * 3,
      );
      cam.position.copy(center).addScaledVector(camZ, dist);
    } else {
      const distH = (maxX * pad) / tanHalfH;
      const distV = (maxY * pad) / tanHalfV;
      const dist = Math.max(distH, distV) + maxZ * 1.15;
      const near = Math.max((dist - maxZ * 1.4) * 0.25, safeRadius * 1e-4);
      const far = dist + maxZ * 3 + safeRadius;
      cam = new THREE.PerspectiveCamera(vFovDeg, aspect, near, far);
      cam.position.copy(center).addScaledVector(camZ, dist);
    }

    const viewZoom = def.ortho && !capture.zoomOrtho ? 1 : capture.zoom;
    cam.zoom = viewZoom;
    cam.updateProjectionMatrix();
    cam.up.copy(def.up);
    cam.lookAt(center);
    cam.updateMatrixWorld();

    scene.background = new THREE.Color(0x161926);
    renderer.render(scene, cam);
    gl.readPixels(0, 0, tileW, tileH, gl.RGBA, gl.UNSIGNED_BYTE, pixelBuf);
    const beautyBuckets = new Set();
    for (let p = 0; p < pixelBuf.length; p += 16) {
      beautyBuckets.add(((pixelBuf[p] >> 4) << 8) | ((pixelBuf[p + 1] >> 4) << 4) | (pixelBuf[p + 2] >> 4));
    }

    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const dx = col * tileW;
    const dy = row * (tileH + labelH);
    ctx.drawImage(renderer.domElement, dx, dy + labelH);
    if (capture.saveViews) viewImages.push({ id: def.id, dataUrl: renderer.domElement.toDataURL('image/png') });

    ctx.fillStyle = '#0b0e18';
    ctx.fillRect(dx, dy, tileW, labelH);
    ctx.strokeStyle = '#2d354f';
    ctx.lineWidth = 1;
    ctx.strokeRect(dx + 0.5, dy + 0.5, tileW - 1, tileH + labelH - 1);
    ctx.font = 'bold 13px monospace';
    ctx.fillStyle = '#f4b459';
    ctx.textAlign = 'left';
    ctx.fillText(def.id, dx + 10, dy + 17);

    try {
      for (const item of maskObjects) {
        item.obj.material = item.double;
        if (item.instanceColor) item.obj.instanceColor = null;
      }
      scene.background = new THREE.Color(0x000000);
      renderer.render(scene, cam);

      // Preserve nearest-surface depth so an inside-out shell cannot fill its mask with far faces.
      scene.background = null;
      renderer.autoClear = false;
      for (const item of maskObjects) item.obj.material = item.front;
      renderer.render(scene, cam);
    } finally {
      renderer.autoClear = true;
      for (const item of maskObjects) {
        item.obj.material = item.original;
        if (item.instanceColor) item.obj.instanceColor = item.instanceColor;
      }
    }

    gl.readPixels(0, 0, tileW, tileH, gl.RGBA, gl.UNSIGNED_BYTE, pixelBuf);
    let covered = 0;
    let frontSidePixels = 0;
    let culledPixels = 0;
    let edgeClipped = false;
    for (let y = 0; y < tileH; y += 1) {
      for (let x = 0; x < tileW; x += 1) {
        const off = (y * tileW + x) * 4;
        if (pixelBuf[off] > 128) {
          covered += 1;
          if (pixelBuf[off + 2] <= 128) {
            frontSidePixels += 1;
            if (pixelBuf[off + 1] <= 128) culledPixels += 1;
          }
          if (x === 0 || x === tileW - 1 || y === 0 || y === tileH - 1) {
            edgeClipped = true;
          }
        }
      }
    }

    if (capture.blackFill && SILHOUETTE_VIEWS.includes(def.id)) {
      // readPixels rows run bottom-up.
      const image = new ImageData(tileW, tileH);
      for (let y = 0; y < tileH; y += 1) {
        for (let x = 0; x < tileW; x += 1) {
          const src = ((tileH - 1 - y) * tileW + x) * 4;
          const dst = (y * tileW + x) * 4;
          const v = pixelBuf[src] > 128 ? 0 : 255;
          image.data[dst] = v;
          image.data[dst + 1] = v;
          image.data[dst + 2] = v;
          image.data[dst + 3] = 255;
        }
      }
      silhouettes.set(def.id, image);
    }

    views.push({
      id: def.id,
      ortho: def.ortho,
      zoom: viewZoom,
      coverageRatio: covered / (tileW * tileH),
      culledFrontSideRatio: frontSidePixels ? culledPixels / frontSidePixels : 0,
      edgeClipped,
      beautyUniqueColors: beautyBuckets.size,
    });
  }

  doubleMask.dispose();
  frontMask.dispose();
  exemptMask.dispose();
  renderer.dispose();
  return {
    views,
    viewImages,
    sheetDataUrl: sheetCanvas.toDataURL('image/png'),
    silhouetteDataUrl: capture.blackFill ? silhouetteSheet(silhouettes, tileW, tileH, labelH) : null,
  };
}

export async function run({ inputKind, glbUrl, glbSource, card, renderSheet, capture }) {
  let root;
  if (inputKind === 'glb') {
    const resp = await fetch(glbUrl);
    if (!resp.ok) throw new Error('Failed to fetch GLB payload');
    const arrayBuf = await resp.arrayBuffer();
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(arrayBuf, '');
    root = gltf.scene;
  } else {
    const fn =
      (UserFactory && (UserFactory.buildAsset || UserFactory.default)) || null;
    if (typeof fn !== 'function') {
      throw new Error('Factory module must export buildAsset(THREE) or default function');
    }
    root = await fn(THREE);
  }
  if (!root || !root.isObject3D) {
    throw new Error('Loaded asset did not return a THREE.Object3D');
  }

  const inspected = inspectRoot(root, inputKind, glbSource, card);
  let views = [];
  let viewImages = [];
  let sheetDataUrl = null;
  let silhouetteDataUrl = null;
  if (renderSheet) {
    const out = renderContactSheet(root, inspected.worldBox, inspected.center, inspected.boundingRadius, card, capture);
    views = out.views;
    viewImages = out.viewImages;
    sheetDataUrl = out.sheetDataUrl;
    silhouetteDataUrl = out.silhouetteDataUrl;
  }
  return {
    metrics: inspected.metrics,
    views,
    viewImages,
    sheetDataUrl,
    silhouetteDataUrl,
  };
}
`;
}

function decodePng(dataUrl: string | null | undefined, what: string): Buffer {
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
    throw new Error(`Browser harness did not return a valid ${what} PNG`);
  }
  return Buffer.from(dataUrl.slice(prefix.length), 'base64');
}

export async function runAssetSession(options: BrowserSessionOptions): Promise<BrowserSessionResult> {
  const absAsset = path.resolve(options.assetPath);
  if (!fs.existsSync(absAsset) || !fs.statSync(absAsset).isFile()) {
    throw new Error(`Asset file not found: ${absAsset}`);
  }
  if (path.extname(absAsset).toLowerCase() === '.gltf') {
    throw new Error('Unsupported .gltf input. Supply a binary .glb or a Three.js factory module.');
  }
  const timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const capture = options.capture ?? DEFAULT_CAPTURE;
  const isGlb = absAsset.toLowerCase().endsWith('.glb');
  const glbSource: GlbSourceInfo | null = isGlb ? inspectGlbSource(absAsset) : null;
  const files = new Map<string, { type: string; body: Buffer }>();
  if (isGlb) files.set('/asset.glb', { type: 'model/gltf-binary', body: fs.readFileSync(absAsset) });

  const jsBundle = await bundleBrowserEntry(
    buildRuntimeEntrySource(isGlb ? null : absAsset),
    path.dirname(fileURLToPath(import.meta.url)),
  );

  return withHarnessPage({ jsBundle, files, args: WEBGL_SWIFTSHADER_FLAGS, timeoutMs }, async (h) => {
    const execution = h.page.evaluate(async (params) => {
      const { run } = await import(params.harnessUrl);
      return run(params) as Promise<{
        metrics: AssetMetrics;
        views: ViewMetrics[];
        viewImages: { id: string; dataUrl: string }[];
        sheetDataUrl: string | null;
        silhouetteDataUrl: string | null;
      }>;
    }, {
      harnessUrl: `${h.baseUrl}/harness.js`,
      inputKind: isGlb ? 'glb' : 'factory',
      glbUrl: `${h.baseUrl}/asset.glb`,
      glbSource,
      card: options.card,
      renderSheet: options.renderSheet,
      capture: {
        ...capture,
        saveViews: options.viewsDir !== undefined,
        blackFill: options.silhouetteSheetPath !== undefined,
      },
    });
    const payload = await withTimeout(execution, timeoutMs);

    if (h.pageErrors.length > 0) {
      throw new Error(`Browser page errors: ${h.pageErrors.join('; ')}`);
    }

    if (options.renderSheet && options.contactSheetPath !== undefined) {
      const pngBytes = decodePng(payload.sheetDataUrl, 'contact sheet');
      fs.mkdirSync(path.dirname(path.resolve(options.contactSheetPath)), { recursive: true });
      fs.writeFileSync(options.contactSheetPath, pngBytes);
    }

    if (options.renderSheet && options.silhouetteSheetPath !== undefined) {
      const pngBytes = decodePng(payload.silhouetteDataUrl, 'silhouette sheet');
      fs.mkdirSync(path.dirname(path.resolve(options.silhouetteSheetPath)), { recursive: true });
      fs.writeFileSync(options.silhouetteSheetPath, pngBytes);
    }

    const viewPaths: string[] = [];
    if (options.renderSheet && options.viewsDir !== undefined) {
      fs.mkdirSync(path.resolve(options.viewsDir), { recursive: true });
      for (const image of payload.viewImages) {
        const viewPath = path.join(path.resolve(options.viewsDir), `${image.id}.png`);
        fs.writeFileSync(viewPath, decodePng(image.dataUrl, `view ${image.id}`));
        viewPaths.push(viewPath);
      }
    }

    return {
      metrics: payload.metrics,
      views: payload.views,
      consoleErrors: [...h.consoleErrors],
      viewPaths,
    };
  });
}

export interface LabeledPng {
  readonly label: string;
  readonly png: Buffer;
}

/** Stacks PNGs of equal width into one image, each under a label bar. */
export async function stackLabeledPngs(images: readonly LabeledPng[], outPath: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const files = new Map(images.map((img, i) => [`/${i}.png`, { type: 'image/png', body: img.png }]));
  const dataUrl = await withHarnessPage({ jsBundle: '', files, args: [], timeoutMs }, async (h) => {
    const execution = h.page.evaluate(async ({ baseUrl, labels }) => {
      const bitmaps = await Promise.all(labels.map(async (_, i) => {
        const resp = await fetch(`${baseUrl}/${i}.png`);
        return createImageBitmap(await resp.blob());
      }));
      const labelH = 26;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(...bitmaps.map((b) => b.width));
      canvas.height = bitmaps.reduce((sum, b) => sum + labelH + b.height, 0);
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('2D canvas unavailable');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'left';
      let y = 0;
      bitmaps.forEach((bitmap, i) => {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, y, canvas.width, labelH);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(labels[i] ?? '', 10, y + 18);
        ctx.drawImage(bitmap, 0, y + labelH);
        y += labelH + bitmap.height;
      });
      return canvas.toDataURL('image/png');
    }, { baseUrl: h.baseUrl, labels: images.map((img) => img.label) });
    return withTimeout(execution, timeoutMs, 'Mask composition');
  });
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, decodePng(dataUrl, 'black-fill masks'));
}
