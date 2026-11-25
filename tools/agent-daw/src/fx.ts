import { SAMPLE_RATE, biquad, biquadStep, dbToGain, onePoleCoeff, type Biquad, type Stereo } from './dsp.js';
import { cabFilters } from './instruments/guitar.js';
import type { FxConfig } from './project.js';

export interface FxContext {
  readonly sampleRate: number;
  readonly secondsPerBeat: number;
  // Loop length in frames, or null for one-shots; modulation rates snap to whole cycles per loop.
  readonly loopFrames: number | null;
}

export function applyFx(buf: Stereo, fx: FxConfig, ctx: FxContext): void {
  switch (fx.type) {
    case 'eq3':
      return eq3(buf, fx);
    case 'chorus':
      return chorus(buf, fx, ctx);
    case 'delay':
      return delay(buf, fx, ctx);
    case 'reverb':
      return reverb(buf, fx);
    case 'overdrive':
      return overdrive(buf, fx);
    case 'cab':
      return cab(buf, fx);
    case 'compressor':
      compress(buf, fx);
      return;
  }
}

function eachChannel(buf: Stereo, make: () => Biquad[]): void {
  for (const ch of [buf.left, buf.right]) {
    const chain = make();
    for (let i = 0; i < ch.length; i += 1) {
      let y = ch[i];
      for (const f of chain) y = biquadStep(f, y);
      ch[i] = y;
    }
  }
}

function eq3(buf: Stereo, fx: Extract<FxConfig, { type: 'eq3' }>): void {
  eachChannel(buf, () => [biquad('lowshelf', fx.lowHz, 0.7, fx.lowDb), biquad('peak', fx.midHz, fx.midQ, fx.midDb), biquad('highshelf', fx.highHz, 0.7, fx.highDb)]);
}

function cab(buf: Stereo, fx: Extract<FxConfig, { type: 'cab' }>): void {
  eachChannel(buf, () => cabFilters(fx.lowCutHz, fx.highCutHz, fx.presenceDb));
}

export function loopSafeRate(rateHz: number, ctx: FxContext): number {
  if (ctx.loopFrames === null) return rateHz;
  const loopS = ctx.loopFrames / ctx.sampleRate;
  return Math.max(1, Math.round(rateHz * loopS)) / loopS;
}

function readFrac(line: Float64Array, write: number, delayFrames: number): number {
  const n = line.length;
  const pos = write - delayFrames;
  const i0 = Math.floor(pos);
  const frac = pos - i0;
  const a = line[((i0 % n) + n) % n];
  const b = line[(((i0 + 1) % n) + n) % n];
  return a + (b - a) * frac;
}

function chorus(buf: Stereo, fx: Extract<FxConfig, { type: 'chorus' }>, ctx: FxContext): void {
  const sr = ctx.sampleRate;
  const rate = loopSafeRate(fx.rateHz, ctx);
  const size = Math.ceil(((fx.delayMs + fx.depthMs) / 1000) * sr) + 4;
  const lines = [new Float64Array(size), new Float64Array(size)];
  const chans = [buf.left, buf.right];
  for (let i = 0; i < buf.left.length; i += 1) {
    const w = i % size;
    for (let c = 0; c < 2; c += 1) {
      const x = chans[c][i];
      lines[c][w] = x;
      const lfo = Math.sin((2 * Math.PI * rate * i) / sr + c * Math.PI * 0.5);
      const d = ((fx.delayMs + fx.depthMs * 0.5 * (1 + lfo)) / 1000) * sr;
      chans[c][i] = x * (1 - fx.mix * 0.5) + readFrac(lines[c], w, d) * fx.mix;
    }
  }
}

function delay(buf: Stereo, fx: Extract<FxConfig, { type: 'delay' }>, ctx: FxContext): void {
  const d = Math.max(1, Math.round(fx.timeBeats * ctx.secondsPerBeat * ctx.sampleRate));
  const lineL = new Float64Array(d);
  const lineR = new Float64Array(d);
  const k = onePoleCoeff(fx.dampHz, ctx.sampleRate);
  let lpL = 0;
  let lpR = 0;
  for (let i = 0; i < buf.left.length; i += 1) {
    const w = i % d;
    const outL = lineL[w];
    const outR = lineR[w];
    lpL += k * (outL - lpL);
    lpR += k * (outR - lpR);
    const xl = buf.left[i];
    const xr = buf.right[i];
    if (fx.pingPong) {
      lineL[w] = (xl + xr) * 0.5 + lpR * fx.feedback;
      lineR[w] = lpL * fx.feedback;
    } else {
      lineL[w] = xl + lpL * fx.feedback;
      lineR[w] = xr + lpR * fx.feedback;
    }
    buf.left[i] = xl + outL * fx.mix;
    buf.right[i] = xr + outR * fx.mix;
  }
}

function overdrive(buf: Stereo, fx: Extract<FxConfig, { type: 'overdrive' }>): void {
  const bias = 0.12;
  const offset = Math.tanh(fx.drive * bias);
  const makeup = 0.5 / Math.tanh(fx.drive * 0.5);
  eachChannelSample(buf, () => {
    const hp = biquad('highpass', 70, 0.7);
    const tone = biquad('lowpass', 1500 + fx.tone * 9000, 0.7);
    return (x: number) => {
      const y = (Math.tanh(fx.drive * (biquadStep(hp, x) + bias)) - offset) * makeup;
      return x * (1 - fx.mix) + biquadStep(tone, y) * fx.mix;
    };
  });
}

function eachChannelSample(buf: Stereo, make: () => (x: number) => number): void {
  for (const ch of [buf.left, buf.right]) {
    const f = make();
    for (let i = 0; i < ch.length; i += 1) ch[i] = f(ch[i]);
  }
}

export interface CompressorSettings {
  readonly thresholdDb: number;
  readonly ratio: number;
  readonly attackMs: number;
  readonly releaseMs: number;
  readonly makeupDb?: number;
  readonly kneeDb?: number;
}

// Stereo-linked RMS compressor with a soft knee; returns the deepest gain reduction in dB.
export function compress(buf: Stereo, c: CompressorSettings, sr = SAMPLE_RATE): number {
  const knee = c.kneeDb ?? 6;
  const rmsCoeff = Math.exp(-1 / (0.01 * sr));
  const att = Math.exp(-1 / ((c.attackMs / 1000) * sr));
  const rel = Math.exp(-1 / ((c.releaseMs / 1000) * sr));
  const makeup = dbToGain(c.makeupDb ?? 0);
  let ms = 0;
  let grDb = 0;
  let deepest = 0;
  for (let i = 0; i < buf.left.length; i += 1) {
    const l = buf.left[i];
    const r = buf.right[i];
    ms = rmsCoeff * ms + (1 - rmsCoeff) * 0.5 * (l * l + r * r);
    const levelDb = 10 * Math.log10(ms + 1e-20);
    const over = levelDb - c.thresholdDb;
    let target = 0;
    if (2 * over > knee) target = over * (1 - 1 / c.ratio);
    else if (2 * Math.abs(over) <= knee) target = ((1 - 1 / c.ratio) * Math.pow(over + knee / 2, 2)) / (2 * Math.max(1e-9, knee));
    grDb = target > grDb ? att * grDb + (1 - att) * target : rel * grDb + (1 - rel) * target;
    deepest = Math.max(deepest, grDb);
    const g = dbToGain(-grDb) * makeup;
    buf.left[i] = l * g;
    buf.right[i] = r * g;
  }
  return deepest;
}

interface Comb {
  readonly line: Float64Array;
  idx: number;
  store: number;
}

interface Allpass {
  readonly line: Float64Array;
  idx: number;
}

const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING = [556, 441, 341, 225];
const STEREO_SPREAD = 23;

const PRESETS = {
  hall: { size: 1.35, er: [[11, 0.42], [17, 0.35], [23, 0.3], [31, 0.25], [43, 0.2], [59, 0.15], [71, 0.12]] as const, diffusion: 0, lowCut: 180, highCut: 8500 },
  plate: { size: 0.85, er: [] as readonly (readonly [number, number])[], diffusion: 4, lowCut: 250, highCut: 12000 },
  room: { size: 0.6, er: [[5, 0.4], [9, 0.32], [13, 0.25], [19, 0.18]] as const, diffusion: 0, lowCut: 150, highCut: 7000 },
};

// Freeverb (8 parallel damped combs into 4 series allpasses per side) with preset-sized rooms,
// decorrelated early reflections and band-limited wet input.
function reverb(buf: Stereo, fx: Extract<FxConfig, { type: 'reverb' }>, sr = SAMPLE_RATE): void {
  const preset = PRESETS[fx.preset];
  const scale = (sr / 44100) * preset.size;
  const feedback = 0.7 + 0.28 * fx.decay;
  const damp = fx.damping * 0.4;
  const makeCombs = (offset: number): Comb[] => COMB_TUNING.map((n) => ({ line: new Float64Array(Math.round((n + offset) * scale)), idx: 0, store: 0 }));
  const makeAllpasses = (offset: number, tuning: readonly number[]): Allpass[] => tuning.map((n) => ({ line: new Float64Array(Math.max(8, Math.round((n + offset) * scale))), idx: 0 }));
  const combsL = makeCombs(0);
  const combsR = makeCombs(STEREO_SPREAD);
  const apL = makeAllpasses(0, ALLPASS_TUNING);
  const apR = makeAllpasses(STEREO_SPREAD, ALLPASS_TUNING);
  const diffuser = makeAllpasses(0, [142, 107, 379, 277].slice(0, preset.diffusion));
  const predelay = Math.max(1, Math.round((fx.predelayMs / 1000) * sr));
  const erMax = Math.round(0.08 * sr) + 2;
  const preLine = new Float64Array(predelay + erMax);
  const lowCut = biquad('highpass', preset.lowCut, 0.7, 0, sr);
  const highCut = biquad('lowpass', preset.highCut, 0.7, 0, sr);
  const erTaps = preset.er.map(([ms, g], k) => ({ d: predelay + Math.round((ms / 1000) * sr), g, left: k % 2 === 0 }));
  const wet1 = 0.5 + fx.width / 2;
  const wet2 = (1 - fx.width) / 2;
  const fixedGain = 0.015 * 2;
  const n = buf.left.length;
  const len = preLine.length;

  const combStep = (c: Comb, x: number): number => {
    const out = c.line[c.idx];
    c.store = out * (1 - damp) + c.store * damp;
    c.line[c.idx] = x + c.store * feedback;
    c.idx = c.idx + 1 === c.line.length ? 0 : c.idx + 1;
    return out;
  };
  const apStep = (a: Allpass, x: number): number => {
    const b = a.line[a.idx];
    a.line[a.idx] = x + b * 0.5;
    a.idx = a.idx + 1 === a.line.length ? 0 : a.idx + 1;
    return b - x;
  };

  for (let i = 0; i < n; i += 1) {
    const w = i % len;
    const dryL = buf.left[i];
    const dryR = buf.right[i];
    preLine[w] = biquadStep(highCut, biquadStep(lowCut, (dryL + dryR) * 0.5));
    let input = preLine[(w - predelay + len) % len];
    for (const d of diffuser) input = apStep(d, input);
    let erL = 0;
    let erR = 0;
    for (const t of erTaps) {
      const v = preLine[(w - t.d + len * 2) % len] * t.g;
      if (t.left) erL += v;
      else erR += v;
    }
    let outL = 0;
    let outR = 0;
    const x = input * fixedGain;
    for (let k = 0; k < combsL.length; k += 1) {
      outL += combStep(combsL[k], x);
      outR += combStep(combsR[k], x);
    }
    for (let k = 0; k < apL.length; k += 1) {
      outL = apStep(apL[k], outL);
      outR = apStep(apR[k], outR);
    }
    const wetL = outL * wet1 + outR * wet2 + erL * 0.35;
    const wetR = outR * wet1 + outL * wet2 + erR * 0.35;
    buf.left[i] = dryL + wetL * fx.mix;
    buf.right[i] = dryR + wetR * fx.mix;
  }
}
