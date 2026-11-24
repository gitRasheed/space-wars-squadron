import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { main } from '../src/cli.js';
import { linearRgbToHexSrgb, runAssetSession, evaluateAssetGates, type StyleCard } from '../src/index.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOX_GLB = path.join(PKG_ROOT, 'tests', 'fixtures', 'BoxVertexColors.glb');

async function writeWedgeGlb(
  outPath: string,
  scaleFactor: number,
  options?: { readonly degenerate?: boolean; readonly vertexGreyU8?: number },
): Promise<void> {
  const doc = new Document();
  const buf = doc.createBuffer();
  // Asymmetric wedge: nose at +Z (1.2), wider tail at -Z (-1.0), dorsal fin at +Y (0.8).
  const s = scaleFactor;
  const positions = new Float32Array([
    // bottom
    -0.5 * s, 0, -0.5 * s,
    0.5 * s, 0, -0.5 * s,
    0, 0, 0.7 * s,
    // left flank
    -0.5 * s, 0, -0.5 * s,
    0, 0, 0.7 * s,
    0, 0.5 * s, -0.2 * s,
    // right flank
    0.5 * s, 0, -0.5 * s,
    0, 0.5 * s, -0.2 * s,
    0, 0, 0.7 * s,
    // rear
    -0.5 * s, 0, -0.5 * s,
    0, 0.5 * s, -0.2 * s,
    0.5 * s, 0, -0.5 * s,
    ...(options?.degenerate === true ? [0, 0, 0, 0, 0, 0, 0, 0, 0] : []),
  ]);

  const posAcc = doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buf);
  const prim = doc.createPrimitive().setAttribute('POSITION', posAcc);

  if (options?.vertexGreyU8 !== undefined) {
    const vertCount = positions.length / 3;
    const cols = new Uint8Array(vertCount * 3).fill(options.vertexGreyU8);
    const colAcc = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(cols)
      .setNormalized(true)
      .setBuffer(buf);
    prim.setAttribute('COLOR_0', colAcc);
  } else {
    const mat = doc
      .createMaterial('hull')
      .setBaseColorFactor([0.8, 0.25, 0.08, 1])
      .setRoughnessFactor(0.9)
      .setMetallicFactor(0);
    prim.setMaterial(mat);
  }

  const mesh = doc.createMesh('wedge').addPrimitive(prim);
  const node = doc.createNode('wedgeNode').setMesh(mesh);
  doc.createScene('scene').addChild(node);

  const io = new NodeIO();
  await io.write(outPath, doc);
}

function writeWedgeFactory(outPath: string, scaleFactor: number, opts?: { readonly hiddenFar?: boolean }): void {
  const s = scaleFactor;
  fs.writeFileSync(
    outPath,
    `
export function buildAsset(THREE) {
  const root = new THREE.Group();
  const geo = new THREE.BufferGeometry();
  const s = ${s};
  const positions = new Float32Array([
    -0.5 * s, 0, -0.5 * s,
    0.5 * s, 0, -0.5 * s,
    0, 0, 0.7 * s,
    -0.5 * s, 0, -0.5 * s,
    0, 0, 0.7 * s,
    0, 0.5 * s, -0.2 * s,
    0.5 * s, 0, -0.5 * s,
    0, 0.5 * s, -0.2 * s,
    0, 0, 0.7 * s,
    -0.5 * s, 0, -0.5 * s,
    0, 0.5 * s, -0.2 * s,
    0.5 * s, 0, -0.5 * s,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.8, 0.25, 0.08, THREE.LinearSRGBColorSpace) });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'wedge';
  root.add(mesh);
  ${
    opts?.hiddenFar === true
      ? `
  const far = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  far.position.set(9999, 0, 0);
  far.visible = false;
  root.add(far);
  `
      : ''
  }
  return root;
}
`,
  );
}

describe('agent-3d Khronos fixture, color-space honesty, and transforms', () => {
  it('measures Khronos CC0 BoxVertexColors.glb with exact bytes, tris, verts, and declared vs effective materials', async () => {
    const session = await runAssetSession({
      assetPath: BOX_GLB,
      card: null,
      renderSheet: false,
    });
    assert.equal(session.metrics.inputKind, 'glb');
    assert.equal(session.metrics.glbSource?.bytes, 1924);
    assert.equal(session.metrics.trianglesByOccurrence, 12);
    assert.equal(session.metrics.positionVerticesUnique, 24);
    assert.equal(session.metrics.glbSource?.declaredMaterials, 0);
    assert.equal(session.metrics.glbSource?.declaredTextures, 0);
    assert.ok(session.metrics.effectiveMaterials >= 1);
  });

  it('decodes linear vertex grey 128/255 honestly as ~#bcbcbc sRGB and rejects a #808080 card', async () => {
    const lin = 128 / 255;
    assert.equal(linearRgbToHexSrgb(lin, lin, lin), '#bcbcbc');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-3d-col-'));
    try {
      const glbPath = path.join(tmpDir, 'grey.glb');
      await writeWedgeGlb(glbPath, 1, { vertexGreyU8: 128 });
      const card: StyleCard = {
        id: 'strict-grey',
        palette: { midGrey: '#808080' },
        paletteDeltaE76Max: 8,
      };
      const session = await runAssetSession({ assetPath: glbPath, card, renderSheet: false });
      const evaluated = evaluateAssetGates(session.metrics, card);
      assert.equal(evaluated.ok, false);
      assert.ok(evaluated.findings.some((f) => f.id === 'PALETTE_DELTA_E_EXCEEDED'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies full world transforms (parent scale 2 * child x=3 === 6) and ignores hidden distant meshes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-3d-xf-'));
    try {
      const factoryPath = path.join(tmpDir, 'scaled.mjs');
      fs.writeFileSync(
        factoryPath,
        `
export function buildAsset(THREE) {
  const root = new THREE.Group();
  root.scale.setScalar(2);
  const child = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x808080 }));
  child.position.set(3, 0, 0);
  root.add(child);
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x808080 }));
  hidden.position.set(500, 0, 0);
  hidden.visible = false;
  root.add(hidden);
  return root;
}
`,
      );
      const session = await runAssetSession({ assetPath: factoryPath, card: null, renderSheet: false });
      assert.equal(session.metrics.worldBounds?.center.x, 6);
      assert.equal(session.metrics.hiddenMeshCount, 1);
      assert.equal(session.metrics.visibleMeshCount, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('agent-3d GLB vs factory parity, scale framing (0.5 m & 300 m), and mutations', () => {
  it('matches bounds and triangle counts between GLB and factory and frames cleanly at 0.5 m and 300 m', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-3d-par-'));
    try {
      for (const scaleFactor of [0.5, 300]) {
        const glbPath = path.join(tmpDir, `wedge_${scaleFactor}.glb`);
        const facPath = path.join(tmpDir, `wedge_${scaleFactor}.mjs`);
        await writeWedgeGlb(glbPath, scaleFactor);
        writeWedgeFactory(facPath, scaleFactor, { hiddenFar: true });

        const sheetGlb = path.join(tmpDir, `sheet_glb_${scaleFactor}.png`);
        const sheetFac = path.join(tmpDir, `sheet_fac_${scaleFactor}.png`);
        const glbRes = await runAssetSession({
          assetPath: glbPath,
          card: null,
          renderSheet: true,
          contactSheetPath: sheetGlb,
        });
        const facRes = await runAssetSession({
          assetPath: facPath,
          card: null,
          renderSheet: true,
          contactSheetPath: sheetFac,
        });

        assert.equal(glbRes.metrics.trianglesByOccurrence, facRes.metrics.trianglesByOccurrence);
        assert.ok(
          glbRes.metrics.worldBounds !== null &&
            facRes.metrics.worldBounds !== null &&
            Math.abs(glbRes.metrics.worldBounds.maxExtent - facRes.metrics.worldBounds.maxExtent) < 1e-3,
        );
        assert.equal(glbRes.views.length, 9);
        assert.equal(facRes.views.length, 9);
        for (const v of [...glbRes.views, ...facRes.views]) {
          assert.equal(v.edgeClipped, false, `${v.id} clipped at scale ${scaleFactor}`);
          assert.ok(v.coverageRatio > 0.02, `${v.id} blank at scale ${scaleFactor}`);
        }
        assert.ok(fs.statSync(sheetGlb).size > 4000);
        assert.ok(fs.statSync(sheetFac).size > 4000);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('flags degenerate triangles with exit 1 (with or without card) and unsupported textured palette gate with exit 2', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-3d-mut-'));
    try {
      const degGlb = path.join(tmpDir, 'degenerate.glb');
      await writeWedgeGlb(degGlb, 1, { degenerate: true });
      // Default degeneracy gate applies even with no card.
      assert.equal(await main(['check', degGlb]), 1);

      const cardPath = path.join(tmpDir, 'card.json');
      fs.writeFileSync(
        cardPath,
        JSON.stringify({ id: 'deg-check', budgets: { degenerateTrianglesMax: 0 } }),
      );
      const degReport = path.join(tmpDir, 'deg-report.json');
      assert.equal(await main(['check', degGlb, '--card', cardPath, '--out', degReport]), 1);
      const parsed = JSON.parse(fs.readFileSync(degReport, 'utf8')) as { findings: Array<{ id: string }> };
      assert.ok(parsed.findings.some((f) => f.id === 'DEGENERATE_TRIANGLES'));

      const texFac = path.join(tmpDir, 'textured.mjs');
      fs.writeFileSync(
        texFac,
        `
export function buildAsset(THREE) {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 16;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e88332';
  ctx.fillRect(0, 0, 16, 16);
  const tex = new THREE.CanvasTexture(c);
  return new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial({ map: tex }));
}
`,
      );
      const strictTexCard = path.join(tmpDir, 'strict-tex-card.json');
      fs.writeFileSync(
        strictTexCard,
        JSON.stringify({
          id: 'strict-tex',
          palette: { ember: '#e88332' },
          paletteDeltaE76Max: 8,
          requirePaletteOnTextured: true,
        }),
      );
      assert.equal(await main(['check', texFac, '--card', strictTexCard]), 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('closes all Astra audit regressions: no overwrite, strict CLI/card, mixed textured palette, instanceColor mask, tiny scale, and drawRange/visibility', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-3d-reg-'));
    try {
      // 1. Refuse to overwrite input asset via --out.
      const copyGlb = path.join(tmpDir, 'BoxVertexColors.glb');
      fs.copyFileSync(BOX_GLB, copyGlb);
      assert.equal(await main(['check', copyGlb, '--out', copyGlb]), 2);
      assert.equal(fs.statSync(copyGlb).size, 1924);

      // 2. Reject unknown flags, invalid card budget types, and impossible topUpAxis: "+Y".
      assert.equal(await main(['check', copyGlb, '--carD', 'missing.json']), 2);
      const badCard = path.join(tmpDir, 'bad-card.json');
      fs.writeFileSync(badCard, JSON.stringify({ id: 'bad', budgets: { trisMax: 'one' } }));
      assert.equal(await main(['check', copyGlb, '--card', badCard]), 2);
      const badAxisCard = path.join(tmpDir, 'bad-axis.json');
      fs.writeFileSync(badAxisCard, JSON.stringify({ id: 'bad-axis', topUpAxis: '+Y' }));
      assert.equal(await main(['check', copyGlb, '--card', badAxisCard]), 2);

      // 3. Mixed textured + off-palette untextured mesh must still fail PALETTE_DELTA_E_EXCEEDED.
      const mixedFac = path.join(tmpDir, 'mixed.mjs');
      fs.writeFileSync(
        mixedFac,
        `
export function buildAsset(THREE) {
  const root = new THREE.Group();
  const c = document.createElement('canvas'); c.width = 4; c.height = 4;
  const tex = new THREE.CanvasTexture(c);
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ map: tex })));
  const blue = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x0044ff }));
  blue.position.x = 2;
  root.add(blue);
  return root;
}
`,
      );
      const redCard = path.join(tmpDir, 'red.json');
      fs.writeFileSync(
        redCard,
        JSON.stringify({ id: 'red-only', palette: { red: '#ff0000' }, paletteDeltaE76Max: 5, requirePaletteOnTextured: false }),
      );
      assert.equal(await main(['check', mixedFac, '--card', redCard]), 1);

      // 4. White instanced cube with black instanceColor fails white palette AND stays visible in silhouette mask.
      const instFac = path.join(tmpDir, 'inst.mjs');
      fs.writeFileSync(
        instFac,
        `
export function buildAsset(THREE) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), 1);
  mesh.setMatrixAt(0, new THREE.Matrix4());
  mesh.setColorAt(0, new THREE.Color(0x000000));
  return mesh;
}
`,
      );
      const whiteCard: StyleCard = { id: 'white-only', palette: { white: '#ffffff' }, paletteDeltaE76Max: 5 };
      const instRes = await runAssetSession({
        assetPath: instFac,
        card: whiteCard,
        renderSheet: true,
        contactSheetPath: path.join(tmpDir, 'inst-sheet.png'),
      });
      const instEval = evaluateAssetGates(instRes.metrics, whiteCard, instRes.views);
      assert.equal(instEval.ok, false);
      assert.ok(instEval.findings.some((f) => f.id === 'PALETTE_DELTA_E_EXCEEDED'));
      for (const v of instRes.views) {
        assert.ok(v.coverageRatio > 0.05, `Instanced mask blank on ${v.id}`);
      }

      // 5. Tiny 0.001 cube frames cleanly (nonzero coverage) and 1e-9 triangle is NOT degenerate.
      const tinyFac = path.join(tmpDir, 'tiny.mjs');
      fs.writeFileSync(
        tinyFac,
        `
export function buildAsset(THREE) {
  return new THREE.Mesh(new THREE.BoxGeometry(0.001, 0.001, 0.001), new THREE.MeshStandardMaterial({ color: 0xcc8844 }));
}
`,
      );
      const tinyRes = await runAssetSession({
        assetPath: tinyFac,
        card: null,
        renderSheet: true,
        contactSheetPath: path.join(tmpDir, 'tiny-sheet.png'),
      });
      for (const v of tinyRes.views) {
        assert.ok(v.coverageRatio > 0.05, `Tiny cube blank on ${v.id}`);
      }

      const microTri = path.join(tmpDir, 'micro.mjs');
      fs.writeFileSync(
        microTri,
        `
export function buildAsset(THREE) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0,0,0, 1e-9,0,0, 0,1e-9,0]), 3));
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
}
`,
      );
      const microRes = await runAssetSession({ assetPath: microTri, card: null, renderSheet: false });
      assert.equal(microRes.metrics.degenerateTriangles, 0);

      // 6. material.visible=false and drawRange limit bounds/tris; unused COLOR_0 ignored when vertexColors=false.
      const drawFac = path.join(tmpDir, 'drawrange.mjs');
      fs.writeFileSync(
        drawFac,
        `
export function buildAsset(THREE) {
  const root = new THREE.Group();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0,0,0, 1,0,0, 0,1,0,
    50,0,0, 51,0,0, 50,1,0
  ]), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array([
    0,0,0, 0,0,0, 0,0,0,
    0,0,0, 0,0,0, 0,0,0
  ]), 3));
  geo.setDrawRange(0, 3);
  root.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff0000, vertexColors: false })));
  const hiddenMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
  hiddenMat.visible = false;
  root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), hiddenMat));
  return root;
}
`,
      );
      const drawRes = await runAssetSession({
        assetPath: drawFac,
        card: { id: 'red', palette: { red: '#ff0000' }, paletteDeltaE76Max: 2 },
        renderSheet: false,
      });
      assert.equal(drawRes.metrics.trianglesByOccurrence, 1);
      assert.equal(drawRes.metrics.worldBounds?.max.x, 1);
      assert.equal(drawRes.metrics.palette.maxDeltaE76, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
