import { SAMPLE_RATE, biquad, clamp, polyBlep, type Biquad, type Rng, type Stereo } from '../dsp.js';
import type { Articulation, ParamValue } from '../project.js';

export type { ParamValue };

export interface NoteEvent {
  readonly midi: number;
  readonly freq: number;
  // Written length; instruments add their own release tail after it.
  readonly durationS: number;
  readonly velocity: number;
  readonly articulation: Articulation;
  readonly bendSemis: number;
  // The previous note on this track is still sounding, so the attack should slur.
  readonly slurred: boolean;
  readonly rng: Rng;
}

export type Params = Readonly<Record<string, ParamValue>>;

export interface Instrument {
  render(ev: NoteEvent, params: Params): Stereo;
  // Track-level stage that must see the summed notes (an amp distorts chords as one signal).
  readonly post?: (buf: Stereo, params: Params) => void;
}

export interface Shape {
  readonly soundS: number;
  readonly gain: number;
  readonly attackScale: number;
  readonly sforzando: boolean;
  readonly releaseScale: number;
}

export function articulate(ev: NoteEvent): Shape {
  const v = ev.velocity;
  switch (ev.articulation) {
    case 'staccato':
      return { soundS: Math.min(ev.durationS, Math.max(0.06, ev.durationS * 0.45)), gain: v, attackScale: 0.5, sforzando: false, releaseScale: 0.5 };
    case 'accent':
      return { soundS: ev.durationS * 0.9, gain: Math.min(1.15, v * 1.18), attackScale: 0.55, sforzando: false, releaseScale: 1 };
    case 'sforzando':
      return { soundS: ev.durationS, gain: Math.min(1.2, v * 1.25), attackScale: 0.4, sforzando: true, releaseScale: 1 };
    case 'legato':
      return { soundS: ev.durationS * 1.02, gain: v, attackScale: ev.slurred ? 2.2 : 1.3, sforzando: false, releaseScale: 1.3 };
    case 'normal':
      return { soundS: ev.durationS * 0.94, gain: v, attackScale: ev.slurred ? 1.6 : 1, sforzando: false, releaseScale: 1 };
  }
}

export function num(params: Params, key: string, def: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

export function bool(params: Params, key: string, def: boolean): boolean {
  const v = params[key];
  return typeof v === 'boolean' ? v : def;
}

export function str(params: Params, key: string, def: string): string {
  const v = params[key];
  return typeof v === 'string' ? v : def;
}

// Attack-sustain-release envelope with an optional sforzando dip; times in seconds.
export function asrEnvelope(frames: number, attackS: number, soundS: number, releaseS: number, sustain: number, sforzando: boolean): Float64Array {
  const env = new Float64Array(frames);
  const sr = SAMPLE_RATE;
  const a = Math.max(1, Math.round(attackS * sr));
  const off = Math.round(soundS * sr);
  const relCoeff = Math.exp(-1 / Math.max(1, releaseS * sr * 0.25));
  let level = 0;
  for (let i = 0; i < frames; i += 1) {
    if (i < off) {
      const t = i / sr;
      if (i < a) level = Math.sin((0.5 * Math.PI * i) / a);
      else {
        const sinceA = t - attackS;
        level = sforzando ? sustain * (0.32 + 0.68 * Math.exp(-sinceA / 0.09)) + (1 - sustain) * Math.exp(-sinceA / 0.05) : sustain + (1 - sustain) * Math.exp(-sinceA / 0.18);
      }
    } else level *= relCoeff;
    env[i] = level;
  }
  return env;
}

// Section `brightness` param: 0 keeps the voicing; 1 opens the filter by half and adds a 6 dB presence shelf.
export function presence(params: Params): { readonly cutoff: number; readonly shelf: () => Biquad[] } {
  const b = clamp(num(params, 'brightness', 0), -1, 2);
  return { cutoff: 1 + 0.5 * b, shelf: () => (b === 0 ? [] : [biquad('highshelf', 1500, 0.7, 6 * b)]) };
}

export function tailFrames(soundS: number, releaseS: number): number {
  return Math.ceil((soundS + releaseS) * SAMPLE_RATE) + 1;
}

export function noise(rng: Rng): number {
  return rng() * 2 - 1;
}

export interface SawVoice {
  phase: number;
}

export function sawStep(v: SawVoice, freq: number): number {
  const dt = clamp(freq / SAMPLE_RATE, 1e-6, 0.45);
  const out = 2 * v.phase - 1 - polyBlep(v.phase, dt);
  v.phase += dt;
  if (v.phase >= 1) v.phase -= 1;
  return out;
}

// Pitch multiplier at time t for a linear bend over the written note.
export function bendRatio(ev: NoteEvent, t: number): number {
  if (ev.bendSemis === 0) return 1;
  return Math.pow(2, (ev.bendSemis * clamp(t / Math.max(1e-3, ev.durationS), 0, 1)) / 12);
}
