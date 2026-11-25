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

export type CameraMode = 'cockpit';
export type EnemyKind = 'raider' | 'striker';
export type WeaponState = 'ready' | 'overheated';
export type BarrelSide = 'left' | 'right';

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
  | { readonly kind: 'paused'; readonly elapsedSeconds: number }
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
  readonly throttlePushEdge: boolean;
  readonly firePrimary: boolean;
  readonly fireMissile: boolean;
  readonly cycleTarget: boolean;
  readonly toggleMute: boolean;
  readonly toggleMusic: boolean;
  readonly togglePause: boolean;
  readonly pauseRequested: boolean;
  readonly launchBriefing: boolean;
  readonly restartSortie: boolean;
}

export interface EnergyState {
  readonly overdrive: boolean;
  readonly weaponState: WeaponState;
  readonly weaponCharge: number;
  readonly shieldCharge: number;
  readonly shieldRegenDelay: number;
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
  /** Set by a manual `T` pick; auto-focus leaves a pinned target alone. */
  readonly targetPinned: boolean;
  readonly lockState: LockState;
  /** Previous tick's missile trigger level, so the sim can tell a fresh press from a hold. */
  readonly missileTriggerHeld: boolean;
  /** Cannon hits since the last critical; raises the next crit chance. */
  readonly critPity: number;
  /** Kills since the last supply drop; raises the next drop chance. */
  readonly dropPity: number;
  readonly nearMissCooldown: number;
  readonly proximityWarning: boolean;
  readonly hitFlash: number;
  readonly recoilKick: number;
  readonly nextBarrel: BarrelSide;
  readonly recoilLeft: number;
  readonly recoilRight: number;
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
  readonly shieldRegenDelay: number;
  readonly shieldHitFlash: number;
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
  readonly owner: 'player' | 'wingmate' | 'hostile';
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
  readonly tint: 'amber' | 'emerald' | 'crimson' | 'cyan';
}

export interface RadioMessage {
  readonly speaker: string;
  readonly text: string;
  readonly remainingSeconds: number;
}

export type SupplyDrop = 'heat_flush' | 'shield_surge' | 'missile_resupply';

export type SimEvent =
  | { readonly kind: 'cannon_fired'; readonly faction: 'friendly' | 'hostile'; readonly barrel?: BarrelSide }
  | { readonly kind: 'missile_fired' }
  | { readonly kind: 'target_locked' }
  | { readonly kind: 'hit_confirmed'; readonly isKill: boolean; readonly shieldHit?: boolean }
  | { readonly kind: 'shield_broken'; readonly position: Vec3 }
  | { readonly kind: 'weapon_overheated' }
  | { readonly kind: 'player_damaged' }
  | { readonly kind: 'overdrive_engaged' }
  | { readonly kind: 'subsystem_destroyed'; readonly label: string }
  | { readonly kind: 'crit_hit'; readonly position: Vec3 }
  | { readonly kind: 'near_miss'; readonly source: 'bolt' | 'buzz'; readonly reward: 'heat_vent' | 'shield' }
  | { readonly kind: 'supply_drop'; readonly drop: SupplyDrop }
  | { readonly kind: 'weapon_ready' }
  | { readonly kind: 'incoming_fire'; readonly position: Vec3 };

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
  throttlePushEdge: false,
  firePrimary: false,
  fireMissile: false,
  cycleTarget: false,
  toggleMute: false,
  toggleMusic: false,
  togglePause: false,
  pauseRequested: false,
  launchBriefing: false,
  restartSortie: false,
};
