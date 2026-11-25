import { createGroundTargets, createOutpost, GROUND_SPEAKER, spawnAirWave } from './planetary';
import { GROUND_TARGET_PLACEMENTS, PLANETARY_TUNING, PLAYER_START, WINGMATE_START } from './planetaryLayout';
import { IDENTITY_QUAT, normalize, quatLookAt, scale, vec3 } from './math';
import type { CapitalShipState, SortieConfig } from './types';
import { DEFAULT_SORTIE_CONFIG } from './world';

export type MissionId = 'saturn' | 'planetary';

export interface MissionInfo {
  readonly id: MissionId;
  readonly key: string;
  readonly title: string;
  readonly objective: string;
}

export const MISSIONS: readonly MissionInfo[] = [
  { id: 'saturn', key: '1', title: 'SATURN ORBIT', objective: 'Defend Hearthstone. Destroy the raiders and both frigate cores.' },
  {
    id: 'planetary',
    key: '2',
    title: 'SUNSET GROUND SUPPORT',
    objective: 'Break the siege on the canyon road, then win the sky.',
  },
];

export const PLANETARY_SORTIE_ID = 'sortie-03-sunset-cas';

// Planetary sorties have no frigate; it waits far below the canyon with nothing to target.
const NO_FRIGATE: CapitalShipState = {
  id: 'frigate-none',
  name: 'NONE',
  faction: 'hostile',
  position: vec3(0, -6000, 0),
  orientation: IDENTITY_QUAT,
  halfExtents: vec3(1, 1, 1),
  hull: 1,
  maxHull: 1,
  subsystems: [],
};

export interface PlanetaryOptions {
  /** Boots straight into stage 2 with half the ground targets already down, for screenshots and tests. */
  readonly airWave?: boolean;
}

export function createPlanetarySortieConfig(options: PlanetaryOptions = {}): SortieConfig {
  const airWave = options.airWave ?? false;
  const destroyed = new Set(
    airWave ? GROUND_TARGET_PLACEMENTS.slice(0, PLANETARY_TUNING.airWaveThreshold).map((p) => p.id) : [],
  );
  const groundTargets = createGroundTargets(destroyed);
  // The scramble preset starts in a gentle climb toward the diving wave.
  const heading = airWave ? normalize(vec3(0, 0.27, -1)) : vec3(0, 0, -1);
  const velocity = scale(heading, PLAYER_START.speed);
  return {
    id: PLANETARY_SORTIE_ID,
    openingRadio: airWave
      ? { speaker: 'OVERWATCH', text: 'SCRAMBLE! Bandits diving through the cloud deck. Break and engage!', remainingSeconds: 4.5 }
      : { speaker: GROUND_SPEAKER, text: 'Valkyrie, we are pinned in the canyon! Burn the flak and walkers off that road!', remainingSeconds: 5 },
    player: {
      ...DEFAULT_SORTIE_CONFIG.player,
      position: PLAYER_START.position,
      velocity,
      orientation: quatLookAt(heading),
      selectedTargetId: groundTargets.find((t) => t.hull > 0)?.id ?? null,
    },
    wingmate: { ...DEFAULT_SORTIE_CONFIG.wingmate, position: WINGMATE_START, velocity, orientation: quatLookAt(heading), targetId: null },
    enemies: airWave ? spawnAirWave() : [],
    friendlyCarrier: createOutpost(),
    hostileFrigate: NO_FRIGATE,
    asteroids: [],
    planetary: {
      stage: airWave ? { kind: 'air_superiority', elapsedSeconds: 0 } : { kind: 'ground_attack' },
      groundTargets,
      groundTargetsDestroyed: destroyed.size,
      convoyAdvance: 0,
      terrainWarning: false,
    },
  };
}

export function createMissionConfig(mission: MissionId, options: PlanetaryOptions = {}): SortieConfig {
  return mission === 'planetary' ? createPlanetarySortieConfig(options) : DEFAULT_SORTIE_CONFIG;
}
