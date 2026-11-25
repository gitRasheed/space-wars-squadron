import type { InstrumentType } from '../project.js';
import { brassHorn, brassTrumpet } from './brass.js';
import type { Instrument } from './common.js';
import { guitarAcoustic, guitarElectric } from './guitar.js';
import { orchestralPerc, timpani } from './percussion.js';
import { piano } from './piano.js';
import { stringsBass, stringsCello, stringsEnsemble } from './strings.js';
import { cinematicSfx, synthBass, synthPad } from './synth.js';

export const INSTRUMENT_MODELS: Readonly<Record<InstrumentType, Instrument>> = {
  piano,
  'brass-horn': brassHorn,
  'brass-trumpet': brassTrumpet,
  'strings-ensemble': stringsEnsemble,
  'strings-cello': stringsCello,
  'strings-bass': stringsBass,
  'guitar-electric': guitarElectric,
  'guitar-acoustic': guitarAcoustic,
  timpani,
  'orchestral-perc': orchestralPerc,
  'synth-pad': synthPad,
  'synth-bass': synthBass,
  'cinematic-sfx': cinematicSfx,
};

export type { Instrument, NoteEvent } from './common.js';
