import { describe, expect, it } from 'vitest';
import { applyDeadzone, mergeFlightInputs } from '../src/input/combine';
import { createInputChannel } from '../src/input/keyboardMouse';
import { NEUTRAL_INPUT } from '../src/sim/types';

function createListenerTarget() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    addEventListener(type: string, cb: (event: unknown) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(cb);
      listeners.set(type, set);
    },
    removeEventListener(type: string, cb: (event: unknown) => void) {
      listeners.get(type)?.delete(cb);
    },
    emit(type: string, event: unknown) {
      for (const cb of listeners.get(type) ?? []) {
        cb(event);
      }
    },
  };
}

/** Installs fake window, document and canvas for one channel; returns them with the channel. */
function withFakeDom(
  overlayOpen: boolean,
  levelAt: Parameters<typeof createInputChannel>[2],
  run: (dom: {
    readonly window: ReturnType<typeof createListenerTarget>;
    readonly canvas: ReturnType<typeof createListenerTarget>;
    readonly channel: ReturnType<typeof createInputChannel>;
  }) => void,
): void {
  const fakeWindow = createListenerTarget();
  const fakeDocument = Object.assign(createListenerTarget(), { hidden: false, pointerLockElement: null });
  const fakeCanvas = Object.assign(createListenerTarget(), {
    requestPointerLock: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  });
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
  try {
    const channel = createInputChannel(fakeCanvas as unknown as HTMLCanvasElement, () => overlayOpen, levelAt);
    run({ window: fakeWindow, canvas: fakeCanvas, channel });
    channel.destroy();
  } finally {
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
  }
}

describe('missile, recharge and briefing input', () => {
  it('keeps a right click pressed and released between two ticks as a fresh missile press', () => {
    withFakeDom(false, undefined, ({ window, canvas, channel }) => {
      canvas.emit('mousedown', { button: 2, clientX: 0, clientY: 0 });
      window.emit('mouseup', { button: 2 });
      const tick = channel.sample();
      expect(tick).toMatchObject({ fireMissilePressed: true, fireMissile: false });
      expect(channel.sample().fireMissilePressed).toBe(false);
    });
  });

  it('holds manual shield recharge while C is down', () => {
    withFakeDom(false, undefined, ({ window, channel }) => {
      window.emit('keydown', { code: 'KeyC', repeat: false, preventDefault: () => undefined });
      expect(channel.sample().rechargeShields).toBe(true);
      window.emit('keyup', { code: 'KeyC' });
      expect(channel.sample().rechargeShields).toBe(false);
    });
  });

  it('picks the clicked briefing mission instead of launching, and sends B once', () => {
    withFakeDom(true, (x) => (x < 100 ? 'trench' : null), ({ window, canvas, channel }) => {
      canvas.emit('mousedown', { button: 0, clientX: 50, clientY: 300 });
      expect(channel.sample()).toMatchObject({ selectLevel: 'trench', launchBriefing: false });
      canvas.emit('mousedown', { button: 0, clientX: 600, clientY: 300 });
      expect(channel.sample()).toMatchObject({ selectLevel: null, launchBriefing: true });
      window.emit('keydown', { code: 'KeyB', repeat: false, preventDefault: () => undefined });
      expect(channel.sample().returnToBriefing).toBe(true);
      expect(channel.sample().returnToBriefing).toBe(false);
    });
  });
});

describe('input deadzone and channel merging', () => {
  it('zeros values inside the deadzone and rescales remaining travel smoothly to 1', () => {
    expect(applyDeadzone(0.04, 0.1)).toBe(0);
    expect(applyDeadzone(-0.09, 0.1)).toBe(0);
    expect(applyDeadzone(0.55, 0.1)).toBeCloseTo(0.5, 6);
    expect(applyDeadzone(-1, 0.1)).toBe(-1);
    expect(applyDeadzone(1.5, 0.1)).toBe(1);
  });

  it('merges keyboard/mouse and controller inputs by clamping analog axes and OR-ing triggers', () => {
    const merged = mergeFlightInputs(
      {
        ...NEUTRAL_INPUT,
        pitch: 0.7,
        yaw: -0.6,
        roll: 1,
        firePrimary: true,
        toggleMute: false,
      },
      {
        ...NEUTRAL_INPUT,
        pitch: 0.6,
        yaw: -0.8,
        roll: -0.25,
        throttleDelta: 0.5,
        throttlePushEdge: true,
        toggleMute: true,
      },
    );

    expect(merged.pitch).toBe(1);
    expect(merged.yaw).toBe(-1);
    expect(merged.roll).toBeCloseTo(0.75, 6);
    expect(merged.throttleDelta).toBe(0.5);
    expect(merged.firePrimary).toBe(true);
    expect(merged.throttlePushEdge).toBe(true);
    expect(merged.toggleMute).toBe(true);
    expect(merged.cycleTarget).toBe(false);
  });

  it('clears queued edge actions on window blur so focus loss cannot fire a stale missile', () => {
    const fakeWindow = createListenerTarget();
    const fakeDocument = Object.assign(createListenerTarget(), {
      hidden: false,
      pointerLockElement: null,
    });
    const fakeCanvas = Object.assign(createListenerTarget(), {
      requestPointerLock: () => undefined,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    });

    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });

    try {
      const channel = createInputChannel(
        fakeCanvas as unknown as HTMLCanvasElement,
        () => false,
      );
      // Number keys pick a mission once per press.
      fakeWindow.emit('keydown', { code: 'Digit2', repeat: false, preventDefault: () => undefined });
      expect(channel.sample().selectLevel).toBe('trench');
      expect(channel.sample().selectLevel).toBeNull();
      fakeWindow.emit('keydown', { code: 'KeyE', repeat: false, preventDefault: () => undefined });
      fakeWindow.emit('keydown', { code: 'KeyM', repeat: false, preventDefault: () => undefined });
      fakeWindow.emit('blur', {});
      const sampled = channel.sample();
      expect(sampled.fireMissile).toBe(false);
      expect(sampled.fireMissilePressed).toBe(false);
      expect(sampled.toggleMute).toBe(false);
      // Losing window focus while active sends idempotent pauseRequested so raiders cannot kill the player off-tab.
      expect(sampled.pauseRequested).toBe(true);
      channel.destroy();
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
      Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
    }
  });

  it('triggers idempotent pause on pointer-lock exit, clears pending resume on blur, and waits for pointer lock on click-resume', () => {
    const fakeWindow = createListenerTarget();
    const fakeDocument: ReturnType<typeof createListenerTarget> & {
      hidden: boolean;
      pointerLockElement: unknown;
    } = Object.assign(createListenerTarget(), {
      hidden: false,
      pointerLockElement: null,
    });
    const fakeCanvas = Object.assign(createListenerTarget(), {
      requestPointerLock: () => undefined,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    });

    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });

    let overlayOpen = false;
    try {
      const channel = createInputChannel(
        fakeCanvas as unknown as HTMLCanvasElement,
        () => overlayOpen,
      );

      // Direct Escape and KeyN work when unlocked.
      fakeWindow.emit('keydown', { code: 'Escape', repeat: false, preventDefault: () => undefined });
      fakeWindow.emit('keydown', { code: 'KeyN', repeat: false, preventDefault: () => undefined });
      const first = channel.sample();
      expect(first.togglePause).toBe(true);
      expect(first.toggleMusic).toBe(true);

      // Pointer lock exit while active (Chrome swallows Escape) queues idempotent pauseRequested.
      fakeDocument.pointerLockElement = fakeCanvas;
      fakeDocument.emit('pointerlockchange', {});
      expect(channel.sample().pauseRequested).toBe(false);

      fakeDocument.pointerLockElement = null;
      fakeDocument.emit('pointerlockchange', {});
      expect(channel.sample().pauseRequested).toBe(true);
      overlayOpen = true;

      // Clicking Resume during Chrome's Escape cooldown (pointerlockerror) keeps overlay open instead of dropping into cursor steering.
      fakeCanvas.emit('mousedown', { button: 0 });
      fakeDocument.emit('pointerlockerror', {});
      expect(channel.sample().launchBriefing).toBe(false);

      // Retrying click once cooldown clears resumes cleanly on lock acquisition.
      fakeCanvas.emit('mousedown', { button: 0 });
      fakeDocument.pointerLockElement = fakeCanvas;
      fakeDocument.emit('pointerlockchange', {});
      expect(channel.sample().launchBriefing).toBe(true);
      overlayOpen = false;

      // Focus loss while paused clears a queued KeyP resume instead of letting it survive tab switch.
      overlayOpen = true;
      fakeWindow.emit('keydown', { code: 'KeyP', repeat: false, preventDefault: () => undefined });
      fakeWindow.emit('blur', {});
      const afterBlur = channel.sample();
      expect(afterBlur.togglePause).toBe(false);
      expect(afterBlur.launchBriefing).toBe(false);
      expect(afterBlur.pauseRequested).toBe(false);

      channel.destroy();
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
      Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
    }
  });
  it('remembers pointer lock when P pauses locked flight, so the resume click waits for the re-lock', () => {
    const fakeWindow = createListenerTarget();
    const fakeDocument: ReturnType<typeof createListenerTarget> & {
      hidden: boolean;
      pointerLockElement: unknown;
      exitPointerLock: () => void;
    } = Object.assign(createListenerTarget(), {
      hidden: false,
      pointerLockElement: null,
      exitPointerLock: () => {
        fakeDocument.pointerLockElement = null;
        fakeDocument.emit('pointerlockchange', {});
      },
    });
    const fakeCanvas = Object.assign(createListenerTarget(), {
      requestPointerLock: () => undefined,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    });

    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });

    let overlayOpen = false;
    try {
      const channel = createInputChannel(fakeCanvas as unknown as HTMLCanvasElement, () => overlayOpen);
      fakeDocument.pointerLockElement = fakeCanvas;
      fakeDocument.emit('pointerlockchange', {});
      channel.sample();

      fakeWindow.emit('keydown', { code: 'KeyP', repeat: false, preventDefault: () => undefined });
      expect(channel.sample().togglePause).toBe(true);
      overlayOpen = true;
      channel.releasePointerForPause();
      expect(fakeDocument.pointerLockElement).toBeNull();

      fakeCanvas.emit('mousedown', { button: 0 });
      expect(channel.sample().launchBriefing).toBe(false);
      fakeDocument.pointerLockElement = fakeCanvas;
      fakeDocument.emit('pointerlockchange', {});
      expect(channel.sample().launchBriefing).toBe(true);

      channel.destroy();
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
      Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
    }
  });
});
