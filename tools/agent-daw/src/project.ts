import fs from 'node:fs';
import { SAMPLE_RATE } from './dsp.js';

export const FORMAT = 'agent-daw/v1';

export const ARTICULATIONS = ['normal', 'legato', 'staccato', 'accent', 'sforzando'] as const;
export const INSTRUMENTS = [
  'piano',
  'brass-horn',
  'brass-trumpet',
  'strings-ensemble',
  'strings-cello',
  'strings-bass',
  'guitar-electric',
  'guitar-acoustic',
  'timpani',
  'orchestral-perc',
  'synth-pad',
  'synth-bass',
  'cinematic-sfx',
] as const;
export const LAYERS = ['base', 'tension', 'combat', 'climax'] as const;
export const ROLES = ['lead', 'counter', 'harmony', 'bass', 'percussion', 'pad', 'fx'] as const;
export const KINDS = ['cue', 'loop', 'stinger', 'sfx'] as const;
export const FX_TYPES = ['eq3', 'chorus', 'delay', 'reverb', 'overdrive', 'cab', 'compressor'] as const;
export const AUTOMATION_PARAMS = ['volume', 'cutoff'] as const;

export const MODES: Readonly<Record<string, readonly number[]>> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

const TONICS: Readonly<Record<string, number>> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

export type Articulation = (typeof ARTICULATIONS)[number];
export type InstrumentType = (typeof INSTRUMENTS)[number];
export type Layer = (typeof LAYERS)[number];
export type Role = (typeof ROLES)[number];
export type ProjectKind = (typeof KINDS)[number];
export type AutomationParam = (typeof AUTOMATION_PARAMS)[number];

export interface Note {
  readonly midi: number;
  readonly startBeat: number;
  readonly durationBeats: number;
  readonly velocity: number;
  readonly articulation: Articulation;
  readonly pan?: number;
  readonly pitchBend?: number;
}

export interface Pattern {
  readonly lengthBeats: number;
  readonly notes: readonly Note[];
}

export interface Clip {
  readonly id: string;
  readonly startBeat: number;
  readonly notes: readonly Note[];
  readonly pattern?: string;
  readonly repeat: number;
  readonly transpose: number;
  readonly velocityScale: number;
}

export type ParamValue = number | string | boolean;

export interface InstrumentConfig {
  readonly type: InstrumentType;
  readonly params: Readonly<Record<string, ParamValue>>;
}

export type FxConfig =
  | { readonly type: 'eq3'; readonly lowDb: number; readonly midDb: number; readonly highDb: number; readonly lowHz: number; readonly midHz: number; readonly highHz: number; readonly midQ: number }
  | { readonly type: 'chorus'; readonly rateHz: number; readonly depthMs: number; readonly delayMs: number; readonly mix: number }
  | { readonly type: 'delay'; readonly timeBeats: number; readonly feedback: number; readonly mix: number; readonly pingPong: boolean; readonly dampHz: number }
  | { readonly type: 'reverb'; readonly preset: 'hall' | 'plate' | 'room'; readonly decay: number; readonly mix: number; readonly predelayMs: number; readonly damping: number; readonly width: number }
  | { readonly type: 'overdrive'; readonly drive: number; readonly tone: number; readonly mix: number }
  | { readonly type: 'cab'; readonly lowCutHz: number; readonly highCutHz: number; readonly presenceDb: number }
  | { readonly type: 'compressor'; readonly thresholdDb: number; readonly ratio: number; readonly attackMs: number; readonly releaseMs: number; readonly makeupDb: number; readonly kneeDb: number };

export interface AutomationPoint {
  readonly beat: number;
  readonly value: number;
}

export interface AutomationLane {
  readonly param: AutomationParam;
  readonly points: readonly AutomationPoint[];
}

export interface Track {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly layer: Layer;
  readonly instrument: InstrumentConfig;
  readonly gainDb: number;
  readonly pan: number;
  readonly mute: boolean;
  readonly fx: readonly FxConfig[];
  readonly automation: readonly AutomationLane[];
  readonly clips: readonly Clip[];
}

export interface Section {
  readonly id: string;
  readonly startBar: number;
  readonly bars: number;
  readonly layer?: Layer;
}

export interface MasterConfig {
  readonly targetLufs: number;
  readonly ceilingDbtp: number;
  readonly hpfHz: number;
  readonly compressor: { readonly thresholdDb: number; readonly ratio: number; readonly attackMs: number; readonly releaseMs: number } | null;
}

export interface Project {
  readonly format: typeof FORMAT;
  readonly id: string;
  readonly title: string;
  readonly kind: ProjectKind;
  readonly tempo: { readonly bpm: number; readonly beatsPerBar: number };
  readonly key: { readonly tonic: string; readonly mode: string };
  readonly bars: number;
  readonly loop: boolean;
  readonly sampleRate: number;
  readonly master: MasterConfig;
  readonly sections: readonly Section[];
  readonly patterns: Readonly<Record<string, Pattern>>;
  readonly tracks: readonly Track[];
}

export interface Issue {
  readonly path: string;
  readonly message: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T; readonly warnings: readonly Issue[] }
  | { readonly ok: false; readonly errors: readonly Issue[]; readonly warnings: readonly Issue[] };

export class Ctx {
  readonly errors: Issue[] = [];
  readonly warnings: Issue[] = [];
  error(path: string, message: string): void {
    this.errors.push({ path, message });
  }
  warn(path: string, message: string): void {
    this.warnings.push({ path, message });
  }
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(ctx: Ctx, o: Obj, key: string, path: string, def: number | undefined, lo = -Infinity, hi = Infinity): number {
  const v = o[key];
  if (v === undefined) {
    if (def === undefined) {
      ctx.error(`${path}.${key}`, 'is required');
      return lo === -Infinity ? 0 : lo;
    }
    return def;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    ctx.error(`${path}.${key}`, `must be a finite number, got ${JSON.stringify(v)}`);
    return def ?? 0;
  }
  if (v < lo || v > hi) {
    ctx.error(`${path}.${key}`, `must be in [${lo}, ${hi}], got ${v}`);
  }
  return v;
}

function str(ctx: Ctx, o: Obj, key: string, path: string, def?: string): string {
  const v = o[key];
  if (v === undefined && def !== undefined) return def;
  if (typeof v !== 'string' || v.length === 0) {
    ctx.error(`${path}.${key}`, 'must be a non-empty string');
    return def ?? '';
  }
  return v;
}

function oneOf<T extends string>(ctx: Ctx, o: Obj, key: string, path: string, options: readonly T[], def?: T): T {
  const v = o[key];
  if (v === undefined && def !== undefined) return def;
  if (typeof v === 'string' && (options as readonly string[]).includes(v)) return v as T;
  ctx.error(`${path}.${key}`, `must be one of ${options.join('|')}, got ${JSON.stringify(v)}`);
  return def ?? (options[0] as T);
}

function bool(ctx: Ctx, o: Obj, key: string, path: string, def: boolean): boolean {
  const v = o[key];
  if (v === undefined) return def;
  if (typeof v !== 'boolean') {
    ctx.error(`${path}.${key}`, 'must be a boolean');
    return def;
  }
  return v;
}

function arr(ctx: Ctx, o: Obj, key: string, path: string): readonly unknown[] {
  const v = o[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    ctx.error(`${path}.${key}`, 'must be an array');
    return [];
  }
  return v;
}

export function parseNote(ctx: Ctx, raw: unknown, path: string): Note | null {
  if (!isObj(raw)) {
    ctx.error(path, 'note must be an object');
    return null;
  }
  // notes/v1 and the report's CLI example spell the key "pitch"; midi is canonical.
  const keyed = raw.midi === undefined && raw.pitch !== undefined ? { ...raw, midi: raw.pitch } : raw;
  const midi = num(ctx, keyed, 'midi', path, undefined, 0, 127);
  if (!Number.isInteger(midi)) ctx.error(`${path}.midi`, 'must be an integer');
  const note: { -readonly [K in keyof Note]: Note[K] } = {
    midi,
    startBeat: num(ctx, keyed, 'startBeat', path, undefined, 0),
    durationBeats: num(ctx, keyed, 'durationBeats', path, undefined, 1e-3),
    velocity: num(ctx, keyed, 'velocity', path, 96, 1, 127),
    articulation: oneOf(ctx, keyed, 'articulation', path, ARTICULATIONS, 'normal'),
  };
  if (keyed.pan !== undefined) note.pan = num(ctx, keyed, 'pan', path, 0, -1, 1);
  if (keyed.pitchBend !== undefined) note.pitchBend = num(ctx, keyed, 'pitchBend', path, 0, -24, 24);
  return note;
}

function parseNotes(ctx: Ctx, list: readonly unknown[], path: string): Note[] {
  const out: Note[] = [];
  list.forEach((n, i) => {
    const note = parseNote(ctx, n, `${path}[${i}]`);
    if (note !== null) out.push(note);
  });
  return out.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
}

export function parseClip(ctx: Ctx, raw: unknown, path: string, patterns: Readonly<Record<string, Pattern>>): Clip | null {
  if (!isObj(raw)) {
    ctx.error(path, 'clip must be an object');
    return null;
  }
  const clip: { -readonly [K in keyof Clip]: Clip[K] } = {
    id: str(ctx, raw, 'id', path),
    startBeat: num(ctx, raw, 'startBeat', path, 0, 0),
    notes: parseNotes(ctx, arr(ctx, raw, 'notes', path), `${path}.notes`),
    repeat: num(ctx, raw, 'repeat', path, 1, 1, 512),
    transpose: num(ctx, raw, 'transpose', path, 0, -48, 48),
    velocityScale: num(ctx, raw, 'velocityScale', path, 1, 0.05, 4),
  };
  if (!Number.isInteger(clip.repeat)) ctx.error(`${path}.repeat`, 'must be an integer');
  if (raw.pattern !== undefined) {
    clip.pattern = str(ctx, raw, 'pattern', path);
    if (patterns[clip.pattern] === undefined) ctx.error(`${path}.pattern`, `unknown pattern "${clip.pattern}"`);
  }
  if (clip.pattern === undefined && clip.repeat > 1) ctx.error(`${path}.repeat`, 'repeat needs a pattern');
  return clip;
}

export function parseInstrument(ctx: Ctx, raw: unknown, path: string): InstrumentConfig {
  if (typeof raw === 'string') raw = { type: raw };
  if (!isObj(raw)) {
    ctx.error(path, 'instrument must be an object or a type name');
    return { type: 'piano', params: {} };
  }
  const type = oneOf(ctx, raw, 'type', path, INSTRUMENTS);
  const params: Record<string, ParamValue> = {};
  const rawParams = raw.params;
  if (rawParams !== undefined) {
    if (!isObj(rawParams)) ctx.error(`${path}.params`, 'must be an object');
    else
      for (const [k, v] of Object.entries(rawParams)) {
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') params[k] = v;
        else ctx.error(`${path}.params.${k}`, 'must be a number, string or boolean');
      }
  }
  return { type, params };
}

export function parseFx(ctx: Ctx, raw: unknown, path: string): FxConfig | null {
  if (!isObj(raw)) {
    ctx.error(path, 'fx must be an object');
    return null;
  }
  const p = isObj(raw.params) ? { ...raw.params, ...raw } : raw;
  const type = oneOf(ctx, p, 'type', path, FX_TYPES);
  switch (type) {
    case 'eq3':
      return {
        type,
        lowDb: num(ctx, p, 'lowDb', path, 0, -24, 24),
        midDb: num(ctx, p, 'midDb', path, 0, -24, 24),
        highDb: num(ctx, p, 'highDb', path, 0, -24, 24),
        lowHz: num(ctx, p, 'lowHz', path, 200, 20, 2000),
        midHz: num(ctx, p, 'midHz', path, 1000, 100, 10000),
        highHz: num(ctx, p, 'highHz', path, 5000, 1000, 20000),
        midQ: num(ctx, p, 'midQ', path, 0.8, 0.1, 10),
      };
    case 'chorus':
      return {
        type,
        rateHz: num(ctx, p, 'rateHz', path, 0.5, 0.01, 10),
        depthMs: num(ctx, p, 'depthMs', path, 3, 0, 20),
        delayMs: num(ctx, p, 'delayMs', path, 12, 1, 40),
        mix: num(ctx, p, 'mix', path, 0.35, 0, 1),
      };
    case 'delay':
      return {
        type,
        timeBeats: num(ctx, p, 'timeBeats', path, 0.75, 0.0625, 8),
        feedback: num(ctx, p, 'feedback', path, 0.3, 0, 0.95),
        mix: num(ctx, p, 'mix', path, 0.2, 0, 1),
        pingPong: bool(ctx, p, 'pingPong', path, true),
        dampHz: num(ctx, p, 'dampHz', path, 5000, 200, 20000),
      };
    case 'reverb':
      return {
        type,
        preset: oneOf(ctx, p, 'preset', path, ['hall', 'plate', 'room'] as const, 'hall'),
        decay: num(ctx, p, 'decay', path, 0.85, 0, 0.98),
        mix: num(ctx, p, 'mix', path, 0.25, 0, 1),
        predelayMs: num(ctx, p, 'predelayMs', path, 20, 0, 200),
        damping: num(ctx, p, 'damping', path, 0.35, 0, 1),
        width: num(ctx, p, 'width', path, 1, 0, 1),
      };
    case 'overdrive':
      return {
        type,
        drive: num(ctx, p, 'drive', path, 4, 1, 100),
        tone: num(ctx, p, 'tone', path, 0.5, 0, 1),
        mix: num(ctx, p, 'mix', path, 1, 0, 1),
      };
    case 'cab':
      return {
        type,
        lowCutHz: num(ctx, p, 'lowCutHz', path, 90, 20, 400),
        highCutHz: num(ctx, p, 'highCutHz', path, 5200, 1500, 12000),
        presenceDb: num(ctx, p, 'presenceDb', path, 3, -12, 12),
      };
    case 'compressor':
      return {
        type,
        thresholdDb: num(ctx, p, 'thresholdDb', path, -18, -60, 0),
        ratio: num(ctx, p, 'ratio', path, 3, 1, 30),
        attackMs: num(ctx, p, 'attackMs', path, 10, 0.1, 500),
        releaseMs: num(ctx, p, 'releaseMs', path, 120, 5, 3000),
        makeupDb: num(ctx, p, 'makeupDb', path, 0, -12, 24),
        kneeDb: num(ctx, p, 'kneeDb', path, 6, 0, 24),
      };
  }
}

export function parseAutomation(ctx: Ctx, raw: unknown, path: string): AutomationLane | null {
  if (!isObj(raw)) {
    ctx.error(path, 'automation lane must be an object');
    return null;
  }
  const param = oneOf(ctx, raw, 'param', path, AUTOMATION_PARAMS);
  const [lo, hi] = param === 'volume' ? [-80, 12] : [20, 20000];
  const points: AutomationPoint[] = [];
  arr(ctx, raw, 'points', path).forEach((pt, i) => {
    const pp = `${path}.points[${i}]`;
    if (!isObj(pt)) {
      ctx.error(pp, 'point must be an object');
      return;
    }
    points.push({ beat: num(ctx, pt, 'beat', pp, undefined, 0), value: num(ctx, pt, 'value', pp, undefined, lo, hi) });
  });
  if (points.length === 0) ctx.error(`${path}.points`, 'needs at least one point');
  return { param, points: points.sort((a, b) => a.beat - b.beat) };
}

const DEFAULT_ROLE: Readonly<Record<InstrumentType, Role>> = {
  piano: 'harmony',
  'brass-horn': 'lead',
  'brass-trumpet': 'lead',
  'strings-ensemble': 'harmony',
  'strings-cello': 'counter',
  'strings-bass': 'bass',
  'guitar-electric': 'counter',
  'guitar-acoustic': 'harmony',
  timpani: 'percussion',
  'orchestral-perc': 'percussion',
  'synth-pad': 'pad',
  'synth-bass': 'bass',
  'cinematic-sfx': 'fx',
};

export const DEFAULT_PAN: Readonly<Record<InstrumentType, number>> = {
  piano: 0,
  'brass-horn': -0.15,
  'brass-trumpet': 0.2,
  // Orchestral seating from the conductor's view: violins left, cellos right, basses just right of centre.
  'strings-ensemble': -0.45,
  'strings-cello': 0.4,
  'strings-bass': 0.12,
  'guitar-electric': 0,
  'guitar-acoustic': -0.25,
  timpani: 0.2,
  'orchestral-perc': 0,
  'synth-pad': 0,
  'synth-bass': 0,
  'cinematic-sfx': 0,
};

export function parseTrack(ctx: Ctx, raw: unknown, path: string, patterns: Readonly<Record<string, Pattern>>): Track | null {
  if (!isObj(raw)) {
    ctx.error(path, 'track must be an object');
    return null;
  }
  const id = str(ctx, raw, 'id', path);
  const instrument = parseInstrument(ctx, raw.instrument ?? 'piano', `${path}.instrument`);
  const clips: Clip[] = [];
  arr(ctx, raw, 'clips', path).forEach((c, i) => {
    const clip = parseClip(ctx, c, `${path}.clips[${i}]`, patterns);
    if (clip !== null) clips.push(clip);
  });
  const fx: FxConfig[] = [];
  arr(ctx, raw, 'fx', path).forEach((f, i) => {
    const parsed = parseFx(ctx, f, `${path}.fx[${i}]`);
    if (parsed !== null) fx.push(parsed);
  });
  const automation: AutomationLane[] = [];
  arr(ctx, raw, 'automation', path).forEach((a, i) => {
    const lane = parseAutomation(ctx, a, `${path}.automation[${i}]`);
    if (lane !== null) automation.push(lane);
  });
  const clipIds = new Set<string>();
  for (const c of clips) {
    if (clipIds.has(c.id)) ctx.error(`${path}.clips`, `duplicate clip id "${c.id}"`);
    clipIds.add(c.id);
  }
  return {
    id,
    name: str(ctx, raw, 'name', path, id),
    role: oneOf(ctx, raw, 'role', path, ROLES, DEFAULT_ROLE[instrument.type]),
    layer: oneOf(ctx, raw, 'layer', path, LAYERS, 'base'),
    instrument,
    gainDb: num(ctx, raw, 'gainDb', path, 0, -60, 12),
    pan: num(ctx, raw, 'pan', path, DEFAULT_PAN[instrument.type], -1, 1),
    mute: bool(ctx, raw, 'mute', path, false),
    fx,
    automation,
    clips,
  };
}

export function loopFrames(bpm: number, beatsPerBar: number, bars: number, sr = SAMPLE_RATE): number {
  return (bars * beatsPerBar * 60 * sr) / bpm;
}

export function parseProject(raw: unknown): ParseResult<Project> {
  const ctx = new Ctx();
  if (!isObj(raw)) return { ok: false, errors: [{ path: '$', message: 'project must be a JSON object' }], warnings: [] };
  if (raw.format !== FORMAT) ctx.error('$.format', `must be "${FORMAT}"`);
  const tempoRaw = isObj(raw.tempo) ? raw.tempo : {};
  const tempo = {
    bpm: num(ctx, tempoRaw, 'bpm', '$.tempo', 120, 20, 300),
    beatsPerBar: num(ctx, tempoRaw, 'beatsPerBar', '$.tempo', 4, 1, 16),
  };
  const keyRaw = isObj(raw.key) ? raw.key : {};
  const key = {
    tonic: oneOf(ctx, keyRaw, 'tonic', '$.key', Object.keys(TONICS), 'C'),
    mode: oneOf(ctx, keyRaw, 'mode', '$.key', Object.keys(MODES), 'major'),
  };
  const bars = num(ctx, raw, 'bars', '$', undefined, 1, 1024);
  if (!Number.isInteger(bars)) ctx.error('$.bars', 'must be an integer');
  const sampleRate = num(ctx, raw, 'sampleRate', '$', SAMPLE_RATE);
  if (sampleRate !== SAMPLE_RATE) ctx.error('$.sampleRate', `only ${SAMPLE_RATE} Hz is supported`);
  const kind = oneOf(ctx, raw, 'kind', '$', KINDS, 'loop');
  const loop = bool(ctx, raw, 'loop', '$', kind === 'loop');
  const masterRaw = isObj(raw.master) ? raw.master : {};
  let compressor: MasterConfig['compressor'] = { thresholdDb: -14, ratio: 2, attackMs: 25, releaseMs: 250 };
  if (masterRaw.compressor === null) compressor = null;
  else if (isObj(masterRaw.compressor)) {
    const c = masterRaw.compressor;
    compressor = {
      thresholdDb: num(ctx, c, 'thresholdDb', '$.master.compressor', -14, -60, 0),
      ratio: num(ctx, c, 'ratio', '$.master.compressor', 2, 1, 20),
      attackMs: num(ctx, c, 'attackMs', '$.master.compressor', 25, 0.1, 500),
      releaseMs: num(ctx, c, 'releaseMs', '$.master.compressor', 250, 5, 3000),
    };
  }
  const master: MasterConfig = {
    targetLufs: num(ctx, masterRaw, 'targetLufs', '$.master', -16, -40, -6),
    ceilingDbtp: num(ctx, masterRaw, 'ceilingDbtp', '$.master', -1.5, -12, 0),
    hpfHz: num(ctx, masterRaw, 'hpfHz', '$.master', 30, 10, 200),
    compressor,
  };

  const patterns: Record<string, Pattern> = {};
  if (raw.patterns !== undefined) {
    if (!isObj(raw.patterns)) ctx.error('$.patterns', 'must be an object keyed by pattern id');
    else
      for (const [pid, pr] of Object.entries(raw.patterns)) {
        const pp = `$.patterns.${pid}`;
        if (!isObj(pr)) {
          ctx.error(pp, 'pattern must be an object');
          continue;
        }
        const notes = parseNotes(ctx, arr(ctx, pr, 'notes', pp), `${pp}.notes`);
        const end = notes.reduce((m, n) => Math.max(m, n.startBeat + n.durationBeats), 0);
        patterns[pid] = { lengthBeats: num(ctx, pr, 'lengthBeats', pp, Math.max(1, Math.ceil(end)), 0.25), notes };
      }
  }

  const tracks: Track[] = [];
  arr(ctx, raw, 'tracks', '$').forEach((t, i) => {
    const track = parseTrack(ctx, t, `$.tracks[${i}]`, patterns);
    if (track !== null) tracks.push(track);
  });
  const ids = new Set<string>();
  for (const t of tracks) {
    if (ids.has(t.id)) ctx.error('$.tracks', `duplicate track id "${t.id}"`);
    ids.add(t.id);
  }

  const sections: Section[] = [];
  arr(ctx, raw, 'sections', '$').forEach((s, i) => {
    const sp = `$.sections[${i}]`;
    if (!isObj(s)) {
      ctx.error(sp, 'section must be an object');
      return;
    }
    const section: { -readonly [K in keyof Section]: Section[K] } = {
      id: str(ctx, s, 'id', sp),
      startBar: num(ctx, s, 'startBar', sp, undefined, 0),
      bars: num(ctx, s, 'bars', sp, undefined, 1),
    };
    if (s.layer !== undefined) section.layer = oneOf(ctx, s, 'layer', sp, LAYERS);
    if (section.startBar + section.bars > bars) ctx.error(sp, `ends at bar ${section.startBar + section.bars}, past the project's ${bars} bars`);
    sections.push(section);
  });

  const project: Project = {
    format: FORMAT,
    id: str(ctx, raw, 'id', '$', 'untitled'),
    title: typeof raw.title === 'string' ? raw.title : str(ctx, raw, 'id', '$', 'untitled'),
    kind,
    tempo,
    key,
    bars,
    loop,
    sampleRate,
    master,
    sections,
    patterns,
    tracks,
  };

  if (ctx.errors.length === 0) lintProject(ctx, project);
  if (ctx.errors.length > 0) return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
  return { ok: true, value: project, warnings: ctx.warnings };
}

function lintProject(ctx: Ctx, p: Project): void {
  const frames = loopFrames(p.tempo.bpm, p.tempo.beatsPerBar, p.bars, p.sampleRate);
  if (p.loop && !Number.isInteger(frames)) {
    ctx.warn(
      '$.tempo.bpm',
      `${p.bars} bars at ${p.tempo.bpm} BPM is ${frames.toFixed(3)} frames, not an integer; the loop will drift. 120 BPM x 16 bars is exactly ${loopFrames(120, 4, 16)} frames`,
    );
  }
  const totalBeats = p.bars * p.tempo.beatsPerBar;
  p.tracks.forEach((t, ti) => {
    const notes = expandTrackNotes(p, t);
    const late = notes.filter((n) => n.startBeat >= totalBeats);
    if (late.length > 0) ctx.warn(`$.tracks[${ti}]`, `${late.length} note(s) start after the project ends (beat ${totalBeats})`);
    if (p.loop) {
      for (const lane of t.automation) {
        const first = lane.points[0];
        const last = lane.points[lane.points.length - 1];
        if (first !== undefined && last !== undefined && Math.abs(first.value - last.value) > 1e-9) {
          ctx.warn(`$.tracks[${ti}].automation`, `${lane.param} ends at ${last.value} but starts at ${first.value}; the loop wrap will jump`);
        }
      }
    }
  });
}

export interface PlacedNote extends Note {
  readonly trackId: string;
  readonly clipId: string;
}

// Resolves clips, patterns, repeats and transposition into absolute, sorted notes.
export function expandTrackNotes(p: Project, t: Track): PlacedNote[] {
  const out: PlacedNote[] = [];
  for (const clip of t.clips) {
    const pattern = clip.pattern !== undefined ? p.patterns[clip.pattern] : undefined;
    const reps = pattern !== undefined ? clip.repeat : 1;
    for (let r = 0; r < reps; r += 1) {
      const offset = clip.startBeat + r * (pattern?.lengthBeats ?? 0);
      const source = pattern !== undefined ? pattern.notes : [];
      for (const n of [...source, ...(r === 0 ? clip.notes : [])]) {
        const midi = n.midi + clip.transpose;
        if (midi < 0 || midi > 127) continue;
        out.push({
          ...n,
          midi,
          startBeat: n.startBeat + offset,
          velocity: Math.max(1, Math.min(127, Math.round(n.velocity * clip.velocityScale))),
          trackId: t.id,
          clipId: clip.id,
        });
      }
    }
  }
  return out.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
}

export function tonicPc(p: Project): number {
  return TONICS[p.key.tonic] ?? 0;
}

export function scalePcs(p: Project): readonly number[] {
  const t = tonicPc(p);
  return (MODES[p.key.mode] ?? MODES.major ?? []).map((d) => (d + t) % 12);
}

export function loadProjectFile(path: string): ParseResult<Project> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [{ path: '$', message: `cannot read ${path}: ${(err as Error).message}` }], warnings: [] };
  }
  return parseProject(raw);
}

export function saveProjectFile(path: string, p: Project): void {
  fs.writeFileSync(path, `${JSON.stringify(p, null, 2)}\n`);
}

export interface InitOptions {
  readonly id: string;
  readonly title?: string;
  readonly kind?: ProjectKind;
  readonly bpm?: number;
  readonly beatsPerBar?: number;
  readonly bars?: number;
  readonly tonic?: string;
  readonly mode?: string;
  readonly targetLufs?: number;
}

export function initProject(o: InitOptions): ParseResult<Project> {
  return parseProject({
    format: FORMAT,
    id: o.id,
    title: o.title ?? o.id,
    kind: o.kind ?? 'loop',
    tempo: { bpm: o.bpm ?? 120, beatsPerBar: o.beatsPerBar ?? 4 },
    key: { tonic: o.tonic ?? 'D', mode: o.mode ?? 'minor' },
    bars: o.bars ?? 8,
    master: { targetLufs: o.targetLufs ?? -16 },
    sections: [],
    patterns: {},
    tracks: [],
  });
}

type Mutation = (raw: Obj) => string | null;

// Every edit goes through the JSON form and back through parseProject, so edits cannot produce an invalid project.
function mutate(p: Project, edit: Mutation): ParseResult<Project> {
  const raw = JSON.parse(JSON.stringify(p)) as Obj;
  const err = edit(raw);
  if (err !== null) return { ok: false, errors: [{ path: '$', message: err }], warnings: [] };
  return parseProject(raw);
}

function findTrack(raw: Obj, trackId: string): Obj | null {
  const tracks = raw.tracks as Obj[];
  return tracks.find((t) => t.id === trackId) ?? null;
}

export function addTrack(p: Project, track: unknown): ParseResult<Project> {
  return mutate(p, (raw) => {
    if (!isObj(track)) return 'track must be an object';
    if (findTrack(raw, String(track.id)) !== null) return `track "${String(track.id)}" already exists`;
    (raw.tracks as unknown[]).push(track);
    return null;
  });
}

export function removeTrack(p: Project, trackId: string): ParseResult<Project> {
  return mutate(p, (raw) => {
    const tracks = raw.tracks as Obj[];
    const idx = tracks.findIndex((t) => t.id === trackId);
    if (idx < 0) return `no track "${trackId}"`;
    tracks.splice(idx, 1);
    return null;
  });
}

export function addClip(p: Project, trackId: string, clip: unknown): ParseResult<Project> {
  return mutate(p, (raw) => {
    const t = findTrack(raw, trackId);
    if (t === null) return `no track "${trackId}"`;
    (t.clips as unknown[]).push(clip);
    return null;
  });
}

export function addNotes(p: Project, trackId: string, clipId: string, notes: unknown): ParseResult<Project> {
  return mutate(p, (raw) => {
    const t = findTrack(raw, trackId);
    if (t === null) return `no track "${trackId}"`;
    const clip = (t.clips as Obj[]).find((c) => c.id === clipId);
    if (clip === undefined) return `no clip "${clipId}" on track "${trackId}"`;
    if (!Array.isArray(notes)) return 'notes must be an array';
    (clip.notes as unknown[]).push(...(notes as unknown[]));
    return null;
  });
}

export function setInstrument(p: Project, trackId: string, instrument: unknown): ParseResult<Project> {
  return mutate(p, (raw) => {
    const t = findTrack(raw, trackId);
    if (t === null) return `no track "${trackId}"`;
    t.instrument = instrument;
    return null;
  });
}

export function addFx(p: Project, trackId: string, fx: unknown): ParseResult<Project> {
  return mutate(p, (raw) => {
    const t = findTrack(raw, trackId);
    if (t === null) return `no track "${trackId}"`;
    (t.fx as unknown[]).push(fx);
    return null;
  });
}

export function addAutomation(p: Project, trackId: string, lane: unknown): ParseResult<Project> {
  return mutate(p, (raw) => {
    const t = findTrack(raw, trackId);
    if (t === null) return `no track "${trackId}"`;
    (t.automation as unknown[]).push(lane);
    return null;
  });
}

export function projectSummary(p: Project): Record<string, unknown> {
  return {
    id: p.id,
    title: p.title,
    kind: p.kind,
    tempo: p.tempo,
    key: p.key,
    bars: p.bars,
    loop: p.loop,
    durationS: (p.bars * p.tempo.beatsPerBar * 60) / p.tempo.bpm,
    loopFrames: loopFrames(p.tempo.bpm, p.tempo.beatsPerBar, p.bars, p.sampleRate),
    sections: p.sections.map((s) => `${s.id}@${s.startBar}+${s.bars}`),
    patterns: Object.keys(p.patterns),
    tracks: p.tracks.map((t) => ({
      id: t.id,
      instrument: t.instrument.type,
      role: t.role,
      layer: t.layer,
      clips: t.clips.length,
      notes: expandTrackNotes(p, t).length,
      fx: t.fx.map((f) => f.type),
      automation: t.automation.map((a) => a.param),
    })),
  };
}
