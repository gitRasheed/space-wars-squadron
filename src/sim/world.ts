import { stepCombat } from './combat';
import { createInitialEnergy } from './energy';
import { stepPlayerFlight } from './flight';
import { IDENTITY_QUAT, quatLookAt, vec3 } from './math';
import { applyTerrainToPlayer, burstFlak, GROUND_SPEAKER, OUTPOST_LOST_REASON, remainingPlanetaryHostiles, stepGroundBattle } from './planetary';
import { segmentTerrainEntry } from './planetaryLayout';
import { SHIP_STATS } from './ships';
import type {
  AsteroidState,
  CapitalShipState,
  EnemyKind,
  EnemyShipState,
  FlightInput,
  PlayerShipState,
  SimEvent,
  SortieConfig,
  SortiePhase,
  WingmateState,
  WorldState,
} from './types';
import { FIXED_DT } from './types';

function createFriendlyCarrier(): CapitalShipState {
  return {
    id: 'carrier-hearthstone',
    name: 'HMV-09 HEARTHSTONE',
    faction: 'friendly',
    position: vec3(-165, -24, -180),
    orientation: IDENTITY_QUAT,
    halfExtents: vec3(44, 26, 155),
    hull: 750,
    maxHull: 750,
    subsystems: [],
  };
}

export const FRIGATE_SUBSYSTEM_LAYOUT = {
  shieldDome: {
    id: 'sub-shield-dome',
    label: 'SHIELD DOME',
    localOffset: vec3(0, 31, -30),
    // Visible dome mesh radius; sim adds a small hit tolerance.
    radius: 12.5,
    maxHull: 180,
  },
  clampCore: {
    id: 'sub-clamp-core',
    label: 'TOW CLAMP',
    localOffset: vec3(0, -28, 62),
    radius: 13.5,
    maxHull: 180,
  },
} as const;

function createHostileFrigate(): CapitalShipState {
  return {
    id: 'frigate-aegis',
    name: 'CONCESSION FRIGATE',
    faction: 'hostile',
    position: vec3(240, 24, -780),
    orientation: quatLookAt(vec3(-0.88, -0.06, 0.47)),
    halfExtents: vec3(34, 22, 128),
    hull: 1000,
    maxHull: 1000,
    subsystems: [
      {
        id: FRIGATE_SUBSYSTEM_LAYOUT.shieldDome.id,
        label: FRIGATE_SUBSYSTEM_LAYOUT.shieldDome.label,
        localOffset: FRIGATE_SUBSYSTEM_LAYOUT.shieldDome.localOffset,
        radius: FRIGATE_SUBSYSTEM_LAYOUT.shieldDome.radius,
        hull: FRIGATE_SUBSYSTEM_LAYOUT.shieldDome.maxHull,
        maxHull: FRIGATE_SUBSYSTEM_LAYOUT.shieldDome.maxHull,
      },
      {
        id: FRIGATE_SUBSYSTEM_LAYOUT.clampCore.id,
        label: FRIGATE_SUBSYSTEM_LAYOUT.clampCore.label,
        localOffset: FRIGATE_SUBSYSTEM_LAYOUT.clampCore.localOffset,
        radius: FRIGATE_SUBSYSTEM_LAYOUT.clampCore.radius,
        hull: FRIGATE_SUBSYSTEM_LAYOUT.clampCore.maxHull,
        maxHull: FRIGATE_SUBSYSTEM_LAYOUT.clampCore.maxHull,
      },
    ],
  };
}

function createRingAsteroids(): readonly AsteroidState[] {
  return [
    { id: 'ast-1', position: vec3(285, -96, -210), radius: 28, rotation: vec3(0.4, 1.1, 0.2), hull: 60, tint: 'ochre' },
    { id: 'ast-2', position: vec3(-340, 115, -420), radius: 38, rotation: vec3(1.2, 0.3, 0.7), hull: 80, tint: 'ice' },
    { id: 'ast-3', position: vec3(185, 165, -360), radius: 24, rotation: vec3(0.8, 2.0, 0.5), hull: 55, tint: 'ice' },
    { id: 'ast-4', position: vec3(-135, -148, -510), radius: 34, rotation: vec3(0.2, 0.9, 1.4), hull: 75, tint: 'slate' },
    { id: 'ast-5', position: vec3(470, 82, -520), radius: 46, rotation: vec3(1.7, 0.6, 0.3), hull: 95, tint: 'ochre' },
    { id: 'ast-6', position: vec3(-420, -45, -120), radius: 32, rotation: vec3(0.5, 1.8, 0.9), hull: 70, tint: 'slate' },
    { id: 'ast-7', position: vec3(40, -135, -920), radius: 52, rotation: vec3(0.9, 0.4, 1.1), hull: 110, tint: 'ice' },
    { id: 'ast-8', position: vec3(410, -125, -880), radius: 36, rotation: vec3(1.4, 2.2, 0.4), hull: 80, tint: 'slate' },
    { id: 'ast-9', position: vec3(-290, 155, -760), radius: 44, rotation: vec3(0.3, 1.5, 0.8), hull: 90, tint: 'ochre' },
    { id: 'ast-10', position: vec3(310, 138, -90), radius: 24, rotation: vec3(1.1, 0.7, 1.9), hull: 55, tint: 'ice' },
  ];
}

function enemyDurability(kind: EnemyKind): Pick<EnemyShipState, 'hull' | 'maxHull' | 'shields' | 'maxShields'> {
  const stats = SHIP_STATS.enemies[kind];
  return { hull: stats.hull, maxHull: stats.hull, shields: stats.shields, maxShields: stats.shields };
}

function createInitialEnemies(): readonly EnemyShipState[] {
  return [
    {
      id: 'raider-1',
      callsign: 'VANE-1',
      kind: 'raider',
      position: vec3(68, 20, -445),
      velocity: vec3(-18, -2, 68),
      orientation: quatLookAt(vec3(-0.25, -0.05, 0.96)),
      maneuver: { kind: 'approach', remainingSeconds: 6.0 },
      ...enemyDurability('raider'),
      shieldRegenDelay: 0,
      shieldHitFlash: 0,
      fireCooldown: 1.1,
      phaseOffset: 0.4,
    },
    {
      id: 'raider-2',
      callsign: 'VANE-2',
      kind: 'raider',
      position: vec3(-115, 48, -560),
      velocity: vec3(24, -6, 62),
      orientation: quatLookAt(vec3(0.35, -0.1, 0.93)),
      maneuver: { kind: 'approach', remainingSeconds: 6.5 },
      ...enemyDurability('raider'),
      shieldRegenDelay: 0,
      shieldHitFlash: 0,
      fireCooldown: 1.4,
      phaseOffset: 2.1,
    },
    {
      id: 'raider-3',
      callsign: 'VANE-3',
      kind: 'raider',
      position: vec3(210, -16, -640),
      velocity: vec3(-32, 8, 56),
      orientation: quatLookAt(vec3(-0.48, 0.14, 0.86)),
      maneuver: { kind: 'approach', remainingSeconds: 7.0 },
      ...enemyDurability('raider'),
      shieldRegenDelay: 0,
      shieldHitFlash: 0,
      fireCooldown: 1.7,
      phaseOffset: 4.0,
    },
    {
      id: 'striker-1',
      callsign: 'STRIKER-4',
      kind: 'striker',
      position: vec3(75, 58, -720),
      velocity: vec3(-22, -6, 54),
      orientation: quatLookAt(vec3(-0.35, -0.08, 0.93)),
      maneuver: { kind: 'approach', remainingSeconds: 7.5 },
      ...enemyDurability('striker'),
      shieldRegenDelay: 0,
      shieldHitFlash: 0,
      fireCooldown: 1.5,
      phaseOffset: 5.3,
    },
  ];
}

function createInitialPlayer(): PlayerShipState {
  return {
    position: vec3(0, 4, 140),
    velocity: vec3(0, 0, -64),
    orientation: IDENTITY_QUAT,
    angularVelocity: vec3(0, 0, 0),
    throttle: 0.6,
    hull: SHIP_STATS.player.hull,
    maxHull: SHIP_STATS.player.hull,
    energy: createInitialEnergy(),
    primaryCooldown: 0,
    missileCooldown: 0,
    missilesReady: 4,
    maxMissiles: 4,
    missileRearmTimer: 0,
    selectedTargetId: 'raider-1',
    targetPinned: false,
    lockState: { kind: 'none' },
    missileTriggerHeld: false,
    critPity: 0,
    dropPity: 0,
    nearMissCooldown: 0,
    proximityWarning: false,
    hitFlash: 0,
    recoilKick: 0,
    nextBarrel: 'left',
    recoilLeft: 0,
    recoilRight: 0,
  };
}

function createInitialWingmate(): WingmateState {
  return {
    callsign: 'VALKYRIE-2',
    position: vec3(-32, 10, 162),
    velocity: vec3(0, 0, -64),
    orientation: IDENTITY_QUAT,
    targetId: 'raider-2',
    fireCooldown: 0.8,
  };
}

export const DEFAULT_SORTIE_CONFIG: SortieConfig = {
  id: 'sortie-01-hearthstone',
  openingRadio: {
    speaker: 'VALKYRIE-2',
    text: 'Shielded raiders inbound on Hearthstone—watch your heat, cleared hot!',
    remainingSeconds: 4.5,
  },
  player: createInitialPlayer(),
  wingmate: createInitialWingmate(),
  enemies: createInitialEnemies(),
  friendlyCarrier: createFriendlyCarrier(),
  hostileFrigate: createHostileFrigate(),
  asteroids: createRingAsteroids(),
};

export function createInitialWorld(
  seed: number,
  startActive = false,
  config: SortieConfig = DEFAULT_SORTIE_CONFIG,
): WorldState {
  return {
    tick: 0,
    rngState: seed,
    sortie: config,
    phase: startActive ? { kind: 'active', elapsedSeconds: 0 } : { kind: 'briefing' },
    cameraMode: 'cockpit',
    player: config.player,
    wingmate: config.wingmate,
    enemies: config.enemies,
    friendlyCarrier: config.friendlyCarrier,
    hostileFrigate: config.hostileFrigate,
    asteroids: config.asteroids,
    projectiles: [],
    explosions: [],
    radio: config.openingRadio,
    enemiesDestroyed: 0,
    subsystemsDestroyed: 0,
    planetary: config.planetary ?? null,
    events: [],
  };
}

function evaluatePhase(
  currentPhase: SortiePhase,
  playerHull: number,
  carrierHull: number,
  carrierLostReason: string,
  remainingEnemies: number,
  remainingSubsystems: number,
  enemiesDestroyed: number,
  subsystemsDestroyed: number,
  dt: number,
): SortiePhase {
  if (currentPhase.kind !== 'active') {
    return currentPhase;
  }
  const elapsedSeconds = currentPhase.elapsedSeconds + dt;
  if (playerHull <= 0) {
    return { kind: 'failed', elapsedSeconds, reason: 'FIGHTER DESTROYED' };
  }
  if (carrierHull <= 0) {
    return { kind: 'failed', elapsedSeconds, reason: carrierLostReason };
  }
  if (remainingEnemies === 0 && remainingSubsystems === 0) {
    return {
      kind: 'victory',
      elapsedSeconds,
      enemiesDestroyed,
      subsystemsDestroyed,
    };
  }
  return { kind: 'active', elapsedSeconds };
}

export function stepWorld(
  world: WorldState,
  input: FlightInput,
  dt: number,
): WorldState {
  if (world.phase.kind === 'briefing') {
    if (input.launchBriefing || input.restartSortie) {
      return {
        ...world,
        phase: { kind: 'active', elapsedSeconds: 0 },
        events: [],
      };
    }
    return { ...world, events: [] };
  }

  if (world.phase.kind === 'paused') {
    if (input.restartSortie) {
      return createInitialWorld(world.rngState, true, world.sortie);
    }
    if (!input.pauseRequested && (input.togglePause || input.launchBriefing)) {
      return {
        ...world,
        phase: { kind: 'active', elapsedSeconds: world.phase.elapsedSeconds },
        events: [],
      };
    }
    return { ...world, events: [] };
  }

  if (world.phase.kind === 'victory' || world.phase.kind === 'failed') {
    if (input.launchBriefing || input.restartSortie) {
      return createInitialWorld(world.rngState, true, world.sortie);
    }
    return { ...world, events: [] };
  }

  if (input.restartSortie) {
    return createInitialWorld(world.rngState, true, world.sortie);
  }

  if (input.pauseRequested || input.togglePause) {
    return {
      ...world,
      phase: { kind: 'paused', elapsedSeconds: world.phase.elapsedSeconds },
      events: [],
    };
  }

  const flightStep = stepPlayerFlight(
    world.player,
    input,
    [world.friendlyCarrier, world.hostileFrigate],
    world.asteroids,
    dt,
  );
  const planetary = world.planetary;
  const tick = world.tick + 1;
  let player = flightStep.player;
  let projectiles = world.projectiles;
  let explosions = world.explosions;
  const preEvents: SimEvent[] = [...flightStep.events];
  let terrainWarning = false;
  if (planetary !== null) {
    const terrain = applyTerrainToPlayer(player);
    terrainWarning = terrain.warning;
    preEvents.push(...terrain.events);
    const flak = burstFlak(tick, projectiles, terrain.player, dt);
    player = flak.player;
    projectiles = flak.projectiles;
    explosions = [...explosions, ...flak.explosions];
    preEvents.push(...flak.events);
  }

  const combatStep = stepCombat({
    tick,
    rngState: world.rngState,
    player,
    wingmate: world.wingmate,
    enemies: world.enemies,
    friendlyCarrier: world.friendlyCarrier,
    hostileFrigate: world.hostileFrigate,
    asteroids: world.asteroids,
    projectiles,
    explosions,
    radio: world.radio,
    input,
    dt,
    ...(planetary === null
      ? {}
      : { groundTargets: planetary.groundTargets, terrainEntry: segmentTerrainEntry, groundSpeaker: GROUND_SPEAKER }),
  });

  const battle =
    planetary === null
      ? null
      : stepGroundBattle({
          tick,
          planetary,
          groundTargets: combatStep.groundTargets,
          groundTargetsDestroyedDelta: combatStep.groundTargetsDestroyedDelta,
          terrainWarning,
          player: combatStep.player,
          wingmate: combatStep.wingmate,
          enemies: combatStep.enemies,
          outpost: combatStep.friendlyCarrier,
          radio: combatStep.radio,
          dt,
        });

  const enemies = battle?.enemies ?? combatStep.enemies;
  const enemiesDestroyed = world.enemiesDestroyed + combatStep.enemiesDestroyedDelta;
  const subsystemsDestroyed = world.subsystemsDestroyed + combatStep.subsystemsDestroyedDelta;
  const remainingSubsystems = combatStep.hostileFrigate.subsystems.filter((s) => s.hull > 0).length;

  const phase = evaluatePhase(
    world.phase,
    combatStep.player.hull,
    combatStep.friendlyCarrier.hull,
    planetary === null ? 'CARRIER HEARTHSTONE LOST' : OUTPOST_LOST_REASON,
    battle === null ? enemies.length : remainingPlanetaryHostiles(battle.planetary, enemies),
    remainingSubsystems,
    enemiesDestroyed,
    battle === null ? subsystemsDestroyed : battle.planetary.groundTargetsDestroyed,
    dt,
  );

  return {
    tick,
    rngState: combatStep.rngState,
    sortie: world.sortie,
    phase,
    cameraMode: 'cockpit',
    player: combatStep.player,
    wingmate: battle?.wingmate ?? combatStep.wingmate,
    enemies,
    friendlyCarrier: combatStep.friendlyCarrier,
    hostileFrigate: combatStep.hostileFrigate,
    asteroids: combatStep.asteroids,
    projectiles: battle === null ? combatStep.projectiles : [...combatStep.projectiles, ...battle.spawned],
    explosions: combatStep.explosions,
    radio: battle?.radio ?? combatStep.radio,
    enemiesDestroyed,
    subsystemsDestroyed,
    planetary: battle?.planetary ?? null,
    events: [...preEvents, ...combatStep.events, ...(battle?.events ?? [])],
  };
}

/**
 * Advances `steps` fixed ticks and collects every tick's events, so a frame that runs several
 * ticks hands its renderer and HUD all of them rather than only the last tick's.
 */
export function stepFrame(
  world: WorldState,
  steps: number,
  sampleInput: () => FlightInput,
  onTick: (before: WorldState, after: WorldState, input: FlightInput) => void,
): { readonly world: WorldState; readonly frameEvents: readonly SimEvent[] } {
  let current = world;
  const frameEvents: SimEvent[] = [];
  for (let i = 0; i < steps; i += 1) {
    const input = sampleInput();
    const next = stepWorld(current, input, FIXED_DT);
    onTick(current, next, input);
    frameEvents.push(...next.events);
    current = next;
  }
  return { world: current, frameEvents };
}
