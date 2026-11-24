import { describe, expect, it } from 'vitest';
import { isInsideCapitalBox } from '../src/sim/combat';
import { createInitialEnergy, ENERGY_RULES, stepEnergy } from '../src/sim/energy';
import { FLIGHT_TUNING, resolveObstacleClearance } from '../src/sim/flight';
import { distance, dot, len, nextRandom, normalize, quatFromAxisAngle, vec3 } from '../src/sim/math';
import {
  DEFAULT_SORTIE_SEED,
  FIXED_DT,
  NEUTRAL_INPUT,
  type CapitalShipState,
  type SortieConfig,
  type WorldState,
} from '../src/sim/types';
import { createInitialWorld, DEFAULT_SORTIE_CONFIG, stepWorld } from '../src/sim/world';

describe('energy and snap-turn drift kernel', () => {
  it('enforces recovery cooldown after boost release and blocks immediate boost-gasping', () => {
    let energy = createInitialEnergy();
    const vel = vec3(0, 0, -90);

    energy = stepEnergy(energy, true, false, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('boosting');

    energy = stepEnergy(energy, false, false, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('recovering');

    energy = stepEnergy(energy, true, false, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('recovering');

    energy = stepEnergy(energy, false, true, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('recovering');

    const recoveryTicks = Math.ceil(ENERGY_RULES.boostRecoverySeconds / FIXED_DT) + 2;
    for (let i = 0; i < recoveryTicks; i += 1) {
      energy = stepEnergy(energy, false, false, vel, FIXED_DT).energy;
    }
    expect(energy.boostMode.kind).toBe('ready');
  });

  it('caps snap-turn drift duration and forces transition into recovery', () => {
    let energy = createInitialEnergy();
    const vel = vec3(0, 0, -110);

    energy = stepEnergy(energy, false, true, vel, FIXED_DT).energy;
    expect(energy.boostMode.kind).toBe('drifting');

    const maxTicks = Math.ceil(ENERGY_RULES.maxDriftSeconds / FIXED_DT) + 2;
    for (let i = 0; i < maxTicks; i += 1) {
      energy = stepEnergy(energy, false, true, vel, FIXED_DT).energy;
    }
    expect(energy.boostMode.kind).toBe('recovering');
  });
});

describe('sortie simulation contracts', () => {
  it('launches from briefing, ignores Enter during active flight, and restarts only on explicit restart', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, false);
    expect(world.phase.kind).toBe('briefing');

    world = stepWorld(world, { ...NEUTRAL_INPUT, launchBriefing: true }, FIXED_DT);
    expect(world.phase.kind).toBe('active');

    world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    const tickBeforeEnter = world.tick;

    world = stepWorld(world, { ...NEUTRAL_INPUT, launchBriefing: true }, FIXED_DT);
    expect(world.tick).toBe(tickBeforeEnter + 1);

    world = stepWorld(world, { ...NEUTRAL_INPUT, restartSortie: true }, FIXED_DT);
    expect(world.tick).toBe(0);
    expect(world.phase.kind).toBe('active');
  });

  it('breaks enemy raiders away after close passes instead of gluing them behind the player', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    let sawBreakAway = false;
    for (let i = 0; i < 420; i += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
      if (world.enemies.some((e) => e.maneuver.kind === 'break_away')) {
        sawBreakAway = true;
      }
      for (const e of world.enemies) {
        if (e.maneuver.kind === 'break_away') {
          expect(distance(e.position, world.player.position)).toBeGreaterThan(20);
        }
      }
    }
    expect(sawBreakAway).toBe(true);
  });

  it('toggles camera, fires cannons, and maintains autonomous wingmate target', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    world = stepWorld(world, { ...NEUTRAL_INPUT, toggleCamera: true, firePrimary: true }, FIXED_DT);
    expect(world.cameraMode).toBe('chase');
    expect(world.projectiles.length).toBeGreaterThanOrEqual(2);
    expect(world.wingmate.targetId).not.toBeNull();
  });

  it('clears lock and rearms missiles after firing', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    world = stepWorld(world, { ...NEUTRAL_INPUT, fireMissile: true }, FIXED_DT);
    expect(world.player.missilesReady).toBe(3);
    expect(world.player.lockState.kind).toBe('none');

    for (let i = 0; i < 270; i += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    }
    expect(world.player.missilesReady).toBe(4);
  });

  it('shatters asteroids when hit by player projectiles', () => {
    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    const targetRock = base.asteroids[0];
    expect(targetRock).toBeDefined();
    if (targetRock === undefined) {
      return;
    }

    const worldWithShot = {
      ...base,
      projectiles: [
        {
          id: 'test-missile',
          kind: 'missile' as const,
          faction: 'friendly' as const,
          position: targetRock.position,
          velocity: vec3(0, 0, -1),
          targetId: null,
          damage: targetRock.hull + 10,
          ttl: 2,
        },
      ],
    };

    const next = stepWorld(worldWithShot, NEUTRAL_INPUT, FIXED_DT);
    expect(next.asteroids.some((a) => a.id === targetRock.id)).toBe(false);
    expect(next.explosions.length).toBeGreaterThan(0);
  });

  it('transitions to victory when all raiders and subsystems are cleared, and retries cleanly', () => {
    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    const cleared = {
      ...base,
      enemies: [],
      hostileFrigate: {
        ...base.hostileFrigate,
        subsystems: base.hostileFrigate.subsystems.map((s) => ({ ...s, hull: 0 })),
      },
    };
    const won = stepWorld(cleared, NEUTRAL_INPUT, FIXED_DT);
    expect(won.phase.kind).toBe('victory');

    const retried = stepWorld(won, { ...NEUTRAL_INPUT, launchBriefing: true }, FIXED_DT);
    expect(retried.phase.kind).toBe('active');
    expect(retried.tick).toBe(0);
    expect(retried.enemies.length).toBeGreaterThan(0);
  });

  it('transitions to failed when either player fighter or friendly carrier is destroyed', () => {
    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    const deadPlayer = stepWorld(
      { ...base, player: { ...base.player, hull: 0 } },
      NEUTRAL_INPUT,
      FIXED_DT,
    );
    expect(deadPlayer.phase.kind).toBe('failed');
    if (deadPlayer.phase.kind === 'failed') {
      expect(deadPlayer.phase.reason).toBe('FIGHTER DESTROYED');
    }

    const deadCarrier = stepWorld(
      { ...base, friendlyCarrier: { ...base.friendlyCarrier, hull: 0 } },
      NEUTRAL_INPUT,
      FIXED_DT,
    );
    expect(deadCarrier.phase.kind).toBe('failed');
    if (deadCarrier.phase.kind === 'failed') {
      expect(deadCarrier.phase.reason).toBe('CARRIER HEARTHSTONE LOST');
    }
  });

  it('resolves rotated capital-ship clearance and projectile hitboxes in ship-local space', () => {
    const rotatedFrigate: CapitalShipState = {
      id: 'rotated-frigate',
      name: 'ROTATED FRIGATE',
      faction: 'hostile',
      position: vec3(0, 0, 0),
      orientation: quatFromAxisAngle(vec3(0, 1, 0), Math.PI / 2),
      halfExtents: vec3(20, 15, 100),
      hull: 1000,
      maxHull: 1000,
      subsystems: [],
    };

    // After 90 deg yaw, local Z (halfExtent 100) lies along world X, and local X (halfExtent 20) lies along world Z.
    expect(isInsideCapitalBox(vec3(80, 0, 0), rotatedFrigate, 0)).toBe(true);
    expect(isInsideCapitalBox(vec3(0, 0, 80), rotatedFrigate, 0)).toBe(false);

    const alongRotatedHull = resolveObstacleClearance(
      vec3(80, 0, 14),
      vec3(0, 0, -40),
      [rotatedFrigate],
      [],
    );
    expect(alongRotatedHull.warning).toBe(true);
    expect(alongRotatedHull.position.x).toBeCloseTo(80, 4);
    expect(alongRotatedHull.position.y).toBeCloseTo(0, 4);
    expect(alongRotatedHull.position.z).toBeGreaterThan(20);

    const clearAlongOldAxis = resolveObstacleClearance(
      vec3(0, 0, 80),
      vec3(0, 0, -40),
      [rotatedFrigate],
      [],
    );
    expect(clearAlongOldAxis.warning).toBe(false);
    expect(clearAlongOldAxis.position).toEqual(vec3(0, 0, 80));
  });

  it('preserves custom sortie configuration across restarts without re-passing config', () => {
    const reconConfig: SortieConfig = {
      ...DEFAULT_SORTIE_CONFIG,
      id: 'sortie-recon',
      openingRadio: {
        speaker: 'CONTROL',
        text: 'Recon sweep clear.',
        remainingSeconds: 4,
      },
      enemies: [],
    };
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true, reconConfig);
    world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    const restarted = stepWorld(world, { ...NEUTRAL_INPUT, restartSortie: true }, FIXED_DT);

    expect(restarted.sortie.id).toBe('sortie-recon');
    expect(restarted.enemies.length).toBe(0);
    expect(restarted.radio?.text).toBe('Recon sweep clear.');
  });

  it('strips outward radial velocity when clamped against the arena boundary', () => {
    const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    let world: WorldState = {
      ...base,
      enemies: [],
      asteroids: [],
      player: {
        ...base.player,
        position: vec3(0, 0, -(FLIGHT_TUNING.arenaRadius - 2)),
        velocity: vec3(0, 0, -100),
        throttle: 1,
      },
    };

    for (let i = 0; i < 15; i += 1) {
      world = stepWorld(world, NEUTRAL_INPUT, FIXED_DT);
    }

    const pos = world.player.position;
    const vel = world.player.velocity;
    const outward = normalize(pos);
    expect(len(pos)).toBeLessThanOrEqual(FLIGHT_TUNING.arenaRadius + 1e-4);
    expect(dot(vel, outward)).toBeLessThanOrEqual(1e-3);
    expect(len(vel)).toBeLessThan(1);
  });

  it('survives 60 seconds of randomized combat flight with finite state and valid invariants', () => {
    let world = createInitialWorld(DEFAULT_SORTIE_SEED, true);
    let seed = 0xdeadbeef;

    for (let tick = 0; tick < 3600; tick += 1) {
      const r1 = nextRandom(seed);
      const r2 = nextRandom(r1.nextState);
      const r3 = nextRandom(r2.nextState);
      seed = r3.nextState;

      world = stepWorld(
        world,
        {
          ...NEUTRAL_INPUT,
          pitch: (r1.value - 0.5) * 1.4,
          yaw: (r2.value - 0.5) * 1.4,
          roll: r3.value > 0.7 ? 1 : r3.value < 0.3 ? -1 : 0,
          boost: r1.value > 0.82,
          drift: r2.value > 0.88,
          firePrimary: r3.value > 0.5,
          fireMissile: tick % 90 === 0,
          cycleTarget: tick % 180 === 0,
        },
        FIXED_DT,
      );

      expect(Number.isFinite(world.player.position.x)).toBe(true);
      expect(Number.isFinite(world.player.position.y)).toBe(true);
      expect(Number.isFinite(world.player.position.z)).toBe(true);
      expect(world.player.energy.engineCharge).toBeGreaterThanOrEqual(0);
      expect(world.player.energy.engineCharge).toBeLessThanOrEqual(100);
      expect(world.player.energy.weaponCharge).toBeGreaterThanOrEqual(0);
      expect(world.player.energy.weaponCharge).toBeLessThanOrEqual(100);
      expect(world.player.missilesReady).toBeGreaterThanOrEqual(0);
      expect(world.player.missilesReady).toBeLessThanOrEqual(world.player.maxMissiles);

      if (world.player.lockState.kind !== 'none') {
        expect(world.player.missilesReady).toBeGreaterThan(0);
      }

      if (world.phase.kind !== 'active') {
        world = stepWorld(world, { ...NEUTRAL_INPUT, restartSortie: true }, FIXED_DT);
      }
    }
  });
});
