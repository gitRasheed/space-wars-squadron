import { afterEach, describe, expect, it, vi } from 'vitest';
import cues from '../src/audio/combat-cues.json';
import { renderCue, type CueId } from '../src/audio/combatCues';
import { COMBAT_LOOP_SCORE, renderCombatLoopStereo } from '../src/audio/combatScore';
import { mixVoice, noiseGenerator, stereoBuffer } from '../src/audio/renderVoice';
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

// The stubbed clock gives each note a millisecond, so every tick mixes this many notes of the score.
const NOTES_PER_TICK = 4;
const SCORE_TICKS = Math.ceil(COMBAT_LOOP_SCORE.tracks.reduce((sum, track) => sum + track.notes.length, 0) / NOTES_PER_TICK);

function cockpit(warm = true) {
  const ctx = new AudioContextFake();
  const doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('window', { AudioContext: vi.fn(function () { return ctx; }) });
  vi.stubGlobal('document', doc);
  let clock = 0;
  vi.stubGlobal('performance', { now: () => clock++ });
  const audio = createSynthAudio();
  audio.unlock();
  const world = createInitialWorld(123, true);
  for (let i = 0; warm && i < SCORE_TICKS; i++) audio.sync({ ...world, phase: { kind: 'paused', elapsedSeconds: 0 } });
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
    tick({ kind: 'overdrive_engaged' }, { kind: 'cannon_fired', faction: 'hostile' });
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

  it('mixes the score across ticks and starts the loop only once it is complete', () => {
    const { ctx, tick } = cockpit(false);
    tick();
    expect(ctx.music).toHaveLength(0);
    for (let ticks = 1; ticks < SCORE_TICKS - 1; ticks++) tick();
    expect(ctx.music).toHaveLength(0);
    tick();
    expect(ctx.music[0]?.start).toHaveBeenCalledOnce();
    expect(ctx.music[0]?.buffer?.getChannelData(0)).toEqual(renderCombatLoopStereo(ctx.sampleRate).left);
    tick();
    expect(ctx.music).toHaveLength(1);
  });

  it('renders every cue in the quiet syncs after the score, ahead of its first trigger', () => {
    const { ctx, tick } = cockpit(false);
    const createBuffer = vi.spyOn(ctx, 'createBuffer');
    const playable = Object.keys(cues).length - 1;
    for (let i = 0; i < SCORE_TICKS + playable; i++) tick();
    expect(createBuffer).toHaveBeenCalledTimes(1 + playable);
    tick({ kind: 'missile_fired' }, { kind: 'subsystem_destroyed', label: 'SHIELD DOME' });
    expect(ctx.cues).toHaveLength(2);
    expect(createBuffer).toHaveBeenCalledTimes(1 + playable);
  });

  it('plays the confirmation and the larger blast on the winning tick and stops the loop', () => {
    const { ctx, audio, tick, world } = cockpit();
    tick();
    audio.sync({
      ...world,
      phase: { kind: 'victory', elapsedSeconds: 42, enemiesDestroyed: 4, subsystemsDestroyed: 2, reactorsDestroyed: 0 },
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
    tick({ kind: 'overdrive_engaged' });
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
    tick({ kind: 'overdrive_engaged' });
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
      { kind: 'target_locked' }, { kind: 'missile_fired' }, { kind: 'overdrive_engaged' },
      { kind: 'weapon_overheated' }, { kind: 'player_damaged' },
      { kind: 'shield_broken', position: { x: 0, y: 0, z: 0 } });
    const expected: CueId[] = ['hit-confirm', 'kill-confirm', 'explosion', 'lock-chirp',
      'missile-launch', 'boost', 'weapon-overheat', 'player-damage', 'shield-break'];
    expect(ctx.cues).toHaveLength(expected.length);
    for (const [i, id] of expected.entries()) {
      const source = ctx.cues[i];
      const left = source?.buffer?.getChannelData(0);
      expect(left).toEqual(renderCue(id, ctx.sampleRate).left);
      expect(left?.some(s => Math.abs(s) > .05)).toBe(true);
      expect(source?.start).toHaveBeenCalledOnce();
    }
  });

  it('smoothly raises both turbine pitches with speed and overdrive and closes them on teardown', () => {
    const { ctx, audio, world } = cockpit();
    const run = (speed: number, overdrive: boolean) => {
      audio.sync({ ...world, player: { ...world.player, velocity: { x: 0, y: 0, z: speed },
        energy: { ...world.player.energy, overdrive } } });
      return ctx.turbines.map(t => t.frequency.value);
    };
    const idle = run(0, false);
    const cruise = run(102, false);
    const overdriven = run(102, true);
    const full = run(168, true);
    expect(idle).toEqual([49, 50.5]);
    expect(full[0]).toBeCloseTo(128);
    expect(full[1]).toBeCloseTo(132);
    for (const [i, turbine] of ctx.turbines.entries()) {
      expect(cruise[i]).toBeGreaterThan(idle[i] ?? Infinity);
      expect(overdriven[i]).toBeGreaterThan(cruise[i] ?? Infinity);
      expect(turbine.frequency.timeConstant).toBeGreaterThan(0);
      expect(turbine.connections[0]).toMatchObject({ type: 'lowpass', frequency: { value: 290 } });
    }
    audio.destroy();
    for (const turbine of ctx.turbines) expect(turbine.stop).toHaveBeenCalledOnce();
  });

  it('keeps every cue voice inside its buffer, where the game and the reference draw the same noise', () => {
    for (const cue of Object.values(cues)) {
      for (const voice of cue.voices) {
        expect(voice.startS + voice.durationS + voice.envelope.releaseS, `${cue.id}/${voice.id}`).toBeLessThanOrEqual(cue.durationS);
      }
    }
  });

  it('stops drawing noise once a burst has decayed to silence, as the reference does', () => {
    const buffer = stereoBuffer(0.2, 48000);
    const noise = noiseGenerator(0x51a7c0de);
    const burst = (pan: number, envelope: [number, number, number, number], startS: number, holdS: number) => {
      const [attackS, decayS, sustainLevel, releaseS] = envelope;
      mixVoice(buffer, 48000, { waveform: 'noise', gainDb: -6, pan, envelope: { attackS, decayS, sustainLevel, releaseS } },
        { startS, holdS, startHz: 220, endHz: 220, gain: 1 }, noise, false);
    };
    burst(0, [0.001, 0.01, 0, 0.03], 0, 0.02);
    burst(0.3, [0.002, 0.02, 0.4, 0.05], 0.06, 0.05);
    for (const [frame, l, r] of [[3600, 5106, 8333], [4800, -809, -1319], [6000, 933, 1522]] as const) {
      expect(Math.round((buffer.left[frame] ?? NaN) * 32768)).toBe(l);
      expect(Math.round((buffer.right[frame] ?? NaN) * 32768)).toBe(r);
    }
  });

  // [frame, left, right] in PCM16 at 48 kHz, read from the reference renders of the standalone recipes.
  const referenceFrames: Record<CueId, readonly (readonly [number, number, number])[]> = {
    'cannon-shot': [[2669, -1524, -1467], [6093, 415, 761], [8019, -52, -328]],
    'enemy-cannon': [[1918, 1580, 2055], [3835, -475, -572], [5852, -400, -499]],
    'hit-confirm': [[2268, 2793, 2698], [4535, -1104, -334], [6804, 207, 50]],
    'kill-confirm': [[5609, 2773, 4128], [11231, 1023, 528], [16828, 770, 945]],
    'lock-chirp': [[5132, -5144, -6476], [10264, 1297, 1094], [15399, -247, 338]],
    'missile-launch': [[13982, 1057, 535], [27964, -1819, -1622], [41954, 475, 451]],
    'explosion': [[16359, 2001, 913], [32717, 644, 488], [49094, 202, 402]],
    'subsystem-destruction': [[23887, -1841, -1690], [47779, -475, -470], [71740, 215, 206]],
    'shield-break': [[9240, 3203, 1211], [18475, 715, 1685], [27719, 101, 183]],
    'weapon-overheat': [[753, 3918, 3066], [9572, 5509, 5749], [19144, 822, 1644], [28726, -502, -483]],
    'boost': [[5217, -1929, -1495], [10434, -4760, -4046], [15655, -468, -603]],
    'player-damage': [[4470, 4750, 4772], [8940, 4277, 4610], [13469, -405, -405]],
  };
  it.each(Object.entries(referenceFrames))('renders %s as the reference does, through every layered voice', (id, frames) => {
    const { left, right } = renderCue(id as CueId, 48000);
    for (const [frame, l, r] of frames) {
      expect(Math.round((left[frame] ?? NaN) * 32768)).toBe(l);
      expect(Math.round((right[frame] ?? NaN) * 32768)).toBe(r);
    }
  });

  it('renders the left and right levels of each four-beat phrase from the gated PCM16 score', () => {
    const { left, right } = renderCombatLoopStereo(48000);
    const framesPerBar = 76800;
    const reference = [
      [0.0899999, 0.0876048], [0.0879379, 0.0851806], [0.0891037, 0.0858638], [0.0924508, 0.0892980],
      [0.0947892, 0.0936925], [0.0920475, 0.0917464], [0.0948554, 0.0932953], [0.0936772, 0.0977316],
      [0.1132299, 0.1184966], [0.1159467, 0.1215001], [0.1163667, 0.1209840], [0.1108841, 0.1170788],
      [0.1179014, 0.1227040], [0.1148320, 0.1208090], [0.1109743, 0.1187290], [0.1173703, 0.1262527],
    ] as const;
    expect(left.length).toBe(reference.length * framesPerBar);
    const rms = (samples: Float32Array, bar: number) => {
      const slice = samples.subarray(bar * framesPerBar, (bar + 1) * framesPerBar);
      return Math.sqrt(slice.reduce((sum, sample) => sum + sample ** 2, 0) / framesPerBar);
    };
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
