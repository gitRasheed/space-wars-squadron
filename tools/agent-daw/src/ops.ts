import fs from 'node:fs';
import path from 'node:path';
import { critique, type Critique } from './critic.js';
import { gateAudio, type Category, type GateReport } from './gate.js';
import { measureLoudness } from './loudness.js';
import { exportMidi } from './midi.js';
import { FORMAT, parseProject, projectSummary, type Layer, type ParseResult, type Project } from './project.js';
import { renderProject, tile } from './render.js';
import { readWav, writeWav, type BitDepth } from './wav.js';

export interface RenderFilesOptions {
  readonly out: string;
  readonly bitDepth?: BitDepth;
  readonly stemsDir?: string;
  readonly repeats?: number;
  readonly layers?: readonly Layer[];
  readonly trackIds?: readonly string[];
}

export function renderToFiles(p: Project, o: RenderFilesOptions): Record<string, unknown> {
  const t0 = performance.now();
  const r = renderProject(p, { ...(o.layers !== undefined ? { layers: o.layers } : {}), ...(o.trackIds !== undefined ? { trackIds: o.trackIds } : {}) });
  const bitDepth = o.bitDepth ?? 24;
  writeWav(o.out, { sampleRate: p.sampleRate, channels: [r.mix.left, r.mix.right] }, bitDepth);
  const written: string[] = [o.out];
  let repeatedOut: string | null = null;
  if ((o.repeats ?? 1) > 1 && p.loop) {
    const looped = tile(r.mix, o.repeats ?? 1);
    repeatedOut = repeatsPath(o.out, o.repeats ?? 1);
    writeWav(repeatedOut, { sampleRate: p.sampleRate, channels: [looped.left, looped.right] }, bitDepth);
    written.push(repeatedOut);
  }
  if (o.stemsDir !== undefined) {
    fs.mkdirSync(o.stemsDir, { recursive: true });
    for (const [layer, stem] of Object.entries(r.stems)) {
      const file = path.join(o.stemsDir, `${p.id}_${layer}.wav`);
      writeWav(file, { sampleRate: p.sampleRate, channels: [stem.left, stem.right] }, bitDepth);
      written.push(file);
    }
  }
  return {
    out: o.out,
    repeatedOut,
    files: written,
    frames: r.frames,
    durationS: Number((r.frames / p.sampleRate).toFixed(4)),
    loop: r.loop,
    master: r.master,
    tracks: r.tracks,
    warnings: r.warnings,
    renderMs: Math.round(performance.now() - t0),
  };
}

// `--repeats N --out X.wav` writes X.wav once through and X_xN.wav tiled N times.
export function repeatsPath(out: string, repeats: number): string {
  return /\.wav$/i.test(out) ? out.replace(/\.wav$/i, `_x${repeats}.wav`) : `${out}_x${repeats}.wav`;
}

export function gateFile(file: string, p: Project | null, o: { readonly category?: Category; readonly pngDir?: string; readonly loop?: boolean; readonly bpm?: number; readonly beatsPerBar?: number } = {}): GateReport {
  const audio = readWav(file);
  const loop = o.loop ?? p?.loop ?? false;
  const bpm = o.bpm ?? p?.tempo.bpm;
  const beatsPerBar = o.beatsPerBar ?? p?.tempo.beatsPerBar;
  return gateAudio(audio, {
    category: o.category ?? (p?.kind === 'sfx' ? 'sfx' : 'music'),
    loop,
    ...(bpm !== undefined ? { bpm } : {}),
    ...(beatsPerBar !== undefined ? { beatsPerBar } : {}),
    ...(p !== null && (o.category ?? 'music') === 'music' && p.kind !== 'sfx' ? { targetLufs: p.master.targetLufs } : {}),
    ...(o.pngDir !== undefined ? { pngDir: o.pngDir, title: path.basename(file) } : {}),
  });
}

export function critiqueProject(p: Project): Critique {
  return critique(p);
}

export function analyseAudioFile(file: string): Record<string, unknown> {
  const audio = readWav(file);
  const report = gateAudio(audio, { category: 'music' });
  return {
    file,
    durationS: report.durationS,
    sampleRate: audio.sampleRate,
    channels: audio.channels.length,
    loudness: measureLoudness(audio.channels, audio.sampleRate),
    centroidHz: report.centroidHz,
    rolloff85Hz: report.rolloff85Hz,
    rolloff95Hz: report.rolloff95Hz,
    correlation: report.correlation,
    balanceDb: report.balanceDb,
    channelRmsDb: report.channelRmsDb,
    dcOffset: report.dcOffset,
    clickRatio: report.clickRatio,
    hum: report.hum,
  };
}

export function writeMidi(p: Project, out: string): Record<string, unknown> {
  const bytes = exportMidi(p);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, bytes);
  return { file: out, bytes: bytes.length, tracks: p.tracks.length + 1 };
}

export function dump(p: Project): Record<string, unknown> {
  return projectSummary(p);
}

// notes/v1: the minimal agent score format (parts of {pitch|midi, start, dur, vel, art}) lifted into a project.
export function importNotes(raw: unknown, id?: string): ParseResult<Project> {
  if (typeof raw !== 'object' || raw === null || (raw as { format?: unknown }).format !== 'notes/v1')
    return { ok: false, errors: [{ path: '$.format', message: 'must be "notes/v1"' }], warnings: [] };
  const s = raw as Record<string, unknown>;
  const parts = Array.isArray(s.parts) ? (s.parts as Record<string, unknown>[]) : [];
  const bpb = typeof s.beatsPerBar === 'number' ? s.beatsPerBar : 4;
  let lastBeat = 0;
  const tracks = parts.map((part, i) => {
    const notes = (Array.isArray(part.notes) ? (part.notes as Record<string, unknown>[]) : []).map((n) => {
      const start = Number(n.start ?? n.startBeat);
      const dur = Number(n.dur ?? n.durationBeats);
      lastBeat = Math.max(lastBeat, start + dur);
      return { midi: n.midi ?? n.pitch, startBeat: start, durationBeats: dur, velocity: n.vel ?? n.velocity ?? 96, articulation: n.art ?? n.articulation ?? 'normal' };
    });
    return {
      id: typeof part.id === 'string' ? part.id : `part${i + 1}`,
      instrument: part.instrument ?? 'piano',
      ...(typeof part.role === 'string' ? { role: part.role } : {}),
      clips: [{ id: 'main', startBeat: 0, notes }],
    };
  });
  const key = (typeof s.key === 'object' && s.key !== null ? s.key : {}) as Record<string, unknown>;
  return parseProject({
    format: FORMAT,
    id: id ?? (typeof s.id === 'string' ? s.id : 'imported'),
    title: typeof s.title === 'string' ? s.title : 'imported',
    kind: 'cue',
    loop: s.loop === true,
    tempo: { bpm: typeof s.bpm === 'number' ? s.bpm : 120, beatsPerBar: bpb },
    key: { tonic: key.tonic ?? 'C', mode: key.mode ?? 'major' },
    bars: typeof s.bars === 'number' ? s.bars : Math.max(1, Math.ceil(lastBeat / bpb)),
    tracks,
  });
}
