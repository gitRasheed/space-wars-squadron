export interface ScoreNote {
  readonly startBeat: number;
  readonly durationBeats: number;
  readonly midi: number;
  readonly velocity: number;
}

export interface ScoreTrack {
  readonly id: string;
  readonly waveform: OscillatorType;
  readonly gain: number;
  readonly filterHz: number;
  readonly filterQ: number;
  readonly attackS: number;
  readonly releaseS: number;
  readonly notes: readonly ScoreNote[];
}

export interface CombatScore {
  readonly bpm: number;
  readonly beats: number;
  readonly tracks: readonly ScoreTrack[];
}

// Mirrors tools/agent-audio/recipes/combat-loop.recipe.json (120 BPM, 8-beat D-minor loop).
export const COMBAT_LOOP_SCORE: CombatScore = {
  bpm: 120,
  beats: 8,
  tracks: [
    {
      id: 'pulse-bass',
      waveform: 'sawtooth',
      gain: 0.085,
      filterHz: 680,
      filterQ: 1.2,
      attackS: 0.006,
      releaseS: 0.06,
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
      gain: 0.065,
      filterHz: 2600,
      filterQ: 0.9,
      attackS: 0.008,
      releaseS: 0.09,
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
