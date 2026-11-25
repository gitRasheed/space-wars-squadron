import { SAMPLE_RATE, biquad, biquadStep, clamp, onePoleCoeff, stereo, type Biquad, type Stereo } from '../dsp.js';
import { articulate, bool, noise, num, type Instrument, type NoteEvent, type Params } from './common.js';

export interface PluckOptions {
  readonly freq: number;
  readonly velocity: number;
  readonly soundS: number;
  readonly t60: number;
  readonly brightness: number;
  readonly pickPosition: number;
  readonly muted: boolean;
  readonly rng: () => number;
}

// Karplus-Strong waveguide. Loop delay = N + S (one-zero damping filter) + allpass fraction, tuned to sr / f0.
export function pluck(o: PluckOptions): Float64Array {
  const sr = SAMPLE_RATE;
  const L = sr / o.freq;
  const S = 0.5 - 0.35 * clamp(o.brightness, 0, 1);
  const N = Math.max(2, Math.floor(L - S - 0.1));
  const frac = L - S - N;
  const a = (1 - frac) / (1 + frac);
  const w0 = (2 * Math.PI * o.freq) / sr;
  const lpMag = Math.sqrt((1 - S) * (1 - S) + S * S + 2 * S * (1 - S) * Math.cos(w0));
  const loopGain = (t60: number): number => Math.min(0.99995, Math.pow(10, -3 / (o.freq * t60)) / lpMag);
  const ringT60 = o.muted ? Math.min(0.18, o.t60) : o.t60;
  const gRing = loopGain(ringT60);
  const gDamp = loopGain(0.07);
  const releaseS = 0.25;
  const frames = Math.ceil((Math.min(o.soundS, ringT60 * 1.3) + releaseS) * sr);
  const off = Math.round(Math.min(o.soundS, ringT60 * 1.3) * sr);

  const exc = new Float64Array(N);
  const lpc = onePoleCoeff(clamp(800 + 9000 * o.velocity * o.velocity * (0.4 + o.brightness), 300, 16000));
  let z = 0;
  for (let i = 0; i < N; i += 1) {
    z += lpc * (noise(o.rng) - z);
    exc[i] = z;
  }
  const pick = Math.max(1, Math.round(o.pickPosition * N));
  const shaped = new Float64Array(N);
  let mean = 0;
  for (let i = 0; i < N; i += 1) {
    shaped[i] = exc[i] - (i >= pick ? exc[i - pick] : 0);
    mean += shaped[i];
  }
  mean /= N;
  let peak = 1e-9;
  for (let i = 0; i < N; i += 1) {
    shaped[i] -= mean;
    peak = Math.max(peak, Math.abs(shaped[i]));
  }

  const out = new Float64Array(frames);
  const line = new Float64Array(N);
  let idx = 0;
  let dPrev = 0;
  let lpPrev = 0;
  let apPrev = 0;
  const amp = (0.5 * o.velocity) / peak;
  for (let n = 0; n < frames; n += 1) {
    const d = line[idx];
    const lp = (1 - S) * d + S * dPrev;
    dPrev = d;
    const ap = a * lp + lpPrev - a * apPrev;
    lpPrev = lp;
    apPrev = ap;
    const y = (n < N ? shaped[n] * amp : 0) + (n < off ? gRing : gDamp) * ap;
    line[idx] = y;
    idx = idx + 1 === N ? 0 : idx + 1;
    out[n] = y;
  }
  const fade = Math.min(frames, Math.round(0.004 * sr));
  for (let i = 0; i < fade; i += 1) out[frames - 1 - i] *= i / fade;
  return out;
}

function acousticBody(): Biquad[] {
  return [biquad('highpass', 70, 0.7), biquad('peak', 98, 2.0, 5), biquad('peak', 204, 2.2, 4), biquad('peak', 390, 1.6, 2.5), biquad('peak', 2500, 1.0, 2), biquad('highshelf', 6500, 0.7, -4)];
}

function renderAcoustic(ev: NoteEvent, params: Params): Stereo {
  const shape = articulate(ev);
  const vel = clamp(shape.gain, 0, 1.2);
  const t60 = num(params, 't60', 3.2) * clamp(Math.pow(2, -(ev.midi - 52) / 24), 0.4, 1.6);
  const s = pluck({
    freq: ev.freq,
    velocity: vel,
    soundS: shape.soundS,
    t60,
    brightness: num(params, 'brightness', 0.55),
    pickPosition: num(params, 'pickPosition', 0.18),
    muted: ev.articulation === 'staccato',
    rng: ev.rng,
  });
  const out = stereo(s.length);
  const bodyL = acousticBody();
  const bodyR = acousticBody();
  const level = 1.1;
  for (let i = 0; i < s.length; i += 1) {
    const x = s[i] * level;
    out.left[i] = biquadChain(bodyL, x);
    out.right[i] = biquadChain(bodyR, x * 0.92 + (i > 24 ? s[i - 24] * level * 0.08 : 0));
  }
  return out;
}

function biquadChain(chain: readonly Biquad[], x: number): number {
  let y = x;
  for (const f of chain) y = biquadStep(f, y);
  return y;
}

function renderElectric(ev: NoteEvent, params: Params): Stereo {
  const sr = SAMPLE_RATE;
  const shape = articulate(ev);
  const vel = clamp(shape.gain, 0, 1.2);
  const muted = ev.articulation === 'staccato' || bool(params, 'palmMute', false);
  const opts = {
    velocity: vel,
    soundS: shape.soundS,
    t60: num(params, 't60', 4.5),
    brightness: num(params, 'brightness', 0.7),
    pickPosition: num(params, 'pickPosition', 0.11),
    muted,
  };
  const takeA = pluck({ ...opts, freq: ev.freq, rng: ev.rng });
  if (!bool(params, 'double', true)) {
    const out = stereo(takeA.length);
    out.left.set(takeA);
    out.right.set(takeA);
    return out;
  }
  // Double-tracked rhythm guitar: a second, slightly late and detuned take hard on the other side.
  const takeB = pluck({ ...opts, freq: ev.freq * Math.pow(2, (ev.rng() - 0.5) * 6 / 1200), rng: ev.rng });
  const lag = Math.round((0.008 + ev.rng() * 0.008) * sr);
  const out = stereo(Math.max(takeA.length, takeB.length + lag));
  out.left.set(takeA);
  out.right.set(takeB, lag);
  return out;
}

export function tubeAmp(buf: Stereo, drive: number, sr = SAMPLE_RATE): void {
  const pre = (): Biquad[] => [biquad('highpass', 110, 0.7, 0, sr), biquad('peak', 850, 0.9, 6, sr)];
  const cab = (): Biquad[] => cabFilters(90, 5200, 3, sr);
  const bias = 0.18;
  const offset = Math.tanh(drive * bias);
  const makeup = 0.28 / Math.tanh(drive * 0.3);
  for (const ch of [buf.left, buf.right]) {
    const p = pre();
    const c = cab();
    let dc = 0;
    for (let i = 0; i < ch.length; i += 1) {
      const x = biquadChain(p, ch[i]);
      // Asymmetric bias adds the even harmonics of a single-ended triode stage.
      let y = Math.tanh(drive * (x + bias)) - offset;
      dc += 0.0005 * (y - dc);
      y -= dc;
      ch[i] = biquadChain(c, y) * makeup;
    }
  }
}

// 4x12 closed-back cabinet: low cut, a thump resonance, a mid scoop, presence peak and a steep cone roll-off.
export function cabFilters(lowCutHz: number, highCutHz: number, presenceDb: number, sr = SAMPLE_RATE): Biquad[] {
  return [
    biquad('highpass', lowCutHz, 0.8, 0, sr),
    biquad('peak', 115, 1.3, 3, sr),
    biquad('peak', 420, 1.0, -3.5, sr),
    biquad('peak', 2300, 1.4, presenceDb, sr),
    biquad('lowpass', highCutHz, 0.75, 0, sr),
    biquad('lowpass', highCutHz * 1.25, 0.55, 0, sr),
  ];
}

export const guitarAcoustic: Instrument = { render: renderAcoustic };
export const guitarElectric: Instrument = {
  render: renderElectric,
  post: (buf, params) => tubeAmp(buf, num(params, 'drive', 9)),
};
