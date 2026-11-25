#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CAPTURE, DEFAULT_TIMEOUT_MS, runAssetSession, stackLabeledPngs } from './browserRuntime.js';
import { evaluateAssetGates } from './evaluate.js';
import { runGpuProbe } from './gpuProbe.js';
import type {
  AxisDirection,
  BatchAssetRow,
  BatchReport,
  CaptureSettings,
  Check3DReport,
  LightingPreset,
  StyleCard,
  TurntableReport,
} from './types.js';

const VALID_AXES = new Set<AxisDirection>(['+X', '-X', '+Y', '-Y', '+Z', '-Z']);
const VALID_HORIZONTAL_AXES = new Set<AxisDirection>(['+X', '-X', '+Z', '-Z']);
const VALID_CARD_KEYS = new Set([
  'id',
  'frontAxis',
  'topUpAxis',
  'pivot',
  'pivotToleranceFraction',
  'palette',
  'paletteDeltaE76Max',
  'requirePaletteOnTextured',
  'shaderColorUniforms',
  'shaderEmissiveUniforms',
  'separationMinDeltaE76',
  'separationRoles',
  'budgets',
  'geometry',
]);
const VALID_BUDGET_KEYS = new Set([
  'trisMax',
  'materialsMax',
  'texturesMax',
  'bytesMax',
  'degenerateTrianglesMax',
  'requireTriangleLists',
]);
const VALID_GEOMETRY_KEYS = new Set([
  'groundContact',
  'groundToleranceFraction',
  'groundFootprintMin',
  'mirrorSymmetryMin',
  'symmetryToleranceFraction',
  'lengthToWidth',
  'heightToLength',
]);
const LIGHTING_PRESETS = new Set<LightingPreset>(['studio', 'cel', 'dramatic']);
const BATCH_ASSET_EXTENSIONS = new Set(['.glb', '.ts', '.mts', '.js', '.mjs']);
const MIN_TILE = 64;
const MAX_TILE = 2048;
const CONSOLE_FLAGS = ['--fail-on-console-error', '--no-fail-on-console-error'];
const CAPTURE_VALUE_FLAGS = ['--tile-size', '--zoom', '--lighting'];
const CAPTURE_SWITCHES = ['--zoom-ortho', '--save-views', '--black-fill'];

function usage(): string {
  return [
    'Usage:',
    '  agent-3d check <asset> [--card <style-card.json>] [--out <report.json>] [--timeout <ms>] [--no-fail-on-console-error]',
    '  agent-3d turntable <asset> --out <dir> [--card <style-card.json>] [--timeout <ms>] [capture options]',
    '  agent-3d batch <dir> --out <dir> [--card <style-card.json>] [--timeout <ms>] [capture options]',
    '  agent-3d gpu-probe [--out <dir>] [--browser chrome|chromium] [--headed] [--timeout <ms>]',
    '',
    '<asset> is a .glb or a factory module (.ts, .mts, .js, .mjs). batch runs every such file in <dir>.',
    'Capture options:',
    '  --tile-size <WxH>         view tile size in pixels (default 420x315, each side 64-2048)',
    '  --zoom <factor>           perspective framing multiplier, 0.25-8 (default 1; above 1 edge clipping is info)',
    '  --zoom-ortho              apply --zoom to the ortho views too (default: they stay at 1)',
    '  --lighting <preset>       studio (default), cel, or dramatic',
    '  --save-views              also write <view-id>.png for each of the nine views',
    '  --black-fill              write silhouette-sheet.png (batch: black-fill-masks.png), ortho-top and',
    '                            ortho-front as black silhouettes on white',
    '  --no-fail-on-console-error  report browser console errors as warnings instead of failing',
    'Exit codes: 0 pass, 1 gate violation, 2 invalid input / unsupported gate / renderer error',
    'gpu-probe exit codes: 0 WebGPU ok, 1 WebGPU blank, 2 launch error, 3 silent WebGL fallback, 4 WebGL failed too',
  ].join('\n');
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

interface ParsedArgs {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

function parseArgs(
  args: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = [],
): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) {
      continue;
    }
    if (token.startsWith('--')) {
      if (booleanFlags.includes(token)) {
        switches.add(token);
        continue;
      }
      if (!valueFlags.includes(token)) {
        throw new Error(`Unknown flag: ${token}`);
      }
      const val = args[i + 1];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`Flag ${token} requires a value`);
      }
      flags.set(token, val);
      i += 1;
    } else {
      positional.push(token);
    }
  }
  if (switches.has('--fail-on-console-error') && switches.has('--no-fail-on-console-error')) {
    throw new Error('--fail-on-console-error and --no-fail-on-console-error are mutually exclusive');
  }
  return { positional, flags, switches };
}

function parseTimeout(flags: ReadonlyMap<string, string>): number {
  return Number(flags.get('--timeout') ?? DEFAULT_TIMEOUT_MS);
}

function parseCapture(flags: ReadonlyMap<string, string>, switches: ReadonlySet<string>): CaptureSettings {
  let { tileWidth, tileHeight, zoom, lighting } = DEFAULT_CAPTURE;
  const tile = flags.get('--tile-size');
  if (tile !== undefined) {
    const m = /^(\d+)x(\d+)$/.exec(tile);
    const w = Number(m?.[1]);
    const h = Number(m?.[2]);
    if (m === null || w < MIN_TILE || h < MIN_TILE || w > MAX_TILE || h > MAX_TILE) {
      throw new Error(`--tile-size must be <W>x<H> with each side ${MIN_TILE}-${MAX_TILE}, got '${tile}'`);
    }
    tileWidth = w;
    tileHeight = h;
  }
  const zoomFlag = flags.get('--zoom');
  if (zoomFlag !== undefined) {
    zoom = Number(zoomFlag);
    if (!/^\d+(\.\d+)?$/.test(zoomFlag) || zoom < 0.25 || zoom > 8) {
      throw new Error(`--zoom must be a number from 0.25 to 8, got '${zoomFlag}'`);
    }
  }
  const lightingFlag = flags.get('--lighting');
  if (lightingFlag !== undefined) {
    if (!LIGHTING_PRESETS.has(lightingFlag as LightingPreset)) {
      throw new Error(`--lighting must be one of ${[...LIGHTING_PRESETS].join(', ')}, got '${lightingFlag}'`);
    }
    lighting = lightingFlag as LightingPreset;
  }
  return { tileWidth, tileHeight, zoom, zoomOrtho: switches.has('--zoom-ortho'), lighting };
}

function validateRange(value: unknown, name: string): void {
  if (
    !Array.isArray(value) || value.length !== 2 || !isFiniteNum(value[0]) || !isFiniteNum(value[1]) ||
    value[0] < 0 || value[0] > value[1]
  ) {
    throw new Error(`geometry.${name} must be [min, max] with 0 <= min <= max`);
  }
}

function validateGeometry(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('geometry must be a JSON object');
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!VALID_GEOMETRY_KEYS.has(k)) {
      throw new Error(`Unknown geometry key '${k}'`);
    }
    if (k === 'groundContact') {
      if (typeof v !== 'boolean') throw new Error('geometry.groundContact must be boolean');
    } else if (k === 'lengthToWidth' || k === 'heightToLength') {
      validateRange(v, k);
    } else if (!isFiniteNum(v) || v < 0 || v > 1) {
      throw new Error(`geometry.${k} must be a number from 0 to 1, got ${String(v)}`);
    }
  }
}

function validateCard(parsed: unknown, cardPath: string): StyleCard {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Style card must be a JSON object: ${cardPath}`);
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!VALID_CARD_KEYS.has(key)) {
      throw new Error(`Unknown style card key '${key}' in ${cardPath}`);
    }
  }
  if (typeof obj['id'] !== 'string' || obj['id'].trim().length === 0) {
    throw new Error(`Style card requires a non-empty string id: ${cardPath}`);
  }
  if (obj['frontAxis'] !== undefined) {
    if (typeof obj['frontAxis'] !== 'string' || !VALID_AXES.has(obj['frontAxis'] as AxisDirection)) {
      throw new Error(`Invalid frontAxis: ${String(obj['frontAxis'])}`);
    }
  }
  if (obj['topUpAxis'] !== undefined) {
    if (
      typeof obj['topUpAxis'] !== 'string' ||
      !VALID_HORIZONTAL_AXES.has(obj['topUpAxis'] as AxisDirection)
    ) {
      throw new Error(`topUpAxis must be +X, -X, +Z, or -Z (cannot be parallel to Y): ${String(obj['topUpAxis'])}`);
    }
  }
  if (obj['pivot'] !== undefined && obj['pivot'] !== 'center' && obj['pivot'] !== 'ground') {
    throw new Error(`Invalid pivot: ${String(obj['pivot'])}`);
  }
  if (
    obj['pivotToleranceFraction'] !== undefined &&
    (!isFiniteNum(obj['pivotToleranceFraction']) || obj['pivotToleranceFraction'] < 0)
  ) {
    throw new Error(`Invalid pivotToleranceFraction: ${String(obj['pivotToleranceFraction'])}`);
  }
  if (obj['palette'] !== undefined) {
    if (typeof obj['palette'] !== 'object' || obj['palette'] === null || Array.isArray(obj['palette'])) {
      throw new Error('Style card palette must be a role -> #RRGGBB map');
    }
    for (const [role, hex] of Object.entries(obj['palette'] as Record<string, unknown>)) {
      if (typeof hex !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(hex.trim())) {
        throw new Error(`Invalid palette hex for role '${role}': ${String(hex)}`);
      }
    }
  }
  if (
    obj['paletteDeltaE76Max'] !== undefined &&
    (!isFiniteNum(obj['paletteDeltaE76Max']) || obj['paletteDeltaE76Max'] < 0)
  ) {
    throw new Error(`Invalid paletteDeltaE76Max: ${String(obj['paletteDeltaE76Max'])}`);
  }
  if (
    obj['requirePaletteOnTextured'] !== undefined &&
    typeof obj['requirePaletteOnTextured'] !== 'boolean'
  ) {
    throw new Error(`Invalid requirePaletteOnTextured: ${String(obj['requirePaletteOnTextured'])}`);
  }
  const uniformNames = (key: string, min: number, max: number): void => {
    const v = obj[key];
    if (v === undefined) return;
    if (
      !Array.isArray(v) || v.length < min || v.length > max ||
      !v.every((n) => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
    ) {
      throw new Error(`${key} must be an array of ${min === max ? min : `${min}-${max}`} GLSL uniform names`);
    }
  };
  uniformNames('shaderColorUniforms', 1, 16);
  uniformNames('shaderEmissiveUniforms', 2, 2);
  if (
    obj['separationMinDeltaE76'] !== undefined &&
    (!isFiniteNum(obj['separationMinDeltaE76']) || obj['separationMinDeltaE76'] < 0)
  ) {
    throw new Error(`Invalid separationMinDeltaE76: ${String(obj['separationMinDeltaE76'])}`);
  }
  if (obj['separationRoles'] !== undefined) {
    if (!Array.isArray(obj['separationRoles'])) {
      throw new Error('separationRoles must be an array of [roleA, roleB] pairs');
    }
    if (obj['palette'] === undefined || Object.keys(obj['palette'] as object).length === 0) {
      throw new Error('separationRoles requires a non-empty palette');
    }
    for (const pair of obj['separationRoles']) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
        throw new Error('Each separationRoles entry must be a [string, string] pair');
      }
    }
  }
  if (obj['budgets'] !== undefined) {
    if (typeof obj['budgets'] !== 'object' || obj['budgets'] === null || Array.isArray(obj['budgets'])) {
      throw new Error('budgets must be a JSON object');
    }
    const b = obj['budgets'] as Record<string, unknown>;
    for (const [k, v] of Object.entries(b)) {
      if (!VALID_BUDGET_KEYS.has(k)) {
        throw new Error(`Unknown budget key '${k}'`);
      }
      if (k === 'requireTriangleLists') {
        if (typeof v !== 'boolean') {
          throw new Error(`budgets.${k} must be boolean`);
        }
      } else if (!isFiniteNum(v) || v < 0) {
        throw new Error(`budgets.${k} must be a non-negative finite number, got ${String(v)}`);
      }
    }
  }
  if (obj['geometry'] !== undefined) {
    validateGeometry(obj['geometry']);
  }
  return obj as unknown as StyleCard;
}

function loadCard(cardPath: string | undefined): StyleCard | null {
  if (cardPath === undefined) {
    return null;
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
  return validateCard(parsed, cardPath);
}

function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  return fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
}

function assertOutputDoesNotClobberInputs(outPath: string, inputPaths: readonly (string | undefined)[]): void {
  const outCanon = canonicalPath(outPath);
  for (const inp of inputPaths) {
    if (inp !== undefined && canonicalPath(inp) === outCanon) {
      throw new Error(`Refusing to overwrite input file with output path: ${outPath}`);
    }
  }
}

function exitCodeFor(report: { readonly ok: boolean; readonly unsupportedGate: boolean }): number {
  if (report.unsupportedGate) return 2;
  return report.ok ? 0 : 1;
}

async function runCheck(args: readonly string[]): Promise<number> {
  const { positional, flags, switches } = parseArgs(args, ['--card', '--out', '--timeout'], CONSOLE_FLAGS);
  const assetPath = positional[0];
  if (positional.length !== 1 || assetPath === undefined) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const cardPath = flags.get('--card');
  const outJson = flags.get('--out');
  if (outJson !== undefined) {
    assertOutputDoesNotClobberInputs(outJson, [assetPath, cardPath]);
  }
  const card = loadCard(cardPath);

  const session = await runAssetSession({
    assetPath,
    timeoutMs: parseTimeout(flags),
    card,
    renderSheet: false,
  });
  const evalResult = evaluateAssetGates(session.metrics, card, undefined, {
    consoleErrors: session.consoleErrors,
    failOnConsoleError: !switches.has('--no-fail-on-console-error'),
  });
  const report: Check3DReport = {
    schemaVersion: 'agent-3d/check/v1',
    ok: evalResult.ok,
    unsupportedGate: evalResult.unsupportedGate,
    asset: assetPath,
    cardId: card?.id ?? null,
    metrics: session.metrics,
    consoleErrors: session.consoleErrors,
    findings: evalResult.findings,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outJson !== undefined) {
    fs.mkdirSync(path.dirname(path.resolve(outJson)), { recursive: true });
    fs.writeFileSync(outJson, serialized);
  }
  process.stdout.write(serialized);
  return exitCodeFor(report);
}

interface TurntableOptions {
  readonly card: StyleCard | null;
  readonly cardPath: string | undefined;
  readonly timeoutMs: number;
  readonly capture: CaptureSettings;
  readonly saveViews: boolean;
  readonly blackFill: boolean;
  readonly failOnConsoleError: boolean;
}

interface TurntableJob extends TurntableOptions {
  readonly assetPath: string;
  readonly outDir: string;
}

function turntableOptions(parsed: ParsedArgs): TurntableOptions {
  const cardPath = parsed.flags.get('--card');
  return {
    card: loadCard(cardPath),
    cardPath,
    timeoutMs: parseTimeout(parsed.flags),
    capture: parseCapture(parsed.flags, parsed.switches),
    saveViews: parsed.switches.has('--save-views'),
    blackFill: parsed.switches.has('--black-fill'),
    failOnConsoleError: !parsed.switches.has('--no-fail-on-console-error'),
  };
}

async function turntableReport(job: TurntableJob): Promise<{ readonly report: TurntableReport; readonly reportPath: string }> {
  const outDir = path.resolve(job.outDir);
  const contactSheetPath = path.join(outDir, 'contact-sheet.png');
  const reportPath = path.join(outDir, 'report.json');
  const silhouetteSheetPath = job.blackFill ? path.join(outDir, 'silhouette-sheet.png') : null;
  for (const out of [contactSheetPath, reportPath, silhouetteSheetPath]) {
    if (out !== null) assertOutputDoesNotClobberInputs(out, [job.assetPath, job.cardPath]);
  }

  const session = await runAssetSession({
    assetPath: job.assetPath,
    timeoutMs: job.timeoutMs,
    card: job.card,
    renderSheet: true,
    contactSheetPath,
    capture: job.capture,
    ...(job.saveViews ? { viewsDir: outDir } : {}),
    ...(silhouetteSheetPath !== null ? { silhouetteSheetPath } : {}),
  });
  const evalResult = evaluateAssetGates(session.metrics, job.card, session.views, {
    consoleErrors: session.consoleErrors,
    failOnConsoleError: job.failOnConsoleError,
    capture: job.capture,
  });
  const report: TurntableReport = {
    schemaVersion: 'agent-3d/turntable/v1',
    ok: evalResult.ok,
    unsupportedGate: evalResult.unsupportedGate,
    asset: job.assetPath,
    cardId: job.card?.id ?? null,
    contactSheetPath,
    silhouetteSheetPath,
    viewPaths: session.viewPaths,
    capture: job.capture,
    metrics: session.metrics,
    views: session.views,
    consoleErrors: session.consoleErrors,
    findings: evalResult.findings,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { report, reportPath };
}

const TURNTABLE_VALUE_FLAGS = ['--card', '--out', '--timeout', ...CAPTURE_VALUE_FLAGS];
const TURNTABLE_SWITCHES = [...CAPTURE_SWITCHES, ...CONSOLE_FLAGS];

async function runTurntable(args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, TURNTABLE_VALUE_FLAGS, TURNTABLE_SWITCHES);
  const assetPath = parsed.positional[0];
  const outDir = parsed.flags.get('--out');
  if (parsed.positional.length !== 1 || assetPath === undefined || outDir === undefined) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const { report } = await turntableReport({ ...turntableOptions(parsed), assetPath, outDir });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return exitCodeFor(report);
}

export function listBatchAssets(dir: string): readonly string[] {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Batch directory not found: ${abs}`);
  }
  const assets = fs.readdirSync(abs)
    .filter((name) => BATCH_ASSET_EXTENSIONS.has(path.extname(name).toLowerCase()) && !name.endsWith('.d.ts'))
    .filter((name) => fs.statSync(path.join(abs, name)).isFile())
    .sort()
    .map((name) => path.join(abs, name));
  const seen = new Map<string, string>();
  for (const asset of assets) {
    const name = assetName(asset);
    const prior = seen.get(name);
    if (prior !== undefined) {
      throw new Error(`Batch assets ${path.basename(prior)} and ${path.basename(asset)} share the output folder '${name}'`);
    }
    seen.set(name, asset);
  }
  return assets;
}

function assetName(assetPath: string): string {
  return path.basename(assetPath, path.extname(assetPath));
}

function formatBatchTable(batch: BatchReport): string {
  const header = ['asset', 'tris', 'degen', 'palette', 'scored', 'shader', 'unscored', 'samples', 'maxΔE76', 'result'];
  const rows = batch.assets.map((a) => [
    a.name,
    a.triangles?.toString() ?? '-',
    a.degenerateTriangles?.toString() ?? '-',
    a.paletteStatus ?? '-',
    a.assessedMeshes?.toString() ?? '-',
    a.shaderUniformMeshes?.toString() ?? '-',
    a.unassessedMeshes?.toString() ?? '-',
    a.paletteSamples?.toString() ?? '-',
    a.paletteMaxDeltaE76?.toFixed(2) ?? '-',
    a.error !== null ? 'ERROR' : a.ok ? 'PASS' : 'FAIL',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: readonly string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  const out = [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
  for (const a of batch.assets) {
    if (a.error !== null) out.push(`${a.name}: ${a.error}`);
    else if (a.failures.length > 0) out.push(`${a.name}: ${a.failures.join(', ')}`);
  }
  out.push(`${batch.passed}/${batch.total} passed${batch.cardId !== null ? ` against card '${batch.cardId}'` : ''}`);
  return `${out.join('\n')}\n`;
}

async function runBatch(args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args, TURNTABLE_VALUE_FLAGS, TURNTABLE_SWITCHES);
  const dir = parsed.positional[0];
  const outDir = parsed.flags.get('--out');
  if (parsed.positional.length !== 1 || dir === undefined || outDir === undefined) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const options = turntableOptions(parsed);
  const assets = listBatchAssets(dir);
  if (assets.length === 0) {
    throw new Error(`No .glb or factory modules found in ${path.resolve(dir)}`);
  }

  const rows: BatchAssetRow[] = [];
  // Sequential on purpose: each asset already drives a multithreaded software rasterizer.
  for (const asset of assets) {
    const name = assetName(asset);
    try {
      const { report, reportPath } = await turntableReport({ ...options, assetPath: asset, outDir: path.join(outDir, name) });
      const palette = report.metrics.palette;
      rows.push({
        name,
        asset,
        ok: report.ok,
        exitCode: exitCodeFor(report),
        reportPath,
        triangles: report.metrics.trianglesByOccurrence,
        degenerateTriangles: report.metrics.degenerateTriangles,
        paletteStatus: palette.status,
        assessedMeshes: palette.assessedMeshes,
        shaderUniformMeshes: palette.shaderUniformMeshes,
        unassessedMeshes: palette.texturedMeshes + palette.shaderMeshes,
        paletteSamples: palette.sampledCorners,
        paletteMaxDeltaE76: palette.maxDeltaE76,
        failures: report.findings.filter((f) => f.severity === 'fail' || f.severity === 'unsupported').map((f) => f.id),
        error: null,
      });
    } catch (err) {
      rows.push({
        name,
        asset,
        ok: false,
        exitCode: 2,
        reportPath: null,
        triangles: null,
        degenerateTriangles: null,
        paletteStatus: null,
        assessedMeshes: null,
        shaderUniformMeshes: null,
        unassessedMeshes: null,
        paletteSamples: null,
        paletteMaxDeltaE76: null,
        failures: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const sheets = !options.blackFill ? [] : rows.flatMap((r) => {
    const sheet = r.reportPath === null ? null : path.join(path.dirname(r.reportPath), 'silhouette-sheet.png');
    return sheet !== null && fs.existsSync(sheet) ? [{ label: r.name, png: fs.readFileSync(sheet) }] : [];
  });
  const blackFillMasksPath = sheets.length > 0
    ? path.join(path.resolve(outDir), 'black-fill-masks.png')
    : null;
  if (blackFillMasksPath !== null) {
    assertOutputDoesNotClobberInputs(blackFillMasksPath, [...assets, options.cardPath]);
    await stackLabeledPngs(sheets, blackFillMasksPath, options.timeoutMs);
  }

  const passed = rows.filter((r) => r.ok).length;
  const batch: BatchReport = {
    schemaVersion: 'agent-3d/batch/v1',
    ok: passed === rows.length,
    dir: path.resolve(dir),
    outDir: path.resolve(outDir),
    cardId: options.card?.id ?? null,
    capture: options.capture,
    blackFillMasksPath,
    total: rows.length,
    passed,
    failed: rows.length - passed,
    assets: rows,
  };
  const table = formatBatchTable(batch);
  fs.mkdirSync(path.resolve(outDir), { recursive: true });
  fs.writeFileSync(path.join(path.resolve(outDir), 'summary.json'), `${JSON.stringify(batch, null, 2)}\n`);
  fs.writeFileSync(path.join(path.resolve(outDir), 'summary.txt'), table);
  process.stdout.write(`${JSON.stringify(batch)}\n`);
  process.stderr.write(table);
  return Math.max(0, ...rows.map((r) => r.exitCode));
}

async function runGpuProbeCli(args: readonly string[]): Promise<number> {
  const { positional, flags, switches } = parseArgs(args, ['--out', '--browser', '--timeout'], ['--headed']);
  const browser = flags.get('--browser') ?? 'chrome';
  if (positional.length !== 0 || (browser !== 'chrome' && browser !== 'chromium')) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const outDir = flags.get('--out');
  const result = await runGpuProbe({
    browser,
    headed: switches.has('--headed'),
    timeoutMs: parseTimeout(flags),
    ...(outDir !== undefined ? { outDir } : {}),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.exitCode;
}

export async function main(argv: readonly string[]): Promise<number> {
  const cmd = argv[0];
  try {
    if (cmd === 'check') {
      return await runCheck(argv.slice(1));
    }
    if (cmd === 'turntable') {
      return await runTurntable(argv.slice(1));
    }
    if (cmd === 'batch') {
      return await runBatch(argv.slice(1));
    }
    if (cmd === 'gpu-probe') {
      return await runGpuProbeCli(argv.slice(1));
    }
    process.stderr.write(`${usage()}\n`);
    return 2;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'CLI_ERROR', message })}\n`);
    return 2;
  }
}

const isEntry =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isEntry) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
