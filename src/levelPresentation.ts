import type { SoundtrackId } from './audio/bakedSoundtrack';
import type { BiomeId } from './render/palette';
import type { LevelId } from './sim/types';

export interface LevelPresentation {
  readonly title: string;
  readonly objective: string;
  readonly biome: BiomeId;
  readonly soundtrack: SoundtrackId;
}

export const MISSION_ORDER: readonly LevelId[] = ['saturn', 'trench', 'planetary'];

/** How each mission is briefed, looks and sounds; the briefing card, biome and score all read this one table. */
export const LEVEL_PRESENTATION: Readonly<Record<LevelId, LevelPresentation>> = {
  saturn: {
    title: 'SATURN ORBIT',
    objective: 'Defend Hearthstone. Destroy the raiders and both frigate cores.',
    biome: 'saturnOrbit',
    soundtrack: 'saturn-orbit',
  },
  trench: {
    title: 'MEGASTRUCTURE TRENCH',
    objective: 'Fly into the spine and destroy its three conduit cores.',
    biome: 'megastructureTrench',
    soundtrack: 'megastructure-trench',
  },
  planetary: {
    title: 'SUNSET GROUND SUPPORT',
    objective: 'Break the siege on the canyon road, then win the sky.',
    biome: 'sunsetGroundSupport',
    soundtrack: 'sunset-ground-support',
  },
};
