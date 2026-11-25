import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fftInPlace } from '../src/fft.js';
import { parseProject, type Project } from '../src/project.js';
import type { Audio } from '../src/wav.js';

export const SR = 48000;

export function project(overrides: Record<string, unknown>): Project {
  const r = parseProject({ format: 'agent-daw/v1', id: 'test', kind: 'loop', tempo: { bpm: 120, beatsPerBar: 4 }, key: { tonic: 'D', mode: 'minor' }, bars: 2, tracks: [], ...overrides });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

export function track(id: string, instrument: unknown, notes: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, instrument, clips: [{ id: 'c', startBeat: 0, notes }], ...extra };
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-daw-test-'));
}

export function sine(freq: number, seconds: number, amp = 0.5, channels = 2): Audio {
  const n = Math.round(seconds * SR);
  const ch = new Float64Array(n);
  for (let i = 0; i < n; i += 1) ch[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return { sampleRate: SR, channels: Array.from({ length: channels }, () => ch.slice()) };
}

export function mono(a: { readonly left: Float64Array; readonly right: Float64Array }): Float64Array {
  return a.left.map((v, i) => 0.5 * (v + a.right[i]));
}

// Peak frequency in [lo, hi] from a zero-padded Hann FFT with parabolic interpolation.
export function peakHz(x: Float64Array, lo: number, hi: number, start = 0, len = x.length - start): number {
  let size = 1;
  while (size < len * 4) size *= 2;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < len; i += 1) re[i] = x[start + i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
  fftInPlace(re, im);
  const mag = (k: number): number => Math.hypot(re[k], im[k]);
  const k0 = Math.floor((lo * size) / SR);
  const k1 = Math.ceil((hi * size) / SR);
  let best = k0;
  for (let k = k0; k <= k1; k += 1) if (mag(k) > mag(best)) best = k;
  const a = Math.log(mag(best - 1) + 1e-30);
  const b = Math.log(mag(best) + 1e-30);
  const c = Math.log(mag(best + 1) + 1e-30);
  const off = (0.5 * (a - c)) / (a - 2 * b + c);
  return ((best + off) * SR) / size;
}

export function centroid(x: Float64Array): number {
  let size = 1;
  while (size < x.length) size *= 2;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(x);
  fftInPlace(re, im);
  let num = 0;
  let den = 0;
  for (let k = 1; k < size / 2; k += 1) {
    const p = re[k] * re[k] + im[k] * im[k];
    num += ((k * SR) / size) * p;
    den += p;
  }
  return num / den;
}

export function rmsOf(x: Float64Array, s = 0, e = x.length): number {
  let acc = 0;
  for (let i = s; i < e; i += 1) acc += x[i] * x[i];
  return Math.sqrt(acc / Math.max(1, e - s));
}

export const cents = (a: number, b: number): number => 1200 * Math.log2(a / b);
