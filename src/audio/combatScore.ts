import recipe from './combat-loop.recipe.json';
import { mixVoice, noiseGenerator, stereoBuffer } from './renderVoice';

export const COMBAT_LOOP_SCORE = recipe;

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function renderCombatLoopStereo(sampleRate: number, score = COMBAT_LOOP_SCORE) {
  const beatS = 60 / score.bpm;
  const buffer = stereoBuffer(score.beats * beatS, sampleRate);
  const noise = noiseGenerator(score.seed);
  for (const { voice, notes } of score.tracks) {
    for (const note of notes) {
      const hz = midiToHz(note.midi);
      mixVoice(buffer, sampleRate, voice, {
        startS: note.startBeat * beatS,
        holdS: note.durationBeats * beatS,
        startHz: hz,
        endHz: hz,
        gain: note.velocity * 10 ** (score.masterGainDb / 20),
      }, noise, score.loopWrap);
    }
  }
  return buffer;
}
