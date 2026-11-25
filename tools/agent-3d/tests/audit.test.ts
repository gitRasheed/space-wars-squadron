import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateAssetGates, nearestPaletteMatch, type Check3DReport, type TurntableReport } from '../src/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = fs.mkdtempSync(path.join(root, 'dist-test', 'assets-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture(name: string, contents: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [path.join(root, 'dist/cli.js'), ...args], {
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.ifError(result.error);
  return result;
}

function turntable(body: string, expectedExit: number): TurntableReport {
  const asset = fixture('model.mjs', 'export function buildAsset(THREE) {\n' + body + '\n}');
  const result = cli('turntable', asset, '--out', dir);
  assert.equal(result.status, expectedExit, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as TurntableReport;
}

describe('turntable gates', () => {
  it('accepts a single-material lit box, including its flat orthographic faces', () => {
    const report = turntable(`return new THREE.Mesh(new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial({ color: 0xcc8844 }));`, 0);
    assert.equal(report.views.length, 9);
    assert.ok(report.views.some(view => view.ortho && view.beautyUniqueColors <= 3));
  });

  it('still rejects a one-color beauty tile with a measurable silhouette', () => {
    const report = turntable(`return new THREE.Mesh(new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial({ colorWrite: false }));`, 1);
    assert.ok(report.views.every(view => view.beautyUniqueColors === 1 && view.coverageRatio > 0.01));
    assert.ok(report.findings.some(f => f.id === 'VIEW_BEAUTY_FLAT'));
  });

  const insideOut = `const geometry = new THREE.BoxGeometry();
    geometry.index.array.reverse();`;
  it('detects reversed winding even when the far faces fill the outline', () => {
    const report = turntable(insideOut + `
      return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());`, 1);
    assert.ok(report.views.every(view => view.coverageRatio > 0.01));
    assert.ok(report.findings.some(f => f.id === 'INVERTED_WINDING' && f.severity === 'fail'));
  });

  it('respects intentionally double- and back-sided material groups', () => {
    const report = turntable(insideOut + `
      const materials = geometry.groups.map((_, i) => new THREE.MeshStandardMaterial({
        side: i % 2 ? THREE.BackSide : THREE.DoubleSide
      }));
      return new THREE.Mesh(geometry, materials);`, 0);
    assert.equal(report.findings.length, 0);
  });
});

describe('CLI inputs and palette gates', () => {
  it('exits 2 when a factory never resolves', () => {
    const factory = fixture('pending.mjs', 'export function buildAsset() { return new Promise(() => {}); }');
    const result = cli('check', factory, '--timeout', '500');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /timed out.*500 ms/i);
  });

  it('also bounds module loading during a turntable', () => {
    const factory = fixture('pending-import.mjs', 'await new Promise(() => {}); export default () => {};');
    const result = cli('turntable', factory, '--out', dir, '--timeout', '500');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /timed out.*500 ms/i);
  });

  it('rejects JSON glTF with a single CLI diagnostic', () => {
    const result = cli('check', fixture('external.gltf', '{"asset":{"version":"2.0"}}'));
    assert.equal(result.status, 2);
    assert.match(JSON.parse(result.stderr).message, /unsupported.*\.gltf.*\.glb/i);
  });

  it('includes emissive intensity in the shared browser and Node palette calculation', () => {
    const asset = fixture('emissive.mjs', `export function buildAsset(THREE) {
      return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({
        color: 0x000000, emissive: new THREE.Color().setRGB(0.25, 0, 0.25), emissiveIntensity: 3
      }));
    }`);
    const card = fixture('ink.json', JSON.stringify({
      id: 'ink', palette: { ink: '#000000' }, paletteDeltaE76Max: 1
    }));
    const result = cli('check', asset, '--card', card);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as Check3DReport;
    const expected = nearestPaletteMatch([0.75, 0, 0.75], { ink: '#000000' });
    assert.equal(report.metrics.palette.maxDeltaE76, expected.deltaE76);
    assert.ok(report.findings.some(f => f.id === 'PALETTE_DELTA_E_EXCEEDED'));
  });

  it('names each GLB-only budget skipped on a factory and enforces GLB bytes on a GLB', () => {
    const asset = fixture('budget.mjs', `export function buildAsset(THREE) {
      return new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    }`);
    const factory = cli('check', asset);
    const glb = cli('check', path.join(root, 'tests/fixtures/BoxVertexColors.glb'));
    assert.equal(factory.status, 0);
    assert.equal(glb.status, 0);
    const { metrics } = JSON.parse(factory.stdout) as Check3DReport;
    for (const budgets of [{ bytesMax: 0 }, { requireTriangleLists: true }]) {
      const result = evaluateAssetGates(metrics, { id: 'budget', budgets });
      assert.equal(result.ok, true);
      assert.ok(result.findings.some(f => f.severity === 'info' && f.message.includes(Object.keys(budgets)[0]!)));
    }
    const result = evaluateAssetGates(JSON.parse(glb.stdout).metrics, { id: 'budget', budgets: { bytesMax: 0 } });
    assert.deepEqual(result.findings.map(f => f.id), ['GLB_BYTES_OVER_BUDGET']);
  });
});

it('packages the CLI, browser color module, and guides with Three.js as a peer', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.peerDependencies.three);
  assert.equal(manifest.peerDependencies.three, manifest.devDependencies.three);
  assert.equal(manifest.dependencies.three, undefined);
  const pack = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const files = JSON.parse(pack.stdout)[0].files.map((file: { path: string }) => file.path);
  for (const name of ['dist/cli.js', 'dist/color.js', 'dist/evaluate.js', 'dist/harness.js', 'dist/gpuProbe.js', 'dist/index.d.ts', 'README.md', 'SKILL.md', 'LICENSE']) {
    assert.ok(files.includes(name), `Missing ${name} from tarball`);
  }
});
