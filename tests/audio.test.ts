import { describe, expect, it } from 'vitest';
import { COMBAT_LOOP_SCORE } from '../src/audio/combatScore';
import { createSynthAudio } from '../src/audio/synthAudio';
import { DEFAULT_SORTIE_SEED } from '../src/sim/types';
import { createInitialWorld } from '../src/sim/world';
import combatLoopRecipe from '../tools/agent-audio/recipes/combat-loop.recipe.json';

interface MockAudioNode {
  readonly kind: string;
  readonly connections: MockAudioNode[];
  connect(dest: MockAudioNode): MockAudioNode;
}

describe('synthAudio master bus isolation, victory SFX, tab-hide safety, and recipe parity', () => {
  it('routes every oscillator, filter, buffer source, and gain behind masterGain, plays victory SFX, and stops music on hide', () => {
    const destination: MockAudioNode = {
      kind: 'destination',
      connections: [],
      connect(dest) {
        this.connections.push(dest);
        return dest;
      },
    };
    const allNodes: MockAudioNode[] = [];
    const gainNodes: Array<
      MockAudioNode & {
        gain: {
          value: number;
          targets: number[];
          setValueAtTime: () => void;
          exponentialRampToValueAtTime: () => void;
          setTargetAtTime: (target: number) => void;
        };
      }
    > = [];
    const bufferSources: Array<
      MockAudioNode & {
        buffer: unknown;
        loop: boolean;
        started: boolean;
        stopped: boolean;
        start: () => void;
        stop: () => void;
      }
    > = [];
    const oscillators: MockAudioNode[] = [];

    class FakeAudioContext {
      readonly destination = destination;
      readonly state = 'running';
      readonly currentTime = 0.05;
      readonly sampleRate = 8000;
      createGain() {
        const targets: number[] = [];
        const node = {
          kind: 'gain',
          connections: [] as MockAudioNode[],
          connect(dest: MockAudioNode) {
            this.connections.push(dest);
            return dest;
          },
          gain: {
            value: 1,
            targets,
            setValueAtTime: () => undefined,
            exponentialRampToValueAtTime: () => undefined,
            setTargetAtTime: (target: number) => {
              targets.push(target);
            },
          },
        };
        gainNodes.push(node);
        allNodes.push(node);
        return node;
      }
      createOscillator() {
        const node = {
          kind: 'osc',
          type: 'sine',
          frequency: {
            value: 0,
            setValueAtTime: () => undefined,
            exponentialRampToValueAtTime: () => undefined,
            setTargetAtTime: () => undefined,
          },
          connections: [] as MockAudioNode[],
          connect(dest: MockAudioNode) {
            this.connections.push(dest);
            return dest;
          },
          start: () => undefined,
          stop: () => undefined,
        };
        oscillators.push(node);
        allNodes.push(node);
        return node;
      }
      createBiquadFilter() {
        const node = {
          kind: 'filter',
          type: 'lowpass',
          frequency: { value: 0 },
          Q: { value: 1 },
          connections: [] as MockAudioNode[],
          connect(dest: MockAudioNode) {
            this.connections.push(dest);
            return dest;
          },
        };
        allNodes.push(node);
        return node;
      }
      createBuffer(channels: number, length: number) {
        const data = Array.from({ length: channels }, () => new Float32Array(length));
        return {
          numberOfChannels: channels,
          length,
          getChannelData: (ch: number) => data[ch] ?? new Float32Array(length),
        };
      }
      createBufferSource() {
        const node = {
          kind: 'bufferSource',
          buffer: null as unknown,
          loop: false,
          started: false,
          stopped: false,
          connections: [] as MockAudioNode[],
          connect(dest: MockAudioNode) {
            this.connections.push(dest);
            return dest;
          },
          start() {
            this.started = true;
          },
          stop() {
            this.stopped = true;
          },
        };
        bufferSources.push(node);
        allNodes.push(node);
        return node;
      }
      resume() {
        return Promise.resolve();
      }
      suspend() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    }

    const visibilityListeners: Array<() => void> = [];
    const fakeDocument = {
      hidden: false,
      addEventListener: (type: string, cb: () => void) => {
        if (type === 'visibilitychange') {
          visibilityListeners.push(cb);
        }
      },
      removeEventListener: () => undefined,
    };
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'window', {
      value: { AudioContext: FakeAudioContext },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: fakeDocument,
      configurable: true,
    });

    try {
      const audio = createSynthAudio();
      expect(audio.isMuted()).toBe(false);
      expect(audio.isMusicEnabled()).toBe(true);
      audio.unlock();

      const activeWorld = {
        ...createInitialWorld(DEFAULT_SORTIE_SEED, true),
        events: [{ kind: 'cannon_fired' as const, faction: 'friendly' as const }],
      };
      audio.sync(activeWorld);

      const masterGain = gainNodes[0];
      const musicGain = gainNodes[1];
      const engineGain = gainNodes[2];
      expect(masterGain).toBeDefined();
      expect(musicGain).toBeDefined();
      expect(engineGain).toBeDefined();

      // Looping soundtrack source started and routes into musicGain -> masterGain.
      const bgmSource = bufferSources.find((src) => src.loop);
      expect(bgmSource).toBeDefined();
      expect(bgmSource?.started).toBe(true);
      expect(bgmSource?.connections).toContain(musicGain);

      // Winning shot transitioning straight into victory still dispatches explosion SFX.
      const oscCountBeforeWin = oscillators.length;
      audio.sync({
        ...activeWorld,
        phase: {
          kind: 'victory',
          elapsedSeconds: 42,
          enemiesDestroyed: 4,
          subsystemsDestroyed: 2,
        },
        events: [{ kind: 'subsystem_destroyed', label: 'SHIELD DOME' }],
      });
      expect(oscillators.length).toBeGreaterThan(oscCountBeforeWin);
      expect(bgmSource?.stopped).toBe(true);

      // Every node created except masterGain must NOT connect directly to destination.
      expect(masterGain?.connections).toContain(destination);
      for (const node of allNodes) {
        if (node !== masterGain) {
          expect(node.connections).not.toContain(destination);
        }
      }

      // Hiding tab stops active music immediately and returning does not restart music before active sync.
      audio.sync({ ...activeWorld, events: [] });
      const secondBgm = bufferSources.filter((src) => src.loop)[1];
      expect(secondBgm?.started).toBe(true);
      fakeDocument.hidden = true;
      for (const cb of visibilityListeners) cb();
      expect(secondBgm?.stopped).toBe(true);
      expect(musicGain?.gain.targets[musicGain.gain.targets.length - 1]).toBe(0);
      fakeDocument.hidden = false;
      for (const cb of visibilityListeners) cb();
      expect(musicGain?.gain.targets[musicGain.gain.targets.length - 1]).toBe(0);

      expect(audio.toggleMusic()).toBe(false);
      expect(audio.toggleMute()).toBe(true);
      expect(masterGain?.gain.targets[masterGain.gain.targets.length - 1]).toBe(0);
      audio.destroy();
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
      Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
    }
  });

  it('keeps in-game COMBAT_LOOP_SCORE voice parameters and notes in exact parity with tools/agent-audio/recipes/combat-loop.recipe.json', () => {
    expect(COMBAT_LOOP_SCORE.bpm).toBe(combatLoopRecipe.bpm);
    expect(COMBAT_LOOP_SCORE.beats).toBe(combatLoopRecipe.beats);
    expect(COMBAT_LOOP_SCORE.masterGainDb).toBe(combatLoopRecipe.masterGainDb);
    expect(COMBAT_LOOP_SCORE.loopWrap).toBe(combatLoopRecipe.loopWrap);
    expect(COMBAT_LOOP_SCORE.tracks.length).toBe(combatLoopRecipe.tracks.length);

    for (let i = 0; i < combatLoopRecipe.tracks.length; i += 1) {
      const actual = COMBAT_LOOP_SCORE.tracks[i];
      const expected = combatLoopRecipe.tracks[i];
      expect(actual).toBeDefined();
      expect(expected).toBeDefined();
      if (actual === undefined || expected === undefined) continue;

      expect(actual.id).toBe(expected.id);
      expect(actual.waveform).toBe(expected.voice.waveform);
      expect(actual.gainDb).toBe(expected.voice.gainDb);
      expect(actual.pan).toBe(expected.voice.pan);
      expect(actual.filterHz).toBe(expected.voice.filter.freqHz);
      expect(actual.filterQ).toBe(expected.voice.filter.q);
      expect(actual.attackS).toBe(expected.voice.envelope.attackS);
      expect(actual.decayS).toBe(expected.voice.envelope.decayS);
      expect(actual.sustainLevel).toBe(expected.voice.envelope.sustainLevel);
      expect(actual.releaseS).toBe(expected.voice.envelope.releaseS);
      expect(actual.drive).toBe(expected.voice.drive ?? 0);
      expect(actual.notes).toEqual(expected.notes);
    }
  });
});
