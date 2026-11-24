export interface ScoreNote {
  readonly startBeat: number;
  readonly durationBeats: number;
  readonly midi: number;
  readonly velocity: number;
}

export interface ScoreTrack {
  readonly id: string;
  readonly waveform: 'saw' | 'triangle';
  readonly gainDb: number;
  readonly pan: number;
  readonly filterHz: number;
  readonly filterQ: number;
  readonly attackS: number;
  readonly decayS: number;
  readonly sustainLevel: number;
  readonly releaseS: number;
  readonly drive: number;
  readonly notes: readonly ScoreNote[];
}

export interface CombatScore {
  readonly bpm: number;
  readonly beats: number;
  readonly masterGainDb: number;
  readonly loopWrap: boolean;
  readonly tracks: readonly ScoreTrack[];
}

// Mirrors tools/agent-audio/recipes/combat-loop.recipe.json (verified by tests/audio.test.ts).
export const COMBAT_LOOP_SCORE: CombatScore = {
  bpm: 120,
  beats: 8,
  masterGainDb: -6.5,
  loopWrap: true,
  tracks: [
    {
      id: 'pulse-bass',
      waveform: 'saw',
      gainDb: -4.0,
      pan: -0.1,
      filterHz: 680,
      filterQ: 1.2,
      attackS: 0.006,
      decayS: 0.11,
      sustainLevel: 0.35,
      releaseS: 0.06,
      drive: 0.7,
      notes: [
        { startBeat: 0.0, durationBeats: 0.45, midi: 38, velocity: 0.95 },
        { startBeat: 0.5, durationBeats: 0.45, midi: 38, velocity: 0.72 },
        { startBeat: 1.0, durationBeats: 0.45, midi: 38, velocity: 0.85 },
        { startBeat: 1.5, durationBeats: 0.45, midi: 41, velocity: 0.75 },
        { startBeat: 2.0, durationBeats: 0.45, midi: 43, velocity: 0.92 },
        { startBeat: 2.5, durationBeats: 0.45, midi: 43, velocity: 0.72 },
        { startBeat: 3.0, durationBeats: 0.45, midi: 45, velocity: 0.86 },
        { startBeat: 3.5, durationBeats: 0.45, midi: 43, velocity: 0.76 },
        { startBeat: 4.0, durationBeats: 0.45, midi: 38, velocity: 0.95 },
        { startBeat: 4.5, durationBeats: 0.45, midi: 38, velocity: 0.74 },
        { startBeat: 5.0, durationBeats: 0.45, midi: 46, velocity: 0.88 },
        { startBeat: 5.5, durationBeats: 0.45, midi: 45, velocity: 0.78 },
        { startBeat: 6.0, durationBeats: 0.45, midi: 43, velocity: 0.9 },
        { startBeat: 6.5, durationBeats: 0.45, midi: 41, velocity: 0.78 },
        { startBeat: 7.0, durationBeats: 0.45, midi: 40, velocity: 0.88 },
        { startBeat: 7.5, durationBeats: 0.45, midi: 45, velocity: 0.84 },
      ],
    },
    {
      id: 'lead-arp',
      waveform: 'triangle',
      gainDb: -7.5,
      pan: 0.15,
      filterHz: 2600,
      filterQ: 0.9,
      attackS: 0.008,
      decayS: 0.14,
      sustainLevel: 0.28,
      releaseS: 0.09,
      drive: 0,
      notes: [
        { startBeat: 0.0, durationBeats: 0.75, midi: 62, velocity: 0.85 },
        { startBeat: 1.0, durationBeats: 0.75, midi: 65, velocity: 0.8 },
        { startBeat: 2.0, durationBeats: 0.75, midi: 67, velocity: 0.88 },
        { startBeat: 3.0, durationBeats: 0.75, midi: 69, velocity: 0.82 },
        { startBeat: 4.0, durationBeats: 0.75, midi: 62, velocity: 0.86 },
        { startBeat: 5.0, durationBeats: 0.75, midi: 70, velocity: 0.9 },
        { startBeat: 6.0, durationBeats: 0.75, midi: 69, velocity: 0.84 },
        { startBeat: 7.0, durationBeats: 0.75, midi: 67, velocity: 0.8 },
      ],
    },
  ],
};

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function adsrGain(
  t: number,
  noteDurS: number,
  attackS: number,
  decayS: number,
  sustainLevel: number,
  releaseS: number,
): number {
  if (t < 0) return 0;
  if (t < noteDurS) {
    if (attackS > 0 && t < attackS) {
      return t / attackS;
    }
    const afterAttack = t - attackS;
    if (decayS > 0 && afterAttack < decayS) {
      return 1 - (1 - sustainLevel) * (afterAttack / decayS);
    }
    return sustainLevel;
  }
  const relT = t - noteDurS;
  if (releaseS <= 0 || relT >= releaseS) return 0;
  let endAmp = sustainLevel;
  if (attackS > 0 && noteDurS < attackS) {
    endAmp = noteDurS / attackS;
  } else if (decayS > 0 && noteDurS - attackS < decayS) {
    endAmp = 1 - (1 - sustainLevel) * ((noteDurS - attackS) / decayS);
  }
  return endAmp * (1 - relT / releaseS);
}

export function renderCombatLoopStereo(
  sampleRate: number,
  score: CombatScore = COMBAT_LOOP_SCORE,
): { readonly left: Float32Array; readonly right: Float32Array } {
  const beatS = 60 / score.bpm;
  const loopDurationS = score.beats * beatS;
  const totalFrames = Math.max(1, Math.round(loopDurationS * sampleRate));
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);
  const masterLin = dbToLinear(score.masterGainDb);

  for (const track of score.tracks) {
    const trackLin = dbToLinear(track.gainDb) * masterLin;
    const panAngle = ((track.pan + 1) * 0.25) * Math.PI;
    const gainL = Math.cos(panAngle) * trackLin;
    const gainR = Math.sin(panAngle) * trackLin;

    // RBJ 2-pole lowpass coefficients.
    const w0 = (2 * Math.PI * Math.min(track.filterHz, sampleRate * 0.45)) / sampleRate;
    const cosW0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.max(0.1, track.filterQ));
    const a0 = 1 + alpha;
    const b0 = ((1 - cosW0) * 0.5) / a0;
    const b1 = (1 - cosW0) / a0;
    const b2 = b0;
    const a1 = (-2 * cosW0) / a0;
    const a2 = (1 - alpha) / a0;

    for (const note of track.notes) {
      const startFrame = Math.round(note.startBeat * beatS * sampleRate);
      const noteDurS = note.durationBeats * beatS;
      const noteTotalFrames = Math.ceil((noteDurS + track.releaseS) * sampleRate);
      const freq = midiToHz(note.midi);
      const phaseInc = freq / sampleRate;
      let phase = 0;
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;

      for (let i = 0; i < noteTotalFrames; i += 1) {
        const t = i / sampleRate;
        const env = adsrGain(
          t,
          noteDurS,
          track.attackS,
          track.decayS,
          track.sustainLevel,
          track.releaseS,
        );
        const osc =
          track.waveform === 'saw'
            ? 2 * phase - 1
            : 1 - 4 * Math.abs(phase - 0.5);
        phase += phaseInc;
        if (phase >= 1) phase -= 1;

        const filtered = b0 * osc + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = osc;
        y2 = y1;
        y1 = filtered;

        let sample = filtered * env * note.velocity;
        if (track.drive > 0) {
          sample = Math.tanh(sample * (1 + track.drive)) / Math.tanh(1 + track.drive);
        }

        const dstRaw = startFrame + i;
        if (!score.loopWrap && dstRaw >= totalFrames) {
          break;
        }
        const dst = ((dstRaw % totalFrames) + totalFrames) % totalFrames;
        left[dst] = (left[dst] ?? 0) + sample * gainL;
        right[dst] = (right[dst] ?? 0) + sample * gainR;
      }
    }
  }

  return { left, right };
}
