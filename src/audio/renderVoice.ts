interface Envelope {
  readonly attackS: number;
  readonly decayS: number;
  readonly sustainLevel: number;
  readonly releaseS: number;
}

interface Voice {
  readonly waveform: string;
  readonly gainDb: number;
  readonly pan: number;
  readonly envelope: Envelope;
  readonly filter?: { readonly type: string; readonly freqHz: number; readonly q: number };
  readonly drive?: number;
  readonly fmRatio?: number;
  readonly fmIndex?: number;
}

export function stereoBuffer(durationS: number, sampleRate: number) {
  const frames = Math.max(1, Math.round(durationS * sampleRate));
  return { left: new Float32Array(frames), right: new Float32Array(frames) };
}

export function noiseGenerator(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 2147483648) - 1;
  };
}

function heldLevel(t: number, e: Envelope): number {
  if (t < e.attackS) return t / e.attackS;
  if (t < e.attackS + e.decayS) return 1 - (1 - e.sustainLevel) * ((t - e.attackS) / e.decayS);
  return e.sustainLevel;
}

function filterCoefficients(filter: Voice['filter'], sampleRate: number) {
  if (!filter) return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  const w = 2 * Math.PI * Math.min(sampleRate * 0.45, filter.freqHz) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * filter.q);
  const a0 = 1 + alpha;
  const a1 = -2 * cos / a0;
  const a2 = (1 - alpha) / a0;
  switch (filter.type) {
    case 'bandpass': return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1, a2 };
    case 'lowpass': {
      const b0 = (1 - cos) / (2 * a0);
      return { b0, b1: 2 * b0, b2: b0, a1, a2 };
    }
    case 'highpass': {
      const b0 = (1 + cos) / (2 * a0);
      return { b0, b1: -2 * b0, b2: b0, a1, a2 };
    }
    default: throw new Error(`Unsupported audio filter ${filter.type}`);
  }
}

interface NoteEvent {
  readonly startS: number;
  readonly holdS: number;
  readonly startHz: number;
  readonly endHz: number;
  readonly gain: number;
}

export function mixVoice(
  { left, right }: ReturnType<typeof stereoBuffer>,
  sampleRate: number,
  voice: Voice,
  event: NoteEvent,
  noise: () => number,
  wrap: boolean,
): void {
  const { startS, holdS, startHz, endHz } = event;
  const env = voice.envelope;
  const releaseLevel = heldLevel(holdS, env);
  const gain = event.gain * 10 ** (voice.gainDb / 20);
  const angle = (voice.pan + 1) * Math.PI / 4;
  const gainL = gain * Math.cos(angle);
  const gainR = gain * Math.sin(angle);
  const frames = Math.ceil((holdS + env.releaseS) * sampleRate);
  let dst = Math.round(startS * sampleRate);
  const { b0, b1, b2, a1, a2 } = filterCoefficients(voice.filter, sampleRate);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const fmRatio = voice.fmRatio ?? 2;
  const fmIndex = voice.fmIndex ?? 1.5;
  const drive = voice.drive ?? 0;
  const driveNorm = Math.tanh(1 + drive);
  let phase = 0;
  let modPhase = 0;
  let hz = startHz;
  const sweep = (endHz / startHz) ** (1 / (holdS * sampleRate));

  for (let i = 0; i < frames; i++, dst++) {
    if (dst === left.length) {
      if (!wrap) break;
      dst = 0;
    }
    const t = i / sampleRate;
    const level = t < holdS ? heldLevel(t, env) : releaseLevel * (1 - (t - holdS) / env.releaseS);
    // A voice that releases from silence stops drawing noise here, as the reference renderer does.
    if (level <= 0 && t > holdS) break;
    const step = 2 * Math.PI * hz / sampleRate;
    phase += step;
    hz = t < holdS ? hz * sweep : endHz;
    const turns = phase / (2 * Math.PI);
    const cycle = turns - Math.floor(turns);
    let raw: number;
    switch (voice.waveform) {
      case 'sine': raw = Math.sin(phase); break;
      case 'saw': raw = 2 * cycle - 1; break;
      case 'triangle': raw = 4 * Math.abs(cycle - 0.5) - 1; break;
      case 'square': raw = cycle < 0.5 ? 1 : -1; break;
      case 'fm':
        modPhase += step * fmRatio;
        raw = Math.sin(phase + Math.sin(modPhase) * fmIndex);
        break;
      case 'noise': raw = noise(); break;
      default: throw new Error(`Unsupported audio waveform ${voice.waveform}`);
    }

    const filtered = b0 * raw + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = raw;
    y2 = y1;
    y1 = filtered;
    const shaped = drive > 0 ? Math.tanh(filtered * (1 + drive)) / driveNorm : filtered;
    left[dst] = (left[dst] ?? 0) + shaped * level * gainL;
    right[dst] = (right[dst] ?? 0) + shaped * level * gainR;
  }
}
