import { SAMPLE_RATE, addInto, clamp, dbToGain, gainToDb, hashString, makeRng, midiToHz, panGains, stereo, svfG, svfStep, type Stereo } from './dsp.js';
import { applyFx, type FxContext } from './fx.js';
import { INSTRUMENT_MODELS } from './instruments/index.js';
import { integratedLufs } from './loudness.js';
import { masterBus, masterStem, type MasterStats } from './master.js';
import { expandTrackNotes, loopFrames, type AutomationLane, type Layer, type Project, type Track } from './project.js';

export interface RenderOptions {
  // Only tracks on these layers are rendered; default is every layer.
  readonly layers?: readonly Layer[];
  // Only these track ids are rendered, muted or not; default is every unmuted track.
  readonly trackIds?: readonly string[];
  // Extra seconds after the last bar for one-shots, so tails are not cut.
  readonly tailS?: number;
}

export interface RenderResult {
  readonly mix: Stereo;
  readonly stems: Readonly<Partial<Record<Layer, Stereo>>>;
  readonly frames: number;
  readonly loop: boolean;
  readonly master: MasterStats;
  readonly tracks: readonly TrackStats[];
  readonly warnings: readonly string[];
}

// Measured on the track as it enters the master bus, before compression and loudness normalisation.
export interface TrackStats {
  readonly id: string;
  readonly notes: number;
  readonly peak: number;
  readonly lufs: number | null;
  readonly rmsDbfs: number | null;
}

// A track this far under the loudest one is probably inaudible in the mix.
export const TRACK_BALANCE_DB = 16;

export function trackBalance(tracks: readonly TrackStats[]): string[] {
  const level = (t: TrackStats): number | null => t.lufs ?? t.rmsDbfs;
  const heard = tracks.filter((t) => t.notes > 0 && level(t) !== null);
  const loudest = heard.reduce<TrackStats | undefined>((a, t) => (a === undefined || (level(t) ?? -Infinity) > (level(a) ?? -Infinity) ? t : a), undefined);
  if (loudest === undefined) return [];
  const top = level(loudest) ?? 0;
  const unit = (t: TrackStats): string => (t.lufs !== null ? 'LU' : 'dB RMS');
  return heard
    .filter((t) => top - (level(t) ?? 0) > TRACK_BALANCE_DB)
    .map((t) => `trackBalance: ${t.id} sits ${(top - (level(t) ?? 0)).toFixed(1)} ${unit(t)} below ${loudest.id}; raise its gainDb or check it is meant to be that quiet`);
}

export function secondsPerBeat(p: Project): number {
  return 60 / p.tempo.bpm;
}

export function projectFrames(p: Project, tailS: number): number {
  const frames = Math.round(loopFrames(p.tempo.bpm, p.tempo.beatsPerBar, p.bars, p.sampleRate));
  return p.loop ? frames : frames + Math.round(tailS * p.sampleRate);
}

function automationValue(lane: AutomationLane, beat: number): number {
  const pts = lane.points;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first === undefined || last === undefined) return 0;
  if (beat <= first.beat) return first.value;
  if (beat >= last.beat) return last.value;
  for (let k = 1; k < pts.length; k += 1) {
    const b = pts[k];
    const a = pts[k - 1];
    if (beat <= b.beat) {
      const t = (beat - a.beat) / Math.max(1e-9, b.beat - a.beat);
      // Cutoff moves in log-frequency so sweeps sound even.
      return lane.param === 'cutoff' ? Math.exp(Math.log(a.value) + t * (Math.log(b.value) - Math.log(a.value))) : a.value + t * (b.value - a.value);
    }
  }
  return last.value;
}

function renderDry(p: Project, t: Track, frames: number): { readonly buf: Stereo; readonly notes: number } {
  const sr = p.sampleRate;
  const spb = secondsPerBeat(p);
  const model = INSTRUMENT_MODELS[t.instrument.type];
  const buf = stereo(frames);
  const notes = expandTrackNotes(p, t);
  // A note slurs when an earlier-starting note is still sounding (or just ended) at its onset; chord tones do not.
  let endBefore = -Infinity;
  let groupStart = -Infinity;
  let groupEnd = -Infinity;
  notes.forEach((n, idx) => {
    if (n.startBeat > groupStart + 1e-6) {
      endBefore = Math.max(endBefore, groupEnd);
      groupStart = n.startBeat;
    }
    const ev = {
      midi: n.midi,
      freq: midiToHz(n.midi),
      durationS: n.durationBeats * spb,
      velocity: n.velocity / 127,
      articulation: n.articulation,
      bendSemis: n.pitchBend ?? 0,
      slurred: endBefore >= n.startBeat - 1e-6,
      rng: makeRng(hashString(`${p.id}/${t.id}/${idx}/${n.midi}/${n.startBeat}`)),
    };
    groupEnd = Math.max(groupEnd, n.startBeat + n.durationBeats);
    const voice = model.render(ev, t.instrument.params);
    const start = Math.round(n.startBeat * spb * sr);
    const [gl, gr] = n.pan === undefined ? [1, 1] : balance(n.pan);
    addInto(buf.left, voice.left, start, gl, p.loop);
    addInto(buf.right, voice.right, start, gr, p.loop);
  });
  return { buf, notes: notes.length };
}

// Pan law for stereo sources: unity at centre, the far side fades out.
function balance(pan: number): readonly [number, number] {
  const [l, r] = panGains(pan);
  return [l / Math.SQRT1_2, r / Math.SQRT1_2].map((g) => Math.min(1.25, g)) as [number, number];
}

function processTrack(p: Project, t: Track, dry: Stereo): Stereo {
  const n = dry.left.length;
  const sr = p.sampleRate;
  const spb = secondsPerBeat(p);
  // Loops run the stateful chain over two periods and keep the second, so reverb and delay tails wrap.
  const passes = p.loop ? 2 : 1;
  const work = stereo(n * passes);
  for (let k = 0; k < passes; k += 1) {
    work.left.set(dry.left, k * n);
    work.right.set(dry.right, k * n);
  }
  const model = INSTRUMENT_MODELS[t.instrument.type];
  model.post?.(work, t.instrument.params);
  const beatOf = (i: number): number => ((i % n) / sr) / spb;
  for (const lane of t.automation.filter((a) => a.param === 'cutoff')) {
    const sl = { ic1: 0, ic2: 0 };
    const sr2 = { ic1: 0, ic2: 0 };
    let g = 0;
    for (let i = 0; i < work.left.length; i += 1) {
      if ((i & 31) === 0) g = svfG(automationValue(lane, beatOf(i)), sr);
      work.left[i] = svfStep(sl, work.left[i], g, Math.SQRT2);
      work.right[i] = svfStep(sr2, work.right[i], g, Math.SQRT2);
    }
  }
  const ctx: FxContext = { sampleRate: sr, secondsPerBeat: spb, loopFrames: p.loop ? n : null };
  for (const fx of t.fx) applyFx(work, fx, ctx);
  for (const lane of t.automation.filter((a) => a.param === 'volume')) {
    for (let i = 0; i < work.left.length; i += 1) {
      const g = dbToGain(automationValue(lane, beatOf(i)));
      work.left[i] *= g;
      work.right[i] *= g;
    }
  }
  const out = p.loop ? { left: work.left.slice(n), right: work.right.slice(n) } : work;
  const [gl, gr] = balance(t.pan);
  const g = dbToGain(t.gainDb);
  for (let i = 0; i < n; i += 1) {
    out.left[i] *= g * gl;
    out.right[i] *= g * gr;
  }
  return out;
}

export function renderTrack(p: Project, t: Track, tailS = 3): { readonly audio: Stereo; readonly notes: number } {
  const frames = projectFrames(p, tailS);
  const dry = renderDry(p, t, frames);
  return { audio: processTrack(p, t, dry.buf), notes: dry.notes };
}

export function renderProject(p: Project, opts: RenderOptions = {}): RenderResult {
  const frames = projectFrames(p, opts.tailS ?? 3);
  const mix = stereo(frames);
  const stems: Partial<Record<Layer, Stereo>> = {};
  const stats: TrackStats[] = [];
  if (opts.trackIds !== undefined) {
    const unknown = opts.trackIds.filter((id) => !p.tracks.some((t) => t.id === id));
    if (unknown.length > 0) throw new Error(`unknown track ${unknown.join(', ')}; tracks are ${p.tracks.map((t) => t.id).join(', ')}`);
  }
  for (const t of p.tracks) {
    const picked = opts.trackIds === undefined ? !t.mute : opts.trackIds.includes(t.id);
    if (!picked || (opts.layers !== undefined && !opts.layers.includes(t.layer))) continue;
    const { audio, notes } = renderTrack(p, t, opts.tailS ?? 3);
    const stem = (stems[t.layer] ??= stereo(frames));
    let peak = 0;
    let energy = 0;
    for (let i = 0; i < frames; i += 1) {
      mix.left[i] += audio.left[i];
      mix.right[i] += audio.right[i];
      stem.left[i] += audio.left[i];
      stem.right[i] += audio.right[i];
      peak = Math.max(peak, Math.abs(audio.left[i]), Math.abs(audio.right[i]));
      energy += audio.left[i] * audio.left[i] + audio.right[i] * audio.right[i];
    }
    const lufs = integratedLufs([audio.left, audio.right], p.sampleRate);
    const rmsDb = gainToDb(Math.sqrt(energy / Math.max(1, 2 * frames)));
    stats.push({ id: t.id, notes, peak: Number(peak.toFixed(4)), lufs: lufs === null ? null : Number(lufs.toFixed(2)), rmsDbfs: Number.isFinite(rmsDb) ? Number(rmsDb.toFixed(2)) : null });
  }
  const mastered = masterBus(mix, p.master, p.loop, p.sampleRate);
  // Stems get the same DC filter and the bus compressor's gain curve and make-up taken from the full mix,
  // so they sum exactly to the pre-limiter master; only the last fraction of a dB of limiting is missing.
  for (const [layer, stem] of Object.entries(stems) as [Layer, Stereo][]) stems[layer] = masterStem(stem, mastered.gainCurve, p.master.hpfHz, p.loop, p.sampleRate);
  const out = p.loop ? mastered.out : trimTail(mastered.out, frames - Math.round((opts.tailS ?? 3) * p.sampleRate), p.sampleRate);
  return { mix: out, stems, frames: out.left.length, loop: p.loop, master: mastered.stats, tracks: stats, warnings: trackBalance(stats) };
}

// One-shots end where the audio decays below -80 dBFS, with a short fade.
function trimTail(buf: Stereo, minFrames: number, sr = SAMPLE_RATE): Stereo {
  const floor = dbToGain(-80);
  let end = buf.left.length;
  while (end > minFrames && Math.abs(buf.left[end - 1]) < floor && Math.abs(buf.right[end - 1]) < floor) end -= 1;
  const out = { left: buf.left.slice(0, end), right: buf.right.slice(0, end) };
  const fade = Math.min(end, Math.round(0.01 * sr));
  for (let i = 0; i < fade; i += 1) {
    const g = clamp(i / fade, 0, 1);
    out.left[end - 1 - i] *= g;
    out.right[end - 1 - i] *= g;
  }
  return out;
}

export function tile(buf: Stereo, times: number): Stereo {
  const n = buf.left.length;
  const out = stereo(n * times);
  for (let k = 0; k < times; k += 1) {
    out.left.set(buf.left, k * n);
    out.right.set(buf.right, k * n);
  }
  return out;
}
