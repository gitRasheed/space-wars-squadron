import { SAMPLE_RATE, biquad, biquadStep, clamp, panGains, stereo, svfG, svfStep, centsRatio, type Biquad, type Stereo } from '../dsp.js';
import { articulate, asrEnvelope, bendRatio, noise, num, presence, sawStep, tailFrames, type Instrument, type NoteEvent, type Params } from './common.js';

interface Section {
  readonly players: number;
  readonly detuneCents: number;
  readonly spread: number;
  readonly bowHz: number;
  readonly brightness: number;
  readonly body: () => Biquad[];
}

const VIOLINS: Section = {
  players: 6,
  detuneCents: 9,
  spread: 0.3,
  bowHz: 3200,
  brightness: 7,
  // Violin body: air mode near 280 Hz, main wood near 460 Hz, bridge hill near 2.8 kHz.
  body: () => [biquad('highpass', 160, 0.7), biquad('peak', 280, 1.5, 4), biquad('peak', 470, 1.6, 2.5), biquad('peak', 1500, 1.2, -3), biquad('peak', 2800, 1.0, 4), biquad('highshelf', 7000, 0.7, -8)],
};

const CELLOS: Section = {
  players: 4,
  detuneCents: 7,
  spread: 0.22,
  bowHz: 1800,
  brightness: 6,
  body: () => [biquad('highpass', 55, 0.7), biquad('peak', 110, 1.4, 3), biquad('peak', 220, 1.5, 4), biquad('peak', 600, 1.4, 3), biquad('peak', 1500, 1.2, -2.5), biquad('lowpass', 6000, 0.7)],
};

const BASSES: Section = {
  players: 3,
  detuneCents: 5,
  spread: 0.12,
  bowHz: 900,
  brightness: 5,
  body: () => [biquad('highpass', 30, 0.7), biquad('peak', 70, 1.3, 3), biquad('peak', 300, 1.4, 2), biquad('lowpass', 3200, 0.7)],
};

function renderStrings(ev: NoteEvent, params: Params, section: Section): Stereo {
  const sr = SAMPLE_RATE;
  const shape = articulate(ev);
  const vel = clamp(shape.gain, 0, 1.2);
  const players = Math.max(1, Math.round(num(params, 'players', section.players)));
  const bright = presence(params);
  const staccato = ev.articulation === 'staccato';
  const attackS = (staccato ? 0.012 : ev.articulation === 'accent' || ev.articulation === 'sforzando' ? 0.03 : 0.09) * (staccato ? 1 : shape.attackScale);
  const releaseS = staccato ? 0.08 : 0.32 * shape.releaseScale;
  const frames = tailFrames(shape.soundS, releaseS) + Math.round(0.03 * sr);
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);

  for (let p = 0; p < players; p += 1) {
    const spreadPos = players === 1 ? 0 : (p / (players - 1)) * 2 - 1;
    const centsOff = spreadPos * section.detuneCents + (ev.rng() - 0.5) * 3;
    const onset = Math.round(ev.rng() * (staccato ? 0.006 : 0.025) * sr);
    const env = asrEnvelope(frames - onset, attackS, shape.soundS, releaseS, 0.9, shape.sforzando);
    const vibRate = 5 + ev.rng() * 1.2;
    const vibDepth = num(params, 'vibratoCents', 8) * (0.7 + ev.rng() * 0.6);
    const vibPhase = ev.rng() * 2 * Math.PI;
    const voice = { phase: ev.rng() };
    const svf = { ic1: 0, ic2: 0 };
    let g = 0;
    const [pl, pr] = panGains(spreadPos * section.spread);
    for (let i = 0; i < env.length; i += 1) {
      const t = i / sr;
      const vib = vibDepth * clamp((t - 0.2) / 0.35, 0, 1) * Math.sin(2 * Math.PI * vibRate * t + vibPhase);
      const f = ev.freq * bendRatio(ev, t) * centsRatio(centsOff + vib);
      const e = env[i];
      if ((i & 15) === 0) g = svfG(clamp(f * (2 + section.brightness * vel * (0.6 + 0.4 * e)) * bright.cutoff, 300, 11000));
      const v = svfStep(svf, sawStep(voice, f), g, 1 / 0.6) * e;
      left[i + onset] += v * pl;
      right[i + onset] += v * pr;
    }
  }

  const bow = biquad('bandpass', section.bowHz, 0.9);
  const level = (0.17 * Math.pow(vel, 1.15)) / Math.sqrt(players);
  const bodyL = [...section.body(), ...bright.shelf()];
  const bodyR = [...section.body(), ...bright.shelf()];
  const out = stereo(frames);
  const scratch = Math.round((staccato ? 0.02 : 0.06) * sr);
  for (let i = 0; i < frames; i += 1) {
    const t = i / sr;
    const rosin = i < scratch ? 0.25 * vel * Math.exp(-t / 0.02) : t < shape.soundS ? 0.02 * vel : 0;
    const b = biquadStep(bow, noise(ev.rng)) * rosin * Math.sqrt(players);
    let l = (left[i] + b) * level;
    let r = (right[i] + b * 0.9) * level;
    for (const f of bodyL) l = biquadStep(f, l);
    for (const f of bodyR) r = biquadStep(f, r);
    out.left[i] = l;
    out.right[i] = r;
  }
  return out;
}

export const stringsEnsemble: Instrument = { render: (ev, p) => renderStrings(ev, p, VIOLINS) };
export const stringsCello: Instrument = { render: (ev, p) => renderStrings(ev, p, CELLOS) };
export const stringsBass: Instrument = { render: (ev, p) => renderStrings(ev, p, BASSES) };
