import { clamp } from '../sim/math';
import type { FlightInput, LevelId } from '../sim/types';
import { applyDeadzone } from './combine';

export interface InputChannel {
  readonly sample: () => FlightInput;
  readonly isPointerLocked: () => boolean;
  /** Releases pointer lock for a pause, remembering it so the resume click re-locks. */
  readonly releasePointerForPause: () => void;
  readonly destroy: () => void;
}

type SteeringMode =
  | { readonly kind: 'idle' }
  | { readonly kind: 'cursor'; readonly x: number; readonly y: number }
  | { readonly kind: 'pointer_locked'; readonly dx: number; readonly dy: number };

const MOUSE_SENSITIVITY = 0.0046;
const LEVEL_KEYS: Readonly<Partial<Record<string, LevelId>>> = {
  Digit1: 'saturn',
  Digit2: 'trench',
  Digit3: 'planetary',
  Numpad1: 'saturn',
  Numpad2: 'trench',
  Numpad3: 'planetary',
};
const CURSOR_STEER_DEADZONE = 0.05;

export function createInputChannel(
  canvas: HTMLCanvasElement,
  isOverlayOpen: () => boolean,
  /** The briefing mission button under a viewport point, if any; a click on one picks it instead of launching. */
  pickLevelAt: (clientX: number, clientY: number) => LevelId | null = () => null,
): InputChannel {
  const heldKeys = new Set<string>();
  let mouseLeftHeld = false;
  let mouseRightHeld = false;
  let steering: SteeringMode = { kind: 'idle' };

  let queuedCycleTarget = false;
  let queuedThrottlePush = false;
  let queuedLaunchBriefing = false;
  let queuedRestartSortie = false;
  let queuedReturnToBriefing = false;
  let queuedFireMissile = false;
  let queuedToggleMute = false;
  let queuedToggleMusic = false;
  let queuedTogglePause = false;
  let queuedPauseRequested = false;
  let queuedSelectLevel: LevelId | null = null;
  let wasPointerLocked = false;
  let lockedBeforePause = false;
  let resumeOnPointerLock = false;

  function clearHeldInputs(): void {
    heldKeys.clear();
    mouseLeftHeld = false;
    mouseRightHeld = false;
    queuedCycleTarget = false;
    queuedThrottlePush = false;
    queuedLaunchBriefing = false;
    queuedRestartSortie = false;
    queuedReturnToBriefing = false;
    queuedFireMissile = false;
    queuedToggleMute = false;
    queuedToggleMusic = false;
    queuedTogglePause = false;
    queuedPauseRequested = false;
    queuedSelectLevel = null;
    resumeOnPointerLock = false;
    steering =
      steering.kind === 'pointer_locked'
        ? { kind: 'pointer_locked', dx: 0, dy: 0 }
        : { kind: 'idle' };
  }

  function onKeyDown(event: KeyboardEvent): void {
    const code = event.code;
    if (
      code === 'Space' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'Tab'
    ) {
      event.preventDefault();
    }

    if (!event.repeat) {
      if (code === 'KeyT' || code === 'Tab') {
        queuedCycleTarget = true;
      } else if (code === 'KeyW') {
        queuedThrottlePush = true;
      } else if (code === 'Enter') {
        lockedBeforePause = false;
        resumeOnPointerLock = false;
        queuedLaunchBriefing = true;
      } else if (code === 'KeyR') {
        lockedBeforePause = false;
        resumeOnPointerLock = false;
        queuedRestartSortie = true;
      } else if (code === 'KeyB') {
        lockedBeforePause = false;
        resumeOnPointerLock = false;
        queuedReturnToBriefing = true;
      } else if (code === 'KeyE') {
        queuedFireMissile = true;
      } else if (code === 'KeyM') {
        queuedToggleMute = true;
      } else if (code === 'KeyN') {
        queuedToggleMusic = true;
      } else if (LEVEL_KEYS[code] !== undefined) {
        queuedSelectLevel = LEVEL_KEYS[code];
      } else if (code === 'Escape' || code === 'KeyP') {
        if (isOverlayOpen()) {
          lockedBeforePause = false;
          resumeOnPointerLock = false;
        }
        queuedTogglePause = true;
      }
    }

    heldKeys.add(code);
  }

  function onKeyUp(event: KeyboardEvent): void {
    heldKeys.delete(event.code);
  }

  function onMouseDown(event: MouseEvent): void {
    if (event.button === 0) {
      const needsLock = document.pointerLockElement !== canvas;
      if (isOverlayOpen()) {
        const level = pickLevelAt(event.clientX, event.clientY);
        if (level !== null) {
          queuedSelectLevel = level;
          return;
        }
        if (lockedBeforePause && needsLock) {
          resumeOnPointerLock = true;
          void Promise.resolve(canvas.requestPointerLock()).catch(() => {
            resumeOnPointerLock = false;
          });
          return;
        }
        if (needsLock) {
          void Promise.resolve(canvas.requestPointerLock()).catch(() => undefined);
        }
        lockedBeforePause = false;
        queuedLaunchBriefing = true;
        return;
      }
      if (needsLock) {
        void Promise.resolve(canvas.requestPointerLock()).catch(() => undefined);
      }
      mouseLeftHeld = true;
    } else if (event.button === 2) {
      mouseRightHeld = true;
      queuedFireMissile = true;
    }
  }

  function onMouseUp(event: MouseEvent): void {
    if (event.button === 0) {
      mouseLeftHeld = false;
    } else if (event.button === 2) {
      mouseRightHeld = false;
    }
  }

  function onMouseMove(event: MouseEvent): void {
    if (steering.kind === 'pointer_locked') {
      steering = {
        kind: 'pointer_locked',
        dx: clamp(steering.dx + event.movementX * MOUSE_SENSITIVITY, -1, 1),
        dy: clamp(steering.dy + event.movementY * MOUSE_SENSITIVITY, -1, 1),
      };
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    steering = {
      kind: 'cursor',
      x: clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1),
      y: clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1),
    };
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
  }

  function onPointerLockChange(): void {
    const nowLocked = document.pointerLockElement === canvas;
    if (!wasPointerLocked && nowLocked && resumeOnPointerLock) {
      resumeOnPointerLock = false;
      lockedBeforePause = false;
      queuedLaunchBriefing = true;
    } else if (wasPointerLocked && !nowLocked && !isOverlayOpen()) {
      // Browsers intercept Escape to release pointer lock without firing keydown('Escape').
      lockedBeforePause = true;
      clearHeldInputs();
      queuedPauseRequested = true;
    }
    wasPointerLocked = nowLocked;
    steering = nowLocked ? { kind: 'pointer_locked', dx: 0, dy: 0 } : { kind: 'idle' };
  }

  function onPointerLockError(): void {
    resumeOnPointerLock = false;
  }

  function onWindowBlur(): void {
    const shouldAutoPause = !isOverlayOpen();
    clearHeldInputs();
    if (shouldAutoPause) {
      queuedPauseRequested = true;
    }
  }

  function onVisibilityChange(): void {
    if (document.hidden) {
      const shouldAutoPause = !isOverlayOpen();
      clearHeldInputs();
      if (shouldAutoPause) {
        queuedPauseRequested = true;
      }
    }
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('blur', onWindowBlur);
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('pointerlockerror', onPointerLockError);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('contextmenu', onContextMenu);

  function sample(): FlightInput {
    const keyPitch = (heldKeys.has('ArrowDown') ? 1 : 0) - (heldKeys.has('ArrowUp') ? 1 : 0);
    const keyYaw = (heldKeys.has('ArrowRight') ? 1 : 0) - (heldKeys.has('ArrowLeft') ? 1 : 0);
    const roll = (heldKeys.has('KeyD') ? 1 : 0) - (heldKeys.has('KeyA') ? 1 : 0);
    const throttleDelta = (heldKeys.has('KeyW') ? 1 : 0) - (heldKeys.has('KeyS') ? 1 : 0);

    let mouseYaw = 0;
    let mousePitch = 0;
    if (steering.kind === 'pointer_locked') {
      mouseYaw = steering.dx;
      mousePitch = -steering.dy;
      steering = {
        kind: 'pointer_locked',
        dx: steering.dx * 0.42,
        dy: steering.dy * 0.42,
      };
    } else if (steering.kind === 'cursor') {
      mouseYaw = applyDeadzone(steering.x, CURSOR_STEER_DEADZONE);
      mousePitch = -applyDeadzone(steering.y, CURSOR_STEER_DEADZONE);
    }

    const input: FlightInput = {
      pitch: clamp(keyPitch + mousePitch, -1, 1),
      yaw: clamp(keyYaw + mouseYaw, -1, 1),
      roll,
      throttleDelta,
      throttlePushEdge: queuedThrottlePush,
      firePrimary: mouseLeftHeld || heldKeys.has('KeyJ'),
      fireMissile: mouseRightHeld || heldKeys.has('KeyE'),
      fireMissilePressed: queuedFireMissile,
      rechargeShields: heldKeys.has('KeyC'),
      cycleTarget: queuedCycleTarget,
      launchBriefing: queuedLaunchBriefing,
      restartSortie: queuedRestartSortie,
      returnToBriefing: queuedReturnToBriefing,
      toggleMute: queuedToggleMute,
      toggleMusic: queuedToggleMusic,
      togglePause: queuedTogglePause,
      pauseRequested: queuedPauseRequested,
      selectLevel: queuedSelectLevel,
    };

    queuedCycleTarget = false;
    queuedThrottlePush = false;
    queuedLaunchBriefing = false;
    queuedRestartSortie = false;
    queuedReturnToBriefing = false;
    queuedFireMissile = false;
    queuedToggleMute = false;
    queuedToggleMusic = false;
    queuedTogglePause = false;
    queuedPauseRequested = false;
    queuedSelectLevel = null;

    return input;
  }

  function releasePointerForPause(): void {
    if (document.pointerLockElement === canvas) {
      lockedBeforePause = true;
      document.exitPointerLock();
    }
  }

  function destroy(): void {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('blur', onWindowBlur);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    document.removeEventListener('pointerlockerror', onPointerLockError);
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('contextmenu', onContextMenu);
  }

  return {
    sample,
    isPointerLocked: () => steering.kind === 'pointer_locked',
    releasePointerForPause,
    destroy,
  };
}
