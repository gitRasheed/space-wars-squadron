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

export type LevelId = 'saturn' | 'trench' | 'planetary';

export type EnemyManeuver =
  /** Holds station around a guard post until the player comes close or the guard takes fire. */
  | { readonly kind: 'patrol'; readonly post: Vec3 }
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
      readonly reactorsDestroyed: number;
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
  /** Missile trigger held this tick; a held trigger launches only on a completed lock. */
  readonly fireMissile: boolean;
  /** A fresh missile trigger press since the last tick, kept even if it was released before the tick ran. */
  readonly fireMissilePressed: boolean;
  readonly cycleTarget: boolean;
  readonly toggleMute: boolean;
  readonly toggleMusic: boolean;
  readonly togglePause: boolean;
  readonly pauseRequested: boolean;
  readonly launchBriefing: boolean;
  readonly restartSortie: boolean;
  /** From the debrief, back to the briefing card with the same mission selected. */
  readonly returnToBriefing: boolean;
  /** Briefing-only mission pick; ignored once a sortie is underway. */
  readonly selectLevel: LevelId | null;
}

export interface EnergyState {
  readonly overdrive: boolean;
  readonly weaponState: WeaponState;
  /** 0 is cold; a shot that reaches 100 overheats the cannons until they cool back to 0. */
  readonly weaponHeat: number;
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
  /** Cannon hits since the last critical; raises the next crit chance. */
  readonly critPity: number;
  /** Kills since the last supply drop; raises the next drop chance. */
  readonly dropPity: number;
  readonly nearMissCooldown: number;
  /** Counts down between `hull_critical` alarms while the hull is critical. */
  readonly hullAlarmCooldown: number;
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

/** A targetable core bolted into level geometry; its collider and mesh come from the level layout. */
export interface ReactorState {
  readonly id: string;
  readonly label: string;
  readonly position: Vec3;
  readonly radius: number;
  readonly hull: number;
  readonly maxHull: number;
}

export type ArenaRole = 'wall' | 'rib' | 'gantry' | 'monolith' | 'rock' | 'pylon' | 'core';

export type ArenaSolid =
  | {
      readonly kind: 'box';
      readonly id: string;
      readonly role: ArenaRole;
      readonly center: Vec3;
      readonly halfExtents: Vec3;
      readonly orientation: Quat;
      /** Bounding-sphere radius for the broad phase. */
      readonly bound: number;
    }
  | {
      readonly kind: 'sphere';
      readonly id: string;
      readonly role: ArenaRole;
      readonly center: Vec3;
      readonly radius: number;
      readonly bound: number;
      /** Set on a reactor's core: alive it takes damage, dead it is just more wall. */
      readonly reactorId: string | null;
    };

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
  /** `flak` is an AA shell that bursts on its fuse; it flies like a hostile bolt until then. */
  readonly kind: 'bolt' | 'missile' | 'flak';
  readonly faction: 'friendly' | 'hostile';
  readonly owner: 'player' | 'wingmate' | 'hostile';
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly targetId: string | null;
  readonly damage: number;
  readonly ttl: number;
  /** Fired from the cannons' Hot Zone, so a crit on impact hits harder. */
  readonly hotZone?: boolean;
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
  | {
      readonly kind: 'shield_broken';
      readonly position: Vec3;
      readonly targetId: string;
      readonly attackerId: 'player' | 'wingmate' | 'enemy';
    }
  | { readonly kind: 'weapon_overheated' }
  | { readonly kind: 'player_damaged' }
  | { readonly kind: 'hull_critical' }
  | { readonly kind: 'overdrive_engaged' }
  | { readonly kind: 'subsystem_destroyed'; readonly label: string }
  | { readonly kind: 'wall_scrape'; readonly position: Vec3 }
  | { readonly kind: 'crit_hit'; readonly position: Vec3 }
  | { readonly kind: 'near_miss'; readonly source: 'bolt' | 'buzz'; readonly reward: 'heat_vent' | 'shield' }
  | { readonly kind: 'supply_drop'; readonly drop: SupplyDrop }
  | { readonly kind: 'weapon_ready' }
  | { readonly kind: 'incoming_fire'; readonly position: Vec3 }
  | { readonly kind: 'ground_target_destroyed'; readonly label: string; readonly position: Vec3 }
  | { readonly kind: 'flak_burst'; readonly position: Vec3 }
  | { readonly kind: 'air_wave_inbound' };

export type GroundTargetKind = 'flak' | 'walker' | 'relay' | 'artillery';

export interface GroundTargetState {
  readonly id: string;
  readonly kind: GroundTargetKind;
  readonly label: string;
  /** Centre of the hit sphere; the pad sits directly below it at ground level. */
  readonly position: Vec3;
  readonly hull: number;
  readonly maxHull: number;
  readonly hitRadius: number;
  /** Takes no damage while this target is still standing. */
  readonly shieldedBy: string | null;
  readonly shieldHitFlash: number;
  readonly fireCooldown: number;
  /** 0..1 telegraph before a shot, so the renderer can glow the muzzle. */
  readonly charge: number;
  readonly heading: number;
}

export type PlanetaryStage =
  | { readonly kind: 'ground_attack' }
  | { readonly kind: 'air_superiority'; readonly elapsedSeconds: number };

export interface PlanetaryState {
  readonly stage: PlanetaryStage;
  readonly groundTargets: readonly GroundTargetState[];
  readonly groundTargetsDestroyed: number;
  /** How far (m) the friendly convoy has rolled forward from the outpost. */
  readonly convoyAdvance: number;
  readonly terrainWarning: boolean;
}

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
  readonly hostileFrigate: CapitalShipState | null;
  readonly reactors: readonly ReactorState[];
  readonly asteroids: readonly AsteroidState[];
  readonly projectiles: readonly ProjectileState[];
  readonly explosions: readonly ExplosionState[];
  readonly radio: RadioMessage | null;
  readonly enemiesDestroyed: number;
  readonly subsystemsDestroyed: number;
  readonly reactorsDestroyed: number;
  /** Null for orbital sorties; set for the planetary ground-support level. */
  readonly planetary: PlanetaryState | null;
  readonly events: readonly SimEvent[];
}

export interface SortieConfig {
  readonly id: string;
  readonly level: LevelId;
  /** Indestructible level geometry; empty in open space. */
  readonly arena: readonly ArenaSolid[];
  readonly reactors: readonly ReactorState[];
  readonly openingRadio: RadioMessage;
  readonly player: PlayerShipState;
  readonly wingmate: WingmateState;
  readonly enemies: readonly EnemyShipState[];
  readonly friendlyCarrier: CapitalShipState;
  readonly hostileFrigate: CapitalShipState | null;
  readonly asteroids: readonly AsteroidState[];
  /** Set only on the planetary ground-support level. */
  readonly planetary?: PlanetaryState;
}

export const FIXED_DT = 1 / 60;
/** At or below this share of max hull the cockpit warns and the alarm repeats. */
export const HULL_CRITICAL_FRACTION = 0.35;
export const HULL_ALARM_INTERVAL_SECONDS = 3.0;
export const DEFAULT_SORTIE_SEED = 0x51a7f00d;

export const NEUTRAL_INPUT: FlightInput = {
  pitch: 0,
  yaw: 0,
  roll: 0,
  throttleDelta: 0,
  throttlePushEdge: false,
  firePrimary: false,
  fireMissile: false,
  fireMissilePressed: false,
  cycleTarget: false,
  toggleMute: false,
  toggleMusic: false,
  togglePause: false,
  pauseRequested: false,
  launchBriefing: false,
  restartSortie: false,
  returnToBriefing: false,
  selectLevel: null,
};
