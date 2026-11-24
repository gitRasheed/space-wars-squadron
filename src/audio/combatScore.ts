import recipe from './combat-loop.recipe.json';
import { mixVoice, noiseGenerator, stereoBuffer } from './renderVoice';

export const COMBAT_LOOP_SCORE = recipe;

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Renders the score a few milliseconds at a time so a long loop never stalls a frame. */
export function combatLoopRenderer(sampleRate: number, score = COMBAT_LOOP_SCORE) {
  const beatS = 60 / score.bpm;
  const buffer = stereoBuffer(score.beats * beatS, sampleRate);
  const noise = noiseGenerator(score.seed);
  const masterGain = 10 ** (score.masterGainDb / 20);
  const events = score.tracks.flatMap(({ voice, notes }) => notes.map(note => ({ voice, note })));
  let next = 0;
  /** Mixes the next notes for about `budgetMs` and reports whether the loop is complete. */
  function advance(budgetMs: number): boolean {
    const deadline = performance.now() + budgetMs;
    for (let event = events[next]; event; event = events[next]) {
      const hz = midiToHz(event.note.midi);
      mixVoice(buffer, sampleRate, event.voice, {
        startS: event.note.startBeat * beatS,
        holdS: event.note.durationBeats * beatS,
        startHz: hz,
        endHz: hz,
        gain: event.note.velocity * masterGain,
      }, noise, score.loopWrap);
      next++;
      if (performance.now() >= deadline) break;
    }
    return next === events.length;
  }
  return { buffer, advance };
}

export function renderCombatLoopStereo(sampleRate: number, score = COMBAT_LOOP_SCORE) {
  const { buffer, advance } = combatLoopRenderer(sampleRate, score);
  advance(Infinity);
  return buffer;
}
