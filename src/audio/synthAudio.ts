import type { SimEvent, WorldState } from '../sim/types';

export interface SynthAudio {
  readonly unlock: () => void;
  readonly toggleMute: () => boolean;
  readonly isMuted: () => boolean;
  readonly sync: (world: WorldState) => void;
  readonly destroy: () => void;
}

export function createSynthAudio(): SynthAudio {
  let ctx: AudioContext | null = null;
  let engineOsc: OscillatorNode | null = null;
  let engineGain: GainNode | null = null;
  let muted = true;

  function onVisibilityChange(): void {
    if (ctx === null || engineGain === null) {
      return;
    }
    if (document.hidden) {
      engineGain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
      void ctx.suspend();
    } else if (!muted) {
      void ctx.resume();
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  function ensureContext(): AudioContext | null {
    if (ctx !== null) {
      return ctx;
    }
    const AudioCtor = window.AudioContext;
    if (typeof AudioCtor !== 'function') {
      return null;
    }
    ctx = new AudioCtor();
    engineOsc = ctx.createOscillator();
    engineGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 340;
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = 72;
    engineGain.gain.value = 0;
    engineOsc.connect(filter);
    filter.connect(engineGain);
    engineGain.connect(ctx.destination);
    engineOsc.start();
    return ctx;
  }

  function unlock(): void {
    if (muted) {
      return;
    }
    const audio = ensureContext();
    if (audio !== null && audio.state === 'suspended') {
      void audio.resume();
    }
  }

  function toggleMute(): boolean {
    muted = !muted;
    if (!muted) {
      unlock();
    } else if (engineGain !== null && ctx !== null) {
      engineGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    }
    return muted;
  }

  function playTone(
    startFreq: number,
    endFreq: number,
    duration: number,
    gainPeak: number,
    type: OscillatorType,
  ): void {
    if (muted || ctx === null || ctx.state !== 'running') {
      return;
    }
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + duration);
    gain.gain.setValueAtTime(gainPeak, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  function handleEvent(event: SimEvent): void {
    switch (event.kind) {
      case 'cannon_fired':
        if (event.faction === 'friendly') {
          playTone(760, 190, 0.08, 0.09, 'sawtooth');
        }
        break;
      case 'missile_fired':
        playTone(420, 110, 0.34, 0.12, 'triangle');
        break;
      case 'target_locked':
        playTone(1180, 1480, 0.11, 0.07, 'sine');
        break;
      case 'hit_confirmed':
        if (event.isKill) {
          playTone(150, 34, 0.42, 0.18, 'sawtooth');
        } else {
          playTone(940, 1220, 0.06, 0.06, 'square');
        }
        break;
      case 'player_damaged':
        playTone(190, 60, 0.22, 0.15, 'square');
        break;
      case 'boost_engaged':
        playTone(180, 440, 0.25, 0.08, 'triangle');
        break;
      case 'drift_engaged':
        playTone(360, 140, 0.28, 0.08, 'sine');
        break;
      case 'subsystem_destroyed':
        playTone(120, 28, 0.6, 0.22, 'sawtooth');
        break;
    }
  }

  function sync(world: WorldState): void {
    if (muted || ctx === null || engineOsc === null || engineGain === null) {
      return;
    }
    const now = ctx.currentTime;
    const isActive = world.phase.kind === 'active';
    const boostAdd = world.player.energy.boostMode.kind === 'boosting' ? 58 : 0;
    const driftShift = world.player.energy.boostMode.kind === 'drifting' ? -18 : 0;
    const targetFreq = 64 + world.player.speed * 0.72 + boostAdd + driftShift;
    engineOsc.frequency.setTargetAtTime(Math.max(40, targetFreq), now, 0.08);
    engineGain.gain.setTargetAtTime(isActive ? 0.045 : 0.008, now, 0.1);

    for (const event of world.events) {
      handleEvent(event);
    }
  }

  function destroy(): void {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (ctx !== null) {
      void ctx.close();
      ctx = null;
    }
  }

  return {
    unlock,
    toggleMute,
    isMuted: () => muted,
    sync,
    destroy,
  };
}
