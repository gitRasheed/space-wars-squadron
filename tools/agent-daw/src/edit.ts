import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dbToGain } from './dsp.js';
import { CATEGORIES, type Category } from './gate.js';
import { integratedLufs, measureLoudness, measureTruePeak } from './loudness.js';
import { crop, limit, wrapPad } from './master.js';
import { readWav, writeWav, type Audio, type BitDepth } from './wav.js';

export const EDIT_OPS = ['trim-silence', 'fade', 'normalize', 'pitch', 'stretch', 'layer', 'export'] as const;
export type EditOp = (typeof EDIT_OPS)[number];
export type Backend = 'native' | 'sox' | 'rubberband' | 'ffmpeg';

export const CATEGORY_LUFS: Readonly<Record<Category, number>> = { music: -16, sfx: -18, ui: -22, ambience: -24 };

export function hasBinary(bin: string): boolean {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  return r.error === undefined;
}

function run(bin: string, args: readonly string[]): void {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.error !== undefined) throw new Error(`${bin} is not installed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed (exit ${String(r.status)}): ${r.stderr.trim()}`);
}

const frames = (a: Audio): number => a.channels[0]?.length ?? 0;
const mapChannels = (a: Audio, f: (ch: Float64Array) => Float64Array): Audio => ({ sampleRate: a.sampleRate, channels: a.channels.map(f) });

export function trimSilence(a: Audio, thresholdDb = -60, padMs = 5): Audio {
  const thr = dbToGain(thresholdDb);
  const n = frames(a);
  const loud = (i: number): boolean => a.channels.some((ch) => Math.abs(ch[i]) > thr);
  let s = 0;
  while (s < n && !loud(s)) s += 1;
  let e = n;
  while (e > s && !loud(e - 1)) e -= 1;
  const pad = Math.round((padMs / 1000) * a.sampleRate);
  return mapChannels(a, (ch) => ch.slice(Math.max(0, s - pad), Math.min(n, e + pad)));
}

export function fade(a: Audio, inS: number, outS: number, curve: 'linear' | 'equal-power' = 'equal-power'): Audio {
  const n = frames(a);
  const fi = Math.min(n, Math.round(inS * a.sampleRate));
  const fo = Math.min(n, Math.round(outS * a.sampleRate));
  const shape = (t: number): number => (curve === 'linear' ? t : Math.sin((t * Math.PI) / 2));
  return mapChannels(a, (ch) => {
    const out = ch.slice();
    for (let i = 0; i < fi; i += 1) out[i] *= shape(i / fi);
    for (let i = 0; i < fo; i += 1) out[n - 1 - i] *= shape(i / fo);
    return out;
  });
}

export interface NormalizeOptions {
  readonly lufs?: number;
  readonly peakDb?: number;
  readonly category?: Category;
  readonly ceilingDbtp?: number;
  readonly loop?: boolean;
}

// Constant gain to the target; a limiter only engages if that gain would break the true-peak ceiling.
export function normalize(a: Audio, o: NormalizeOptions): { readonly audio: Audio; readonly gainDb: number; readonly limited: boolean } {
  const ceiling = o.ceilingDbtp ?? -1.5;
  let gainDb: number;
  if (o.peakDb !== undefined) {
    const tp = measureTruePeak(a.channels).truePeakLinear;
    gainDb = tp > 0 ? o.peakDb - 20 * Math.log10(tp) : 0;
  } else {
    const target = o.lufs ?? CATEGORY_LUFS[o.category ?? 'music'];
    const now = integratedLufs(a.channels, a.sampleRate) ?? measureLoudness(a.channels, a.sampleRate).momentaryMaxLufs;
    gainDb = now === null ? 0 : target - now;
  }
  const g = dbToGain(gainDb);
  const scaled = mapChannels(a, (ch) => ch.map((x) => x * g));
  const tp = measureTruePeak(scaled.channels).truePeakDbtp;
  if (tp === null || tp <= ceiling || o.peakDb !== undefined) return { audio: scaled, gainDb, limited: false };
  const [l, r] = scaled.channels;
  if (l === undefined) return { audio: scaled, gainDb, limited: false };
  const st = { left: l, right: r ?? l };
  const n = l.length;
  const pad = o.loop === true ? Math.min(n, 2 * a.sampleRate) : 0;
  let thr = ceiling - 0.3;
  let out = st;
  for (let pass = 0; pass < 4; pass += 1) {
    const src = o.loop === true ? wrapPad(st, pad) : st;
    const limited = limit(src, thr, a.sampleRate).out;
    out = o.loop === true ? crop(limited, pad, n) : limited;
    const over = (measureTruePeak([out.left, out.right]).truePeakDbtp ?? -100) - ceiling;
    if (over <= 0) break;
    thr -= over + 0.05;
  }
  return { audio: { sampleRate: a.sampleRate, channels: r === undefined ? [out.left] : [out.left, out.right] }, gainDb, limited: true };
}

// Windowed-sinc (Lanczos a=8) resampling by a read-rate ratio: ratio 2 reads twice as fast (an octave up, half as long).
export function resample(ch: Float64Array, ratio: number): Float64Array {
  const outLen = Math.max(1, Math.floor(ch.length / ratio));
  const out = new Float64Array(outLen);
  const A = 8;
  const cutoff = Math.min(1, 1 / ratio);
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    const base = Math.floor(pos);
    let acc = 0;
    let wsum = 0;
    const reach = Math.ceil(A / cutoff);
    for (let k = base - reach + 1; k <= base + reach; k += 1) {
      if (k < 0 || k >= ch.length) continue;
      const x = (pos - k) * cutoff;
      const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const win = Math.abs(x) < A ? (Math.abs(x) < 1e-9 ? 1 : Math.sin((Math.PI * x) / A) / ((Math.PI * x) / A)) : 0;
      const w = sinc * win;
      acc += ch[k] * w;
      wsum += w;
    }
    out[i] = wsum !== 0 ? acc / wsum : 0;
  }
  return out;
}

// WSOLA: overlap-add Hann frames, each shifted within a search range to line up with the previous output.
export function wsola(ch: Float64Array, durationRatio: number, sr: number): Float64Array {
  const N = Math.round(0.046 * sr);
  const hopOut = Math.round(N / 4);
  const hopIn = hopOut / durationRatio;
  const search = Math.round(0.012 * sr);
  const outLen = Math.round(ch.length * durationRatio);
  const out = new Float64Array(outLen + N);
  const norm = new Float64Array(outLen + N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i += 1) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
  const at = (i: number): number => (i >= 0 && i < ch.length ? ch[i] : 0);
  let prevStart = 0;
  for (let k = 0; k * hopOut < outLen; k += 1) {
    const nominal = Math.round(k * hopIn);
    let best = nominal;
    if (k > 0) {
      // The natural continuation of the previous frame is where the new one should match.
      const target = prevStart + hopOut;
      let bestScore = -Infinity;
      for (let d = -search; d <= search; d += 4) {
        const cand = nominal + d;
        let score = 0;
        for (let j = 0; j < N / 2; j += 8) score += at(cand + j) * at(target + j);
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
    }
    const o0 = k * hopOut;
    for (let j = 0; j < N; j += 1) {
      out[o0 + j] += at(best + j) * win[j];
      norm[o0 + j] += win[j];
    }
    prevStart = best;
  }
  const res = new Float64Array(outLen);
  for (let i = 0; i < outLen; i += 1) res[i] = norm[i] > 1e-6 ? out[i] / norm[i] : 0;
  return res;
}

export function pitchShift(a: Audio, semitones: number, preserveDuration = true): Audio {
  const ratio = Math.pow(2, semitones / 12);
  return mapChannels(a, (ch) => {
    const shifted = resample(ch, ratio);
    return preserveDuration ? fitLength(wsola(shifted, ratio, a.sampleRate), ch.length) : shifted;
  });
}

function fitLength(ch: Float64Array, n: number): Float64Array {
  if (ch.length === n) return ch;
  const out = new Float64Array(n);
  out.set(ch.subarray(0, n));
  return out;
}

export function stretch(a: Audio, durationRatio: number): Audio {
  return mapChannels(a, (ch) => wsola(ch, durationRatio, a.sampleRate));
}

export function layer(inputs: readonly Audio[], gainsDb: readonly number[] = [], offsetsS: readonly number[] = []): Audio {
  const first = inputs[0];
  if (first === undefined) throw new Error('layer needs at least one input');
  const sr = first.sampleRate;
  if (inputs.some((x) => x.sampleRate !== sr)) throw new Error('layer inputs must share a sample rate');
  const chCount = Math.max(...inputs.map((x) => x.channels.length));
  const len = Math.max(...inputs.map((x, i) => frames(x) + Math.round((offsetsS[i] ?? 0) * sr)));
  const out = Array.from({ length: chCount }, () => new Float64Array(len));
  inputs.forEach((x, i) => {
    const g = dbToGain(gainsDb[i] ?? 0);
    const off = Math.round((offsetsS[i] ?? 0) * sr);
    for (let c = 0; c < chCount; c += 1) {
      const src = x.channels[Math.min(c, x.channels.length - 1)];
      if (src === undefined) continue;
      for (let j = 0; j < src.length; j += 1) out[c][j + off] += src[j] * g;
    }
  });
  return { sampleRate: sr, channels: out };
}

export interface EditRequest {
  readonly op: EditOp;
  readonly inputs: readonly string[];
  readonly out: string;
  readonly backend?: Backend;
  readonly bitDepth?: BitDepth;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface EditResult {
  readonly op: EditOp;
  readonly out: string;
  readonly backend: Backend;
  readonly durationS: number;
  readonly notes: readonly string[];
}

const numParam = (p: Readonly<Record<string, unknown>>, k: string, def?: number): number => {
  const v = p[k];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  if (def === undefined) throw new Error(`missing numeric parameter "${k}"`);
  return def;
};

function withTemp<T>(f: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-daw-'));
  try {
    return f(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function runEdit(req: EditRequest): EditResult {
  const p = req.params ?? {};
  const backend = req.backend ?? 'native';
  const bitDepth = req.bitDepth ?? 24;
  const notes: string[] = [];
  const input = req.inputs[0];
  if (input === undefined) throw new Error(`${req.op} needs an input file`);
  const finish = (a: Audio): EditResult => {
    writeWav(req.out, a, bitDepth);
    return { op: req.op, out: req.out, backend, durationS: Number((frames(a) / a.sampleRate).toFixed(4)), notes };
  };

  if (backend !== 'native' && (req.op === 'pitch' || req.op === 'stretch' || req.op === 'export')) {
    return withTemp((dir) => {
      const outTmp = req.op === 'export' ? req.out : path.join(dir, 'out.wav');
      if (backend === 'rubberband') {
        const args = req.op === 'pitch' ? ['-q', '-p', String(numParam(p, 'semitones')), input, outTmp] : ['-q', '-t', String(numParam(p, 'ratio')), input, outTmp];
        if (req.op === 'export') throw new Error('rubberband cannot export; use ffmpeg or sox');
        run('rubberband', args);
      } else if (backend === 'sox') {
        const effect = req.op === 'pitch' ? ['pitch', String(numParam(p, 'semitones') * 100)] : req.op === 'stretch' ? ['tempo', '-m', String(1 / numParam(p, 'ratio'))] : [];
        run('sox', [input, ...(req.op === 'export' ? ['-b', String(bitDepth)] : []), outTmp, ...effect]);
      } else {
        if (req.op !== 'export') throw new Error('the ffmpeg backend only exports; use rubberband or sox for pitch and stretch');
        run('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, outTmp]);
      }
      if (req.op === 'export') return { op: req.op, out: req.out, backend, durationS: 0, notes: [`encoded by ${backend}`] };
      return finish(readWav(outTmp));
    });
  }

  const a = readWav(input);
  switch (req.op) {
    case 'trim-silence':
      return finish(trimSilence(a, numParam(p, 'thresholdDb', -60), numParam(p, 'padMs', 5)));
    case 'fade':
      return finish(fade(a, numParam(p, 'inS', numParam(p, 'in', 0.005)), numParam(p, 'outS', numParam(p, 'out', 0.03)), p.curve === 'linear' ? 'linear' : 'equal-power'));
    case 'normalize': {
      const cat = typeof p.category === 'string' && (CATEGORIES as readonly string[]).includes(p.category) ? (p.category as Category) : undefined;
      const r = normalize(a, {
        ...(p.lufs !== undefined ? { lufs: numParam(p, 'lufs') } : {}),
        ...(p.peakDb !== undefined ? { peakDb: numParam(p, 'peakDb') } : {}),
        ...(cat !== undefined ? { category: cat } : {}),
        ceilingDbtp: numParam(p, 'ceilingDbtp', -1.5),
        loop: p.loop === true || p.loop === 'true',
      });
      notes.push(`gain ${r.gainDb.toFixed(2)} dB${r.limited ? ', true-peak limiter engaged' : ''}`);
      return finish(r.audio);
    }
    case 'pitch':
      return finish(pitchShift(a, numParam(p, 'semitones'), p.preserveDuration !== false && p.preserveDuration !== 'false'));
    case 'stretch':
      return finish(stretch(a, numParam(p, 'ratio')));
    case 'layer': {
      const gains = Array.isArray(p.gainsDb) ? (p.gainsDb as unknown[]).map(Number) : [];
      const offsets = Array.isArray(p.offsetsS) ? (p.offsetsS as unknown[]).map(Number) : [];
      return finish(layer(req.inputs.map(readWav), gains, offsets));
    }
    case 'export':
      if (!req.out.toLowerCase().endsWith('.wav')) throw new Error('native export writes WAV only; pass backend ffmpeg or sox for other formats');
      return finish(a);
  }
}
