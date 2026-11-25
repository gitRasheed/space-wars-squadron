#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAudio, DEFAULT_LOOP_DISCONTINUITY_RATIO, DEFAULT_THRESHOLDS } from './analyze.js';
import { checkMix, MIX_THRESHOLD_KEYS, MixError, mixStems, parseMixFlag, parseMixManifest, type MixSpec } from './mix.js';
import { writeInspectionPngs } from './png.js';
import { errorRow, formatSummaryTable, summaryRow, type SummaryRow } from './summary.js';
import { RecipeError, renderRecipe, validateRecipe } from './synth.js';
import { THRESHOLD_KEYS, WavError, type AudioBufferData, type CheckReport, type CheckThresholds } from './types.js';
import { decodeWav, encodeWav, readWavFile } from './wav.js';

const KNOWN_THRESHOLD_KEYS: ReadonlySet<string> = new Set(THRESHOLD_KEYS);

function usage(): string {
  const keyWidth = Math.max(...THRESHOLD_KEYS.map((key) => key.length));
  const thresholdLines = THRESHOLD_KEYS.map((key) => {
    const loopDefault =
      key === 'maxLoopDiscontinuityRatio' ? `${DEFAULT_LOOP_DISCONTINUITY_RATIO} with --loop` : 'off';
    return `  ${key.padEnd(keyWidth)}  ${DEFAULT_THRESHOLDS[key] ?? loopDefault}`;
  });
  return [
    'Usage:',
    '  agent-audio render <recipe.json> --out <file.wav>',
    '  agent-audio check <file.wav> [--loop] [--strict] [--summary] [--png <dir>] [--out <report.json>] [--thresholds <json | file.json>]',
    '  agent-audio batch <dir> --out <dir> [--loop] [--strict] [--summary] [--png <dir>] [--thresholds <json | file.json>]',
    '  agent-audio mix-check <manifest.json> | --mix <a.wav:gainDb[@offsetS],...> [--out <report.json>] [--wav <mix.wav>] [--png <dir>] [--thresholds <json | file.json>]',
    '  agent-audio --help',
    '',
    'Exit codes: 0 pass, 1 gate fail, 2 input/tool error',
    '--strict turns advisory warnings (ALIASING_SUSPECTED, QUIET_TAIL) into failures.',
    '--summary prints one table row per file instead of JSON.',
    '',
    'Threshold keys for --thresholds, with defaults:',
    ...thresholdLines,
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

function parseThresholds(raw: string | undefined, allowed: ReadonlySet<string> = KNOWN_THRESHOLD_KEYS): CheckThresholds {
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
    if (!allowed.has(k)) {
      throw new Error(`Unknown threshold key: ${k} (allowed here: ${[...allowed].join(', ')})`);
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`Threshold '${k}' must be a finite number, got ${String(v)}`);
    }
    validated[k] = v;
  }
  return validated as CheckThresholds;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeWav(file: string, audio: AudioBufferData): Uint8Array {
  const bytes = encodeWav(audio.channels, audio.sampleRate, audio.format === 'float32' ? 'float32' : 'pcm16');
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, bytes);
  return bytes;
}

function renderRecipeFile(recipePath: string): { readonly id: string; readonly kind: string; readonly audio: AudioBufferData } {
  const recipe = validateRecipe(JSON.parse(fs.readFileSync(recipePath, 'utf8')) as unknown);
  return { id: recipe.id, kind: recipe.kind, audio: renderRecipe(recipe) };
}

function runRender(args: readonly string[]): number {
  const { positional, flags } = parseCommandArgs(args, new Set(['--out']), new Set());
  const recipePath = positional[0];
  const outPath = flags.get('--out');
  if (positional.length !== 1 || recipePath === undefined || typeof outPath !== 'string') {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const { id, kind, audio } = renderRecipeFile(recipePath);
  const bytes = writeWav(outPath, audio);
  const frames = audio.channels[0]?.length ?? 0;
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 'agent-audio/render/v1',
        ok: true,
        id,
        kind,
        out: outPath,
        sampleRateHz: audio.sampleRate,
        channels: audio.channels.length,
        encoding: audio.format === 'float32' ? 'float32' : 'pcm16',
        frames,
        durationS: Number((frames / audio.sampleRate).toFixed(6)),
        bytes: bytes.byteLength,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

interface GateOptions {
  readonly loop: boolean;
  readonly strict: boolean;
  readonly thresholds: CheckThresholds;
  readonly pngDir: string | undefined;
}

function gate(audio: AudioBufferData, file: string, options: GateOptions): CheckReport {
  const report = checkAudio(audio, file, options);
  if (options.pngDir === undefined) {
    return report;
  }
  return { ...report, pngs: writeInspectionPngs(audio, options.pngDir, path.parse(file).name, options.loop) };
}

function stringFlag(flags: ReadonlyMap<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

function runCheck(args: readonly string[]): number {
  const { positional, flags } = parseCommandArgs(
    args,
    new Set(['--png', '--out', '--thresholds']),
    new Set(['--loop', '--strict', '--summary']),
  );
  const wavPath = positional[0];
  if (positional.length !== 1 || wavPath === undefined) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const options: GateOptions = {
    loop: flags.get('--loop') === true,
    strict: flags.get('--strict') === true,
    thresholds: parseThresholds(stringFlag(flags, '--thresholds')),
    pngDir: stringFlag(flags, '--png'),
  };
  const report = gate(readWavFile(wavPath), wavPath, options);
  const outJson = stringFlag(flags, '--out');
  if (outJson !== undefined) {
    writeJson(outJson, report);
  }
  process.stdout.write(
    flags.get('--summary') === true
      ? `${formatSummaryTable([summaryRow(report)])}\n`
      : `${JSON.stringify(report, null, 2)}\n`,
  );
  return report.ok ? 0 : 1;
}

const RECIPE_SUFFIX = '.recipe.json';

interface BatchEntry {
  readonly source: string;
  readonly ok: boolean;
  readonly row: SummaryRow;
  readonly wav?: string;
  readonly report?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

function errorInfo(err: unknown): { readonly code: string; readonly message: string } {
  const code =
    err instanceof WavError || err instanceof MixError
      ? err.code
      : err instanceof RecipeError
        ? 'INVALID_RECIPE'
        : 'CLI_ERROR';
  return { code, message: err instanceof Error ? err.message : String(err) };
}

// A recipe is the source of its WAV, so a WAV sharing a recipe's base name is the recipe's earlier render.
function batchSources(dir: string): readonly string[] {
  const names = fs.readdirSync(dir).sort();
  const recipeBases = new Set(names.filter((n) => n.endsWith(RECIPE_SUFFIX)).map((n) => n.slice(0, -RECIPE_SUFFIX.length)));
  return names.filter(
    (n) => n.endsWith(RECIPE_SUFFIX) || (n.toLowerCase().endsWith('.wav') && !recipeBases.has(n.slice(0, -4))),
  );
}

function batchOne(dir: string, name: string, outDir: string, options: GateOptions): BatchEntry {
  const source = path.join(dir, name);
  try {
    const isRecipe = name.endsWith(RECIPE_SUFFIX);
    const base = isRecipe ? name.slice(0, -RECIPE_SUFFIX.length) : path.parse(name).name;
    let audio: AudioBufferData;
    let wav = source;
    let loop = options.loop;
    if (isRecipe) {
      const rendered = renderRecipeFile(source);
      loop = rendered.kind === 'loop';
      wav = path.join(outDir, `${base}.wav`);
      // Gate the quantised file on disk, so batch and check agree on it.
      audio = decodeWav(writeWav(wav, rendered.audio));
    } else {
      audio = readWavFile(source);
    }
    const report = gate(audio, wav, { ...options, loop });
    const reportPath = path.join(outDir, `${base}.report.json`);
    writeJson(reportPath, report);
    return { source, ok: report.ok, row: summaryRow(report, name), wav, report: reportPath };
  } catch (err) {
    const error = errorInfo(err);
    return { source, ok: false, row: errorRow(name, error.code), error };
  }
}

function runBatch(args: readonly string[]): number {
  const { positional, flags } = parseCommandArgs(
    args,
    new Set(['--out', '--png', '--thresholds']),
    new Set(['--loop', '--strict', '--summary']),
  );
  const dir = positional[0];
  const outDir = stringFlag(flags, '--out');
  if (positional.length !== 1 || dir === undefined || outDir === undefined) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const options: GateOptions = {
    loop: flags.get('--loop') === true,
    strict: flags.get('--strict') === true,
    thresholds: parseThresholds(stringFlag(flags, '--thresholds')),
    pngDir: stringFlag(flags, '--png'),
  };
  const sources = batchSources(dir);
  if (sources.length === 0) {
    throw new Error(`No *.recipe.json or *.wav files in ${dir}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const entries = sources.map((name) => batchOne(dir, name, outDir, options));

  if (flags.get('--summary') === true) {
    process.stdout.write(`${formatSummaryTable(entries.map((e) => e.row))}\n`);
  } else {
    const results = entries.map(({ row, ...rest }) => ({ ...rest, verdict: row.verdict, findings: row.findings }));
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 'agent-audio/batch/v1', ok: entries.every((e) => e.ok), results }, null, 2)}\n`,
    );
  }
  if (entries.some((e) => e.error !== undefined)) {
    return 2;
  }
  return entries.every((e) => e.ok) ? 0 : 1;
}

const MIX_THRESHOLD_KEY_SET: ReadonlySet<string> = new Set(MIX_THRESHOLD_KEYS);

function runMixCheck(args: readonly string[]): number {
  const { positional, flags } = parseCommandArgs(
    args,
    new Set(['--mix', '--out', '--wav', '--png', '--thresholds']),
    new Set(),
  );
  const manifestPath = positional[0];
  const mixFlag = stringFlag(flags, '--mix');
  if (positional.length > 1 || (manifestPath === undefined) === (mixFlag === undefined)) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const spec: MixSpec =
    manifestPath !== undefined
      ? parseMixManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown, path.dirname(manifestPath))
      : parseMixFlag(mixFlag ?? '');
  const stems = spec.stems.map((s) => ({ ...s, audio: readWavFile(s.file) }));
  const composite = mixStems(stems, spec.durationS);
  const report = checkMix(stems, composite, parseThresholds(stringFlag(flags, '--thresholds'), MIX_THRESHOLD_KEY_SET));

  const wavOut = stringFlag(flags, '--wav');
  if (wavOut !== undefined) {
    writeWav(wavOut, composite);
  }
  const pngDir = stringFlag(flags, '--png');
  const label = manifestPath !== undefined ? path.parse(manifestPath).name.replace(/\.mix$/, '') : 'mix';
  const full = pngDir !== undefined ? { ...report, pngs: writeInspectionPngs(composite, pngDir, label, false) } : report;
  const outJson = stringFlag(flags, '--out');
  if (outJson !== undefined) {
    writeJson(outJson, full);
  }
  process.stdout.write(`${JSON.stringify(full, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

export function main(argv: readonly string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const cmd = argv[0];
  try {
    if (cmd === 'render') {
      return runRender(argv.slice(1));
    }
    if (cmd === 'check') {
      return runCheck(argv.slice(1));
    }
    if (cmd === 'batch') {
      return runBatch(argv.slice(1));
    }
    if (cmd === 'mix-check') {
      return runMixCheck(argv.slice(1));
    }
    process.stderr.write(`${usage()}\n`);
    return 2;
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ ok: false, ...errorInfo(err) })}\n`);
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
