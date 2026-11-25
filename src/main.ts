import { createSynthAudio } from './audio/synthAudio';
import { createInputChannel } from './input/keyboardMouse';
import { createCockpitHud } from './render/cockpitHud';
import { createSceneRenderer } from './render/sceneRenderer';
import { len } from './sim/math';
import { DEFAULT_SORTIE_SEED, FIXED_DT, type LevelId, type Vec3, type WorldState } from './sim/types';
import { createInitialWorld, SORTIE_CONFIGS, stepFrame } from './sim/world';

interface ReadOnlyTelemetry {
  readonly getSnapshot: () => {
    readonly tick: number;
    readonly level: LevelId;
    readonly phase: WorldState['phase']['kind'];
    readonly playerPosition: Vec3;
    readonly hull: number;
    readonly reactorsRemaining: number;
    readonly cameraMode: WorldState['cameraMode'];
    readonly speed: number;
    readonly throttle: number;
    readonly overdrive: boolean;
    readonly weaponState: WorldState['player']['energy']['weaponState'];
    readonly weaponCharge: number;
    readonly shieldCharge: number;
    readonly missilesReady: number;
    readonly enemiesRemaining: number;
    readonly subsystemsRemaining: number;
    readonly projectilesCount: number;
    readonly selectedTargetId: string | null;
    readonly targetPinned: boolean;
    readonly lockState: WorldState['player']['lockState']['kind'];
    readonly lockTargetId: string | null;
    readonly playerMissileTargets: readonly (string | null)[];
    readonly wingmateTargetId: string | null;
  };
}

interface TimingSummary {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

interface FrameProfile {
  readonly frames: number;
  readonly fps: number;
  readonly frame: TimingSummary;
  readonly sim: TimingSummary;
  readonly render: TimingSummary;
}

interface ProfileHandle {
  readonly snapshot: () => FrameProfile;
  readonly reset: () => void;
}

declare global {
  interface Window {
    __SWS_TELEMETRY__?: ReadOnlyTelemetry;
    __SW_PROFILE__?: ProfileHandle;
  }
}

const PROFILE_WINDOW = 600;

function summarize(samples: Float64Array, count: number): TimingSummary {
  if (count === 0) {
    return { mean: 0, p50: 0, p95: 0, p99: 0 };
  }
  const sorted = Array.from(samples.subarray(0, count)).sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(count - 1, Math.floor(q * count))] ?? 0;
  return { mean: sorted.reduce((sum, v) => sum + v, 0) / count, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

/**
 * Opt-in via `?profile=1`; when absent, the frame loop never calls into it. `sim` covers the
 * frame's fixed steps including input sampling and audio sync; `render` covers scene and HUD.
 */
function createProfiler(): ProfileHandle & { readonly record: (frameMs: number, simMs: number, renderMs: number) => void } {
  const frame = new Float64Array(PROFILE_WINDOW);
  const sim = new Float64Array(PROFILE_WINDOW);
  const render = new Float64Array(PROFILE_WINDOW);
  let next = 0;
  let count = 0;
  const snapshot = (): FrameProfile => {
    const frameSummary = summarize(frame, count);
    return {
      frames: count,
      fps: frameSummary.mean > 0 ? 1000 / frameSummary.mean : 0,
      frame: frameSummary,
      sim: summarize(sim, count),
      render: summarize(render, count),
    };
  };

  const readout = document.createElement('pre');
  readout.style.cssText =
    'position:fixed;top:8px;right:8px;margin:0;padding:6px 8px;font:11px/1.35 monospace;' +
    'color:#9fffc8;background:rgba(0,0,0,0.6);pointer-events:none;z-index:10;white-space:pre';
  document.body.appendChild(readout);
  window.addEventListener('keydown', (event) => {
    if (event.code === 'Backquote') {
      readout.hidden = !readout.hidden;
    }
  });
  window.setInterval(() => {
    if (readout.hidden) return;
    const p = snapshot();
    const row = (name: string, t: TimingSummary): string =>
      `${name.padEnd(6)} p50 ${t.p50.toFixed(2)}  p95 ${t.p95.toFixed(2)}  p99 ${t.p99.toFixed(2)} ms`;
    readout.textContent = [`${p.fps.toFixed(1)} fps  (\` hides)`, row('frame', p.frame), row('sim', p.sim), row('render', p.render)].join('\n');
  }, 500);

  return {
    snapshot,
    reset: () => {
      next = 0;
      count = 0;
    },
    record: (frameMs, simMs, renderMs) => {
      frame[next] = frameMs;
      sim[next] = simMs;
      render[next] = renderMs;
      next = (next + 1) % PROFILE_WINDOW;
      count = Math.min(count + 1, PROFILE_WINDOW);
    },
  };
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

  // `?level=trench` boots straight into Level 2's briefing; anything else is the default sortie.
  const requestedLevel: LevelId = new URLSearchParams(window.location.search).get('level') === 'trench' ? 'trench' : 'saturn';
  let world = createInitialWorld(DEFAULT_SORTIE_SEED, false, SORTIE_CONFIGS[requestedLevel]);
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
      level: world.sortie.level,
      phase: world.phase.kind,
      playerPosition: world.player.position,
      hull: world.player.hull,
      reactorsRemaining: world.reactors.filter((r) => r.hull > 0).length,
      cameraMode: world.cameraMode,
      speed: len(world.player.velocity),
      throttle: world.player.throttle,
      overdrive: world.player.energy.overdrive,
      weaponState: world.player.energy.weaponState,
      weaponCharge: world.player.energy.weaponCharge,
      shieldCharge: world.player.energy.shieldCharge,
      missilesReady: world.player.missilesReady,
      enemiesRemaining: world.enemies.length,
      subsystemsRemaining: world.hostileFrigate?.subsystems.filter((s) => s.hull > 0).length ?? 0,
      projectilesCount: world.projectiles.length,
      selectedTargetId: world.player.selectedTargetId,
      targetPinned: world.player.targetPinned,
      lockState: world.player.lockState.kind,
      lockTargetId: world.player.lockState.kind === 'none' ? null : world.player.lockState.targetId,
      playerMissileTargets: world.projectiles
        .filter((p) => p.kind === 'missile' && p.owner === 'player')
        .map((p) => p.targetId),
      wingmateTargetId: world.wingmate.targetId,
    }),
  };

  const profiler = new URLSearchParams(window.location.search).get('profile') === '1' ? createProfiler() : null;
  if (profiler !== null) {
    window.__SW_PROFILE__ = { snapshot: profiler.snapshot, reset: profiler.reset };
  }

  let lastFrameMs = performance.now();
  let accumulator = 0;

  function frame(nowMs: number): void {
    const rawFrameMs = nowMs - lastFrameMs;
    const frameDelta = Math.min(rawFrameMs / 1000, 0.1);
    lastFrameMs = nowMs;
    accumulator += frameDelta;
    const steps = Math.floor(accumulator / FIXED_DT);
    accumulator -= steps * FIXED_DT;

    const simStart = profiler === null ? 0 : performance.now();
    const advanced = stepFrame(world, steps, input.sample, (before, after, sampled) => {
      if (sampled.toggleMute) {
        audio.toggleMute();
      }
      if (sampled.toggleMusic) {
        audio.toggleMusic();
      }
      if (before.phase.kind === 'active' && after.phase.kind === 'paused') {
        input.releasePointerForPause();
      }
      audio.sync(after);
    });
    world = advanced.world;
    const frameWorld = { ...world, events: advanced.frameEvents };

    const renderStart = profiler === null ? 0 : performance.now();
    renderer.render(frameWorld);
    hud.render(frameWorld, renderer.projectWorldPoint, audio.isMuted(), audio.isMusicEnabled());
    if (profiler !== null) {
      const end = performance.now();
      profiler.record(rawFrameMs, renderStart - simStart, end - renderStart);
    }
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

boot();
