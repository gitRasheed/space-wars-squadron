import { FLIGHT_TUNING } from '../sim/flight';
import { len, toLocalPoint } from '../sim/math';
import type { SimEvent, WorldState } from '../sim/types';
import { BAKED_LOOP, loadBakedSoundtrack, type SoundtrackId } from './bakedSoundtrack';
import { CUE_IDS, engineRunup, renderCue, type CueId } from './combatCues';
import { combatLoopRenderer } from './combatScore';

export interface SynthAudioOptions {
  /** Baked level score to stream over the synthesized loop; `null` keeps the synthesized loop. */
  readonly soundtrack?: SoundtrackId | null;
}

export interface SynthAudio {
  readonly unlock: () => void;
  readonly toggleMute: () => boolean;
  readonly isMuted: () => boolean;
  readonly toggleMusic: () => boolean;
  readonly isMusicEnabled: () => boolean;
  readonly setSoundtrack: (id: SoundtrackId | null) => void;
  readonly sync: (world: WorldState) => void;
  readonly destroy: () => void;
}

const SCORE_SLICE_MS = 4;
const SYNTH_MUSIC_GAIN = 0.31;
// The baked scores are mastered about 1.4 LU hotter than the synthesized loop.
const BAKED_MUSIC_GAIN = 0.27;
// Hits landing within this many sim steps of the last one extend the chain.
const CHAIN_WINDOW_STEPS = 48;
// C D E G A sit in every level key, so the chain climbs D E G A C D over the hit-confirm's D.
const CHAIN_CENTS = [0, 200, 500, 700, 1000, 1200];
const INCOMING_COOLDOWN_STEPS = 30;
const CRIT_DUCK = { depth: 0.63, holdS: 0.12 };

interface CueOptions {
  readonly pan?: number;
  readonly detune?: number;
  readonly mirror?: boolean;
  readonly delayS?: number;
}

function audioBuffer(ctx: AudioContext, samples: ReturnType<typeof renderCue>) {
  const buffer = ctx.createBuffer(2, samples.left.length, ctx.sampleRate);
  buffer.getChannelData(0).set(samples.left);
  buffer.getChannelData(1).set(samples.right);
  return buffer;
}

function createBuses(ctx: AudioContext) {
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const bus = (volume: number) => {
    const gain = ctx.createGain();
    gain.gain.value = volume;
    gain.connect(master);
    return gain;
  };
  const music = bus(0);
  const engine = bus(0);
  const effects = bus(0.55);
  const turbines = engineRunup.voices.map(voice => {
    const osc = ctx.createOscillator();
    osc.type = voice.waveform === 'triangle' ? 'triangle' : 'sine';
    osc.frequency.value = voice.freqStartHz;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = voice.filter.freqHz;
    // Web Audio expresses lowpass resonance in dB. The recipe uses linear Q.
    filter.Q.value = 20 * Math.log10(voice.filter.q);
    const gain = ctx.createGain();
    gain.gain.value = 10 ** ((voice.gainDb + engineRunup.masterGainDb) / 20) * voice.envelope.sustainLevel;
    const pan = ctx.createStereoPanner();
    pan.pan.value = voice.pan;
    osc.connect(filter).connect(gain).connect(pan).connect(engine);
    osc.start();
    return { osc, idleHz: voice.freqStartHz, boostHz: voice.freqEndHz };
  });
  return { ctx, master, music, engine, effects, turbines };
}

type Buses = ReturnType<typeof createBuses>;

export function createSynthAudio(options: SynthAudioOptions = {}): SynthAudio {
  let buses: Buses | undefined;
  let scoreRender: ReturnType<typeof combatLoopRenderer> | undefined;
  let musicBuffer: AudioBuffer | undefined;
  let musicSource: AudioBufferSourceNode | undefined;
  let soundtrack = options.soundtrack === undefined ? 'saturn-orbit' : options.soundtrack;
  const bakedBuffers = new Map<SoundtrackId, AudioBuffer | 'loading' | 'unavailable'>();
  let musicGain = SYNTH_MUSIC_GAIN;
  const cueBuffers = new Map<CueId, AudioBuffer>();
  const mirroredBuffers = new Map<CueId, AudioBuffer>();
  const cannonSide = { friendly: 1, hostile: -1 };
  let muted = false;
  let musicEnabled = true;
  let step = 0;
  let chain = 0;
  let lastHitStep = -Infinity;
  let incomingReadyStep = 0;
  let threatSide = -1;

  function stopMusic(): void {
    musicSource?.stop();
    musicSource = undefined;
  }

  function onVisibilityChange(): void {
    if (!buses) return;
    const { ctx, master, music, engine } = buses;
    if (document.hidden) {
      stopMusic();
      master.gain.setValueAtTime(0, ctx.currentTime);
      music.gain.setValueAtTime(0, ctx.currentTime);
      engine.gain.setValueAtTime(0, ctx.currentTime);
      void ctx.suspend();
    } else if (!muted) {
      master.gain.setTargetAtTime(1, ctx.currentTime, 0.015);
      void ctx.resume();
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  function unlock(): void {
    if (document.hidden || typeof window.AudioContext !== 'function') return;
    buses ??= createBuses(new window.AudioContext());
    const { ctx, master } = buses;
    requestSoundtrack(buses);
    master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.015);
    if (ctx.state === 'suspended' && !muted) void ctx.resume();
  }

  function toggleMute(): boolean {
    muted = !muted;
    if (!muted) unlock();
    else if (buses) {
      buses.master.gain.setTargetAtTime(0, buses.ctx.currentTime, 0.015);
      stopMusic();
    }
    return muted;
  }

  function toggleMusic(): boolean {
    musicEnabled = !musicEnabled;
    if (!musicEnabled) stopMusic();
    return musicEnabled;
  }

  function bakedBuffer(): AudioBuffer | undefined {
    const baked = soundtrack ? bakedBuffers.get(soundtrack) : undefined;
    return typeof baked === 'object' ? baked : undefined;
  }

  function requestSoundtrack(bus: Buses) {
    const id = soundtrack;
    if (!id || bakedBuffers.has(id)) return;
    bakedBuffers.set(id, 'loading');
    void loadBakedSoundtrack(bus.ctx, id).then(buffer => {
      if (buses === bus) bakedBuffers.set(id, buffer ?? 'unavailable');
    });
  }

  function setSoundtrack(id: SoundtrackId | null): void {
    soundtrack = id;
    if (buses) requestSoundtrack(buses);
  }

  function syncMusic(bus: Buses, active: boolean) {
    const baked = bakedBuffer();
    // The synthesized loop keeps mixing until a baked score has decoded, so music never waits on the network.
    if (baked) scoreRender = undefined;
    else if (!musicBuffer) {
      scoreRender ??= combatLoopRenderer(bus.ctx.sampleRate);
      if (scoreRender.advance(SCORE_SLICE_MS)) {
        musicBuffer = audioBuffer(bus.ctx, scoreRender.buffer);
        scoreRender = undefined;
      }
    }
    const buffer = baked ?? musicBuffer;
    if (!active || !musicEnabled || !buffer) {
      stopMusic();
      bus.music.gain.setValueAtTime(0, bus.ctx.currentTime);
      return;
    }
    if (musicSource?.buffer === buffer) return;
    if (musicSource) {
      stopMusic();
      bus.music.gain.setValueAtTime(0, bus.ctx.currentTime);
    }
    musicSource = bus.ctx.createBufferSource();
    musicSource.buffer = buffer;
    musicSource.loop = true;
    musicSource.connect(bus.music);
    musicGain = baked ? BAKED_MUSIC_GAIN : SYNTH_MUSIC_GAIN;
    bus.music.gain.setTargetAtTime(musicGain, bus.ctx.currentTime, 0.04);
    if (baked) {
      musicSource.loopStart = BAKED_LOOP.startS;
      musicSource.loopEnd = BAKED_LOOP.endS;
      musicSource.start(0, BAKED_LOOP.startS);
    } else {
      musicSource.start();
    }
  }

  /** Dips the score under a crit so the bell reads, then lets it swell back. */
  function duckMusic({ ctx, music }: Buses) {
    if (!musicSource) return;
    music.gain.setTargetAtTime(musicGain * CRIT_DUCK.depth, ctx.currentTime, 0.008);
    music.gain.setTargetAtTime(musicGain, ctx.currentTime + CRIT_DUCK.holdS, 0.08);
  }

  function cueBuffer(ctx: AudioContext, id: CueId) {
    let buffer = cueBuffers.get(id);
    if (!buffer) {
      buffer = audioBuffer(ctx, renderCue(id, ctx.sampleRate));
      cueBuffers.set(id, buffer);
    }
    return buffer;
  }

  /** The cue with its channels swapped, for a pass that runs right to left. */
  function mirroredBuffer(ctx: AudioContext, id: CueId) {
    let buffer = mirroredBuffers.get(id);
    if (!buffer) {
      const original = cueBuffer(ctx, id);
      buffer = ctx.createBuffer(2, original.length, ctx.sampleRate);
      buffer.getChannelData(0).set(original.getChannelData(1));
      buffer.getChannelData(1).set(original.getChannelData(0));
      mirroredBuffers.set(id, buffer);
    }
    return buffer;
  }

  function playCue(bus: Buses, id: CueId, { pan = 0, detune = 0, mirror = false, delayS = 0 }: CueOptions = {}) {
    const { ctx, effects } = bus;
    const source = ctx.createBufferSource();
    source.buffer = mirror ? mirroredBuffer(ctx, id) : cueBuffer(ctx, id);
    source.detune.value = detune;
    if (pan) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      source.connect(panner).connect(effects);
    } else {
      source.connect(effects);
    }
    if (delayS) source.start(ctx.currentTime + delayS);
    else source.start();
  }

  /** Which side of the cockpit a world point is on: -1 hard left to 1 hard right. */
  function sideOf(world: WorldState, point: { readonly x: number; readonly y: number; readonly z: number }) {
    const local = toLocalPoint(world.player.position, world.player.orientation, point);
    return local.x / Math.max(1e-6, len(local));
  }

  function handleEvent(bus: Buses, world: WorldState, event: SimEvent, previous?: SimEvent, next?: SimEvent) {
    switch (event.kind) {
      case 'cannon_fired': {
        let side: number;
        if (event.barrel !== undefined) {
          side = event.barrel === 'left' ? -1 : 1;
        } else {
          cannonSide[event.faction] *= -1;
          side = cannonSide[event.faction];
        }
        playCue(bus, event.faction === 'friendly' ? 'cannon-shot' : 'enemy-cannon', { pan: side * 0.16, detune: side * 22 });
        break;
      }
      case 'hit_confirmed':
        if (event.isKill) {
          chain = 0;
          lastHitStep = -Infinity;
          playCue(bus, 'kill-confirm');
          // A subsystem kill emits its own larger explosion immediately after the confirmation.
          if (next?.kind !== 'subsystem_destroyed') playCue(bus, 'explosion');
        } else {
          chain = step - lastHitStep <= CHAIN_WINDOW_STEPS ? chain + 1 : 0;
          lastHitStep = step;
          playCue(bus, 'hit-confirm', { detune: CHAIN_CENTS[Math.min(chain, CHAIN_CENTS.length - 1)] ?? 0 });
        }
        break;
      case 'crit_hit':
        playCue(bus, 'crit-hit');
        duckMusic(bus);
        break;
      case 'near_miss':
        // The event carries no bearing, so the pass runs away from the last shooter's side.
        playCue(bus, 'near-miss', { mirror: threatSide > 0 });
        break;
      case 'supply_drop': playCue(bus, 'supply-drop'); break;
      // A drop that clears an overheat chimes first, then the cannons latch.
      case 'weapon_ready': playCue(bus, 'weapon-ready', { delayS: previous?.kind === 'supply_drop' ? 0.25 : 0 }); break;
      case 'incoming_fire': {
        const side = sideOf(world, event.position);
        threatSide = side < 0 ? -1 : 1;
        if (step < incomingReadyStep) break;
        incomingReadyStep = step + INCOMING_COOLDOWN_STEPS;
        playCue(bus, 'incoming-fire', { pan: side * 0.7 });
        break;
      }
      case 'shield_broken': playCue(bus, 'shield-break'); break;
      case 'weapon_overheated': playCue(bus, 'weapon-overheat'); break;
      case 'subsystem_destroyed': playCue(bus, 'subsystem-destruction'); break;
      case 'missile_fired': playCue(bus, 'missile-launch'); break;
      case 'target_locked': playCue(bus, 'lock-chirp'); break;
      case 'player_damaged': playCue(bus, 'player-damage'); break;
      case 'overdrive_engaged': playCue(bus, 'boost'); break;
    }
  }

  function sync(world: WorldState): void {
    if (!buses) return;
    step++;
    const { ctx, engine, turbines } = buses;
    const audible = !muted && !document.hidden && ctx.state === 'running';
    const active = audible && world.phase.kind === 'active';
    syncMusic(buses, active);
    // One cue per sync once the score is in, so a first shot or blast never renders mid-fight.
    const unrendered = (bakedBuffer() ?? musicBuffer) && CUE_IDS.find(id => !cueBuffers.has(id));
    if (unrendered) cueBuffer(ctx, unrendered);
    if (active) {
      const speed = Math.min(1, len(world.player.velocity) / FLIGHT_TUNING.overdriveSpeed);
      const overdrive = world.player.energy.overdrive;
      const throttle = speed * 0.78 + (overdrive ? 0.22 : 0);
      for (const { osc, idleHz, boostHz } of turbines) {
        osc.frequency.setTargetAtTime(idleHz * (boostHz / idleHz) ** throttle, ctx.currentTime, 0.1);
      }
      engine.gain.setTargetAtTime(0.35 + 0.65 * throttle, ctx.currentTime, 0.09);
    } else {
      engine.gain.setTargetAtTime(0, ctx.currentTime, 0.035);
    }
    if (!audible) return;
    for (const [i, event] of world.events.entries()) handleEvent(buses, world, event, world.events[i - 1], world.events[i + 1]);
  }

  function destroy(): void {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    stopMusic();
    if (buses) {
      for (const { osc } of buses.turbines) osc.stop();
      void buses.ctx.close();
      buses = undefined;
    }
    scoreRender = undefined;
    musicBuffer = undefined;
    bakedBuffers.clear();
    cueBuffers.clear();
    mirroredBuffers.clear();
  }

  return {
    unlock, toggleMute, isMuted: () => muted, toggleMusic, isMusicEnabled: () => musicEnabled, setSoundtrack, sync, destroy,
  };
}
