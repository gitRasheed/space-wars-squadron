import { SAMPLE_RATE, biquad, biquadStep, clamp, panGains, stereo, svfG, svfStep, centsRatio, type Biquad, type Stereo } from '../dsp.js';
import { articulate, asrEnvelope, bendRatio, noise, num, sawStep, tailFrames, type Instrument, type NoteEvent, type Params } from './common.js';

interface BrassVoicing {
  readonly players: number;
  readonly detuneCents: number;
  readonly attackS: number;
  readonly releaseS: number;
  readonly scoopCents: number;
  readonly vibratoCents: number;
  readonly brightness: number;
  // How much the bore's wave steepening brightens forte notes.
  readonly blare: number;
  readonly breathHz: number;
  readonly spread: number;
  readonly bell: () => Biquad[];
}

const HORN: BrassVoicing = {
  players: 4,
  detuneCents: 6,
  attackS: 0.05,
  releaseS: 0.22,
  scoopCents: -35,
  vibratoCents: 7,
  brightness: 9,
  blare: 0.45,
  breathHz: 700,
  spread: 0.45,
  // The horn bell faces away from the hall, so the top is soft and the low mids carry.
  bell: () => [biquad('peak', 420, 1.0, 5), biquad('peak', 1100, 1.4, 2.5), biquad('highshelf', 2800, 0.7, -7), biquad('lowpass', 5200, 0.7)],
};

const TRUMPET: BrassVoicing = {
  players: 3,
  detuneCents: 5,
  attackS: 0.03,
  releaseS: 0.15,
  scoopCents: -18,
  vibratoCents: 10,
  brightness: 16,
  blare: 0.7,
  breathHz: 1500,
  spread: 0.35,
  bell: () => [biquad('highpass', 170, 0.7), biquad('peak', 1250, 1.2, 5), biquad('peak', 2600, 1.6, 3.5), biquad('lowpass', 9500, 0.7)],
};

function renderBrass(ev: NoteEvent, params: Params, voicing: BrassVoicing): Stereo {
  const sr = SAMPLE_RATE;
  const shape = articulate(ev);
  const vel = clamp(shape.gain, 0, 1.25);
  const players = Math.max(1, Math.round(num(params, 'players', voicing.players)));
  const releaseS = voicing.releaseS * shape.releaseScale;
  const frames = tailFrames(shape.soundS, releaseS) + Math.round(0.03 * sr);
  const out = stereo(frames);
  const drive = 1.2;
  const norm = 1 / Math.tanh(drive);
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);

  for (let p = 0; p < players; p += 1) {
    const centsOff = players === 1 ? 0 : ((p / (players - 1)) * 2 - 1) * voicing.detuneCents + (ev.rng() - 0.5) * 2;
    const onset = shape.attackScale < 0.6 ? Math.round(ev.rng() * 0.006 * sr) : Math.round(ev.rng() * 0.02 * sr);
    const env = asrEnvelope(frames - onset, voicing.attackS * shape.attackScale, shape.soundS, releaseS, 0.86, shape.sforzando);
    const vibRate = 5.1 + ev.rng() * 0.6;
    const vibPhase = ev.rng() * 2 * Math.PI;
    const voice = { phase: ev.rng() };
    const svf = { ic1: 0, ic2: 0 };
    let g = 0;
    let prev = 0;
    const pan = players === 1 ? 0 : ((p / (players - 1)) * 2 - 1) * voicing.spread;
    const [pl, pr] = panGains(pan);
    const scoop = ev.slurred ? voicing.scoopCents * 0.3 : voicing.scoopCents;
    for (let i = 0; i < env.length; i += 1) {
      const t = i / sr;
      const vibDepth = voicing.vibratoCents * clamp((t - 0.35) / 0.4, 0, 1);
      const cents = centsOff + scoop * Math.exp(-t / 0.035) + vibDepth * Math.sin(2 * Math.PI * vibRate * t + vibPhase);
      const f = ev.freq * bendRatio(ev, t) * centsRatio(cents);
      const e = env[i];
      if ((i & 15) === 0) g = svfG(clamp(f * (1 + voicing.brightness * vel * vel * Math.pow(e, 1.4)), 120, 12000));
      const raw = svfStep(svf, sawStep(voice, f), g, 1 / 0.75);
      // Nonlinear propagation in the bore steepens loud wavefronts: add the slope, scaled by dynamics.
      const steep = (raw - prev) * (sr / (2 * Math.PI * f));
      prev = raw;
      const v = Math.tanh(drive * (raw + voicing.blare * vel * vel * e * steep)) * norm * e;
      left[i + onset] += v * pl;
      right[i + onset] += v * pr;
    }
  }

  const breath = biquad('bandpass', voicing.breathHz, 1.1);
  const lip = Math.round(0.07 * sr);
  const level = (0.2 * Math.pow(vel, 1.2)) / Math.sqrt(players);
  const bellL = voicing.bell();
  const bellR = voicing.bell();
  for (let i = 0; i < frames; i += 1) {
    const t = i / sr;
    const breathEnv = i < lip ? 0.07 * vel * Math.exp(-t / 0.025) : t < shape.soundS ? 0.006 * vel : 0;
    const b = biquadStep(breath, noise(ev.rng)) * breathEnv * players * 0.7;
    let l = (left[i] + b) * level;
    let r = (right[i] + b) * level;
    for (const f of bellL) l = biquadStep(f, l);
    for (const f of bellR) r = biquadStep(f, r);
    out.left[i] = l;
    out.right[i] = r;
  }
  return out;
}

export const brassHorn: Instrument = { render: (ev, p) => renderBrass(ev, p, HORN) };
export const brassTrumpet: Instrument = { render: (ev, p) => renderBrass(ev, p, TRUMPET) };
