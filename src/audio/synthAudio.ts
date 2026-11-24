import { FLIGHT_TUNING } from '../sim/flight';
import { len } from '../sim/math';
import type { SimEvent, WorldState } from '../sim/types';
import { engineRunup, renderCue, type CueId } from './combatCues';
import { renderCombatLoopStereo } from './combatScore';

export interface SynthAudio {
  readonly unlock: () => void;
  readonly toggleMute: () => boolean;
  readonly isMuted: () => boolean;
  readonly toggleMusic: () => boolean;
  readonly isMusicEnabled: () => boolean;
  readonly sync: (world: WorldState) => void;
  readonly destroy: () => void;
}

function audioBuffer(ctx: AudioContext, samples: ReturnType<typeof renderCombatLoopStereo>) {
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

export function createSynthAudio(): SynthAudio {
  let buses: Buses | undefined;
  let musicBuffer: AudioBuffer | undefined;
  let musicSource: AudioBufferSourceNode | undefined;
  const cueBuffers = new Map<CueId, AudioBuffer>();
  const cannonSide = { friendly: 1, hostile: -1 };
  let muted = false;
  let musicEnabled = true;

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

  function syncMusic(bus: Buses, active: boolean) {
    if (!active || !musicEnabled) {
      stopMusic();
      bus.music.gain.setValueAtTime(0, bus.ctx.currentTime);
      return;
    }
    if (musicSource) return;
    musicBuffer ??= audioBuffer(bus.ctx, renderCombatLoopStereo(bus.ctx.sampleRate));
    musicSource = bus.ctx.createBufferSource();
    musicSource.buffer = musicBuffer;
    musicSource.loop = true;
    musicSource.connect(bus.music);
    bus.music.gain.setTargetAtTime(0.31, bus.ctx.currentTime, 0.04);
    musicSource.start();
  }

  function playCue(bus: Buses, id: CueId, side = 0) {
    const { ctx, effects } = bus;
    let buffer = cueBuffers.get(id);
    if (!buffer) {
      buffer = audioBuffer(ctx, renderCue(id, ctx.sampleRate));
      cueBuffers.set(id, buffer);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (side) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = side * 0.16;
      source.detune.value = side * 22;
      source.connect(pan).connect(effects);
    } else {
      source.connect(effects);
    }
    source.start();
  }

  function handleEvent(bus: Buses, event: SimEvent, next?: SimEvent) {
    switch (event.kind) {
      case 'cannon_fired':
        cannonSide[event.faction] *= -1;
        playCue(bus, event.faction === 'friendly' ? 'cannon-shot' : 'enemy-cannon', cannonSide[event.faction]);
        break;
      case 'hit_confirmed':
        playCue(bus, event.isKill ? 'kill-confirm' : 'hit-confirm');
        // A subsystem kill emits its own larger explosion immediately after the confirmation.
        if (event.isKill && next?.kind !== 'subsystem_destroyed') playCue(bus, 'explosion');
        break;
      case 'subsystem_destroyed': playCue(bus, 'subsystem-destruction'); break;
      case 'missile_fired': playCue(bus, 'missile-launch'); break;
      case 'target_locked': playCue(bus, 'lock-chirp'); break;
      case 'player_damaged': playCue(bus, 'player-damage'); break;
      case 'boost_engaged': playCue(bus, 'boost'); break;
      case 'drift_engaged': playCue(bus, 'snap-turn'); break;
    }
  }

  function sync(world: WorldState): void {
    if (!buses) return;
    const { ctx, engine, turbines } = buses;
    const audible = !muted && !document.hidden && ctx.state === 'running';
    const active = audible && world.phase.kind === 'active';
    syncMusic(buses, active);
    if (active) {
      const speed = Math.min(1, len(world.player.velocity) / FLIGHT_TUNING.boostSpeed);
      const boosting = world.player.energy.boostMode.kind === 'boosting';
      const throttle = speed * 0.78 + (boosting ? 0.22 : 0);
      for (const { osc, idleHz, boostHz } of turbines) {
        osc.frequency.setTargetAtTime(idleHz * (boostHz / idleHz) ** throttle, ctx.currentTime, 0.1);
      }
      engine.gain.setTargetAtTime(0.35 + 0.65 * throttle, ctx.currentTime, 0.09);
    } else {
      engine.gain.setTargetAtTime(0, ctx.currentTime, 0.035);
    }
    if (!audible) return;
    for (const [i, event] of world.events.entries()) handleEvent(buses, event, world.events[i + 1]);
  }

  function destroy(): void {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    stopMusic();
    if (buses) {
      for (const { osc } of buses.turbines) osc.stop();
      void buses.ctx.close();
      buses = undefined;
    }
    musicBuffer = undefined;
    cueBuffers.clear();
  }

  return { unlock, toggleMute, isMuted: () => muted, toggleMusic, isMusicEnabled: () => musicEnabled, sync, destroy };
}
