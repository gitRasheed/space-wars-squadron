import path from 'node:path';
import { DEFAULT_THRESHOLDS, loudnessFindings, truePeakFindings } from './analyze.js';
import { measureLoudness } from './loudness.js';
import type {
  AudioBufferData,
  CheckFinding,
  CheckThresholds,
  LoudnessMetrics,
  SupportedSampleRate,
  ThresholdKey,
} from './types.js';

export class MixError extends Error {
  readonly code: 'INVALID_MIX' | 'MIX_SAMPLE_RATE_MISMATCH';
  constructor(code: 'INVALID_MIX' | 'MIX_SAMPLE_RATE_MISMATCH', message: string) {
    super(message);
    this.name = 'MixError';
    this.code = code;
  }
}

export interface MixStemSpec {
  readonly file: string;
  readonly gainDb: number;
  readonly offsetS: number;
  readonly loop: boolean;
}

export interface MixSpec {
  readonly stems: readonly MixStemSpec[];
  readonly durationS?: number;
}

export interface MixStem extends MixStemSpec {
  readonly audio: AudioBufferData;
}

export const MIX_THRESHOLD_KEYS = [
  'maxTruePeakDbtp',
  'maxFullScaleSamples',
  'minMomentaryLufs',
  'maxMomentaryLufs',
  'minIntegratedLufs',
  'maxIntegratedLufs',
] as const satisfies readonly ThresholdKey[];

export interface MixReport {
  readonly schemaVersion: 'agent-audio/mix-check/v1';
  readonly ok: boolean;
  readonly stems: readonly (MixStemSpec & { readonly frames: number })[];
  readonly format: {
    readonly sampleRateHz: SupportedSampleRate;
    readonly channels: 1 | 2;
    readonly frames: number;
    readonly durationS: number;
  };
  readonly loudness: LoudnessMetrics;
  readonly samplePeakDbfs: number | null;
  readonly headroomDb: number | null;
  readonly fullScaleSamples: readonly number[];
  readonly thresholds: CheckThresholds;
  readonly findings: readonly CheckFinding[];
}

const MANIFEST_KEYS = ['schemaVersion', 'stems', 'durationS'];
const STEM_KEYS = ['file', 'gainDb', 'offsetS', 'loop'];

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function rejectUnknown(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new MixError('INVALID_MIX', `Unknown key "${key}" at ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

/** Parses a mix manifest; stem paths resolve against baseDir. */
export function parseMixManifest(raw: unknown, baseDir: string): MixSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MixError('INVALID_MIX', 'Mix manifest must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  rejectUnknown(obj, MANIFEST_KEYS, 'manifest');
  if (obj['schemaVersion'] !== 'agent-audio/mix/v1') {
    throw new MixError('INVALID_MIX', `Unsupported mix schemaVersion: ${String(obj['schemaVersion'])}`);
  }
  if (obj['durationS'] !== undefined && (!finite(obj['durationS']) || obj['durationS'] <= 0)) {
    throw new MixError('INVALID_MIX', `durationS must be > 0, got ${String(obj['durationS'])}`);
  }
  if (!Array.isArray(obj['stems']) || obj['stems'].length === 0) {
    throw new MixError('INVALID_MIX', 'Mix manifest needs at least one stem');
  }
  const stems = (obj['stems'] as unknown[]).map((rawStem, i): MixStemSpec => {
    const where = `stems[${i}]`;
    if (typeof rawStem !== 'object' || rawStem === null || Array.isArray(rawStem)) {
      throw new MixError('INVALID_MIX', `${where} must be an object`);
    }
    const s = rawStem as Record<string, unknown>;
    rejectUnknown(s, STEM_KEYS, where);
    if (typeof s['file'] !== 'string' || s['file'].length === 0) {
      throw new MixError('INVALID_MIX', `${where}.file must be a non-empty string`);
    }
    const gainDb = s['gainDb'] ?? 0;
    const offsetS = s['offsetS'] ?? 0;
    if (!finite(gainDb) || gainDb < -120 || gainDb > 24) {
      throw new MixError('INVALID_MIX', `${where}.gainDb must be in [-120, 24], got ${String(gainDb)}`);
    }
    if (!finite(offsetS) || offsetS < 0) {
      throw new MixError('INVALID_MIX', `${where}.offsetS must be >= 0, got ${String(offsetS)}`);
    }
    if (s['loop'] !== undefined && typeof s['loop'] !== 'boolean') {
      throw new MixError('INVALID_MIX', `${where}.loop must be a boolean`);
    }
    return { file: path.resolve(baseDir, s['file']), gainDb, offsetS, loop: s['loop'] === true };
  });
  return obj['durationS'] !== undefined ? { stems, durationS: obj['durationS'] } : { stems };
}

/** Parses "a.wav:-6,b.wav:-3@0.25" (file:gainDb[@offsetS]); the gain follows the last colon. */
export function parseMixFlag(flag: string): MixSpec {
  const stems = flag.split(',').map((part): MixStemSpec => {
    const match = /^(.+):([-+]?\d+(?:\.\d+)?)(?:@(\d+(?:\.\d+)?))?$/.exec(part.trim());
    if (match === null) {
      throw new MixError('INVALID_MIX', `--mix entry "${part}" must be file:gainDb or file:gainDb@offsetS`);
    }
    return { file: match[1] ?? '', gainDb: Number(match[2]), offsetS: Number(match[3] ?? 0), loop: false };
  });
  return { stems };
}

/**
 * Sums stems at their bus gains without clamping. Mono stems feed both channels at full level, as a mono source
 * up-mixes onto a stereo bus. The mix lasts durationS, or until the last one-shot stem ends; looped stems tile from
 * their offset to the end, and with only looped stems the mix lasts one pass of the longest.
 */
export function mixStems(stems: readonly MixStem[], durationS?: number): AudioBufferData {
  const first = stems[0];
  if (first === undefined) {
    throw new MixError('INVALID_MIX', 'Mix needs at least one stem');
  }
  const sampleRate = first.audio.sampleRate;
  for (const stem of stems) {
    if (stem.audio.sampleRate !== sampleRate) {
      throw new MixError(
        'MIX_SAMPLE_RATE_MISMATCH',
        `${stem.file} is ${stem.audio.sampleRate} Hz but ${first.file} is ${sampleRate} Hz; render every stem at one rate`,
      );
    }
  }
  const lengthOf = (s: MixStem): number => s.audio.channels[0]?.length ?? 0;
  const offsetOf = (s: MixStem): number => Math.round(s.offsetS * sampleRate);
  const oneShots = stems.filter((s) => !s.loop);
  const frames =
    durationS !== undefined
      ? Math.round(durationS * sampleRate)
      : oneShots.length > 0
        ? Math.max(...oneShots.map((s) => offsetOf(s) + lengthOf(s)))
        : Math.max(...stems.map((s) => offsetOf(s) + lengthOf(s)));
  const channelCount = stems.some((s) => s.audio.channels.length === 2) ? 2 : 1;
  const out = Array.from({ length: channelCount }, () => new Float64Array(frames));

  for (const stem of stems) {
    const gain = Math.pow(10, stem.gainDb / 20);
    const len = lengthOf(stem);
    const offset = offsetOf(stem);
    const end = stem.loop ? frames : Math.min(frames, offset + len);
    if (len === 0) {
      continue;
    }
    for (const [c, buf] of out.entries()) {
      const src = stem.audio.channels[Math.min(c, stem.audio.channels.length - 1)] ?? new Float64Array(0);
      for (let i = offset; i < end; i += 1) {
        buf[i] = (buf[i] ?? 0) + (src[(i - offset) % len] ?? 0) * gain;
      }
    }
  }
  return { sampleRate, channels: out, format: 'float32' };
}

function roundTo(value: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

export function checkMix(stems: readonly MixStem[], composite: AudioBufferData, overrides?: CheckThresholds): MixReport {
  const mixKeys: ReadonlySet<string> = new Set(MIX_THRESHOLD_KEYS);
  const defaults = Object.fromEntries(Object.entries(DEFAULT_THRESHOLDS).filter(([k]) => mixKeys.has(k)));
  const thresholds: CheckThresholds = { ...defaults, ...overrides };
  const loudness = measureLoudness(composite.channels, composite.sampleRate);
  const frames = composite.channels[0]?.length ?? 0;
  let samplePeak = 0;
  const fullScaleSamples = composite.channels.map((buf) => {
    let count = 0;
    for (const v of buf) {
      samplePeak = Math.max(samplePeak, Math.abs(v));
      if (Math.abs(v) >= 0.999) {
        count += 1;
      }
    }
    return count;
  });

  const findings: CheckFinding[] = [...truePeakFindings(loudness, thresholds, composite.sampleRate)];
  for (const [channel, count] of fullScaleSamples.entries()) {
    if (thresholds.maxFullScaleSamples !== undefined && count > thresholds.maxFullScaleSamples) {
      findings.push({
        code: 'FULL_SCALE_SAMPLES',
        severity: 'fail',
        channel,
        message: `Mix channel ${channel} has ${count} samples at or above full scale (limit ${thresholds.maxFullScaleSamples}); they clip once written to a fixed-point bus`,
      });
    }
  }
  findings.push(...loudnessFindings(loudness, thresholds));

  return {
    schemaVersion: 'agent-audio/mix-check/v1',
    ok: findings.every((f) => f.severity !== 'fail'),
    stems: stems.map((s) => ({
      file: s.file,
      gainDb: s.gainDb,
      offsetS: s.offsetS,
      loop: s.loop,
      frames: s.audio.channels[0]?.length ?? 0,
    })),
    format: {
      sampleRateHz: composite.sampleRate,
      channels: composite.channels.length === 2 ? 2 : 1,
      frames,
      durationS: roundTo(frames / composite.sampleRate, 4),
    },
    loudness,
    samplePeakDbfs: samplePeak > 0 ? roundTo(20 * Math.log10(samplePeak), 3) : null,
    headroomDb: loudness.truePeakDbtp !== null ? roundTo(-loudness.truePeakDbtp, 3) : null,
    fullScaleSamples,
    thresholds,
    findings,
  };
}
