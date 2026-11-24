import type {
  AdsrEnvelope,
  AudioBufferData,
  AudioRecipe,
  BiquadSpec,
  LoopRecipe,
  OneShotRecipe,
  SupportedSampleRate,
  VoiceSpec,
} from './types.js';

export class RecipeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeError';
  }
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function evalAdsr(t: number, holdEnd: number, env: AdsrEnvelope): number {
  if (t < 0) {
    return 0;
  }
  const a = Math.max(0, env.attackS);
  const d = Math.max(0, env.decayS);
  const s = Math.max(0, Math.min(1, env.sustainLevel));
  const r = Math.max(0.001, env.releaseS);

  let level: number;
  if (a > 0 && t < a) {
    level = t / a;
  } else if (d > 0 && t < a + d) {
    level = 1 - ((t - a) / d) * (1 - s);
  } else {
    level = s;
  }

  if (t >= holdEnd) {
    const relT = t - holdEnd;
    if (relT >= r) {
      return 0;
    }
    const levelAtRelease =
      a > 0 && holdEnd < a
        ? holdEnd / a
        : d > 0 && holdEnd < a + d
          ? 1 - ((holdEnd - a) / d) * (1 - s)
          : s;
    return levelAtRelease * (1 - relT / r);
  }
  return level;
}

interface FilterState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

function createBiquad(spec: BiquadSpec, sampleRate: number): FilterState {
  const freq = Math.max(20, Math.min(sampleRate * 0.45, spec.freqHz));
  const q = Math.max(0.1, spec.q ?? 0.7071);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);

  let b0 = 1;
  let b1 = 0;
  let b2 = 0;
  if (spec.type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else if (spec.type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  return {
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function stepBiquad(f: FilterState, x0: number): number {
  const y0 = f.b0 * x0 + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1;
  f.x1 = x0;
  f.y2 = f.y1;
  f.y1 = y0;
  return y0;
}

function renderVoiceEvent(
  channels: readonly Float64Array[],
  totalFrames: number,
  sampleRate: SupportedSampleRate,
  voice: VoiceSpec,
  startFrame: number,
  holdDurationS: number,
  velocityScale: number,
  rng: () => number,
  loopWrap: boolean,
): void {
  const releaseS = Math.max(0.001, voice.envelope.releaseS);
  const totalDurS = Math.max(0.001, holdDurationS + releaseS);
  const eventFrames = Math.ceil(totalDurS * sampleRate);

  const gain = dbToLinear(voice.gainDb) * velocityScale;
  const pan = Math.max(-1, Math.min(1, voice.pan ?? 0));
  const leftGain = channels.length === 1 ? gain : gain * Math.cos(((pan + 1) * Math.PI) / 4);
  const rightGain = channels.length === 1 ? 0 : gain * Math.sin(((pan + 1) * Math.PI) / 4);

  const fStart = Math.max(10, voice.freqStartHz ?? 220);
  const fEnd = Math.max(10, voice.freqEndHz ?? fStart);
  const expCurve = voice.freqCurve !== 'linear';
  const fmRatio = voice.fmRatio ?? 2;
  const fmIndex = voice.fmIndex ?? 1.5;
  const drive = Math.max(0, voice.drive ?? 0);
  const filter = voice.filter !== undefined ? createBiquad(voice.filter, sampleRate) : null;

  let phase = 0;
  let modPhase = 0;

  for (let i = 0; i < eventFrames; i += 1) {
    const t = i / sampleRate;
    const env = evalAdsr(t, holdDurationS, voice.envelope);
    if (env <= 0 && t > holdDurationS) {
      break;
    }

    const frac = Math.min(1, t / Math.max(1e-6, holdDurationS));
    const freq = expCurve
      ? fStart * Math.pow(fEnd / fStart, frac)
      : fStart + (fEnd - fStart) * frac;

    let raw = 0;
    if (voice.waveform === 'noise') {
      raw = rng() * 2 - 1;
    } else {
      phase += (2 * Math.PI * freq) / sampleRate;
      const cycle = ((phase / (2 * Math.PI)) % 1 + 1) % 1;
      if (voice.waveform === 'sine') {
        raw = Math.sin(phase);
      } else if (voice.waveform === 'triangle') {
        raw = 4 * Math.abs(cycle - 0.5) - 1;
      } else if (voice.waveform === 'saw') {
        raw = 2 * cycle - 1;
      } else if (voice.waveform === 'square') {
        raw = cycle < 0.5 ? 1 : -1;
      } else {
        modPhase += (2 * Math.PI * freq * fmRatio) / sampleRate;
        raw = Math.sin(phase + Math.sin(modPhase) * fmIndex);
      }
    }

    if (filter !== null) {
      raw = stepBiquad(filter, raw);
    }
    if (drive > 0) {
      raw = Math.tanh(raw * (1 + drive)) / Math.tanh(1 + drive);
    }

    const sample = raw * env;
    const rawTarget = startFrame + i;
    if (!loopWrap && (rawTarget < 0 || rawTarget >= totalFrames)) {
      continue;
    }
    const targetFrame = loopWrap
      ? ((rawTarget % totalFrames) + totalFrames) % totalFrames
      : rawTarget;

    const left = channels[0];
    if (left !== undefined) {
      left[targetFrame] = (left[targetFrame] ?? 0) + sample * leftGain;
    }
    const right = channels[1];
    if (right !== undefined) {
      right[targetFrame] = (right[targetFrame] ?? 0) + sample * rightGain;
    }
  }
}

const VALID_WAVEFORMS = new Set(['sine', 'triangle', 'saw', 'square', 'noise', 'fm']);
const VALID_FILTERS = new Set(['lowpass', 'highpass', 'bandpass']);

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const RECIPE_KEYS = ['schemaVersion', 'kind', 'id', 'sampleRate', 'channels', 'encoding', 'seed', 'masterGainDb'];
const ONE_SHOT_KEYS = [...RECIPE_KEYS, 'durationS', 'voices'];
const LOOP_KEYS = [...RECIPE_KEYS, 'bpm', 'beats', 'loopWrap', 'tracks'];
const TRACK_VOICE_KEYS = ['waveform', 'gainDb', 'pan', 'fmRatio', 'fmIndex', 'envelope', 'filter', 'drive'];
const ONE_SHOT_VOICE_KEYS = ['id', ...TRACK_VOICE_KEYS, 'freqStartHz', 'freqEndHz', 'freqCurve', 'startS', 'durationS'];
const TRACK_KEYS = ['id', 'voice', 'notes'];
const NOTE_KEYS = ['startBeat', 'durationBeats', 'midi', 'velocity'];
const ENVELOPE_KEYS = ['attackS', 'decayS', 'sustainLevel', 'releaseS'];
const FILTER_KEYS = ['type', 'freqHz', 'q'];

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new RecipeError(`Unknown key "${key}" at ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function validateVoiceCommon(
  v: Record<string, unknown>,
  label: string,
  where: string,
  allowedKeys: readonly string[],
): void {
  rejectUnknownKeys(v, allowedKeys, where);
  if (typeof v['waveform'] !== 'string' || !VALID_WAVEFORMS.has(v['waveform'])) {
    throw new RecipeError(`${label} invalid waveform: ${String(v['waveform'])}`);
  }
  if (!isFiniteNum(v['gainDb']) || v['gainDb'] < -120 || v['gainDb'] > 24) {
    throw new RecipeError(`${label} invalid gainDb: ${String(v['gainDb'])}`);
  }
  if (v['pan'] !== undefined && (!isFiniteNum(v['pan']) || v['pan'] < -1 || v['pan'] > 1)) {
    throw new RecipeError(`${label} pan must be in [-1, 1], got ${String(v['pan'])}`);
  }
  if (v['drive'] !== undefined && (!isFiniteNum(v['drive']) || v['drive'] < 0 || v['drive'] > 20)) {
    throw new RecipeError(`${label} invalid drive: ${String(v['drive'])}`);
  }
  if (v['fmRatio'] !== undefined && (!isFiniteNum(v['fmRatio']) || v['fmRatio'] <= 0)) {
    throw new RecipeError(`${label} invalid fmRatio: ${String(v['fmRatio'])}`);
  }
  if (v['fmIndex'] !== undefined && (!isFiniteNum(v['fmIndex']) || v['fmIndex'] < 0)) {
    throw new RecipeError(`${label} invalid fmIndex: ${String(v['fmIndex'])}`);
  }

  const env = v['envelope'];
  if (typeof env !== 'object' || env === null) {
    throw new RecipeError(`${label} missing envelope`);
  }
  const e = env as Record<string, unknown>;
  rejectUnknownKeys(e, ENVELOPE_KEYS, `${where}.envelope`);
  if (!isFiniteNum(e['attackS']) || e['attackS'] < 0) {
    throw new RecipeError(`${label} envelope.attackS must be >= 0`);
  }
  if (!isFiniteNum(e['decayS']) || e['decayS'] < 0) {
    throw new RecipeError(`${label} envelope.decayS must be >= 0`);
  }
  if (!isFiniteNum(e['sustainLevel']) || e['sustainLevel'] < 0 || e['sustainLevel'] > 1) {
    throw new RecipeError(`${label} envelope.sustainLevel must be in [0, 1]`);
  }
  if (!isFiniteNum(e['releaseS']) || e['releaseS'] <= 0) {
    throw new RecipeError(`${label} envelope.releaseS must be > 0`);
  }

  if (v['filter'] !== undefined) {
    if (typeof v['filter'] !== 'object' || v['filter'] === null) {
      throw new RecipeError(`${label} invalid filter object`);
    }
    const f = v['filter'] as Record<string, unknown>;
    rejectUnknownKeys(f, FILTER_KEYS, `${where}.filter`);
    if (typeof f['type'] !== 'string' || !VALID_FILTERS.has(f['type'])) {
      throw new RecipeError(`${label} invalid filter.type: ${String(f['type'])}`);
    }
    if (!isFiniteNum(f['freqHz']) || f['freqHz'] <= 0) {
      throw new RecipeError(`${label} invalid filter.freqHz: ${String(f['freqHz'])}`);
    }
    if (f['q'] !== undefined && (!isFiniteNum(f['q']) || f['q'] <= 0)) {
      throw new RecipeError(`${label} invalid filter.q: ${String(f['q'])}`);
    }
  }
}

export function validateRecipe(raw: unknown): AudioRecipe {
  if (typeof raw !== 'object' || raw === null) {
    throw new RecipeError('Recipe must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj['schemaVersion'] !== 'agent-audio/recipe/v1') {
    throw new RecipeError(`Unsupported recipe schemaVersion: ${String(obj['schemaVersion'])}`);
  }
  if (typeof obj['id'] !== 'string' || obj['id'].trim().length === 0) {
    throw new RecipeError('Recipe requires a non-empty string id');
  }
  const sampleRate = obj['sampleRate'] ?? 48000;
  if (sampleRate !== 44100 && sampleRate !== 48000) {
    throw new RecipeError(`Unsupported recipe sampleRate: ${String(sampleRate)}`);
  }
  const channels = obj['channels'] ?? 2;
  if (channels !== 1 && channels !== 2) {
    throw new RecipeError(`Unsupported recipe channels: ${String(channels)}`);
  }
  const encoding = obj['encoding'] ?? 'pcm16';
  if (encoding !== 'pcm16' && encoding !== 'float32') {
    throw new RecipeError(`Unsupported recipe encoding: ${String(encoding)}`);
  }
  if (obj['masterGainDb'] !== undefined && !isFiniteNum(obj['masterGainDb'])) {
    throw new RecipeError(`Invalid masterGainDb: ${String(obj['masterGainDb'])}`);
  }
  if (obj['seed'] !== undefined && !isFiniteNum(obj['seed'])) {
    throw new RecipeError(`Invalid seed: ${String(obj['seed'])}`);
  }

  if (obj['kind'] === 'one-shot') {
    rejectUnknownKeys(obj, ONE_SHOT_KEYS, 'recipe');
    const dur = obj['durationS'];
    if (!isFiniteNum(dur) || dur <= 0 || dur > 30) {
      throw new RecipeError(`Invalid one-shot durationS: ${String(dur)}`);
    }
    if (!Array.isArray(obj['voices']) || obj['voices'].length === 0) {
      throw new RecipeError('One-shot recipe requires at least one voice');
    }
    for (const [voiceIdx, rawVoice] of (obj['voices'] as unknown[]).entries()) {
      if (typeof rawVoice !== 'object' || rawVoice === null) {
        throw new RecipeError('Voice entry must be an object');
      }
      const v = rawVoice as Record<string, unknown>;
      if (typeof v['id'] !== 'string' || v['id'].trim().length === 0) {
        throw new RecipeError('Voice requires non-empty string id');
      }
      validateVoiceCommon(v, `Voice '${v['id']}'`, `voices[${voiceIdx}]`, ONE_SHOT_VOICE_KEYS);
      if (v['freqStartHz'] !== undefined && (!isFiniteNum(v['freqStartHz']) || v['freqStartHz'] <= 0)) {
        throw new RecipeError(`Voice '${v['id']}' invalid freqStartHz`);
      }
      if (v['freqEndHz'] !== undefined && (!isFiniteNum(v['freqEndHz']) || v['freqEndHz'] <= 0)) {
        throw new RecipeError(`Voice '${v['id']}' invalid freqEndHz`);
      }
      if (
        v['freqCurve'] !== undefined &&
        v['freqCurve'] !== 'linear' &&
        v['freqCurve'] !== 'exp'
      ) {
        throw new RecipeError(`Voice '${v['id']}' invalid freqCurve: ${String(v['freqCurve'])}`);
      }
      const start = v['startS'] ?? 0;
      if (!isFiniteNum(start) || start < 0 || start >= dur) {
        throw new RecipeError(`Voice '${v['id']}' startS=${String(start)} out of range [0, ${dur})`);
      }
      if (v['durationS'] !== undefined && (!isFiniteNum(v['durationS']) || v['durationS'] <= 0)) {
        throw new RecipeError(`Voice '${v['id']}' durationS must be > 0`);
      }
    }
    return obj as unknown as OneShotRecipe;
  }

  if (obj['kind'] === 'loop') {
    rejectUnknownKeys(obj, LOOP_KEYS, 'recipe');
    const bpm = obj['bpm'];
    const beats = obj['beats'];
    if (!isFiniteNum(bpm) || bpm < 30 || bpm > 300) {
      throw new RecipeError(`Invalid loop bpm: ${String(bpm)}`);
    }
    if (!isFiniteNum(beats) || beats <= 0 || beats > 512) {
      throw new RecipeError(`Invalid loop beats: ${String(beats)}`);
    }
    if (obj['loopWrap'] !== undefined && typeof obj['loopWrap'] !== 'boolean') {
      throw new RecipeError(`Invalid loopWrap: ${String(obj['loopWrap'])}`);
    }
    if (!Array.isArray(obj['tracks']) || obj['tracks'].length === 0) {
      throw new RecipeError('Loop recipe requires at least one track');
    }
    for (const [trackIdx, rawTrack] of (obj['tracks'] as unknown[]).entries()) {
      if (typeof rawTrack !== 'object' || rawTrack === null) {
        throw new RecipeError('Track entry must be an object');
      }
      const track = rawTrack as Record<string, unknown>;
      const trackWhere = `tracks[${trackIdx}]`;
      rejectUnknownKeys(track, TRACK_KEYS, trackWhere);
      if (typeof track['id'] !== 'string' || track['id'].trim().length === 0) {
        throw new RecipeError('Track requires non-empty string id');
      }
      if (typeof track['voice'] !== 'object' || track['voice'] === null) {
        throw new RecipeError(`Track '${track['id']}' missing voice`);
      }
      validateVoiceCommon(
        track['voice'] as Record<string, unknown>,
        `Track '${track['id']}' voice`,
        `${trackWhere}.voice`,
        TRACK_VOICE_KEYS,
      );
      if (!Array.isArray(track['notes'])) {
        throw new RecipeError(`Track '${track['id']}' missing notes array`);
      }
      for (const [noteIdx, rawNote] of (track['notes'] as unknown[]).entries()) {
        if (typeof rawNote !== 'object' || rawNote === null) {
          throw new RecipeError(`Track '${track['id']}' note must be an object`);
        }
        const note = rawNote as Record<string, unknown>;
        rejectUnknownKeys(note, NOTE_KEYS, `${trackWhere}.notes[${noteIdx}]`);
        if (!isFiniteNum(note['midi']) || note['midi'] < 0 || note['midi'] > 127) {
          throw new RecipeError(`Track '${track['id']}' MIDI pitch ${String(note['midi'])} out of range 0..127`);
        }
        if (!isFiniteNum(note['startBeat']) || note['startBeat'] < 0 || note['startBeat'] >= beats) {
          throw new RecipeError(
            `Track '${track['id']}' note startBeat ${String(note['startBeat'])} out of range [0, ${beats})`,
          );
        }
        if (!isFiniteNum(note['durationBeats']) || note['durationBeats'] <= 0) {
          throw new RecipeError(`Track '${track['id']}' note durationBeats must be a positive number`);
        }
        if (!isFiniteNum(note['velocity']) || note['velocity'] <= 0 || note['velocity'] > 1) {
          throw new RecipeError(`Track '${track['id']}' note velocity ${String(note['velocity'])} out of (0, 1]`);
        }
      }
    }
    return obj as unknown as LoopRecipe;
  }

  throw new RecipeError(`Unsupported recipe kind: ${String(obj['kind'])}`);
}

export function renderRecipe(recipe: AudioRecipe): AudioBufferData {
  const sampleRate: SupportedSampleRate = recipe.sampleRate ?? 48000;
  const numChannels = recipe.channels ?? 2;
  const encoding = recipe.encoding ?? 'pcm16';
  const rng = createMulberry32(recipe.seed ?? 0x51a7c0de);
  const masterGain = dbToLinear(recipe.masterGainDb ?? 0);

  let totalFrames: number;
  if (recipe.kind === 'one-shot') {
    totalFrames = Math.max(1, Math.round(recipe.durationS * sampleRate));
  } else {
    // Round absolute loop duration once to avoid cumulative per-beat rounding drift.
    totalFrames = Math.max(1, Math.round(((recipe.beats * 60) / recipe.bpm) * sampleRate));
  }

  const channels: Float64Array[] = [];
  for (let c = 0; c < numChannels; c += 1) {
    channels.push(new Float64Array(totalFrames));
  }

  if (recipe.kind === 'one-shot') {
    for (const voice of recipe.voices) {
      const startFrame = Math.round((voice.startS ?? 0) * sampleRate);
      const maxHold = Math.max(0.001, recipe.durationS - (voice.startS ?? 0) - voice.envelope.releaseS);
      const holdS = Math.min(maxHold, voice.durationS ?? maxHold);
      renderVoiceEvent(channels, totalFrames, sampleRate, voice, startFrame, holdS, 1, rng, false);
    }
  } else {
    const secPerBeat = 60 / recipe.bpm;
    const loopWrap = recipe.loopWrap ?? true;
    for (const track of recipe.tracks) {
      for (const note of track.notes) {
        const startFrame = Math.round(note.startBeat * secPerBeat * sampleRate);
        const holdS = note.durationBeats * secPerBeat;
        const hz = midiToHz(note.midi);
        const voiceSpec: VoiceSpec = {
          ...track.voice,
          id: track.id,
          freqStartHz: hz,
          freqEndHz: hz,
        };
        renderVoiceEvent(
          channels,
          totalFrames,
          sampleRate,
          voiceSpec,
          startFrame,
          holdS,
          note.velocity,
          rng,
          loopWrap,
        );
      }
    }
  }

  if (masterGain !== 1) {
    for (const ch of channels) {
      for (let i = 0; i < totalFrames; i += 1) {
        ch[i] = (ch[i] ?? 0) * masterGain;
      }
    }
  }

  return {
    sampleRate,
    channels,
    format: encoding,
  };
}
