import { SAMPLE_RATE, biquad, biquadStep, clamp, panGains, stereo, svfG, svfLowpass, svfStep, type Stereo } from '../dsp.js';
import { articulate, asrEnvelope, bendRatio, noise, num, sawStep, str, tailFrames, type Instrument, type NoteEvent, type Params } from './common.js';

function renderPad(ev: NoteEvent, params: Params): Stereo {
  const sr = SAMPLE_RATE;
  const shape = articulate(ev);
  const vel = clamp(shape.gain, 0, 1.2);
  const voices = Math.max(1, Math.round(num(params, 'voices', 7)));
  const attackS = num(params, 'attack', 0.6) * shape.attackScale;
  const releaseS = num(params, 'release', 1.4);
  const detune = num(params, 'detuneCents', 14);
  const baseCutoff = num(params, 'cutoff', 2200);
  const frames = tailFrames(shape.soundS, releaseS);
  const env = asrEnvelope(frames, attackS, shape.soundS, releaseS, 0.92, false);
  const out = stereo(frames);
  const level = (0.2 * Math.pow(vel, 0.9)) / Math.sqrt(voices);
  for (let v = 0; v < voices; v += 1) {
    const pos = voices === 1 ? 0 : (v / (voices - 1)) * 2 - 1;
    const ratio = Math.pow(2, (pos * detune) / 1200);
    const osc = { phase: ev.rng() };
    const svf = { ic1: 0, ic2: 0 };
    const [pl, pr] = panGains(pos * 0.85);
    const lfoRate = 0.15 + ev.rng() * 0.2;
    const lfoPhase = ev.rng() * 2 * Math.PI;
    let g = 0;
    for (let i = 0; i < frames; i += 1) {
      const t = i / sr;
      const e = env[i];
      if ((i & 31) === 0) g = svfG(baseCutoff * (0.45 + 0.55 * e * vel) * (1 + 0.15 * Math.sin(2 * Math.PI * lfoRate * t + lfoPhase)));
      const x = svfStep(svf, sawStep(osc, ev.freq * ratio * bendRatio(ev, t)), g, 1 / 0.8) * e * level;
      out.left[i] += x * pl;
      out.right[i] += x * pr;
    }
  }
  return out;
}

function renderBass(ev: NoteEvent, params: Params): Stereo {
  const sr = SAMPLE_RATE;
  const shape = articulate(ev);
  const vel = clamp(shape.gain, 0, 1.2);
  const releaseS = 0.07 * shape.releaseScale;
  const frames = tailFrames(shape.soundS, releaseS);
  const env = asrEnvelope(frames, 0.004 * shape.attackScale, shape.soundS, releaseS, 0.85, shape.sforzando);
  const osc = { phase: 0 };
  const svf = { ic1: 0, ic2: 0 };
  const svf2 = { ic1: 0, ic2: 0 };
  const cutoff = num(params, 'cutoff', 900);
  const envAmt = num(params, 'envAmount', 2200);
  const mono = new Float64Array(frames);
  let subPhase = 0;
  for (let i = 0; i < frames; i += 1) {
    const t = i / sr;
    const f = ev.freq * bendRatio(ev, t);
    const fc = clamp(f * 1.5 + cutoff * 0.3 + envAmt * vel * Math.exp(-t / 0.14), 60, 9000);
    const saw = svfLowpass(svf2, svfLowpass(svf, sawStep(osc, f), fc, 1.1), fc * 1.4, 0.6);
    subPhase += (2 * Math.PI * f) / sr;
    mono[i] = (saw * 0.6 + Math.sin(subPhase) * 0.55) * env[i] * 0.24 * vel;
  }
  const out = stereo(frames);
  out.left.set(mono);
  out.right.set(mono);
  return out;
}

type SfxRenderer = (ev: NoteEvent, soundS: number, vel: number) => Stereo;

const SFX: Readonly<Record<string, SfxRenderer>> = {
  doppler: (ev, soundS, vel) => {
    const sr = SAMPLE_RATE;
    const D = Math.max(0.6, soundS);
    const frames = Math.round(D * sr);
    const out = stereo(frames);
    const c = 343;
    const speed = 95;
    const miss = 9;
    const osc = { phase: 0 };
    const bp = biquad('bandpass', 900, 0.8);
    let lp = 0;
    for (let i = 0; i < frames; i += 1) {
      const t = i / sr;
      const x = speed * (t - D / 2);
      const r = Math.hypot(x, miss);
      const towards = (-speed * x) / r;
      const f = ev.freq * (c / (c - towards));
      const amp = (miss / r) * vel * 0.32 * Math.min(1, t / 0.05, (D - t) / 0.05);
      lp += 0.25 * (sawStep(osc, f) - lp);
      const s = lp * 0.7 + biquadStep(bp, noise(ev.rng)) * 0.6;
      const [gl, gr] = panGains(clamp(x / r, -1, 1) * 0.9);
      out.left[i] = s * amp * gl;
      out.right[i] = s * amp * gr;
    }
    return out;
  },
  'bell-impact': (ev, _soundS, vel) => {
    const sr = SAMPLE_RATE;
    const frames = Math.round(3.5 * sr);
    const mono = new Float64Array(frames);
    for (let i = 0; i < frames; i += 1) {
      const t = i / sr;
      const index = 5 * vel * Math.exp(-t / 0.35);
      const mod = Math.sin(2 * Math.PI * ev.freq * 1.4 * t) * index;
      mono[i] = Math.sin(2 * Math.PI * ev.freq * t + mod) * Math.exp(-t / 1.2) * 0.3 * vel * Math.min(1, i / 32);
      mono[i] += Math.sin(2 * Math.PI * 55 * t) * 0.25 * vel * Math.exp(-t / 0.12) * Math.min(1, i / 32);
    }
    return widen(mono, 0.4);
  },
  glass: (ev, _soundS, vel) => {
    const sr = SAMPLE_RATE;
    const frames = Math.round(2.4 * sr);
    const mono = new Float64Array(frames);
    const partials: readonly [number, number, number][] = [[1, 1, 1.6], [2.32, 0.5, 1.0], [4.25, 0.3, 0.7], [6.63, 0.18, 0.45], [9.38, 0.1, 0.3]];
    for (const [ratio, a, d] of partials) {
      const f = ev.freq * ratio;
      if (f > sr * 0.45) continue;
      for (let i = 0; i < frames; i += 1) {
        const t = i / sr;
        mono[i] += (Math.sin(2 * Math.PI * f * t) + Math.sin(2 * Math.PI * (f + 0.7) * t)) * 0.5 * a * 0.16 * vel * Math.exp(-t / d) * Math.min(1, i / 16);
      }
    }
    return widen(mono, 0.6);
  },
  'shield-shatter': (ev, _soundS, vel) => {
    const sr = SAMPLE_RATE;
    const frames = Math.round(1.8 * sr);
    const mono = new Float64Array(frames);
    for (let k = 0; k < 24; k += 1) {
      const f = 1500 + ev.rng() * 7500;
      const start = Math.round(ev.rng() * 0.15 * sr);
      const decay = 0.08 + ev.rng() * 0.5;
      const a = (0.03 + ev.rng() * 0.04) * vel;
      for (let i = start; i < frames; i += 1) {
        const t = (i - start) / sr;
        const e = a * Math.exp(-t / decay);
        if (e < 1e-6) break;
        mono[i] += Math.sin(2 * Math.PI * f * t) * e * Math.min(1, (i - start) / 8);
      }
    }
    const hp = biquad('highpass', 2000, 0.7);
    let phase = 0;
    for (let i = 0; i < frames; i += 1) {
      const t = i / sr;
      mono[i] += biquadStep(hp, noise(ev.rng)) * 0.4 * vel * Math.exp(-t / 0.03);
      phase += (2 * Math.PI * (300 + 2700 * Math.exp(-t / 0.12))) / sr;
      mono[i] += Math.sin(phase) * 0.12 * vel * Math.exp(-t / 0.3) * Math.min(1, i / 32);
    }
    return widen(mono, 0.8);
  },
  chime: (ev, _soundS, vel) => {
    const sr = SAMPLE_RATE;
    const frames = Math.round(2.6 * sr);
    const mono = new Float64Array(frames);
    [1, 1.5, 2, 3].forEach((step, k) => {
      const start = Math.round(k * 0.045 * sr);
      for (const [ratio, a] of [[1, 1], [2, 0.35], [3, 0.12], [4.2, 0.08]] as const) {
        const f = ev.freq * step * ratio;
        if (f > sr * 0.45) continue;
        for (let i = start; i < frames; i += 1) {
          const t = (i - start) / sr;
          mono[i] += Math.sin(2 * Math.PI * f * t) * a * 0.09 * vel * Math.exp(-t / (1.3 / ratio)) * Math.min(1, (i - start) / 24);
        }
      }
    });
    return widen(mono, 0.5);
  },
  riser: (ev, soundS, vel) => {
    const sr = SAMPLE_RATE;
    const D = Math.max(0.5, soundS);
    const frames = Math.round(D * sr);
    const out = stereo(frames);
    const osc = { phase: 0 };
    const bpL = { ic1: 0, ic2: 0 };
    const bpR = { ic1: 0, ic2: 0 };
    for (let i = 0; i < frames; i += 1) {
      const t = i / sr;
      const p = t / D;
      const f = ev.freq * Math.pow(4, p);
      const amp = 0.22 * vel * Math.pow(p, 1.6) * Math.min(1, (D - t) / 0.03);
      const s = sawStep(osc, f) * 0.35;
      out.left[i] = (s + svfLowpass(bpL, noise(ev.rng), f * 3, 2)) * amp;
      out.right[i] = (s + svfLowpass(bpR, noise(ev.rng), f * 3, 2)) * amp;
    }
    return out;
  },
  'sub-drop': (ev, _soundS, vel) => {
    const sr = SAMPLE_RATE;
    const frames = Math.round(2 * sr);
    const mono = new Float64Array(frames);
    let phase = 0;
    for (let i = 0; i < frames; i += 1) {
      const t = i / sr;
      phase += (2 * Math.PI * ev.freq * (1 + 3 * Math.exp(-t / 0.25))) / sr;
      mono[i] = Math.sin(phase) * 0.5 * vel * Math.exp(-t / 0.7) * Math.min(1, i / 48);
    }
    return widen(mono, 0);
  },
};

export const SFX_PRESETS = Object.keys(SFX);

function widen(mono: Float64Array, width: number): Stereo {
  const out = stereo(mono.length);
  const lag = Math.round(width * 30);
  for (let i = 0; i < mono.length; i += 1) {
    const late = i >= lag ? mono[i - lag] : 0;
    out.left[i] = mono[i] * (1 - width * 0.3) + late * width * 0.3;
    out.right[i] = mono[i] * (1 - width * 0.3) - late * width * 0.3;
  }
  return out;
}

function renderSfx(ev: NoteEvent, params: Params): Stereo {
  const shape = articulate(ev);
  const preset = str(params, 'preset', 'chime');
  const r = SFX[preset];
  if (r === undefined) throw new Error(`unknown cinematic-sfx preset "${preset}"; use one of ${SFX_PRESETS.join('|')}`);
  return r(ev, shape.soundS, clamp(shape.gain, 0, 1.2));
}

export const synthPad: Instrument = { render: renderPad };
export const synthBass: Instrument = { render: renderBass };
export const cinematicSfx: Instrument = { render: renderSfx };
