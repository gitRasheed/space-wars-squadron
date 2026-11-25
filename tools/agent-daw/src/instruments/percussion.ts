import { SAMPLE_RATE, biquad, biquadStep, clamp, midiToHz, panGains, stereo, type Biquad, type Rng, type Stereo } from '../dsp.js';
import { articulate, noise, type Instrument, type NoteEvent, type Params } from './common.js';

interface Mode {
  readonly ratio: number;
  readonly amp: number;
  readonly decayS: number;
}

interface Membrane {
  readonly freq: number;
  readonly modes: readonly Mode[];
  readonly glide: number;
  readonly glideS: number;
  readonly level: number;
  readonly hardness: number;
}

function addModes(out: Float64Array, m: Membrane, vel: number, dampAt: number, rng: Rng): void {
  const sr = SAMPLE_RATE;
  m.modes.forEach((mode, k) => {
    const amp = mode.amp * m.level * Math.pow(vel, 1.3) * Math.pow(clamp(vel, 0.05, 1), m.hardness * k * 0.15);
    const mul = Math.exp(-1 / (mode.decayS * sr));
    const dampMul = Math.exp(-1 / (0.05 * sr));
    const glideMul = Math.exp(-1 / (m.glideS * sr));
    const w0 = (2 * Math.PI * m.freq * mode.ratio) / sr;
    let glide = m.glide * vel;
    let phase = rng() * 0.3;
    let e = amp;
    let i = 0;
    // While the strike glide is audible the phase is integrated; afterwards a recursive oscillator takes over.
    for (; i < out.length && glide > 1e-5; i += 1) {
      phase += w0 * (1 + glide);
      glide *= glideMul;
      out[i] += Math.sin(phase) * e * Math.min(1, i / 24);
      e *= i >= dampAt ? dampMul : mul;
    }
    const k2 = 2 * Math.cos(w0);
    let y1 = Math.sin(phase);
    let y2 = Math.sin(phase - w0);
    for (; i < out.length && e >= 1e-6; i += 1) {
      const y = k2 * y1 - y2;
      y2 = y1;
      y1 = y;
      out[i] += y * e * Math.min(1, i / 24);
      e *= i >= dampAt ? dampMul : mul;
    }
  });
}

function addNoise(out: Float64Array, rng: Rng, filters: readonly Biquad[], amp: number, decayS: number, startS = 0, attackS = 0.0005): void {
  const sr = SAMPLE_RATE;
  const start = Math.round(startS * sr);
  const mul = Math.exp(-1 / (decayS * sr));
  let e = amp;
  for (let i = start; i < out.length; i += 1) {
    let x = noise(rng);
    for (const f of filters) x = biquadStep(f, x);
    const t = (i - start) / sr;
    out[i] += x * e * Math.min(1, t / attackS);
    e *= mul;
    if (e < 1e-6) break;
  }
}

// Kettle-drum modes are nearly harmonic because the air load pulls the (n,1) family into line.
const TIMPANI_MODES: readonly Mode[] = [
  { ratio: 0.58, amp: 0.35, decayS: 0.12 },
  { ratio: 1.0, amp: 1.0, decayS: 1.9 },
  { ratio: 1.504, amp: 0.55, decayS: 1.2 },
  { ratio: 1.742, amp: 0.25, decayS: 0.7 },
  { ratio: 2.0, amp: 0.32, decayS: 0.95 },
  { ratio: 2.245, amp: 0.18, decayS: 0.55 },
  { ratio: 2.494, amp: 0.14, decayS: 0.5 },
  { ratio: 2.8, amp: 0.09, decayS: 0.4 },
];

function renderTimpani(ev: NoteEvent, _params: Params): Stereo {
  const sr = SAMPLE_RATE;
  const shape = articulate(ev);
  const vel = clamp(shape.gain, 0, 1.2);
  const frames = Math.round((ev.articulation === 'staccato' ? shape.soundS + 0.4 : 3.2) * sr);
  const mono = new Float64Array(frames);
  const dampAt = ev.articulation === 'staccato' ? Math.round(shape.soundS * sr) : frames;
  addModes(mono, { freq: ev.freq, modes: TIMPANI_MODES, glide: 0.025, glideS: 0.06, level: 0.32, hardness: 1 }, vel, dampAt, ev.rng);
  addNoise(mono, ev.rng, [biquad('lowpass', 1400, 0.7), biquad('highpass', 60, 0.7)], 0.12 * vel, 0.012);
  return spread(mono, 0.18);
}

function spread(mono: Float64Array, width: number): Stereo {
  const out = stereo(mono.length);
  const [l, r] = panGains(-width);
  const [l2, r2] = panGains(width);
  const lag = 18;
  for (let i = 0; i < mono.length; i += 1) {
    const late = i >= lag ? mono[i - lag] : 0;
    out.left[i] = mono[i] * l * 0.8 + late * l2 * 0.2;
    out.right[i] = mono[i] * r * 0.8 + late * r2 * 0.2;
  }
  return out;
}

function taiko(freq: number, vel: number, rng: Rng, lengthS: number, level: number): Float64Array {
  const out = new Float64Array(Math.round(lengthS * SAMPLE_RATE));
  addModes(out, {
    freq,
    modes: [
      { ratio: 1, amp: 1, decayS: 0.55 },
      { ratio: 1.59, amp: 0.45, decayS: 0.3 },
      { ratio: 2.14, amp: 0.3, decayS: 0.22 },
      { ratio: 2.3, amp: 0.2, decayS: 0.16 },
      { ratio: 2.65, amp: 0.12, decayS: 0.12 },
    ],
    glide: 0.9,
    glideS: 0.025,
    level,
    hardness: 1.4,
  }, vel, out.length, rng);
  addNoise(out, rng, [biquad('lowpass', 700, 0.7)], 0.35 * vel * level, 0.03);
  addNoise(out, rng, [biquad('bandpass', 2200, 1.2)], 0.12 * vel * level, 0.006);
  return out;
}

function snare(vel: number, rng: Rng, bright: boolean): Float64Array {
  const out = new Float64Array(Math.round(0.6 * SAMPLE_RATE));
  addModes(out, { freq: 185, modes: [{ ratio: 1, amp: 1, decayS: 0.09 }, { ratio: 1.78, amp: 0.6, decayS: 0.06 }], glide: 0.1, glideS: 0.01, level: 0.32, hardness: 1 }, vel, out.length, rng);
  // Snare wires: band-passed noise through a short multi-tap comb for the rattle.
  const wires = new Float64Array(out.length);
  addNoise(wires, rng, [biquad('highpass', 1600, 0.7), biquad('peak', bright ? 5200 : 4200, 1, 4)], 0.42 * Math.pow(vel, 1.1), bright ? 0.15 : 0.19);
  const taps = [0, 97, 149, 226];
  const gains = [1, 0.45, 0.3, 0.2];
  for (let i = 0; i < out.length; i += 1) {
    let s = 0;
    for (let k = 0; k < taps.length; k += 1) if (i >= taps[k]) s += wires[i - taps[k]] * gains[k];
    out[i] += s * 0.6;
  }
  return out;
}

function metal(rng: Rng, lengthS: number, amp: number, decays: readonly [number, number, number], swellS: number): Float64Array {
  const sr = SAMPLE_RATE;
  const out = new Float64Array(Math.round(lengthS * sr));
  const bands: readonly [number, number][] = [[4200, 0.9], [7400, 1.1], [11000, 1.3]];
  bands.forEach(([f, q], k) => {
    const filters = [biquad('highpass', 2500, 0.7), biquad('bandpass', f, q)];
    const mul = Math.exp(-1 / (decays[k] * sr));
    let e = amp * (k === 0 ? 1 : 0.7);
    const swell = Math.round(swellS * sr);
    for (let i = 0; i < out.length; i += 1) {
      let x = noise(rng);
      for (const fl of filters) x = biquadStep(fl, x);
      const env = i < swell ? Math.pow(i / swell, 2.5) : e;
      out[i] += x * env;
      if (i >= swell) e *= mul;
      if (i >= swell && e < 1e-6) break;
    }
  });
  // Inharmonic bell modes of the cymbal plate.
  for (const [ratio, a] of [[1, 0.5], [1.47, 0.4], [2.09, 0.35], [2.56, 0.3], [3.37, 0.25], [4.21, 0.2]] as const) {
    const f = 410 * ratio * (1 + (rng() - 0.5) * 0.03);
    const mul = Math.exp(-1 / (decays[0] * 0.6 * sr));
    let e = amp * a * 0.12;
    const swell = Math.round(swellS * sr);
    for (let i = 0; i < out.length; i += 1) {
      const env = i < swell ? Math.pow(i / swell, 2.5) * amp * a * 0.12 : e;
      out[i] += Math.sin((2 * Math.PI * f * i) / sr) * env;
      if (i >= swell) e *= mul;
    }
  }
  return out;
}

function trailerHit(vel: number, rng: Rng): Float64Array {
  const sr = SAMPLE_RATE;
  const out = taiko(44, vel, rng, 2.6, 0.5);
  let phase = 0;
  for (let i = 0; i < out.length; i += 1) {
    const t = i / sr;
    const f = 32 + 60 * Math.exp(-t / 0.18);
    phase += (2 * Math.PI * f) / sr;
    out[i] += Math.sin(phase) * 0.42 * vel * Math.exp(-t / 0.9) * Math.min(1, i / 48);
  }
  addNoise(out, rng, [biquad('bandpass', 2500, 0.5)], 0.25 * vel, 0.08);
  for (const ratio of [1, 2.76, 5.4, 8.93]) {
    const f = 196 * ratio;
    for (let i = 0; i < out.length; i += 1) out[i] += Math.sin((2 * Math.PI * f * i) / sr) * 0.05 * vel * Math.exp(-i / (sr * 1.1 / ratio));
  }
  return out;
}

const TOM_FREQS: Readonly<Record<number, number>> = { 41: 68, 43: 86, 45: 108, 47: 136, 48: 160, 50: 190 };

function renderPerc(ev: NoteEvent, _params: Params): Stereo {
  const shape = articulate(ev);
  const vel = clamp(shape.gain, 0, 1.2);
  const m = ev.midi;
  if (m === 35 || m === 36) return spread(taiko(m === 35 ? 48 : 56, vel, ev.rng, 1.4, 0.7), 0.1);
  if (m === 38 || m === 40) return spread(snare(vel, ev.rng, m === 40), 0.15);
  if (m === 39) return spread(trailerHit(vel, ev.rng), 0.35);
  if (m === 42) return spread(metal(ev.rng, 0.12, 0.12 * vel, [0.03, 0.025, 0.02], 0), 0.3);
  if (m === 46) return spread(metal(ev.rng, 0.6, 0.12 * vel, [0.25, 0.2, 0.15], 0), 0.3);
  if (m === 49 || m === 57) return spread(metal(ev.rng, 3.2, 0.2 * vel, [1.3, 1.0, 0.8], 0), 0.6);
  if (m === 51) return spread(metal(ev.rng, 1.6, 0.1 * vel, [0.8, 0.6, 0.4], 0), 0.4);
  if (m === 52 || m === 55) {
    const swellS = Math.max(0.3, shape.soundS);
    return spread(metal(ev.rng, swellS + 2.6, 0.17 * vel, [1.2, 0.95, 0.8], swellS), 0.7);
  }
  const tom = TOM_FREQS[m];
  return spread(taiko(tom ?? clamp(midiToHz(m), 40, 400), vel, ev.rng, 1.1, 0.55), 0.2);
}

export const timpani: Instrument = { render: renderTimpani };
export const orchestralPerc: Instrument = { render: renderPerc };

export const PERC_MAP: Readonly<Record<string, number>> = {
  taiko: 36,
  'taiko-low': 35,
  snare: 38,
  rimshot: 40,
  'trailer-hit': 39,
  'hat-closed': 42,
  'hat-open': 46,
  crash: 49,
  ride: 51,
  'cymbal-swell': 55,
  'tom-low': 41,
  'tom-mid': 45,
  'tom-high': 48,
};
