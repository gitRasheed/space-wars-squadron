#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAssetSession } from './browserRuntime.js';
import { evaluateAssetGates } from './evaluate.js';
import type { AxisDirection, Check3DReport, StyleCard, TurntableReport } from './types.js';

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
  'separationMinDeltaE76',
  'separationRoles',
  'budgets',
]);
const VALID_BUDGET_KEYS = new Set([
  'trisMax',
  'materialsMax',
  'texturesMax',
  'bytesMax',
  'degenerateTrianglesMax',
  'requireTriangleLists',
]);

function usage(): string {
  return [
    'Usage:',
    '  agent-3d check <asset.glb|factory.ts|factory.mjs> [--card <style-card.json>] [--out <report.json>]',
    '  agent-3d turntable <asset.glb|factory.ts|factory.mjs> --out <dir> [--card <style-card.json>]',
    'Exit codes: 0 pass, 1 gate violation, 2 invalid input / unsupported gate / renderer error',
  ].join('\n');
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseArgs(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
): { readonly positional: readonly string[]; readonly flags: ReadonlyMap<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) {
      continue;
    }
    if (token.startsWith('--')) {
      if (!valueFlags.has(token)) {
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
  return { positional, flags };
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

async function runCheck(args: readonly string[]): Promise<number> {
  const { positional, flags } = parseArgs(args, new Set(['--card', '--out']));
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
    card,
    renderSheet: false,
  });
  const evalResult = evaluateAssetGates(session.metrics, card);
  const report: Check3DReport = {
    schemaVersion: 'agent-3d/check/v1',
    ok: evalResult.ok,
    unsupportedGate: evalResult.unsupportedGate,
    asset: assetPath,
    cardId: card?.id ?? null,
    metrics: session.metrics,
    findings: evalResult.findings,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outJson !== undefined) {
    fs.mkdirSync(path.dirname(path.resolve(outJson)), { recursive: true });
    fs.writeFileSync(outJson, serialized);
  }
  process.stdout.write(serialized);
  if (report.unsupportedGate) {
    return 2;
  }
  return report.ok ? 0 : 1;
}

async function runTurntable(args: readonly string[]): Promise<number> {
  const { positional, flags } = parseArgs(args, new Set(['--card', '--out']));
  const assetPath = positional[0];
  const outDir = flags.get('--out');
  if (positional.length !== 1 || assetPath === undefined || outDir === undefined) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const cardPath = flags.get('--card');
  const contactSheetPath = path.join(path.resolve(outDir), 'contact-sheet.png');
  const reportPath = path.join(path.resolve(outDir), 'report.json');
  assertOutputDoesNotClobberInputs(contactSheetPath, [assetPath, cardPath]);
  assertOutputDoesNotClobberInputs(reportPath, [assetPath, cardPath]);
  const card = loadCard(cardPath);

  const session = await runAssetSession({
    assetPath,
    card,
    renderSheet: true,
    contactSheetPath,
  });
  const evalResult = evaluateAssetGates(session.metrics, card, session.views);
  const report: TurntableReport = {
    schemaVersion: 'agent-3d/turntable/v1',
    ok: evalResult.ok,
    unsupportedGate: evalResult.unsupportedGate,
    asset: assetPath,
    cardId: card?.id ?? null,
    contactSheetPath,
    metrics: session.metrics,
    views: session.views,
    findings: evalResult.findings,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  fs.mkdirSync(path.resolve(outDir), { recursive: true });
  fs.writeFileSync(reportPath, serialized);
  process.stdout.write(serialized);
  if (report.unsupportedGate) {
    return 2;
  }
  return report.ok ? 0 : 1;
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
