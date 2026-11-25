import { SAMPLE_RATE, biquad, biquadStep, clamp, panGains, stereo, type Stereo } from '../dsp.js';
import { articulate, bool, noise, num, type Instrument, type NoteEvent, type Params } from './common.js';

// Stiff-string inharmonicity B rises toward the treble (Fletcher: f_n = n f0 sqrt(1 + B n^2)).
export function pianoInharmonicity(midi: number): number {
  return 3e-5 * Math.exp(0.05 * (midi - 21));
}

export function pianoPartialFreq(f0: number, n: number, B: number): number {
  return n * f0 * Math.sqrt(1 + B * n * n);
}

function render(ev: NoteEvent, params: Params): Stereo {
  const sr = SAMPLE_RATE;
  const shape = articulate(ev);
  const vel = clamp(shape.gain, 0, 1.2);
  const B = pianoInharmonicity(ev.midi);
  const pedal = bool(params, 'pedal', true);
  const brightness = num(params, 'brightness', 0.5);

  const tauLong = clamp(14 * Math.pow(2, -(ev.midi - 33) / 17), 0.6, 16);
  const tauPrompt = tauLong * 0.11;
  const undamped = ev.midi >= 89;
  const dampTau = pedal ? 0.55 : 0.09 + 0.25 * clamp((60 - ev.midi) / 40, 0, 1);
  const releaseS = undamped ? Math.min(3, tauLong) : dampTau * 5;
  const ringS = Math.min(shape.soundS, tauLong * 4);
  const frames = Math.ceil((ringS + releaseS) * sr) + 1;
  const off = Math.round(ringS * sr);

  const out = stereo(frames);
  const hardness = 2.55 - 1.35 * clamp(vel, 0, 1) - 0.4 * brightness;
  const fc = 1200 + 7000 * vel * vel + 3000 * brightness;
  const strike = 1 / 8.3;
  const maxPartials = Math.max(1, Math.min(32, Math.floor(17000 / ev.freq)));
  const strings = ev.midi < 32 ? 1 : ev.midi < 45 ? 2 : 3;
  const [gl, gr] = panGains(clamp((ev.midi - 64) / 70, -0.6, 0.6));

  const amps: number[] = [];
  let ampSum = 0;
  for (let n = 1; n <= maxPartials; n += 1) {
    const fn = pianoPartialFreq(ev.freq, n, B);
    if (fn > sr * 0.45) break;
    const a = Math.pow(n, -hardness) * (0.15 + Math.abs(Math.sin(Math.PI * n * strike))) / (1 + (fn / fc) * (fn / fc));
    amps.push(a);
    ampSum += a;
  }
  const level = (0.85 * Math.pow(vel, 1.7)) / Math.max(1e-9, ampSum);
  const dampMul = Math.exp(-1 / (dampTau * sr));

  for (let k = 0; k < amps.length; k += 1) {
    const n = k + 1;
    const fn = pianoPartialFreq(ev.freq, n, B);
    const tauScale = 1 / (1 + 0.035 * Math.pow(n, 1.6));
    const mulPrompt = Math.exp(-1 / (tauPrompt * tauScale * sr));
    const mulLong = Math.exp(-1 / (tauLong * tauScale * sr));
    const side = n % 2 === 0 ? 0.12 : -0.12;
    const [sl, sr2] = panGains(side);
    for (let s = 0; s < strings; s += 1) {
      const cents = strings === 1 ? 0 : (s - (strings - 1) / 2) * 0.9 + (ev.rng() - 0.5) * 0.4;
      const w = (2 * Math.PI * fn * Math.pow(2, cents / 1200)) / sr;
      const k2 = 2 * Math.cos(w);
      // One zero-phase sine for both samples; independent phases scaled the partial by up to 1/sin(w).
      let y1 = Math.sin(-w);
      let y2 = Math.sin(-2 * w);
      let ePrompt = (amps[k] * level * 0.72) / strings;
      let eLong = (amps[k] * level * 0.28) / strings;
      let damper = 1;
      for (let i = 0; i < frames; i += 1) {
        const y = k2 * y1 - y2;
        y2 = y1;
        y1 = y;
        if (i >= off && !undamped) damper *= dampMul;
        const v = y * (ePrompt + eLong) * damper;
        ePrompt *= mulPrompt;
        eLong *= mulLong;
        out.left[i] += v * sl * gl;
        out.right[i] += v * sr2 * gr;
        if (ePrompt + eLong < 1e-7 || damper < 1e-5) break;
      }
    }
  }

  // Felt hammer on wood: a band-limited knock a few ms long.
  const knockFrames = Math.round(0.012 * sr);
  const bp = biquad('bandpass', clamp(ev.freq * 3, 400, 3500), 0.8);
  const knockAmp = 0.045 * Math.pow(vel, 1.5);
  for (let i = 0; i < knockFrames && i < frames; i += 1) {
    const v = biquadStep(bp, noise(ev.rng)) * knockAmp * Math.exp(-i / (0.0025 * sr));
    out.left[i] += v * gl;
    out.right[i] += v * gr;
  }

  // Sympathetic resonance of undamped strings while the pedal is down.
  if (pedal) {
    const attack = 0.08 * sr;
    for (const ratio of [2, 3]) {
      const w = (2 * Math.PI * ev.freq * ratio * (1 + 0.0007 * ratio)) / sr;
      if (ev.freq * ratio > sr * 0.4) continue;
      const amp = 0.012 * level * ampSum;
      const mul = Math.exp(-1 / (tauLong * 0.7 * sr));
      let e = amp;
      for (let i = 0; i < frames; i += 1) {
        const v = Math.sin(w * i) * e * Math.min(1, i / attack);
        e *= mul;
        out.left[i] += v * 0.8;
        out.right[i] += v;
      }
    }
  }
  return out;
}

export const piano: Instrument = { render };
