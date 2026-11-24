import { createSynthAudio } from './audio/synthAudio';
import { createInputChannel } from './input/keyboardMouse';
import { createCockpitHud } from './render/cockpitHud';
import { createSceneRenderer } from './render/sceneRenderer';
import { len } from './sim/math';
import { DEFAULT_SORTIE_SEED, FIXED_DT, type WorldState } from './sim/types';
import { createInitialWorld, stepWorld } from './sim/world';

interface ReadOnlyTelemetry {
  readonly getSnapshot: () => {
    readonly tick: number;
    readonly phase: WorldState['phase']['kind'];
    readonly cameraMode: WorldState['cameraMode'];
    readonly speed: number;
    readonly boostMode: WorldState['player']['energy']['boostMode']['kind'];
    readonly engineCharge: number;
    readonly weaponCharge: number;
    readonly missilesReady: number;
    readonly enemiesRemaining: number;
    readonly subsystemsRemaining: number;
    readonly projectilesCount: number;
    readonly selectedTargetId: string | null;
    readonly wingmateTargetId: string | null;
  };
}

declare global {
  interface Window {
    __SWS_TELEMETRY__?: ReadOnlyTelemetry;
  }
}

function requireCanvas(id: string): HTMLCanvasElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLCanvasElement)) {
    throw new Error(`Missing required canvas #${id}`);
  }
  return element;
}

function boot(): void {
  const glCanvas = requireCanvas('gl-canvas');
  const hudCanvas = requireCanvas('hud-canvas');

  let world = createInitialWorld(DEFAULT_SORTIE_SEED, false);
  const input = createInputChannel(glCanvas, () => world.phase.kind !== 'active');
  const renderer = createSceneRenderer(glCanvas);
  const hud = createCockpitHud(hudCanvas);
  const audio = createSynthAudio();

  function syncViewport(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.resize(width, height);
    hud.resize(width, height);
  }
  syncViewport();
  window.addEventListener('resize', syncViewport);

  glCanvas.addEventListener('mousedown', () => {
    audio.unlock();
  });
  window.addEventListener('keydown', () => {
    audio.unlock();
  });

  window.__SWS_TELEMETRY__ = {
    getSnapshot: () => ({
      tick: world.tick,
      phase: world.phase.kind,
      cameraMode: world.cameraMode,
      speed: len(world.player.velocity),
      boostMode: world.player.energy.boostMode.kind,
      engineCharge: world.player.energy.engineCharge,
      weaponCharge: world.player.energy.weaponCharge,
      missilesReady: world.player.missilesReady,
      enemiesRemaining: world.enemies.length,
      subsystemsRemaining: world.hostileFrigate.subsystems.filter((s) => s.hull > 0).length,
      projectilesCount: world.projectiles.length,
      selectedTargetId: world.player.selectedTargetId,
      wingmateTargetId: world.wingmate.targetId,
    }),
  };

  let lastFrameMs = performance.now();
  let accumulator = 0;

  function frame(nowMs: number): void {
    const frameDelta = Math.min((nowMs - lastFrameMs) / 1000, 0.1);
    lastFrameMs = nowMs;
    accumulator += frameDelta;

    while (accumulator >= FIXED_DT) {
      const sampled = input.sample();
      if (sampled.toggleMute) {
        audio.toggleMute();
      }
      if (sampled.toggleMusic) {
        audio.toggleMusic();
      }
      const wasActive = world.phase.kind === 'active';
      world = stepWorld(world, sampled, FIXED_DT);
      if (wasActive && world.phase.kind === 'paused' && document.pointerLockElement === glCanvas) {
        document.exitPointerLock();
      }
      audio.sync(world);
      accumulator -= FIXED_DT;
    }

    renderer.render(world);
    hud.render(world, renderer.projectWorldPoint, audio.isMuted(), audio.isMusicEnabled());
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

boot();
