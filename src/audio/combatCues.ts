import combatCues from './combat-cues.json';
import gameCues from './game-cues.json';
import { mixVoice, noiseGenerator, stereoBuffer } from './renderVoice';

// combat-cues.json mirrors the standalone agent-audio recipes one for one; game-cues.json holds cues that live only here.
const cues = { ...combatCues, ...gameCues };

export type CueId = Exclude<keyof typeof cues, 'engine-runup'>;
export const engineRunup = cues['engine-runup'];
export const CUE_IDS = Object.keys(cues).filter((id): id is CueId => id !== 'engine-runup');

export function renderCue(id: CueId, sampleRate: number) {
  const cue = cues[id];
  const buffer = stereoBuffer(cue.durationS, sampleRate);
  const noise = noiseGenerator(0x51a7c0de);
  for (const voice of cue.voices) {
    mixVoice(buffer, sampleRate, voice, {
      startS: voice.startS,
      holdS: voice.durationS,
      startHz: voice.freqStartHz ?? 220,
      endHz: voice.freqEndHz ?? 220,
      gain: 10 ** (cue.masterGainDb / 20),
    }, noise, false);
  }
  return buffer;
}
