export const SAMPLE_RATE = 48000;

export interface Stereo {
  readonly left: Float64Array;
  readonly right: Float64Array;
}

export function stereo(frames: number): Stereo {
  return { left: new Float64Array(frames), right: new Float64Array(frames) };
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => (g > 0 ? 20 * Math.log10(g) : -Infinity);
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const midiToHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

// Equal-power pan law, pan in [-1, 1].
export function panGains(pan: number): readonly [number, number] {
  const a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type Rng = () => number;

// mulberry32: uniform in [0, 1).
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export type BiquadKind = 'lowpass' | 'highpass' | 'bandpass' | 'peak' | 'lowshelf' | 'highshelf' | 'notch';

// RBJ audio-EQ cookbook.
export function biquad(kind: BiquadKind, freq: number, q: number, gainDb = 0, sr = SAMPLE_RATE): Biquad {
  const f = clamp(freq, 5, sr * 0.49);
  const w0 = (2 * Math.PI * f) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Math.max(1e-4, q));
  const A = Math.pow(10, gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (kind) {
    case 'lowpass':
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1; b1 = -2 * cos; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'peak':
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + s); b1 = 2 * A * (A - 1 - (A + 1) * cos); b2 = A * (A + 1 - (A - 1) * cos - s);
      a0 = A + 1 + (A - 1) * cos + s; a1 = -2 * (A - 1 + (A + 1) * cos); a2 = A + 1 + (A - 1) * cos - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + s); b1 = -2 * A * (A - 1 + (A + 1) * cos); b2 = A * (A + 1 + (A - 1) * cos - s);
      a0 = A + 1 - (A - 1) * cos + s; a1 = 2 * (A - 1 - (A + 1) * cos); a2 = A + 1 - (A - 1) * cos - s;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

export function biquadStep(f: Biquad, x: number): number {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1;
  f.x1 = x;
  f.y2 = f.y1;
  f.y1 = y;
  return y;
}

export function biquadRun(f: Biquad, buf: Float64Array): void {
  for (let i = 0; i < buf.length; i += 1) buf[i] = biquadStep(f, buf[i]);
}

export function filterChain(buf: Float64Array, filters: readonly Biquad[]): void {
  for (const f of filters) biquadRun(f, buf);
}

// Topology-preserving state-variable filter; cutoff may change every sample.
export interface Svf {
  ic1: number;
  ic2: number;
}

export function svfLowpass(state: Svf, x: number, cutoff: number, q: number, sr = SAMPLE_RATE): number {
  return svfStep(state, x, svfG(cutoff, sr), 1 / q);
}

export function svfG(cutoff: number, sr = SAMPLE_RATE): number {
  return Math.tan((Math.PI * clamp(cutoff, 10, sr * 0.45)) / sr);
}

// k = 1 / Q; callers that sweep cutoff can refresh g every few samples instead of every sample.
export function svfStep(state: Svf, x: number, g: number, k: number): number {
  const a1 = 1 / (1 + g * (g + k));
  const a2 = g * a1;
  const a3 = g * a2;
  const v3 = x - state.ic2;
  const v1 = a1 * state.ic1 + a2 * v3;
  const v2 = state.ic2 + a2 * state.ic1 + a3 * v3;
  state.ic1 = 2 * v1 - state.ic1;
  state.ic2 = 2 * v2 - state.ic2;
  return v2;
}

export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

// 2^(cents / 1200) to within 0.03 cents for |cents| <= 40.
export function centsRatio(cents: number): number {
  const x = cents * 5.776226504666211e-4;
  return 1 + x * (1 + x * (0.5 + x / 6));
}

export function onePoleCoeff(cutoff: number, sr = SAMPLE_RATE): number {
  return 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
}

export function softClip(x: number): number {
  return Math.tanh(x);
}

export function addInto(dst: Float64Array, src: Float64Array, offset: number, gain: number, wrap: boolean): void {
  const n = dst.length;
  for (let i = 0; i < src.length; i += 1) {
    let j = offset + i;
    if (wrap) {
      j %= n;
      if (j < 0) j += n;
    } else if (j < 0 || j >= n) {
      continue;
    }
    dst[j] += src[i] * gain;
  }
}

export function rms(buf: Float64Array, start = 0, end = buf.length): number {
  let s = 0;
  for (let i = start; i < end; i += 1) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, end - start));
}

export function peakAbs(buf: Float64Array): number {
  let m = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const a = Math.abs(buf[i]);
    if (a > m) m = a;
  }
  return m;
}
