import { SAMPLE_RATE, biquad, biquadStep, dbToGain, stereo, type Stereo } from './dsp.js';
import { compress } from './fx.js';
import { integratedLufs, measureTruePeak } from './loudness.js';
import type { MasterConfig } from './project.js';

export const LOOP_PAD_S = 2;

export interface MasterStats {
  readonly preLufs: number | null;
  readonly gainDb: number;
  readonly compressorGrDb: number;
  readonly limiterGrDb: number;
  readonly limiterThresholdDb: number;
  readonly lufs: number | null;
  readonly truePeakDbtp: number | null;
}

// Wraps the loop end before the start and the loop start after the end, so every stateful
// stage sees the audio it would hear on repeat; cropping the middle leaves an invisible seam.
export function wrapPad(buf: Stereo, pad: number): Stereo {
  const n = buf.left.length;
  const out = stereo(n + 2 * pad);
  for (let i = 0; i < out.left.length; i += 1) {
    const j = (((i - pad) % n) + n) % n;
    out.left[i] = buf.left[j];
    out.right[i] = buf.right[j];
  }
  return out;
}

export function crop(buf: Stereo, start: number, frames: number): Stereo {
  return { left: buf.left.slice(start, start + frames), right: buf.right.slice(start, start + frames) };
}

export function highpass(buf: Stereo, hz: number, sr = SAMPLE_RATE): void {
  for (const ch of [buf.left, buf.right]) {
    const a = biquad('highpass', hz, 0.541, 0, sr);
    const b = biquad('highpass', hz, 1.307, 0, sr);
    for (let i = 0; i < ch.length; i += 1) ch[i] = biquadStep(b, biquadStep(a, ch[i]));
  }
}

export function scale(buf: Stereo, gain: number): void {
  for (const ch of [buf.left, buf.right]) for (let i = 0; i < ch.length; i += 1) ch[i] *= gain;
}

// Lookahead brickwall: the gain reaches its target before the peak arrives, then releases smoothly.
export function limit(buf: Stereo, thresholdDb: number, sr = SAMPLE_RATE, lookaheadMs = 1.5, releaseMs = 80): { readonly out: Stereo; readonly deepestDb: number } {
  const n = buf.left.length;
  const thr = dbToGain(thresholdDb);
  const W = Math.max(2, Math.round((lookaheadMs / 1000) * sr));
  const need = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = Math.max(Math.abs(buf.left[i]), Math.abs(buf.right[i]));
    need[i] = p > thr ? thr / p : 1;
  }
  // Trailing min over W samples, then a trailing W-sample mean: the gain at n bounds need[n - W + 1].
  const minBuf = new Float64Array(n);
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i += 1) {
    while (tail > head && need[deque[tail - 1]] >= need[i]) tail -= 1;
    deque[tail++] = i;
    if (deque[head] <= i - W) head += 1;
    minBuf[i] = need[deque[head]];
  }
  const rel = Math.exp(-1 / ((releaseMs / 1000) * sr));
  const out = stereo(n);
  let sum = 0;
  let g = 1;
  let deepest = 1;
  for (let i = 0; i < n + W - 1; i += 1) {
    const enter = i < n ? minBuf[i] - 1 : 0;
    const leave = i >= W && i - W < n ? minBuf[i - W] - 1 : 0;
    sum += enter - leave;
    const avg = Math.min(1, 1 + sum / W);
    g = Math.min(avg, rel * g + (1 - rel) * avg);
    const src = i - (W - 1);
    if (src >= 0 && src < n) {
      out.left[src] = buf.left[src] * g;
      out.right[src] = buf.right[src] * g;
      deepest = Math.min(deepest, g);
    }
  }
  return { out, deepestDb: deepest < 1 ? -20 * Math.log10(deepest) : 0 };
}

// DC-blocking HPF, RMS bus compressor, constant gain to the loudness target, then a true-peak-checked limiter.
// For loops every stage runs on wrap-padded audio and the exact loop frames are cropped back out.
export function masterBus(mix: Stereo, cfg: MasterConfig, loop: boolean, sr = SAMPLE_RATE): { readonly out: Stereo; readonly gainCurve: Float64Array; readonly stats: MasterStats } {
  const n = mix.left.length;
  const pad = loop ? Math.min(n, Math.round(LOOP_PAD_S * sr)) : 0;
  const work = loop ? wrapPad(mix, pad) : { left: mix.left.slice(), right: mix.right.slice() };
  highpass(work, cfg.hpfHz, sr);
  const curve = new Float64Array(work.left.length).fill(1);
  const compressorGrDb = cfg.compressor === null ? 0 : compress(work, { ...cfg.compressor, kneeDb: 6 }, sr, curve);
  const body = (b: Stereo): Stereo => (loop ? crop(b, pad, n) : b);
  const preLufs = integratedLufs([body(work).left, body(work).right], sr);
  let gainDb = preLufs === null ? 0 : cfg.targetLufs - preLufs;
  let thresholdDb = cfg.ceilingDbtp - 0.3;
  let result = { out: body(work), deepestDb: 0 };
  let lufs: number | null = null;
  let tp: number | null = null;
  for (let pass = 0; pass < 6; pass += 1) {
    const staged = { left: work.left.slice(), right: work.right.slice() };
    scale(staged, dbToGain(gainDb));
    const limited = limit(staged, thresholdDb, sr);
    result = { out: body(limited.out), deepestDb: limited.deepestDb };
    lufs = integratedLufs([result.out.left, result.out.right], sr);
    tp = measureTruePeak([result.out.left, result.out.right]).truePeakDbtp;
    const lufsErr = lufs === null ? 0 : cfg.targetLufs - lufs;
    const tpOver = tp === null ? 0 : tp - (cfg.ceilingDbtp - 0.1);
    if (Math.abs(lufsErr) < 0.15 && tpOver <= 0) break;
    if (tpOver > 0) thresholdDb -= tpOver + 0.05;
    gainDb += lufsErr;
  }
  const gain = dbToGain(gainDb);
  const gainCurve = (loop ? curve.slice(pad, pad + n) : curve).map((g) => g * gain);
  return {
    out: result.out,
    gainCurve,
    stats: {
      preLufs,
      gainDb,
      compressorGrDb,
      limiterGrDb: result.deepestDb,
      limiterThresholdDb: thresholdDb,
      lufs,
      truePeakDbtp: tp,
    },
  };
}

// The linear part of the master (DC filter, compressor gain curve and make-up) applied to one stem.
export function masterStem(stem: Stereo, gainCurve: Float64Array, hpfHz: number, loop: boolean, sr = SAMPLE_RATE): Stereo {
  const n = stem.left.length;
  const pad = loop ? Math.min(n, Math.round(LOOP_PAD_S * sr)) : 0;
  const work = loop ? wrapPad(stem, pad) : { left: stem.left.slice(), right: stem.right.slice() };
  highpass(work, hpfHz, sr);
  const out = loop ? crop(work, pad, n) : work;
  for (let i = 0; i < n; i += 1) {
    out.left[i] *= gainCurve[i];
    out.right[i] *= gainCurve[i];
  }
  return out;
}
