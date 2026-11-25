import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { Document, getBounds, NodeIO } from '@gltf-transform/core';
import { listBatchAssets } from '../src/cli.js';
import {
  classifyGpuProbe,
  evaluateAssetGates,
  hexSrgbToLinearRgb,
  linearRgbToHexSrgb,
  runAssetSession,
  runGpuProbe,
  WEBGPU_SWIFTSHADER_FLAGS,
  type BatchReport,
  type Check3DReport,
  type StyleCard,
  type TurntableReport,
} from '../src/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = fs.mkdtempSync(path.join(root, 'dist-test', 'features-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture(name: string, contents: string): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function factory(name: string, body: string): string {
  return fixture(name, `export function buildAsset(THREE) {\n${body}\n}`);
}

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [path.join(root, 'dist/cli.js'), ...args], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.ifError(result.error);
  return result;
}

function pngSize(file: string): { readonly width: number; readonly height: number } {
  const bytes = fs.readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// Decodes the 8-bit RGB/RGBA non-interlaced PNGs Chromium's canvas writes; returns one gray byte per pixel (red channel).
function pngRed(file: string): { readonly width: number; readonly height: number; readonly red: Uint8Array } {
  const bytes = fs.readFileSync(file);
  const { width, height } = pngSize(file);
  const [depth, colorType, interlace] = [bytes[24], bytes[25], bytes[28]];
  assert.ok(depth === 8 && (colorType === 2 || colorType === 6) && interlace === 0, `unsupported PNG ${file}`);
  const bpp = colorType === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let o = 8; o < bytes.length;) {
    const len = bytes.readUInt32BE(o);
    if (bytes.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(bytes.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  const red = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const base = y * (stride + 1);
    const filter = raw[base]!;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[base + 1 + i]!;
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      cur[i] = (x + [0, a, b, (a + b) >> 1, paeth][filter]!) & 0xff;
    }
    for (let x = 0; x < width; x += 1) red[y * width + x] = cur[x * bpp]!;
    prev.set(cur);
  }
  return { width, height, red };
}

const box = factory('box.mjs', `return new THREE.Mesh(new THREE.BoxGeometry(1, 0.6, 2),
  new THREE.MeshStandardMaterial({ color: 0xcc8844 }));`);

describe('turntable capture flags', () => {
  it('writes nine view PNGs at --tile-size and records the capture settings', () => {
    const out = path.join(dir, 'tiles');
    const result = cli('turntable', box, '--out', out, '--tile-size', '160x120', '--save-views');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as TurntableReport;
    assert.deepEqual(report.capture, { tileWidth: 160, tileHeight: 120, zoom: 1, zoomOrtho: false, lighting: 'studio' });
    assert.equal(report.viewPaths.length, 9);
    for (const view of report.views) {
      const file = path.join(out, `${view.id}.png`);
      assert.ok(report.viewPaths.includes(file), `missing ${file}`);
      assert.deepEqual(pngSize(file), { width: 160, height: 120 });
    }
    assert.deepEqual(pngSize(path.join(out, 'contact-sheet.png')), { width: 480, height: 3 * (120 + 26) });
  });

  it('skips view PNGs without --save-views', () => {
    const out = path.join(dir, 'no-views');
    const result = cli('turntable', box, '--out', out, '--tile-size', '96x96');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((JSON.parse(result.stdout) as TurntableReport).viewPaths, []);
    assert.deepEqual(fs.readdirSync(out).sort(), ['contact-sheet.png', 'report.json']);
  });

  it('zooms only the perspective views by default, so ortho silhouettes stay whole', () => {
    const base = JSON.parse(cli('turntable', box, '--out', path.join(dir, 'z1'), '--tile-size', '128x96').stdout) as TurntableReport;
    const result = cli('turntable', box, '--out', path.join(dir, 'z4'), '--tile-size', '128x96', '--zoom', '4');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const zoomed = JSON.parse(result.stdout) as TurntableReport;
    assert.equal(zoomed.capture.zoomOrtho, false);
    for (const [i, view] of zoomed.views.entries()) {
      const before = base.views[i]!;
      if (view.ortho) {
        assert.equal(view.zoom, 1);
        assert.equal(view.coverageRatio, before.coverageRatio, `${view.id} changed framing`);
        assert.equal(view.edgeClipped, false, `${view.id} clipped`);
      } else {
        assert.equal(view.zoom, 4);
        assert.ok(view.coverageRatio > before.coverageRatio, `${view.id} did not zoom in`);
      }
    }
    const clipped = zoomed.findings.filter((f) => f.id === 'VIEW_EDGE_CLIPPED');
    assert.ok(clipped.length > 0);
    assert.ok(clipped.every((f) => f.severity === 'info' && !f.message.includes("'ortho-")));
  });

  it('zooms the ortho views too with --zoom-ortho', () => {
    const base = JSON.parse(cli('turntable', box, '--out', path.join(dir, 'zo1'), '--tile-size', '128x96').stdout) as TurntableReport;
    const result = cli('turntable', box, '--out', path.join(dir, 'zo4'), '--tile-size', '128x96', '--zoom', '4', '--zoom-ortho');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const zoomed = JSON.parse(result.stdout) as TurntableReport;
    assert.equal(zoomed.capture.zoomOrtho, true);
    for (const [i, view] of zoomed.views.entries()) {
      assert.equal(view.zoom, 4);
      assert.ok(view.coverageRatio > base.views[i]!.coverageRatio, `${view.id} did not zoom in`);
    }
    assert.ok(zoomed.findings.some((f) => f.id === 'VIEW_EDGE_CLIPPED' && f.severity === 'info' && f.message.includes("'ortho-")));
  });

  it('fails an unzoomed ortho view that clips even when --zoom is set', () => {
    const views = [
      { id: 'persp-front', ortho: false, zoom: 2, coverageRatio: 0.5, edgeClipped: true, beautyUniqueColors: 9 },
      { id: 'ortho-top', ortho: true, zoom: 1, coverageRatio: 0.5, edgeClipped: true, beautyUniqueColors: 9 },
    ];
    const metrics = (JSON.parse(cli('check', box).stdout) as Check3DReport).metrics;
    const clipped = evaluateAssetGates(metrics, null, views).findings.filter((f) => f.id === 'VIEW_EDGE_CLIPPED');
    assert.deepEqual(clipped.map((f) => f.severity), ['info', 'fail']);
  });

  it('writes a black-on-white ortho-top and ortho-front silhouette sheet with --black-fill', () => {
    // A cone points up, so a vertical flip of the front mask would put its wide base on top.
    const cone = factory('cone.mjs', `return new THREE.Mesh(new THREE.ConeGeometry(0.5, 2, 24),
      new THREE.MeshStandardMaterial({ color: 0xcc8844 }));`);
    const out = path.join(dir, 'black-fill');
    const result = cli('turntable', cone, '--out', out, '--tile-size', '160x120', '--zoom', '1.4', '--black-fill');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as TurntableReport;
    assert.equal(report.silhouetteSheetPath, path.join(out, 'silhouette-sheet.png'));
    const { width, height, red } = pngRed(path.join(out, 'silhouette-sheet.png'));
    assert.deepEqual([width, height], [2 * 160, 26 + 120]);
    for (const [col, id] of ['ortho-top', 'ortho-front'].entries()) {
      let black = 0;
      let topBlack = 0;
      let bottomBlack = 0;
      for (let y = 0; y < 120; y += 1) {
        for (let x = 0; x < 160; x += 1) {
          const v = red[(26 + y) * width + col * 160 + x]!;
          assert.ok(v === 0 || v === 255, `${id} has gray pixel ${v}`);
          if (v === 0) {
            black += 1;
            if (y < 40) topBlack += 1;
            if (y >= 80) bottomBlack += 1;
          }
        }
      }
      const view = report.views.find((v) => v.id === id)!;
      assert.equal(black, Math.round(view.coverageRatio * 160 * 120), `${id} mask disagrees with coverage`);
      if (id === 'ortho-front') assert.ok(bottomBlack > topBlack * 2, `${id} looks flipped (${topBlack} top vs ${bottomBlack} bottom)`);
    }
    const plain = JSON.parse(cli('turntable', cone, '--out', path.join(dir, 'no-black-fill'), '--tile-size', '96x72').stdout) as TurntableReport;
    assert.equal(plain.silhouetteSheetPath, null);
    assert.equal(fs.existsSync(path.join(dir, 'no-black-fill', 'silhouette-sheet.png')), false);
  });

  it('renders every lighting preset without a flat beauty tile and with distinct pixels', () => {
    const hashes = new Set<string>();
    for (const lighting of ['studio', 'cel', 'dramatic']) {
      const out = path.join(dir, `light-${lighting}`);
      const result = cli('turntable', box, '--out', out, '--tile-size', '128x96', '--lighting', lighting);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout) as TurntableReport;
      assert.equal(report.capture.lighting, lighting);
      assert.ok(!report.findings.some((f) => f.id === 'VIEW_BEAUTY_FLAT'));
      hashes.add(crypto.createHash('sha256').update(fs.readFileSync(path.join(out, 'contact-sheet.png'))).digest('hex'));
    }
    assert.equal(hashes.size, 3);
  });

  it('rejects malformed capture flags with exit 2', () => {
    const out = path.join(dir, 'bad-flags');
    for (const args of [
      ['--tile-size', '840'],
      ['--tile-size', '32x32'],
      ['--tile-size', '4096x300'],
      ['--zoom', '0'],
      ['--zoom', '1e3'],
      ['--lighting', 'neon'],
      ['--save-views', '--no-fail-on-console-error', '--fail-on-console-error'],
    ]) {
      const result = cli('turntable', box, '--out', out, ...args);
      assert.equal(result.status, 2, `${args.join(' ')} should exit 2`);
    }
  });
});

describe('console error gate', () => {
  const brokenShader = factory('broken-shader.mjs', `return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.ShaderMaterial({
    vertexShader: 'void main() { gl_Position = vec4(position, 1.0); }',
    fragmentShader: 'void main() { gl_FragColor = vec4(undefinedThing, 1.0); }',
  }));`);

  it('fails a turntable whose shader does not compile, with the WebGL diagnostic in the finding', () => {
    const result = cli('turntable', brokenShader, '--out', path.join(dir, 'shader'), '--tile-size', '96x72');
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as TurntableReport;
    const finding = report.findings.find((f) => f.id === 'CONSOLE_ERROR');
    assert.equal(finding?.severity, 'fail');
    assert.match(finding?.message ?? '', /undefinedThing|Shader Error|compile/i);
    assert.ok(report.consoleErrors.length > 0);
  });

  it('reports the same errors as a warning with --no-fail-on-console-error', () => {
    const result = cli(
      'turntable', brokenShader, '--out', path.join(dir, 'shader-warn'), '--tile-size', '96x72', '--no-fail-on-console-error',
    );
    const report = JSON.parse(result.stdout) as TurntableReport;
    assert.equal(report.findings.find((f) => f.id === 'CONSOLE_ERROR')?.severity, 'warn');
    assert.ok(!report.findings.some((f) => f.id === 'CONSOLE_ERROR' && f.severity === 'fail'));
  });

  it('catches console.error during check, and passes a clean asset with the explicit flag', () => {
    const noisy = factory('noisy.mjs', `console.error('texture atlas missing');
      return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());`);
    const result = cli('check', noisy);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as Check3DReport;
    assert.deepEqual(report.consoleErrors, ['texture atlas missing']);
    assert.equal(cli('check', box, '--fail-on-console-error').status, 0);
  });
});

describe('palette sampling', () => {
  it('lists each sampled color with its nearest role and skips colorless ShaderMaterials', async () => {
    const asset = factory('two-tone.mjs', `const root = new THREE.Group();
      root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: 0xe88332 })));
      const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: 0x232838 }));
      b.position.x = 2; root.add(b);
      const glow = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.ShaderMaterial({
        vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }',
      }));
      glow.position.x = -2; root.add(glow);
      return root;`);
    const card: StyleCard = {
      id: 'two-tone', palette: { 'amber-trim': '#e88332', 'obsidian-hull': '#232838' }, paletteDeltaE76Max: 1,
    };
    const session = await runAssetSession({ assetPath: asset, card, renderSheet: false });
    const palette = session.metrics.palette;
    assert.equal(palette.status, 'partial_textured');
    assert.equal(palette.shaderMeshes, 1);
    assert.equal(palette.assessedMeshes, 2);
    assert.equal(palette.distinctColors, 2);
    assert.deepEqual(palette.colors.map((c) => [c.hexSrgb, c.nearestRole]).sort(), [
      ['#232838', 'obsidian-hull'],
      ['#e88332', 'amber-trim'],
    ]);
    const evaluated = evaluateAssetGates(session.metrics, card);
    assert.equal(evaluated.ok, true);
    assert.ok(evaluated.findings.some((f) => f.id === 'PALETTE_UNASSESSED_SHADER'));
  });

  const celShader = (albedo: string, extra = '') => `new THREE.ShaderMaterial({
    uniforms: {
      uAlbedo: { value: new THREE.Color(${albedo}) },
      uEmissive: { value: new THREE.Color(0x200000) },
      uEmissiveIntensity: { value: 0.5 },
      uBandBase: { value: new THREE.Vector3(9, 9, 9) },
      ${extra}
    },
    vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uAlbedo; void main() { gl_FragColor = vec4(uAlbedo, 1.0); }',
  })`;
  const hullCard = fixture('hull-card.json', JSON.stringify({
    id: 'hull', palette: { 'ivory-hull': '#ede6d5', 'obsidian-hull': '#232838' }, paletteDeltaE76Max: 3,
  }));

  it('scores a ShaderMaterial uAlbedo plus uEmissive times uEmissiveIntensity', async () => {
    const asset = factory('cel-hull.mjs', `return new THREE.Mesh(new THREE.BoxGeometry(), ${celShader('0xede6d5')});`);
    const result = cli('check', asset, '--card', hullCard);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const palette = (JSON.parse(result.stdout) as Check3DReport).metrics.palette;
    assert.deepEqual([palette.status, palette.assessedMeshes, palette.shaderMeshes, palette.shaderUniformMeshes], ['assessed', 1, 0, 1]);
    const lin = hexSrgbToLinearRgb('#ede6d5');
    const red = Math.min(1, lin[0] + 0.5 * hexSrgbToLinearRgb('#200000')[0]);
    assert.equal(palette.colors[0]?.hexSrgb, linearRgbToHexSrgb(red, lin[1], lin[2]));
  });

  it('fails an off-palette uAlbedo on a ShaderMaterial', () => {
    const asset = factory('cel-off.mjs', `return new THREE.Mesh(new THREE.BoxGeometry(), ${celShader('0x00c040')});`);
    const result = cli('check', asset, '--card', hullCard);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as Check3DReport;
    const finding = report.findings.find((f) => f.id === 'PALETTE_DELTA_E_EXCEEDED');
    assert.ok(finding !== undefined);
    assert.ok(typeof finding.actual === 'number' && finding.actual > 30);
    assert.equal(report.findings.some((f) => f.id === 'PALETTE_UNASSESSED_SHADER'), false);
  });

  it('reads the uniforms a card names and still treats a textured shader as textured', async () => {
    const asset = factory('cel-custom.mjs', `const root = new THREE.Group();
      const custom = new THREE.ShaderMaterial({
        uniforms: { tint: { value: new THREE.Color(0x232838) }, uAlbedo: { value: new THREE.Color(0x00ff00) } },
        vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 tint; void main() { gl_FragColor = vec4(tint, 1.0); }',
      });
      root.add(new THREE.Mesh(new THREE.BoxGeometry(), custom));
      const tex = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
      const mapped = new THREE.Mesh(new THREE.BoxGeometry(), ${celShader('0xffffff', 'uMap: { value: tex },')});
      mapped.position.x = 2; root.add(mapped);
      return root;`);
    const card: StyleCard = {
      id: 'custom', palette: { 'obsidian-hull': '#232838' }, paletteDeltaE76Max: 1, shaderColorUniforms: ['tint'],
    };
    const session = await runAssetSession({ assetPath: asset, card, renderSheet: false });
    const palette = session.metrics.palette;
    assert.deepEqual([palette.status, palette.shaderUniformMeshes, palette.texturedMeshes], ['partial_textured', 1, 1]);
    assert.deepEqual(palette.colors.map((c) => c.hexSrgb), ['#232838']);
    assert.equal(evaluateAssetGates(session.metrics, card).ok, true);
  });

  it('rejects malformed shader uniform lists in a card', () => {
    const asset = factory('cel-ok.mjs', `return new THREE.Mesh(new THREE.BoxGeometry(), ${celShader('0xede6d5')});`);
    for (const bad of [{ shaderColorUniforms: [] }, { shaderColorUniforms: ['u-bad'] }, { shaderEmissiveUniforms: ['uEmissive'] }]) {
      const card = fixture('bad-shader-card.json', JSON.stringify({ id: 'bad', ...bad }));
      const result = cli('check', asset, '--card', card);
      assert.equal(result.status, 2, JSON.stringify(bad));
      assert.match(JSON.parse(result.stderr).message, /shader(Color|Emissive)Uniforms/);
    }
  });
});

describe('geometry gates', () => {
  const measure = async (name: string, body: string, card: StyleCard) => {
    const session = await runAssetSession({ assetPath: factory(name, body), card, renderSheet: false });
    return { shape: session.metrics.shape!, result: evaluateAssetGates(session.metrics, card) };
  };
  const ids = (r: { readonly findings: readonly { readonly id: string }[] }) => r.findings.map((f) => f.id);

  it('measures mirror symmetry across the width axis', async () => {
    const card: StyleCard = { id: 'sym', geometry: { mirrorSymmetryMin: 0.95 } };
    const sym = await measure('sym.mjs', 'return new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshBasicMaterial());', card);
    assert.equal(sym.shape.mirror.planeAxis, 'x');
    assert.equal(sym.shape.mirror.matchRatio, 1);
    assert.deepEqual(ids(sym.result), []);

    const lopsided = await measure('lopsided.mjs', `const root = new THREE.Group();
      root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshBasicMaterial()));
      const pod = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), new THREE.MeshBasicMaterial());
      pod.position.set(1.6, 0, 1); root.add(pod);
      return root;`, card);
    assert.ok(lopsided.shape.mirror.matchRatio < 0.95, `match ${lopsided.shape.mirror.matchRatio}`);
    assert.deepEqual(ids(lopsided.result), ['MIRROR_SYMMETRY_LOW']);
  });

  it('keeps mirror symmetry exact when the vertex count exceeds the query sample cap', async () => {
    const card: StyleCard = { id: 'sym-dense', geometry: { mirrorSymmetryMin: 0.99 } };
    // 72,000 vertices laid out as (p, mirror(p)) pairs, so a strided grid would hold only one side.
    const dense = await measure('dense.mjs', `let seed = 7;
      const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const pos = new Float32Array(72000 * 3);
      for (let i = 0; i < 36000; i += 1) {
        const x = 0.1 + rand(), y = rand(), z = rand();
        pos.set([x, y, z, -x, y, z], i * 6);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      return new THREE.Mesh(geo, new THREE.MeshBasicMaterial());`, card);
    assert.equal(dense.shape.mirror.sampledPoints, 36000);
    assert.equal(dense.shape.mirror.matchRatio, 1);
    assert.deepEqual(ids(dense.result), []);
  });

  it('flags floating, sinking, and point-contact assets against ground rules', async () => {
    const card: StyleCard = { id: 'ground', geometry: { groundContact: true, groundFootprintMin: 0.25 } };
    const grounded = await measure('grounded.mjs', `const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      m.position.y = 0.5; return m;`, card);
    assert.equal(grounded.shape.groundOffset, 0);
    assert.equal(grounded.shape.groundFootprintRatio, 1);
    assert.deepEqual(ids(grounded.result), []);

    const floating = await measure('floating.mjs', `const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      m.position.y = 0.8; return m;`, card);
    assert.deepEqual(ids(floating.result), ['GROUND_FLOATING']);
    const sinking = await measure('sinking.mjs', 'return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());', card);
    assert.deepEqual(ids(sinking.result), ['GROUND_SINKING']);

    const spike = await measure('spike.mjs', `const m = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 8), new THREE.MeshBasicMaterial());
      m.rotation.x = Math.PI; m.position.y = 0.5; return m;`, card);
    assert.ok(Math.abs(spike.shape.groundOffset) < 1e-6);
    assert.ok((spike.shape.groundFootprintRatio ?? 1) < 0.01);
    assert.deepEqual(ids(spike.result), ['GROUND_FOOTPRINT_SMALL']);
  });

  it('checks length/width and height/length against the front axis', async () => {
    const body = 'return new THREE.Mesh(new THREE.BoxGeometry(2, 1, 8), new THREE.MeshBasicMaterial());';
    const zFront = await measure('long.mjs', body, { id: 'z', frontAxis: '-Z', geometry: { lengthToWidth: [3, 5], heightToLength: [0.1, 0.2] } });
    assert.equal(zFront.shape.lengthToWidth, 4);
    assert.equal(zFront.shape.heightToLength, 0.125);
    assert.deepEqual(ids(zFront.result), []);
    const xFront = await measure('long-x.mjs', body, { id: 'x', frontAxis: '+X', geometry: { lengthToWidth: [3, 5] } });
    assert.equal(xFront.shape.lengthAxis, 'x');
    assert.equal(xFront.shape.lengthToWidth, 0.25);
    assert.deepEqual(ids(xFront.result), ['ASPECT_LENGTH_TO_WIDTH']);
  });

  it('rejects malformed geometry card entries with exit 2', () => {
    for (const geometry of [{ mirrorSymmetry: 1 }, { lengthToWidth: [3, 1] }, { groundContact: 'yes' }, { mirrorSymmetryMin: 2 }]) {
      const card = fixture('geo-card.json', JSON.stringify({ id: 'geo', geometry }));
      assert.equal(cli('check', box, '--card', card).status, 2, JSON.stringify(geometry));
    }
  });
});

describe('quantized GLB bounds', () => {
  it('matches gltf-transform getBounds on normalized int16 positions under a node transform', async () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    // Quantized positions span the full int16 range; only the node scale maps them to meters.
    const positions = new Int16Array([
      -32767, 0, -32767, 32767, 0, -32767, 0, 0, 32767,
      -32767, 0, -32767, 0, 0, 32767, 0, 16000, 0,
      32767, 0, -32767, 0, 16000, 0, 0, 0, 32767,
    ]);
    const accessor = doc.createAccessor().setType('VEC3').setArray(positions).setNormalized(true).setBuffer(buffer);
    const prim = doc.createPrimitive().setAttribute('POSITION', accessor);
    const node = doc.createNode('ship').setMesh(doc.createMesh('ship').addPrimitive(prim))
      .setScale([3, 2, 5]).setTranslation([0, 1.5, 0]);
    const scene = doc.createScene('scene').addChild(node);
    const file = path.join(dir, 'quantized.glb');
    await new NodeIO().write(file, doc);

    const reference = getBounds(scene);
    const session = await runAssetSession({ assetPath: file, card: null, renderSheet: false });
    const bounds = session.metrics.worldBounds!;
    const measured = [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z];
    const expected = [...reference.min, ...reference.max];
    for (const [i, v] of measured.entries()) {
      assert.ok(Math.abs(v - expected[i]!) < 1e-4, `bound ${i}: ${v} vs ${expected[i]}`);
    }
    assert.equal(session.metrics.shape?.groundOffset, bounds.min.y);
    assert.ok(Math.abs(bounds.min.y - 1.5) < 1e-4);
  });
});

describe('batch', () => {
  const okCard = { id: 'batch-card', palette: { amber: '#cc8844' }, paletteDeltaE76Max: 2 };

  it('runs every asset, writes per-asset folders and a summary, and exits 1 on a gate failure', () => {
    const batchDir = path.join(dir, 'batch-a');
    fs.mkdirSync(batchDir, { recursive: true });
    fs.copyFileSync(box, path.join(batchDir, 'b-good.mjs'));
    fs.writeFileSync(path.join(batchDir, 'a-off-palette.mjs'), `export function buildAsset(THREE) {
      return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x0044ff }));
    }`);
    fs.writeFileSync(path.join(batchDir, 'card.json'), JSON.stringify(okCard));
    fs.writeFileSync(path.join(batchDir, 'types.d.ts'), 'export {};');
    fs.writeFileSync(path.join(batchDir, 'notes.txt'), 'ignored');
    assert.deepEqual(listBatchAssets(batchDir).map((f) => path.basename(f)), ['a-off-palette.mjs', 'b-good.mjs']);

    const out = path.join(dir, 'batch-a-out');
    const result = cli('batch', batchDir, '--card', path.join(batchDir, 'card.json'), '--out', out, '--tile-size', '96x72', '--black-fill');
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(result.stdout) as BatchReport;
    assert.deepEqual(summary, JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8')));
    assert.equal(summary.schemaVersion, 'agent-3d/batch/v1');
    assert.equal(summary.cardId, 'batch-card');
    assert.deepEqual([summary.total, summary.passed, summary.failed, summary.ok], [2, 1, 1, false]);
    const [bad, good] = summary.assets;
    assert.equal(bad?.name, 'a-off-palette');
    assert.deepEqual(bad?.failures, ['PALETTE_DELTA_E_EXCEEDED']);
    assert.equal(good?.ok, true);
    assert.equal(good?.triangles, 12);
    assert.equal(good?.degenerateTriangles, 0);
    assert.equal(good?.paletteStatus, 'assessed');
    for (const name of ['a-off-palette', 'b-good']) {
      assert.ok(fs.existsSync(path.join(out, name, 'contact-sheet.png')));
      assert.ok(fs.existsSync(path.join(out, name, 'report.json')));
      assert.deepEqual(pngSize(path.join(out, name, 'silhouette-sheet.png')), { width: 192, height: 26 + 72 });
    }
    assert.equal(summary.blackFillMasksPath, path.join(out, 'black-fill-masks.png'));
    const masks = pngRed(path.join(out, 'black-fill-masks.png'));
    assert.deepEqual([masks.width, masks.height], [192, 2 * (26 + 26 + 72)]);
    // Each asset row's mask area matches that asset's own silhouette sheet.
    const goodSheet = pngRed(path.join(out, 'b-good', 'silhouette-sheet.png'));
    const rowStart = (26 + 26 + 72) + 26 + 26;
    for (let i = 0; i < 192 * 72; i += 1) {
      assert.equal(masks.red[rowStart * 192 + i], goodSheet.red[26 * 192 + i]);
    }
    assert.match(result.stderr, /^asset\s+tris\s+degen\s+palette/m);
    assert.match(result.stderr, /1\/2 passed against card 'batch-card'/);
    assert.equal(fs.readFileSync(path.join(out, 'summary.txt'), 'utf8'), result.stderr);
  });

  it('keeps going after an asset throws and exits 2', () => {
    const batchDir = path.join(dir, 'batch-b');
    fs.mkdirSync(batchDir, { recursive: true });
    fs.writeFileSync(path.join(batchDir, 'a-throws.mjs'), 'export function buildAsset() { throw new Error("boom"); }');
    fs.copyFileSync(box, path.join(batchDir, 'b-good.mjs'));
    const result = cli('batch', batchDir, '--out', path.join(dir, 'batch-b-out'), '--tile-size', '96x72');
    assert.equal(result.status, 2, result.stderr);
    const summary = JSON.parse(result.stdout) as BatchReport;
    assert.match(summary.assets[0]?.error ?? '', /boom/);
    assert.equal(summary.assets[1]?.ok, true);
    assert.match(result.stderr, /a-throws: .*boom/);
  });

  it('refuses an empty directory and assets that would share an output folder', () => {
    const empty = path.join(dir, 'batch-empty');
    fs.mkdirSync(empty, { recursive: true });
    assert.equal(cli('batch', empty, '--out', path.join(dir, 'x')).status, 2);
    const clash = path.join(dir, 'batch-clash');
    fs.mkdirSync(clash, { recursive: true });
    fs.copyFileSync(box, path.join(clash, 'ship.mjs'));
    fs.copyFileSync(box, path.join(clash, 'ship.js'));
    assert.throws(() => listBatchAssets(clash), /share the output folder 'ship'/);
  });
});

describe('gpu-probe', () => {
  it('uses the full SwiftShader WebGPU flag set and never --disable-vulkan-surface', () => {
    assert.deepEqual([...WEBGPU_SWIFTSHADER_FLAGS].sort(), [
      '--enable-features=Vulkan',
      '--enable-unsafe-swiftshader',
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      '--use-angle=swiftshader',
      '--use-gl=angle',
      '--use-vulkan=swiftshader',
      '--use-webgpu-adapter=swiftshader',
    ]);
    assert.ok(!WEBGPU_SWIFTSHADER_FLAGS.some((f) => f.startsWith('--disable-vulkan-surface')));
  });

  it('maps backends and colour counts to exit codes', () => {
    const gl = { backend: 'WebGLRenderer', uniqueColors: 900, error: null };
    assert.equal(classifyGpuProbe({ backend: 'WebGPUBackend', uniqueColors: 50, error: null }, gl).exitCode, 0);
    assert.equal(classifyGpuProbe({ backend: 'WebGPUBackend', uniqueColors: 49, error: null }, gl).exitCode, 1);
    assert.equal(classifyGpuProbe({ backend: 'WebGLBackend', uniqueColors: 900, error: null }, gl).exitCode, 3);
    assert.equal(classifyGpuProbe({ backend: null, uniqueColors: 0, error: 'no adapter' }, gl).exitCode, 3);
    assert.equal(
      classifyGpuProbe({ backend: null, uniqueColors: 0, error: 'x' }, { backend: null, uniqueColors: 0, error: 'y' }).exitCode,
      4,
    );
  });

  it('runs end to end on the bundled Chromium and always renders the WebGL reference', async () => {
    const out = path.join(dir, 'gpu');
    const result = await runGpuProbe({ browser: 'chromium', headed: false, timeoutMs: 60000, outDir: out });
    assert.ok([0, 1, 3].includes(result.exitCode), `unexpected verdict ${result.verdict}`);
    assert.ok(result.webgl.uniqueColors >= 50);
    assert.equal(result.ok, result.exitCode === 0);
    for (const name of ['probe.json', 'REPORT.md', 'webgl.png']) {
      assert.ok(fs.existsSync(path.join(out, name)), `missing ${name}`);
    }
  });
});
