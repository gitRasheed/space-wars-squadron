import { afterEach, describe, expect, it, vi } from 'vitest';
import cues from '../src/audio/combat-cues.json';
import { renderCue, type CueId } from '../src/audio/combatCues';
import { COMBAT_LOOP_SCORE, renderCombatLoopStereo } from '../src/audio/combatScore';
import { createSynthAudio } from '../src/audio/synthAudio';
import type { SimEvent } from '../src/sim/types';
import { createInitialWorld } from '../src/sim/world';

class Node {
  connections: Node[] = [];
  connect<T extends Node>(dest: T): T {
    this.connections.push(dest);
    return dest;
  }
}
class Param {
  value = 0;
  timeConstant = 0;
  setTargetAtTime(value: number, _when: number, timeConstant: number) {
    this.value = value;
    this.timeConstant = timeConstant;
  }
  setValueAtTime(value: number) { this.value = value; }
}
class Gain extends Node { gain = new Param(); }
class Panner extends Node { pan = new Param(); }
class Filter extends Node { type = ''; frequency = new Param(); Q = new Param(); }
class Source extends Node { start = vi.fn(); stop = vi.fn(); }
class Oscillator extends Source { type = ''; frequency = new Param(); }
class BufferSource extends Source {
  buffer?: ReturnType<AudioContextFake['createBuffer']>;
  detune = new Param();
  loop = false;
}
class AudioContextFake {
  destination = new Node();
  state = 'running';
  currentTime = 0.05;
  sampleRate = 8000;
  nodes: Node[] = [];
  private register<T extends Node>(node: T): T { this.nodes.push(node); return node; }
  createGain() { return this.register(new Gain()); }
  createStereoPanner() { return this.register(new Panner()); }
  createBiquadFilter() { return this.register(new Filter()); }
  createOscillator() { return this.register(new Oscillator()); }
  createBufferSource() { return this.register(new BufferSource()); }
  createBuffer(channels: number, length: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, getChannelData: (ch: number) => data[ch] };
  }
  resume = vi.fn();
  suspend = vi.fn();
  close = vi.fn();
  get sources() { return this.nodes.filter(n => n instanceof BufferSource); }
  get cues() { return this.sources.filter(n => !n.loop); }
  get music() { return this.sources.filter(n => n.loop); }
  get turbines() { return this.nodes.filter(n => n instanceof Oscillator); }
}

function cockpit() {
  const ctx = new AudioContextFake();
  const doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('window', { AudioContext: vi.fn(function () { return ctx; }) });
  vi.stubGlobal('document', doc);
  const audio = createSynthAudio();
  audio.unlock();
  const world = createInitialWorld(123, true);
  const tick = (...events: SimEvent[]) => { audio.sync({ ...world, events }); };
  const visibility = (hidden: boolean) => {
    doc.hidden = hidden;
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  return { ctx, audio, tick, world, visibility };
}

afterEach(() => vi.unstubAllGlobals());

describe('combat audio', () => {
  it('keeps every Web Audio path, including both turbines and alternating cannon panners, behind master', () => {
    const { ctx, tick } = cockpit();
    tick({ kind: 'boost_engaged' }, { kind: 'cannon_fired', faction: 'hostile' });
    const outputs = ctx.nodes.filter(node => node.connections.includes(ctx.destination));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toBeInstanceOf(Gain);
    const pathToMaster = (node: Node): boolean => node === outputs[0] ||
      (node.connections.length > 0 && node.connections.every(pathToMaster));
    expect(ctx.nodes.every(pathToMaster)).toBe(true);
    expect(ctx.music[0]?.start).toHaveBeenCalledOnce();
    expect(ctx.cues).toHaveLength(2);
    expect(ctx.turbines).toHaveLength(2);
  });

  it('plays the confirmation and the larger blast on the winning tick and stops the loop', () => {
    const { ctx, audio, tick, world } = cockpit();
    tick();
    audio.sync({
      ...world,
      phase: { kind: 'victory', elapsedSeconds: 42, enemiesDestroyed: 4, subsystemsDestroyed: 2 },
      events: [{ kind: 'hit_confirmed', isKill: true }, { kind: 'subsystem_destroyed', label: 'SHIELD DOME' }],
    });
    expect(ctx.music[0]?.stop).toHaveBeenCalledOnce();
    expect(ctx.cues.map(s => s.buffer?.length)).toEqual(
      [cues['kill-confirm'], cues['subsystem-destruction']].map(c => c.durationS * ctx.sampleRate)
    );
    for (const source of ctx.cues) expect(source.start).toHaveBeenCalledOnce();
  });

  it('stops on hide, ignores hidden ticks and waits for active flight before restarting', () => {
    const { ctx, audio, visibility, world, tick } = cockpit();
    tick();
    const master = ctx.nodes.find(n => n.connections.includes(ctx.destination));
    const musicGain = ctx.music[0]?.connections[0];
    expect(master).toBeInstanceOf(Gain);
    expect(musicGain).toBeInstanceOf(Gain);
    visibility(true);
    tick({ kind: 'boost_engaged' });
    expect(ctx.suspend).toHaveBeenCalledOnce();
    expect(ctx.music[0]?.stop).toHaveBeenCalledOnce();
    expect((master as Gain).gain.value).toBe(0);
    expect((musicGain as Gain).gain.value).toBe(0);
    expect(ctx.cues).toHaveLength(0);
    visibility(false);
    expect(ctx.resume).toHaveBeenCalledOnce();
    audio.sync({ ...world, phase: { kind: 'paused', elapsedSeconds: 1 } });
    expect(ctx.music).toHaveLength(1);
    tick();
    expect(ctx.music).toHaveLength(2);
    expect(ctx.music[1]?.buffer).toBe(ctx.music[0]?.buffer);
    expect((musicGain as Gain).gain.value).toBeGreaterThan(0);
    expect(audio.toggleMusic()).toBe(false);
    tick({ kind: 'target_locked' });
    expect(ctx.music[1]?.stop).toHaveBeenCalledOnce();
    expect(ctx.cues).toHaveLength(1);
    expect(audio.toggleMute()).toBe(true);
    tick({ kind: 'boost_engaged' });
    expect((master as Gain).gain.value).toBe(0);
    expect(ctx.cues).toHaveLength(1);
    audio.destroy();
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it('varies pan and pitch independently for each faction and reuses the rendered shots', () => {
    const { ctx, tick } = cockpit();
    const player = { kind: 'cannon_fired', faction: 'friendly' } as const;
    const enemy = { kind: 'cannon_fired', faction: 'hostile' } as const;
    tick(player, enemy, enemy, player);
    expect(ctx.cues.map(s => s.detune.value)).toEqual([-22, 22, -22, 22]);
    expect(ctx.cues.map(s => (s.connections[0] as Panner).pan.value)).toEqual([-.16, .16, -.16, .16]);
    expect(ctx.cues[0]?.buffer).toBe(ctx.cues[3]?.buffer);
    expect(ctx.cues[1]?.buffer).toBe(ctx.cues[2]?.buffer);
    expect(ctx.cues[0]?.buffer).not.toBe(ctx.cues[1]?.buffer);
  });

  it('dispatches the layered cues for each combat event', () => {
    const { ctx, tick } = cockpit();
    tick({ kind: 'hit_confirmed', isKill: false }, { kind: 'hit_confirmed', isKill: true },
      { kind: 'target_locked' }, { kind: 'missile_fired' }, { kind: 'boost_engaged' },
      { kind: 'drift_engaged' }, { kind: 'player_damaged' });
    const expected: CueId[] = ['hit-confirm', 'kill-confirm', 'explosion', 'lock-chirp',
      'missile-launch', 'boost', 'snap-turn', 'player-damage'];
    expect(ctx.cues).toHaveLength(expected.length);
    for (const [i, id] of expected.entries()) {
      const source = ctx.cues[i];
      const left = source?.buffer?.getChannelData(0);
      expect(left).toEqual(renderCue(id, ctx.sampleRate).left);
      expect(left?.some(s => Math.abs(s) > .05)).toBe(true);
      expect(source?.start).toHaveBeenCalledOnce();
    }
  });

  it('smoothly raises both turbine pitches with speed and boost and closes them on teardown', () => {
    const { ctx, audio, world } = cockpit();
    const run = (speed: number, mode: 'ready' | 'boosting') => {
      audio.sync({ ...world, player: { ...world.player, velocity: { x: 0, y: 0, z: speed },
        energy: { ...world.player.energy, boostMode: { kind: mode } } } });
      return ctx.turbines.map(t => t.frequency.value);
    };
    const idle = run(0, 'ready');
    const cruise = run(102, 'ready');
    const boosted = run(102, 'boosting');
    const full = run(180, 'boosting');
    expect(idle).toEqual([49, 50.5]);
    expect(full[0]).toBeCloseTo(128);
    expect(full[1]).toBeCloseTo(132);
    for (const [i, turbine] of ctx.turbines.entries()) {
      expect(cruise[i]).toBeGreaterThan(idle[i] ?? Infinity);
      expect(boosted[i]).toBeGreaterThan(cruise[i] ?? Infinity);
      expect(turbine.frequency.timeConstant).toBeGreaterThan(0);
      expect(turbine.connections[0]).toMatchObject({ type: 'lowpass', frequency: { value: 290 } });
    }
    audio.destroy();
    for (const turbine of ctx.turbines) expect(turbine.stop).toHaveBeenCalledOnce();
  });

  it('preserves the seeded debris burst when the preceding noise envelope ends on a sample boundary', () => {
    const { left, right } = renderCue('explosion', 48000);
    const reference = [[4981, -2045, -2693], [7111, -77, 561], [10029, 932, 1156]] as const;
    for (const [frame, l, r] of reference) {
      expect(Math.round((left[frame] ?? NaN) * 32768)).toBe(l);
      expect(Math.round((right[frame] ?? NaN) * 32768)).toBe(r);
    }
  });

  it('renders the left and right levels of each four-beat phrase from the gated PCM16 score', () => {
    const { left, right } = renderCombatLoopStereo(48000);
    const framesPerBar = 76800;
    expect(left.length).toBe(4 * framesPerBar);
    const rms = (samples: Float32Array, bar: number) => {
      const slice = samples.subarray(bar * framesPerBar, (bar + 1) * framesPerBar);
      return Math.sqrt(slice.reduce((sum, sample) => sum + sample ** 2, 0) / framesPerBar);
    };
    const reference = [[0.1047285, 0.1169037], [0.0949218, 0.1056347], [0.105278, 0.1176913], [0.0968301, 0.1073069]] as const;
    for (const [bar, [l, r]] of reference.entries()) {
      expect(rms(left, bar)).toBeCloseTo(l, 5);
      expect(rms(right, bar)).toBeCloseTo(r, 5);
    }
  });

  it.each([COMBAT_LOOP_SCORE, ...Object.values(cues)])('matches the standalone reference recipe for $id', async recipe => {
    const { readFileSync } = await vi.importActual<{ readFileSync: (path: URL, encoding: 'utf8') => string }>('node:fs');
    const reference = new URL(`../tools/agent-audio/recipes/${recipe.id}.recipe.json`, import.meta.url);
    expect(recipe).toEqual(JSON.parse(readFileSync(reference, 'utf8')));
  });
});
