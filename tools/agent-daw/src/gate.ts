import { fftInPlace } from './fft.js';
import { measureLoudness, type LoudnessMetrics } from './loudness.js';
import { writePngs } from './png.js';
import type { Audio } from './wav.js';

export const CATEGORIES = ['music', 'sfx', 'ui', 'ambience'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface GateThresholds {
  readonly lufsMin: number | null;
  readonly lufsMax: number | null;
  readonly momentaryMin: number | null;
  readonly momentaryMax: number;
  readonly maxTruePeakDbtp: number;
  readonly maxDcOffset: number;
  readonly maxClippedSamples: number;
  readonly maxClickRatio: number;
  readonly humRatioDb: number;
  readonly minCorrelation: number;
  readonly maxBalanceDb: number;
  readonly centroidHz: readonly [number, number];
  readonly rolloff85Hz: readonly [number, number];
  readonly maxSeamStep: number;
  readonly seamVsBarRatio: number;
}

const CATEGORY_DEFAULTS: Readonly<Record<Category, GateThresholds>> = {
  music: {
    lufsMin: -18, lufsMax: -14, momentaryMin: null, momentaryMax: -6, maxTruePeakDbtp: -1, maxDcOffset: 0.002, maxClippedSamples: 0, maxClickRatio: 25,
    humRatioDb: 15, minCorrelation: -0.2, maxBalanceDb: 9, centroidHz: [250, 5000], rolloff85Hz: [700, 13000], maxSeamStep: 6, seamVsBarRatio: 2,
  },
  sfx: {
    lufsMin: null, lufsMax: null, momentaryMin: -26, momentaryMax: -8, maxTruePeakDbtp: -1, maxDcOffset: 0.002, maxClippedSamples: 0, maxClickRatio: 40,
    humRatioDb: 15, minCorrelation: -0.2, maxBalanceDb: 12, centroidHz: [120, 9000], rolloff85Hz: [300, 18000], maxSeamStep: 6, seamVsBarRatio: 2,
  },
  ui: {
    lufsMin: null, lufsMax: null, momentaryMin: -30, momentaryMax: -12, maxTruePeakDbtp: -1, maxDcOffset: 0.002, maxClippedSamples: 0, maxClickRatio: 60,
    humRatioDb: 15, minCorrelation: -0.2, maxBalanceDb: 12, centroidHz: [400, 12000], rolloff85Hz: [600, 16000], maxSeamStep: 6, seamVsBarRatio: 2,
  },
  ambience: {
    lufsMin: -27, lufsMax: -21, momentaryMin: null, momentaryMax: -12, maxTruePeakDbtp: -1, maxDcOffset: 0.002, maxClippedSamples: 0, maxClickRatio: 25,
    humRatioDb: 15, minCorrelation: -0.2, maxBalanceDb: 9, centroidHz: [100, 6000], rolloff85Hz: [300, 14000], maxSeamStep: 6, seamVsBarRatio: 2,
  },
};

export interface GateOptions {
  readonly category?: Category;
  readonly loop?: boolean;
  readonly bpm?: number;
  readonly beatsPerBar?: number;
  readonly targetLufs?: number;
  readonly lufsTolerance?: number;
  readonly thresholds?: Partial<GateThresholds>;
  readonly pngDir?: string;
  readonly title?: string;
}

export interface Finding {
  readonly code: string;
  readonly message: string;
  readonly channel?: number;
  readonly timeS?: number;
}

export interface SeamMetrics {
  readonly wrapStep: number;
  readonly maxBarStep: number;
  readonly wrapJumpDb: number;
  readonly maxBarJumpDb: number;
}

export interface HumMetrics {
  readonly hz: 50 | 60;
  // Line level over the median of its neighbours (on the beat comb when the tempo is known); weaker of two windows on long files.
  readonly fundamentalDb: number;
  readonly harmonicDb: number;
}

export interface GateReport {
  readonly ok: boolean;
  readonly category: Category;
  readonly durationS: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly loudness: LoudnessMetrics;
  readonly dcOffset: readonly number[];
  readonly clippedSamples: number;
  readonly clickRatio: readonly number[];
  readonly clickTimeS: readonly number[];
  readonly hum: readonly HumMetrics[];
  readonly channelRmsDb: readonly number[];
  readonly correlation: number | null;
  readonly balanceDb: number | null;
  readonly centroidHz: number;
  readonly rolloff85Hz: number;
  readonly rolloff95Hz: number;
  readonly seam: SeamMetrics | null;
  readonly thresholds: GateThresholds;
  readonly findings: readonly Finding[];
  readonly pngs?: { readonly waveform: string; readonly spectrogram: string };
}

const round = (v: number, d = 3): number => Number(v.toFixed(d));
const toDb = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -200);

function percentile(values: Float64Array, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

// sqrt(2) x the loudest 10 ms RMS: the peak of a steady sine, and nearly unmoved by a one-sample click.
function referenceLevel(channels: readonly Float64Array[], sr: number): number {
  const half = Math.max(1, Math.round(sr * 0.005));
  let maxSq = 0;
  for (const buf of channels) {
    let prev = 0;
    for (let s = 0; s < buf.length; s += half) {
      let sq = 0;
      for (let i = s; i < Math.min(buf.length, s + half); i += 1) sq += buf[i] * buf[i];
      maxSq = Math.max(maxSq, prev + sq);
      prev = sq;
    }
  }
  return Math.sqrt((2 * maxSq) / Math.max(1, Math.min(2 * half, channels[0]?.length ?? 1)));
}

// A sample whose curvature towers over the surrounding 1 ms and does not repeat at a pitch period is a click.
function detectClick(buf: Float64Array, sr: number, level: number): { readonly ratio: number; readonly frame: number } {
  const n = buf.length;
  if (n < 16 || level < 3e-4) return { ratio: 0, frame: 0 };
  const curv = new Float64Array(n);
  for (let i = 1; i < n - 1; i += 1) curv[i] = Math.abs(buf[i] - 0.5 * (buf[i - 1] + buf[i + 1]));
  const halfWin = Math.max(16, Math.min(64, Math.floor(sr * 0.001)));
  const gate = level * 0.04;
  const floor = level * 0.004;
  const frames: number[] = [];
  const sizes: number[] = [];
  const ratios: number[] = [];
  let windowSum = 0;
  let lo = 1;
  let hi = 0;
  for (let i = 2; i < n - 2; i += 1) {
    const nlo = Math.max(1, i - halfWin);
    const nhi = Math.min(n - 2, i + halfWin);
    for (; hi < nhi; hi += 1) windowSum += curv[hi + 1];
    for (; lo < nlo; lo += 1) windowSum -= curv[lo];
    const c = curv[i];
    if (c < gate) continue;
    let excl = 0;
    for (let j = Math.max(lo, i - 2); j <= Math.min(hi, i + 2); j += 1) excl += curv[j];
    const count = hi - lo + 1 - (Math.min(hi, i + 2) - Math.max(lo, i - 2) + 1);
    const ratio = c / Math.max(count > 0 ? (windowSum - excl) / count : 0, floor);
    if (ratio < 4) continue;
    const last = frames.length - 1;
    if (last < 0 || i - frames[last] > 4) {
      frames.push(i);
      sizes.push(c);
      ratios.push(ratio);
    } else if (c > sizes[last]) {
      frames[last] = i;
      sizes[last] = c;
      ratios[last] = ratio;
    }
  }
  const maxPeriod = Math.round(sr * 0.05);
  let best = { ratio: 0, frame: 0 };
  for (let s = 0; s < frames.length; s += 1) {
    if (sizes[s] < level * 0.08 || ratios[s] <= best.ratio) continue;
    if (repeatsAsPitch(frames, sizes, s, maxPeriod)) continue;
    best = { ratio: ratios[s], frame: frames[s] };
  }
  return best;
}

function repeatsAsPitch(frames: readonly number[], sizes: readonly number[], s: number, maxPeriod: number): boolean {
  const f = frames[s];
  const minSize = sizes[s] * 0.5;
  const dist = (j: number): number => Math.abs(frames[j] - f);
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.25 * Math.max(a, b);
  for (const step of [-1, 1]) {
    for (let j = s + step; j >= 0 && j < frames.length && dist(j) <= maxPeriod; j += step) {
      if (sizes[j] < minSize) continue;
      const period = dist(j);
      for (let k = j + step; k >= 0 && k < frames.length && dist(k) <= 2 * maxPeriod; k += step) if (sizes[k] >= minSize && near(dist(k), 2 * period)) return true;
      for (let k = s - step; k >= 0 && k < frames.length && dist(k) <= 2 * maxPeriod; k -= step) if (sizes[k] >= minSize && near(dist(k), period)) return true;
    }
  }
  return false;
}

function goertzelPower(x: Float64Array, start: number, len: number, window: Float64Array, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  const k = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < len; i += 1) {
    const s = x[start + i] * window[i] + k * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}

// Mains hum is a stationary line at exactly 50 or 60 Hz. One long Hann window (up to 16 s, 0.25 Hz main lobe)
// resolves it from G1 (49 Hz) or B1 (61.7 Hz) bass notes. A tempo-locked pattern puts lines on every multiple of
// the beat rate (50 Hz is the 25th at 120 BPM), so with a known tempo the line is compared against its neighbours
// on that same comb.
function measureHum(mono: Float64Array, sr: number, beatHz: number | null): HumMetrics[] {
  if (mono.length < 2 * sr) return [];
  const len = Math.min(mono.length, 16 * sr);
  const window = new Float64Array(len);
  for (let i = 0; i < len; i += 1) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
  const starts = mono.length >= 2 * len ? [0, mono.length - len] : [Math.floor((mono.length - len) / 2)];
  const offsets = beatHz !== null && beatHz >= 0.75 ? [-4, -3, -2, -1, 1, 2, 3, 4].map((k) => k * beatHz) : [-3, -2, -1.5, -1, -0.75, -0.5, 0.5, 0.75, 1, 1.5, 2, 3];
  const lineDb = (start: number, f: number): number => {
    const p = goertzelPower(mono, start, len, window, f, sr);
    const floor = offsets.map((o) => goertzelPower(mono, start, len, window, f + o, sr)).sort((a, b) => a - b);
    const mid = floor.length / 2;
    const med = (floor[mid - 1] + floor[mid]) / 2;
    return 10 * Math.log10((p + 1e-30) / (med + 1e-30));
  };
  return ([50, 60] as const).map((hz) => {
    const fund = Math.min(...starts.map((st) => lineDb(st, hz)));
    const harm = Math.min(...starts.map((st) => Math.max(lineDb(st, 2 * hz), lineDb(st, 3 * hz))));
    return { hz, fundamentalDb: round(fund, 2), harmonicDb: round(harm, 2) };
  });
}

function spectral(channels: readonly Float64Array[], sr: number): { centroid: number; r85: number; r95: number } {
  const size = 4096;
  const hop = size / 2;
  const bins = hop + 1;
  const n = channels[0]?.length ?? 0;
  const power = new Float64Array(bins);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const l = channels[0];
  const r = channels[1] ?? channels[0];
  if (l === undefined || r === undefined || n < 16) return { centroid: 0, r85: 0, r95: 0 };
  for (let start = -hop; start < n; start += hop) {
    for (let j = 0; j < size; j += 1) {
      const idx = start + j;
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * j) / size));
      re[j] = idx >= 0 && idx < n ? l[idx] * w : 0;
      im[j] = idx >= 0 && idx < n ? r[idx] * w : 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k < bins; k += 1) {
      const m = (size - k) % size;
      power[k] += re[k] * re[k] + im[k] * im[k] + re[m] * re[m] + im[m] * im[m];
    }
  }
  const binHz = sr / size;
  let total = 0;
  let weighted = 0;
  for (let k = 0; k < bins; k += 1) {
    total += power[k];
    weighted += k * binHz * power[k];
  }
  if (total <= 0) return { centroid: 0, r85: 0, r95: 0 };
  let acc = 0;
  let r85 = 0;
  let r95 = 0;
  for (let k = 0; k < bins; k += 1) {
    acc += power[k];
    if (r85 === 0 && acc >= 0.85 * total) r85 = k * binHz;
    if (acc >= 0.95 * total) {
      r95 = k * binHz;
      break;
    }
  }
  return { centroid: weighted / total, r85, r95 };
}

// How far the sample step at a boundary stands out from the steps around it (first and second differences,
// each over its local median), so tonal material is judged strictly and noisy material leniently.
function boundaryStep(buf: Float64Array, at: number, sr: number, level: number): number {
  const n = buf.length;
  const x = (i: number): number => buf[((i % n) + n) % n];
  const d1 = (i: number): number => Math.abs(x(i) - x(i - 1));
  const d2 = (i: number): number => Math.abs(x(i) - 2 * x(i - 1) + x(i - 2));
  const span = Math.round(sr * 0.02);
  const a = new Float64Array(2 * span);
  const b = new Float64Array(2 * span);
  let k = 0;
  for (let i = at - span; i < at + span; i += 1) {
    if (Math.abs(i - at) <= 2) continue;
    a[k] = d1(i);
    b[k] = d2(i);
    k += 1;
  }
  const floor = level * 1e-4 + 1e-9;
  const m1 = Math.max(percentile(a.subarray(0, k), 0.5), floor);
  const m2 = Math.max(percentile(b.subarray(0, k), 0.5), floor);
  return Math.max(d1(at) / m1, d2(at) / m2, d2(at + 1) / m2);
}

function levelJumpDb(buf: Float64Array, at: number, sr: number): number {
  const n = buf.length;
  const w = Math.round(sr * 0.01);
  let a = 0;
  let b = 0;
  for (let i = 1; i <= w; i += 1) {
    const before = buf[(((at - i) % n) + n) % n];
    const after = buf[(at + i - 1) % n];
    a += before * before;
    b += after * after;
  }
  return Math.abs(10 * Math.log10((a + 1e-12) / (b + 1e-12)));
}

// The loop wrap must look like any other bar line: compared against the roughest bar line in the file.
function measureSeam(channels: readonly Float64Array[], sr: number, barFrames: number | null, level: number): SeamMetrics {
  let wrapStep = 0;
  let maxBarStep = 0;
  let wrapJumpDb = 0;
  let maxBarJumpDb = 0;
  for (const ch of channels) {
    const n = ch.length;
    wrapStep = Math.max(wrapStep, boundaryStep(ch, 0, sr, level));
    wrapJumpDb = Math.max(wrapJumpDb, levelJumpDb(ch, 0, sr));
    if (barFrames !== null && barFrames > 0) {
      for (let b = barFrames; b < n - 2; b += barFrames) {
        const at = Math.round(b);
        maxBarStep = Math.max(maxBarStep, boundaryStep(ch, at, sr, level));
        maxBarJumpDb = Math.max(maxBarJumpDb, levelJumpDb(ch, at, sr));
      }
    }
  }
  return { wrapStep: round(wrapStep), maxBarStep: round(maxBarStep), wrapJumpDb: round(wrapJumpDb, 2), maxBarJumpDb: round(maxBarJumpDb, 2) };
}

export function gateAudio(audio: Audio, o: GateOptions = {}): GateReport {
  const category = o.category ?? 'music';
  const base = CATEGORY_DEFAULTS[category];
  const tol = o.lufsTolerance ?? 2;
  const lufsWindow = o.targetLufs !== undefined ? { lufsMin: o.targetLufs - tol, lufsMax: o.targetLufs + tol } : {};
  const th: GateThresholds = { ...base, ...lufsWindow, ...o.thresholds };
  const sr = audio.sampleRate;
  const chans = audio.channels;
  const n = chans[0]?.length ?? 0;
  const findings: Finding[] = [];
  const add = (f: Finding): void => {
    findings.push(f);
  };

  const loudness = measureLoudness(chans, sr);
  if (th.lufsMin !== null && (loudness.integratedLufs === null || loudness.integratedLufs < th.lufsMin))
    add({ code: 'too_quiet', message: `integrated ${String(loudness.integratedLufs)} LUFS is below ${th.lufsMin}` });
  if (th.lufsMax !== null && loudness.integratedLufs !== null && loudness.integratedLufs > th.lufsMax)
    add({ code: 'too_loud', message: `integrated ${loudness.integratedLufs} LUFS is above ${th.lufsMax}` });
  if (loudness.momentaryMaxLufs !== null && loudness.momentaryMaxLufs > th.momentaryMax)
    add({ code: 'momentary_too_loud', message: `momentary max ${loudness.momentaryMaxLufs} LUFS is above ${th.momentaryMax}` });
  if (th.momentaryMin !== null && (loudness.momentaryMaxLufs === null || loudness.momentaryMaxLufs < th.momentaryMin))
    add({ code: 'momentary_too_quiet', message: `momentary max ${String(loudness.momentaryMaxLufs)} LUFS is below ${th.momentaryMin}` });
  if (loudness.truePeakDbtp !== null && loudness.truePeakDbtp > th.maxTruePeakDbtp)
    add({ code: 'true_peak', message: `true peak ${loudness.truePeakDbtp} dBTP exceeds ${th.maxTruePeakDbtp}`, timeS: round((loudness.truePeakFrame ?? 0) / sr) });

  const level = referenceLevel(chans, sr);
  const dcOffset: number[] = [];
  const clickRatio: number[] = [];
  const clickTimeS: number[] = [];
  const channelRmsDb: number[] = [];
  let clipped = 0;
  chans.forEach((ch, c) => {
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < n; i += 1) {
      sum += ch[i];
      sq += ch[i] * ch[i];
      if (Math.abs(ch[i]) >= 0.9999) clipped += 1;
    }
    const dc = sum / Math.max(1, n);
    dcOffset.push(round(dc, 6));
    channelRmsDb.push(round(toDb(Math.sqrt(sq / Math.max(1, n))), 2));
    if (Math.abs(dc) > th.maxDcOffset) add({ code: 'dc_offset', channel: c, message: `channel ${c} DC offset ${round(dc, 5)} exceeds ${th.maxDcOffset}` });
    const click = detectClick(ch, sr, level);
    clickRatio.push(round(click.ratio, 2));
    clickTimeS.push(round(click.frame / sr, 4));
    if (click.ratio >= th.maxClickRatio) add({ code: 'click', channel: c, timeS: round(click.frame / sr, 4), message: `channel ${c} impulse click ratio ${round(click.ratio, 1)} at ${round(click.frame / sr, 4)} s (limit ${th.maxClickRatio})` });
  });
  if (clipped > th.maxClippedSamples) add({ code: 'clipping', message: `${clipped} samples at full scale` });

  const loudest = Math.max(...channelRmsDb);
  if (loudest < -70) add({ code: 'silent', message: `file is silent (loudest channel ${loudest} dBFS RMS)` });
  else
    channelRmsDb.forEach((db, c) => {
      if (db < -70) add({ code: 'silent_channel', channel: c, message: `channel ${c} is silent (${db} dBFS RMS) while another plays at ${loudest}` });
    });

  const mono = new Float64Array(n);
  for (const ch of chans) for (let i = 0; i < n; i += 1) mono[i] += ch[i] / chans.length;
  const hum = measureHum(mono, sr, o.bpm !== undefined ? o.bpm / 60 : null);
  for (const h of hum)
    if (h.fundamentalDb >= th.humRatioDb || (h.fundamentalDb >= th.humRatioDb / 2 && h.harmonicDb >= th.humRatioDb / 2))
      add({ code: 'hum', message: `${h.hz} Hz mains hum: line ${h.fundamentalDb} dB over its neighbours, harmonics ${h.harmonicDb} dB` });

  let correlation: number | null = null;
  let balanceDb: number | null = null;
  const [l, r] = chans;
  if (l !== undefined && r !== undefined) {
    let ll = 0;
    let rr = 0;
    let lr = 0;
    for (let i = 0; i < n; i += 1) {
      ll += l[i] * l[i];
      rr += r[i] * r[i];
      lr += l[i] * r[i];
    }
    correlation = ll > 0 && rr > 0 ? round(lr / Math.sqrt(ll * rr), 4) : null;
    balanceDb = ll > 0 && rr > 0 ? round(10 * Math.log10(ll / rr), 2) : null;
    if (correlation !== null && correlation < th.minCorrelation) add({ code: 'phase', message: `stereo correlation ${correlation} is below ${th.minCorrelation}; the mix cancels in mono` });
    if (balanceDb !== null && Math.abs(balanceDb) > th.maxBalanceDb) add({ code: 'balance', message: `L/R balance ${balanceDb} dB exceeds ±${th.maxBalanceDb}` });
  }

  const sp = spectral(chans, sr);
  if (loudest >= -70) {
    if (sp.centroid < th.centroidHz[0]) add({ code: 'dull', message: `spectral centroid ${round(sp.centroid, 0)} Hz is below ${th.centroidHz[0]} Hz (muffled or bass-heavy)` });
    if (sp.centroid > th.centroidHz[1]) add({ code: 'harsh', message: `spectral centroid ${round(sp.centroid, 0)} Hz is above ${th.centroidHz[1]} Hz (thin or harsh)` });
    if (sp.r85 < th.rolloff85Hz[0] || sp.r85 > th.rolloff85Hz[1]) add({ code: 'rolloff', message: `85% rolloff ${round(sp.r85, 0)} Hz is outside ${th.rolloff85Hz[0]}-${th.rolloff85Hz[1]} Hz` });
  }

  let seam: SeamMetrics | null = null;
  if (o.loop === true) {
    const barFrames = o.bpm !== undefined ? ((o.beatsPerBar ?? 4) * 60 * sr) / o.bpm : null;
    seam = measureSeam(chans, sr, barFrames, level);
    const limit = Math.max(th.maxSeamStep, th.seamVsBarRatio * seam.maxBarStep);
    if (seam.wrapStep > limit) add({ code: 'loop_seam', message: `loop wrap step ${seam.wrapStep} exceeds ${round(limit, 2)} (roughest bar line ${seam.maxBarStep})` });
    const jumpLimit = Math.max(6, seam.maxBarJumpDb + 3);
    if (seam.wrapJumpDb > jumpLimit) add({ code: 'loop_level_jump', message: `loop wrap level jump ${seam.wrapJumpDb} dB exceeds ${round(jumpLimit, 2)} dB` });
  }

  const pngs = o.pngDir !== undefined ? writePngs(audio, o.pngDir, 'gate', { title: o.title ?? category, ...(o.bpm !== undefined && n / sr > 4 ? { barS: ((o.beatsPerBar ?? 4) * 60) / o.bpm } : {}) }) : undefined;

  return {
    ok: findings.length === 0,
    category,
    durationS: round(n / sr, 4),
    sampleRate: sr,
    channels: chans.length,
    loudness,
    dcOffset,
    clippedSamples: clipped,
    clickRatio,
    clickTimeS,
    hum,
    channelRmsDb,
    correlation,
    balanceDb,
    centroidHz: round(sp.centroid, 1),
    rolloff85Hz: round(sp.r85, 1),
    rolloff95Hz: round(sp.r95, 1),
    seam,
    thresholds: th,
    findings,
    ...(pngs !== undefined ? { pngs } : {}),
  };
}
