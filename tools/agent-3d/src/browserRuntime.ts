import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright';
import { inspectGlbSource } from './glbHeader.js';
import type { AssetMetrics, GlbSourceInfo, StyleCard, ViewMetrics } from './types.js';

const requireFromHere = createRequire(import.meta.url);
// Works on Node 20.0.0+ without relying on import.meta.resolve (added in 20.6).
const THREE_BUILD_DIR = path.dirname(requireFromHere.resolve('three'));
const THREE_ENTRY = path.resolve(THREE_BUILD_DIR, 'three.module.js');
const THREE_DIR = path.resolve(THREE_BUILD_DIR, '..');

export interface BrowserSessionOptions {
  readonly assetPath: string;
  readonly card: StyleCard | null;
  readonly renderSheet: boolean;
  readonly contactSheetPath?: string;
}

export interface BrowserSessionResult {
  readonly metrics: AssetMetrics;
  readonly views: readonly ViewMetrics[];
}

function buildRuntimeEntrySource(factoryImportPath: string | null): string {
  const importLine =
    factoryImportPath !== null
      ? `import * as UserFactory from ${JSON.stringify(factoryImportPath)};`
      : `const UserFactory = null;`;

  return `
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
${importLine}

function srgbToLin(c) {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function linToSrgb(c) {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
function hexToLin(hex) {
  const clean = hex.trim().replace(/^#/, '');
  return [
    srgbToLin(parseInt(clean.slice(0, 2), 16) / 255),
    srgbToLin(parseInt(clean.slice(2, 4), 16) / 255),
    srgbToLin(parseInt(clean.slice(4, 6), 16) / 255),
  ];
}
function linToHex(r, g, b) {
  const b2 = (v) => Math.max(0, Math.min(255, Math.round(linToSrgb(v) * 255))).toString(16).padStart(2, '0');
  return '#' + b2(r) + b2(g) + b2(b);
}
function linToLab(r, g, b) {
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / 0.95047);
  const fy = f(y / 1.0);
  const fz = f(z / 1.08883);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}
function deltaE76(a, b) {
  return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);
}

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

function activeSpansForMesh(mesh) {
  const geo = mesh.geometry;
  const pos = geo && geo.getAttribute('position');
  if (!pos) return [];
  const idx = geo.index;
  const total = idx ? idx.count : pos.count;
  const drStart = Math.max(0, geo.drawRange.start);
  const drEnd = Math.min(total, drStart + geo.drawRange.count);
  if (drEnd - drStart < 3) return [];

  const isMulti = Array.isArray(mesh.material);
  const mats = isMulti ? mesh.material : [mesh.material];
  const groups =
    geo.groups && geo.groups.length > 0
      ? geo.groups
      : [{ start: 0, count: total, materialIndex: 0 }];

  const spans = [];
  for (const g of groups) {
    const start = Math.max(drStart, g.start);
    const end = Math.min(drEnd, g.start + g.count);
    if (end - start < 3) continue;
    const matIdx = g.materialIndex ?? 0;
    const mat = isMulti ? mats[matIdx] : mats[0];
    if (!mat || mat.visible === false) continue;
    const triCount = Math.floor((end - start) / 3);
    if (triCount <= 0) continue;
    spans.push({ start, end: start + triCount * 3, triCount, material: mat });
  }
  return spans;
}

function collectMaterialTextures(mat, outSet) {
  for (const val of Object.values(mat)) {
    if (val && typeof val === 'object' && val.isTexture) {
      outSet.add(val);
    }
  }
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
    const instances = obj.isInstancedMesh ? obj.count : 1;
    if (instances <= 0) {
      hiddenMeshCount += 1;
      return;
    }
    const spans = activeSpansForMesh(obj);
    if (spans.length === 0) {
      hiddenMeshCount += 1;
      return;
    }
    activeMeshEntries.push({ mesh: obj, spans, instances });
    uniqueGeos.add(obj.geometry);
    for (const span of spans) {
      trianglesByOccurrence += span.triCount * instances;
      effectiveMaterials.add(span.material);
      collectMaterialTextures(span.material, effectiveTextures);
    }
  });

  // Compute exact world bounds from vertices referenced by active spans only.
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

  // Palette assessment: strict linear material * active vertexColors * active instanceColor -> Lab D65.
  let palette = {
    status: 'skipped_no_palette',
    assessedMeshes: 0,
    texturedMeshes: 0,
    sampledCorners: 0,
    maxDeltaE76: null,
    worstViolation: null,
  };

  if (card && card.palette && Object.keys(card.palette).length > 0) {
    const palEntries = Object.entries(card.palette).map(([role, hex]) => {
      const lin = hexToLin(hex);
      return { role, hex, lab: linToLab(lin[0], lin[1], lin[2]) };
    });

    let assessedMeshes = 0;
    let texturedMeshes = 0;
    let sampledCorners = 0;
    let maxDelta = 0;
    let worst = null;

    const evalLinearColor = (meshName, lr, lg, lb) => {
      sampledCorners += 1;
      const lab = linToLab(lr, lg, lb);
      let bestRole = '';
      let bestHex = '#000000';
      let bestD = Infinity;
      for (const p of palEntries) {
        const d = deltaE76(lab, p.lab);
        if (d < bestD) {
          bestD = d;
          bestRole = p.role;
          bestHex = p.hex;
        }
      }
      if (bestD > maxDelta) {
        maxDelta = bestD;
        worst = {
          meshName,
          hexSrgb: linToHex(lr, lg, lb),
          nearestRole: bestRole,
          nearestHex: bestHex,
          deltaE76: bestD,
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
      let meshHadAssessed = false;

      for (const span of spans) {
        const mat = span.material;
        const hasBaseTexture = Boolean(mat.map && mat.map.isTexture);
        if (hasBaseTexture) {
          meshHadTextured = true;
          continue;
        }
        meshHadAssessed = true;
        const matR = mat.color ? mat.color.r : 1;
        const matG = mat.color ? mat.color.g : 1;
        const matB = mat.color ? mat.color.b : 1;
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
              evalLinearColor(
                meshName,
                matR * ir * colorAttr.getX(vi),
                matG * ig * colorAttr.getY(vi),
                matB * ib * colorAttr.getZ(vi),
              );
            }
          } else {
            evalLinearColor(meshName, matR * ir, matG * ig, matB * ib);
          }
        }
      }

      if (meshHadTextured) texturedMeshes += 1;
      if (meshHadAssessed) assessedMeshes += 1;
    }

    palette = {
      status:
        texturedMeshes > 0 && assessedMeshes > 0
          ? 'partial_textured'
          : texturedMeshes > 0
            ? 'unassessed_textured'
            : 'assessed',
      assessedMeshes,
      texturedMeshes,
      sampledCorners,
      maxDeltaE76: sampledCorners > 0 ? maxDelta : null,
      worstViolation: worst,
    };
  }

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
    },
    worldBox: hasBounds ? worldBox : null,
    center,
    boundingRadius,
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

function renderContactSheet(root, worldBox, center, radius, card) {
  const tileW = 420;
  const tileH = 315;
  const cols = 3;
  const rows = 3;
  const labelH = 26;

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(tileW, tileH, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const safeRadius = Math.max(radius, 1e-6);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x161926);
  scene.add(root);

  const keyLight = new THREE.DirectionalLight(0xfff1dc, 2.2);
  keyLight.position.set(1.2, 1.5, 1.0).multiplyScalar(safeRadius * 4);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0x7ca2ff, 1.0);
  rimLight.position.set(-1.3, 0.7, -1.1).multiplyScalar(safeRadius * 4);
  scene.add(rimLight);

  const hemi = new THREE.HemisphereLight(0xaab8e0, 0x242038, 0.85);
  scene.add(hemi);

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

  const maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const gl = renderer.getContext();
  const pixelBuf = new Uint8Array(tileW * tileH * 4);
  const aspect = tileW / tileH;
  const vFovDeg = 40;
  const tanHalfV = Math.tan(((vFovDeg * Math.PI) / 180) * 0.5);
  const tanHalfH = tanHalfV * aspect;
  const corners = worldBox ? boxCorners(worldBox) : [];

  const instancedWithColor = [];
  root.traverse((obj) => {
    if (obj.isInstancedMesh && obj.instanceColor) {
      instancedWithColor.push({ mesh: obj, saved: obj.instanceColor });
    }
  });

  const views = [];

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

    cam.up.copy(def.up);
    cam.lookAt(center);
    cam.updateMatrixWorld();

    // 1. Beauty render
    scene.overrideMaterial = null;
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

    ctx.fillStyle = '#0b0e18';
    ctx.fillRect(dx, dy, tileW, labelH);
    ctx.strokeStyle = '#2d354f';
    ctx.lineWidth = 1;
    ctx.strokeRect(dx + 0.5, dy + 0.5, tileW - 1, tileH + labelH - 1);
    ctx.font = 'bold 13px monospace';
    ctx.fillStyle = '#f4b459';
    ctx.textAlign = 'left';
    ctx.fillText(def.id, dx + 10, dy + 17);

    // 2. Internal foreground mask (temporarily strip instanceColor so dark instances stay white in the mask).
    for (const item of instancedWithColor) {
      item.mesh.instanceColor = null;
    }
    try {
      scene.overrideMaterial = maskMat;
      scene.background = new THREE.Color(0x000000);
      renderer.render(scene, cam);
    } finally {
      for (const item of instancedWithColor) {
        item.mesh.instanceColor = item.saved;
      }
      scene.overrideMaterial = null;
    }

    gl.readPixels(0, 0, tileW, tileH, gl.RGBA, gl.UNSIGNED_BYTE, pixelBuf);
    let covered = 0;
    let edgeClipped = false;
    for (let y = 0; y < tileH; y += 1) {
      for (let x = 0; x < tileW; x += 1) {
        const off = (y * tileW + x) * 4;
        if (pixelBuf[off] > 128) {
          covered += 1;
          if (x === 0 || x === tileW - 1 || y === 0 || y === tileH - 1) {
            edgeClipped = true;
          }
        }
      }
    }

    views.push({
      id: def.id,
      ortho: def.ortho,
      coverageRatio: Number((covered / (tileW * tileH)).toFixed(4)),
      edgeClipped,
      beautyUniqueColors: beautyBuckets.size,
    });
  }

  maskMat.dispose();
  renderer.dispose();
  return {
    views,
    sheetDataUrl: sheetCanvas.toDataURL('image/png'),
  };
}

globalThis.__AGENT_3D_RUN__ = async ({ inputKind, glbUrl, glbSource, card, renderSheet }) => {
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
  let sheetDataUrl = null;
  if (renderSheet) {
    const out = renderContactSheet(root, inspected.worldBox, inspected.center, inspected.boundingRadius, card);
    views = out.views;
    sheetDataUrl = out.sheetDataUrl;
  }
  return {
    metrics: inspected.metrics,
    views,
    sheetDataUrl,
  };
};
`;
}

export async function runAssetSession(options: BrowserSessionOptions): Promise<BrowserSessionResult> {
  const absAsset = path.resolve(options.assetPath);
  if (!fs.existsSync(absAsset) || !fs.statSync(absAsset).isFile()) {
    throw new Error(`Asset file not found: ${absAsset}`);
  }
  const isGlb = absAsset.toLowerCase().endsWith('.glb');
  const glbSource: GlbSourceInfo | null = isGlb ? inspectGlbSource(absAsset) : null;
  const glbBytes = isGlb ? fs.readFileSync(absAsset) : null;

  const threeExamplesDir = path.resolve(THREE_DIR, 'examples');
  const bundleResult = await esbuild.build({
    stdin: {
      contents: buildRuntimeEntrySource(isGlb ? null : absAsset),
      resolveDir: path.dirname(absAsset),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    alias: {
      three: THREE_ENTRY,
      'three/examples': threeExamplesDir,
    },
    logOverride: { 'import-is-undefined': 'silent' },
  });
  const jsBundle = bundleResult.outputFiles[0]?.text;
  if (jsBundle === undefined) {
    throw new Error('Failed to bundle browser harness');
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><script type="module" src="/harness.js"></script></body></html>');
      return;
    }
    if (req.url === '/harness.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(jsBundle);
      return;
    }
    if (req.url === '/asset.glb' && glbBytes !== null) {
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary' });
      res.end(glbBytes);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind ephemeral HTTP port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
      ],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof (globalThis as Record<string, unknown>)['__AGENT_3D_RUN__'] === 'function');

    const payload = await page.evaluate(
      async (params) => {
        const runner = (globalThis as Record<string, unknown>)['__AGENT_3D_RUN__'] as (
          p: typeof params,
        ) => Promise<{
          metrics: AssetMetrics;
          views: ViewMetrics[];
          sheetDataUrl: string | null;
        }>;
        return runner(params);
      },
      {
        inputKind: isGlb ? 'glb' : 'factory',
        glbUrl: `${baseUrl}/asset.glb`,
        glbSource,
        card: options.card,
        renderSheet: options.renderSheet,
      },
    );

    if (pageErrors.length > 0) {
      throw new Error(`Browser page errors: ${pageErrors.join('; ')}`);
    }

    if (options.renderSheet && options.contactSheetPath !== undefined) {
      if (payload.sheetDataUrl === null || !payload.sheetDataUrl.startsWith('data:image/png;base64,')) {
        throw new Error('Browser harness did not return a valid contact sheet PNG');
      }
      const pngBytes = Buffer.from(payload.sheetDataUrl.slice('data:image/png;base64,'.length), 'base64');
      fs.mkdirSync(path.dirname(path.resolve(options.contactSheetPath)), { recursive: true });
      fs.writeFileSync(options.contactSheetPath, pngBytes);
    }

    return {
      metrics: payload.metrics,
      views: payload.views,
    };
  } finally {
    if (browser !== undefined) {
      await browser.close();
    }
    server.close();
  }
}
