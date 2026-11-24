#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAudio } from './analyze.js';
import { writeInspectionPngs } from './png.js';
import { RecipeError, renderRecipe, validateRecipe } from './synth.js';
import { WavError, type CheckThresholds } from './types.js';
import { encodeWav, readWavFile } from './wav.js';

const KNOWN_THRESHOLD_KEYS = new Set<keyof CheckThresholds>([
  'maxTruePeakDbtp',
  'maxDcOffset',
  'maxFullScaleSamples',
  'maxLeadingSilenceS',
  'maxEndEdgeRatio',
  'maxClickRatio',
  'minMomentaryLufs',
  'maxMomentaryLufs',
  'minIntegratedLufs',
  'maxIntegratedLufs',
  'maxLoopDiscontinuityRatio',
  'maxLoopWrapDelta',
  'maxStereoBalanceDb',
]);

function usage(): string {
  return [
    'Usage:',
    '  agent-audio render <recipe.json> --out <file.wav>',
    '  agent-audio check <file.wav> [--loop] [--png <dir>] [--out <report.json>] [--thresholds <json>]',
    'Exit codes: 0 pass, 1 gate fail, 2 input/tool error',
  ].join('\n');
}

function parseCommandArgs(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
  boolFlags: ReadonlySet<string>,
): { readonly positional: readonly string[]; readonly flags: ReadonlyMap<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) {
      continue;
    }
    if (token.startsWith('--')) {
      if (boolFlags.has(token)) {
        flags.set(token, true);
      } else if (valueFlags.has(token)) {
        const val = args[i + 1];
        if (val === undefined || val.startsWith('--')) {
          throw new Error(`Flag ${token} requires a value`);
        }
        flags.set(token, val);
        i += 1;
      } else {
        throw new Error(`Unknown flag: ${token}`);
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function parseThresholds(raw: string | undefined): CheckThresholds {
  if (raw === undefined) {
    return {};
  }
  const content = fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : raw;
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Thresholds must be a JSON object');
  }
  const validated: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KNOWN_THRESHOLD_KEYS.has(k as keyof CheckThresholds)) {
      throw new Error(`Unknown threshold key: ${k}`);
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`Threshold '${k}' must be a finite number, got ${String(v)}`);
    }
    validated[k] = v;
  }
  return validated as CheckThresholds;
}

function runRender(args: readonly string[]): number {
  const { positional, flags } = parseCommandArgs(args, new Set(['--out']), new Set());
  const recipePath = positional[0];
  const outPath = flags.get('--out');
  if (positional.length !== 1 || recipePath === undefined || typeof outPath !== 'string') {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const raw = JSON.parse(fs.readFileSync(recipePath, 'utf8')) as unknown;
  const recipe = validateRecipe(raw);
  const rendered = renderRecipe(recipe);
  const encoding = rendered.format === 'float32' ? 'float32' : 'pcm16';
  const bytes = encodeWav(rendered.channels, rendered.sampleRate, encoding);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, bytes);
  const frames = rendered.channels[0]?.length ?? 0;
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 'agent-audio/render/v1',
        ok: true,
        id: recipe.id,
        kind: recipe.kind,
        out: outPath,
        sampleRateHz: rendered.sampleRate,
        channels: rendered.channels.length,
        encoding,
        frames,
        durationS: Number((frames / rendered.sampleRate).toFixed(6)),
        bytes: bytes.byteLength,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

function runCheck(args: readonly string[]): number {
  const { positional, flags } = parseCommandArgs(
    args,
    new Set(['--png', '--out', '--thresholds']),
    new Set(['--loop']),
  );
  const wavPath = positional[0];
  if (positional.length !== 1 || wavPath === undefined) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const loop = flags.get('--loop') === true;
  const pngDir = flags.get('--png');
  const outJson = flags.get('--out');
  const rawThresholds = flags.get('--thresholds');
  const thresholds = parseThresholds(typeof rawThresholds === 'string' ? rawThresholds : undefined);

  const audio = readWavFile(wavPath);
  const baseReport = checkAudio(audio, wavPath, { loop, thresholds });
  const pngs =
    typeof pngDir === 'string'
      ? writeInspectionPngs(audio, pngDir, path.parse(wavPath).name, loop)
      : undefined;
  const report = pngs !== undefined ? { ...baseReport, pngs } : baseReport;
  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  if (typeof outJson === 'string') {
    fs.mkdirSync(path.dirname(path.resolve(outJson)), { recursive: true });
    fs.writeFileSync(outJson, serialized);
  }
  process.stdout.write(serialized);
  return report.ok ? 0 : 1;
}

export function main(argv: readonly string[]): number {
  const cmd = argv[0];
  try {
    if (cmd === 'render') {
      return runRender(argv.slice(1));
    }
    if (cmd === 'check') {
      return runCheck(argv.slice(1));
    }
    process.stderr.write(`${usage()}\n`);
    return 2;
  } catch (err) {
    const code =
      err instanceof WavError ? err.code : err instanceof RecipeError ? 'INVALID_RECIPE' : 'CLI_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
    return 2;
  }
}

const isEntry =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isEntry) {
  process.exit(main(process.argv.slice(2)));
}
