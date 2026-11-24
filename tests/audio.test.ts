import { describe, expect, it } from 'vitest';
import { createSynthAudio } from '../src/audio/synthAudio';
import { DEFAULT_SORTIE_SEED } from '../src/sim/types';
import { createInitialWorld } from '../src/sim/world';

interface MockAudioNode {
  readonly kind: string;
  readonly connections: MockAudioNode[];
  connect(dest: MockAudioNode): MockAudioNode;
}

describe('synthAudio master bus mute', () => {
  it('routes engine and one-shot effects through a single master gain that mutes cleanly', () => {
    const destination: MockAudioNode = {
      kind: 'destination',
      connections: [],
      connect(dest) {
        this.connections.push(dest);
        return dest;
      },
    };
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

    class FakeAudioContext {
      readonly destination = destination;
      readonly state = 'running';
      readonly currentTime = 0.05;
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
        return node;
      }
      createOscillator() {
        return {
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
      }
      createBiquadFilter() {
        return {
          kind: 'filter',
          type: 'lowpass',
          frequency: { value: 0 },
          connections: [] as MockAudioNode[],
          connect(dest: MockAudioNode) {
            this.connections.push(dest);
            return dest;
          },
        };
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

    const fakeDocument = {
      hidden: false,
      addEventListener: () => undefined,
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
      expect(audio.toggleMute()).toBe(false);

      const world = {
        ...createInitialWorld(DEFAULT_SORTIE_SEED, true),
        events: [{ kind: 'subsystem_destroyed' as const, label: 'SHIELD DOME' }],
      };
      audio.sync(world);

      const masterGain = gainNodes[0];
      const effectGain = gainNodes[gainNodes.length - 1];
      expect(masterGain).toBeDefined();
      expect(effectGain).toBeDefined();
      expect(masterGain?.connections).toContain(destination);
      expect(effectGain?.connections).toContain(masterGain);
      expect(effectGain?.connections).not.toContain(destination);

      expect(audio.toggleMute()).toBe(true);
      expect(masterGain?.gain.targets[masterGain.gain.targets.length - 1]).toBe(0);
      audio.destroy();
    } finally {
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
      Object.defineProperty(globalThis, 'document', { value: originalDocument, configurable: true });
    }
  });
});
