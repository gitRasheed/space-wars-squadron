import { stepCombat } from './combat';
import { createInitialEnergy } from './energy';
import { stepPlayerFlight } from './flight';
import { IDENTITY_QUAT, quatLookAt, vec3 } from './math';
import type {
  AsteroidState,
  CapitalShipState,
  EnemyShipState,
  FlightInput,
  PlayerShipState,
  SortiePhase,
  WingmateState,
  WorldState,
} from './types';

function createFriendlyCarrier(): CapitalShipState {
  return {
    id: 'carrier-hearthstone',
    name: 'HMV-09 HEARTHSTONE',
    faction: 'friendly',
    position: vec3(-165, -24, -180),
    orientation: IDENTITY_QUAT,
    halfExtents: vec3(44, 26, 155),
    hull: 1000,
    maxHull: 1000,
    subsystems: [],
  };
}

function createHostileFrigate(): CapitalShipState {
  return {
    id: 'frigate-aegis',
    name: 'CONCESSION FRIGATE',
    faction: 'hostile',
    position: vec3(240, 24, -740),
    orientation: quatLookAt(vec3(-0.88, -0.06, 0.47)),
    halfExtents: vec3(34, 22, 128),
    hull: 1000,
    maxHull: 1000,
    subsystems: [
      {
        id: 'sub-shield-dome',
        label: 'SHIELD DOME',
        localOffset: vec3(0, 28, -32),
        radius: 16,
        hull: 140,
        maxHull: 140,
      },
      {
        id: 'sub-clamp-core',
        label: 'TOW CLAMP',
        localOffset: vec3(0, -20, 62),
        radius: 16,
        hull: 140,
        maxHull: 140,
      },
    ],
  };
}

function createRingAsteroids(): readonly AsteroidState[] {
  return [
    { id: 'ast-1', position: vec3(285, -96, -210), radius: 28, rotation: vec3(0.4, 1.1, 0.2), tint: 'ochre' },
    { id: 'ast-2', position: vec3(-340, 115, -420), radius: 38, rotation: vec3(1.2, 0.3, 0.7), tint: 'ice' },
    { id: 'ast-3', position: vec3(185, 165, -360), radius: 24, rotation: vec3(0.8, 2.0, 0.5), tint: 'ice' },
    { id: 'ast-4', position: vec3(-135, -148, -510), radius: 34, rotation: vec3(0.2, 0.9, 1.4), tint: 'slate' },
    { id: 'ast-5', position: vec3(470, 82, -520), radius: 46, rotation: vec3(1.7, 0.6, 0.3), tint: 'ochre' },
    { id: 'ast-6', position: vec3(-420, -45, -120), radius: 32, rotation: vec3(0.5, 1.8, 0.9), tint: 'slate' },
    { id: 'ast-7', position: vec3(40, -135, -920), radius: 52, rotation: vec3(0.9, 0.4, 1.1), tint: 'ice' },
    { id: 'ast-8', position: vec3(410, -125, -880), radius: 36, rotation: vec3(1.4, 2.2, 0.4), tint: 'slate' },
    { id: 'ast-9', position: vec3(-290, 155, -760), radius: 44, rotation: vec3(0.3, 1.5, 0.8), tint: 'ochre' },
    { id: 'ast-10', position: vec3(310, 138, -90), radius: 24, rotation: vec3(1.1, 0.7, 1.9), tint: 'ice' },
  ];
}

function createInitialEnemies(): readonly EnemyShipState[] {
  return [
    {
      id: 'raider-1',
      callsign: 'VANE-1',
      kind: 'raider',
      position: vec3(55, 16, -295),
      velocity: vec3(-18, -2, 65),
      orientation: quatLookAt(vec3(-0.3, -0.05, 0.95)),
      maneuver: { kind: 'approach', remainingSeconds: 3.8 },
      hull: 60,
      maxHull: 60,
      shields: 0,
      maxShields: 0,
      fireCooldown: 1.5,
      phaseOffset: 0.4,
    },
    {
      id: 'raider-2',
      callsign: 'VANE-2',
      kind: 'raider',
      position: vec3(-95, 42, -450),
      velocity: vec3(24, -6, 60),
      orientation: quatLookAt(vec3(0.35, -0.1, 0.93)),
      maneuver: { kind: 'approach', remainingSeconds: 4.6 },
      hull: 60,
      maxHull: 60,
      shields: 0,
      maxShields: 0,
      fireCooldown: 2.0,
      phaseOffset: 2.1,
    },
    {
      id: 'raider-3',
      callsign: 'VANE-3',
      kind: 'raider',
      position: vec3(185, -12, -510),
      velocity: vec3(-32, 8, 52),
      orientation: quatLookAt(vec3(-0.5, 0.15, 0.85)),
      maneuver: { kind: 'approach', remainingSeconds: 5.2 },
      hull: 60,
      maxHull: 60,
      shields: 0,
      maxShields: 0,
      fireCooldown: 2.4,
      phaseOffset: 4.0,
    },
    {
      id: 'striker-1',
      callsign: 'STRIKER-4',
      kind: 'striker',
      position: vec3(80, 62, -630),
      velocity: vec3(-12, -4, 48),
      orientation: quatLookAt(vec3(-0.2, -0.05, 0.98)),
      maneuver: { kind: 'approach', remainingSeconds: 5.5 },
      hull: 100,
      maxHull: 100,
      shields: 48,
      maxShields: 48,
      fireCooldown: 2.2,
      phaseOffset: 5.3,
    },
  ];
}

function createInitialPlayer(): PlayerShipState {
  return {
    position: vec3(0, 4, 140),
    velocity: vec3(0, 0, -58),
    orientation: IDENTITY_QUAT,
    angularVelocity: vec3(0, 0, 0),
    throttle: 0.55,
    speed: 58,
    hull: 100,
    maxHull: 100,
    energy: createInitialEnergy(),
    primaryCooldown: 0,
    missileCooldown: 0,
    missilesReady: 4,
    maxMissiles: 4,
    missileRearmTimer: 0,
    selectedTargetId: 'raider-1',
    lockState: { kind: 'none' },
    proximityWarning: false,
    hitFlash: 0,
    recoilKick: 0,
  };
}

function createInitialWingmate(): WingmateState {
  return {
    callsign: 'VALKYRIE-2',
    position: vec3(-32, 10, 162),
    velocity: vec3(0, 0, -58),
    orientation: IDENTITY_QUAT,
    targetId: 'raider-2',
    fireCooldown: 0.5,
  };
}

export function createInitialWorld(seed: number, startActive = false): WorldState {
  return {
    tick: 0,
    rngState: seed,
    phase: startActive ? { kind: 'active', elapsedSeconds: 0 } : { kind: 'briefing' },
    cameraMode: 'cockpit',
    player: createInitialPlayer(),
    wingmate: createInitialWingmate(),
    enemies: createInitialEnemies(),
    friendlyCarrier: createFriendlyCarrier(),
    hostileFrigate: createHostileFrigate(),
    asteroids: createRingAsteroids(),
    projectiles: [],
    explosions: [],
    radio: {
      speaker: 'VALKYRIE-2',
      text: 'Raiders inbound on Hearthstone—I have your flank, cleared hot!',
      remainingSeconds: 4.5,
    },
    enemiesDestroyed: 0,
    subsystemsDestroyed: 0,
    events: [],
  };
}

function evaluatePhase(
  currentPhase: SortiePhase,
  playerHull: number,
  carrierHull: number,
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
    return { kind: 'failed', elapsedSeconds, reason: 'CARRIER HEARTHSTONE LOST' };
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

export function stepWorld(world: WorldState, input: FlightInput, dt: number): WorldState {
  const cameraMode = input.toggleCamera
    ? world.cameraMode === 'cockpit'
      ? 'chase'
      : 'cockpit'
    : world.cameraMode;

  if (world.phase.kind === 'briefing') {
    if (input.launchBriefing || input.restartSortie) {
      return {
        ...world,
        cameraMode,
        phase: { kind: 'active', elapsedSeconds: 0 },
        events: [],
      };
    }
    return { ...world, cameraMode, events: [] };
  }

  if (world.phase.kind === 'victory' || world.phase.kind === 'failed') {
    if (input.launchBriefing || input.restartSortie) {
      return {
        ...createInitialWorld(world.rngState, true),
        cameraMode,
      };
    }
    return { ...world, cameraMode, events: [] };
  }

  if (input.restartSortie) {
    return {
      ...createInitialWorld(world.rngState, true),
      cameraMode,
    };
  }

  const flightStep = stepPlayerFlight(
    world.player,
    input,
    [world.friendlyCarrier, world.hostileFrigate],
    world.asteroids,
    dt,
  );
  const combatStep = stepCombat(
    world.tick + 1,
    world.rngState,
    flightStep.player,
    world.wingmate,
    world.enemies,
    world.friendlyCarrier,
    world.hostileFrigate,
    world.projectiles,
    world.explosions,
    world.radio,
    input,
    dt,
  );

  const enemiesDestroyed = world.enemiesDestroyed + combatStep.enemiesDestroyedDelta;
  const subsystemsDestroyed = world.subsystemsDestroyed + combatStep.subsystemsDestroyedDelta;
  const remainingSubsystems = combatStep.hostileFrigate.subsystems.filter((s) => s.hull > 0).length;

  const phase = evaluatePhase(
    world.phase,
    combatStep.player.hull,
    combatStep.friendlyCarrier.hull,
    combatStep.enemies.length,
    remainingSubsystems,
    enemiesDestroyed,
    subsystemsDestroyed,
    dt,
  );

  return {
    tick: world.tick + 1,
    rngState: combatStep.rngState,
    phase,
    cameraMode,
    player: combatStep.player,
    wingmate: combatStep.wingmate,
    enemies: combatStep.enemies,
    friendlyCarrier: combatStep.friendlyCarrier,
    hostileFrigate: combatStep.hostileFrigate,
    asteroids: world.asteroids,
    projectiles: combatStep.projectiles,
    explosions: combatStep.explosions,
    radio: combatStep.radio,
    enemiesDestroyed,
    subsystemsDestroyed,
    events: [...flightStep.events, ...combatStep.events],
  };
}
