export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export type CameraMode = 'cockpit' | 'chase';
export type EnemyKind = 'raider' | 'striker';

export type BoostMode =
  | { readonly kind: 'ready' }
  | { readonly kind: 'boosting' }
  | {
      readonly kind: 'drifting';
      readonly driftVelocity: Vec3;
      readonly elapsedSeconds: number;
    }
  | {
      readonly kind: 'recovering';
      readonly remainingSeconds: number;
    };

export type LockState =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'acquiring';
      readonly targetId: string;
      readonly progress: number;
    }
  | {
      readonly kind: 'locked';
      readonly targetId: string;
    };

export type EnemyManeuver =
  | { readonly kind: 'approach'; readonly remainingSeconds: number }
  | {
      readonly kind: 'break_away';
      readonly escapeDir: Vec3;
      readonly remainingSeconds: number;
    };

export type SortiePhase =
  | { readonly kind: 'briefing' }
  | { readonly kind: 'active'; readonly elapsedSeconds: number }
  | {
      readonly kind: 'victory';
      readonly elapsedSeconds: number;
      readonly enemiesDestroyed: number;
      readonly subsystemsDestroyed: number;
    }
  | {
      readonly kind: 'failed';
      readonly elapsedSeconds: number;
      readonly reason: string;
    };

export interface FlightInput {
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
  readonly throttleDelta: number;
  readonly boost: boolean;
  readonly drift: boolean;
  readonly firePrimary: boolean;
  readonly fireMissile: boolean;
  readonly cycleTarget: boolean;
  readonly toggleCamera: boolean;
  readonly toggleMute: boolean;
  readonly launchBriefing: boolean;
  readonly restartSortie: boolean;
}

export interface EnergyState {
  readonly boostMode: BoostMode;
  readonly engineCharge: number;
  readonly weaponCharge: number;
  readonly shieldCharge: number;
}

export interface PlayerShipState {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly orientation: Quat;
  readonly angularVelocity: Vec3;
  readonly throttle: number;
  readonly hull: number;
  readonly maxHull: number;
  readonly energy: EnergyState;
  readonly primaryCooldown: number;
  readonly missileCooldown: number;
  readonly missilesReady: number;
  readonly maxMissiles: number;
  readonly missileRearmTimer: number;
  readonly selectedTargetId: string | null;
  readonly lockState: LockState;
  readonly proximityWarning: boolean;
  readonly hitFlash: number;
  readonly recoilKick: number;
}

export interface WingmateState {
  readonly callsign: string;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly orientation: Quat;
  readonly targetId: string | null;
  readonly fireCooldown: number;
}

export interface EnemyShipState {
  readonly id: string;
  readonly callsign: string;
  readonly kind: EnemyKind;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly orientation: Quat;
  readonly maneuver: EnemyManeuver;
  readonly hull: number;
  readonly maxHull: number;
  readonly shields: number;
  readonly maxShields: number;
  readonly fireCooldown: number;
  readonly phaseOffset: number;
}

export interface SubsystemState {
  readonly id: string;
  readonly label: string;
  readonly localOffset: Vec3;
  readonly radius: number;
  readonly hull: number;
  readonly maxHull: number;
}

export interface CapitalShipState {
  readonly id: string;
  readonly name: string;
  readonly faction: 'friendly' | 'hostile';
  readonly position: Vec3;
  readonly orientation: Quat;
  readonly halfExtents: Vec3;
  readonly hull: number;
  readonly maxHull: number;
  readonly subsystems: readonly SubsystemState[];
}

export interface AsteroidState {
  readonly id: string;
  readonly position: Vec3;
  readonly radius: number;
  readonly rotation: Vec3;
  readonly hull: number;
  readonly tint: 'ice' | 'ochre' | 'slate';
}

export interface ProjectileState {
  readonly id: string;
  readonly kind: 'bolt' | 'missile';
  readonly faction: 'friendly' | 'hostile';
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly targetId: string | null;
  readonly damage: number;
  readonly ttl: number;
}

export interface ExplosionState {
  readonly id: string;
  readonly position: Vec3;
  readonly radius: number;
  readonly elapsed: number;
  readonly duration: number;
  readonly tint: 'amber' | 'emerald' | 'crimson';
}

export interface RadioMessage {
  readonly speaker: string;
  readonly text: string;
  readonly remainingSeconds: number;
}

export type SimEvent =
  | { readonly kind: 'cannon_fired'; readonly faction: 'friendly' | 'hostile' }
  | { readonly kind: 'missile_fired' }
  | { readonly kind: 'target_locked' }
  | { readonly kind: 'hit_confirmed'; readonly isKill: boolean }
  | { readonly kind: 'player_damaged' }
  | { readonly kind: 'boost_engaged' }
  | { readonly kind: 'drift_engaged' }
  | { readonly kind: 'subsystem_destroyed'; readonly label: string };

export interface WorldState {
  readonly tick: number;
  readonly rngState: number;
  readonly sortie: SortieConfig;
  readonly phase: SortiePhase;
  readonly cameraMode: CameraMode;
  readonly player: PlayerShipState;
  readonly wingmate: WingmateState;
  readonly enemies: readonly EnemyShipState[];
  readonly friendlyCarrier: CapitalShipState;
  readonly hostileFrigate: CapitalShipState;
  readonly asteroids: readonly AsteroidState[];
  readonly projectiles: readonly ProjectileState[];
  readonly explosions: readonly ExplosionState[];
  readonly radio: RadioMessage | null;
  readonly enemiesDestroyed: number;
  readonly subsystemsDestroyed: number;
  readonly events: readonly SimEvent[];
}

export interface SortieConfig {
  readonly id: string;
  readonly openingRadio: RadioMessage;
  readonly player: PlayerShipState;
  readonly wingmate: WingmateState;
  readonly enemies: readonly EnemyShipState[];
  readonly friendlyCarrier: CapitalShipState;
  readonly hostileFrigate: CapitalShipState;
  readonly asteroids: readonly AsteroidState[];
}

export const FIXED_DT = 1 / 60;
export const DEFAULT_SORTIE_SEED = 0x51a7f00d;

export const NEUTRAL_INPUT: FlightInput = {
  pitch: 0,
  yaw: 0,
  roll: 0,
  throttleDelta: 0,
  boost: false,
  drift: false,
  firePrimary: false,
  fireMissile: false,
  cycleTarget: false,
  toggleCamera: false,
  toggleMute: false,
  launchBriefing: false,
  restartSortie: false,
};
