import { len } from '../sim/math';
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
  let masterGain: GainNode | null = null;
  let engineOsc: OscillatorNode | null = null;
  let engineGain: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let muted = true;

  function onVisibilityChange(): void {
    if (ctx === null || masterGain === null) {
      return;
    }
    if (document.hidden) {
      masterGain.gain.setTargetAtTime(0, ctx.currentTime, 0.015);
      void ctx.suspend();
    } else if (!muted) {
      masterGain.gain.setTargetAtTime(1, ctx.currentTime, 0.015);
      void ctx.resume();
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  function ensureNoiseBuffer(audio: AudioContext): AudioBuffer | null {
    if (noiseBuffer !== null) {
      return noiseBuffer;
    }
    if (typeof audio.createBuffer !== 'function') {
      return null;
    }
    const sampleRate = audio.sampleRate || 48000;
    const length = Math.floor(sampleRate * 0.6);
    const buffer = audio.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x51a7c0de;
    for (let i = 0; i < length; i += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      data[i] = ((seed >>> 0) / 4294967296) * 2 - 1;
    }
    noiseBuffer = buffer;
    return buffer;
  }

  function ensureContext(): AudioContext | null {
    if (ctx !== null) {
      return ctx;
    }
    const AudioCtor = window.AudioContext;
    if (typeof AudioCtor !== 'function') {
      return null;
    }
    ctx = new AudioCtor();
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 1;
    masterGain.connect(ctx.destination);

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
    engineGain.connect(masterGain);
    engineOsc.start();
    return ctx;
  }

  function unlock(): void {
    if (muted) {
      return;
    }
    const audio = ensureContext();
    if (audio !== null) {
      if (masterGain !== null) {
        masterGain.gain.setTargetAtTime(1, audio.currentTime, 0.015);
      }
      if (audio.state === 'suspended') {
        void audio.resume();
      }
    }
  }

  function toggleMute(): boolean {
    muted = !muted;
    if (!muted) {
      unlock();
    } else if (masterGain !== null && ctx !== null) {
      masterGain.gain.setTargetAtTime(0, ctx.currentTime, 0.015);
    }
    return muted;
  }

  function playTone(
    startFreq: number,
    endFreq: number,
    duration: number,
    gainPeak: number,
    type: OscillatorType,
    delayS = 0,
    lowpassHz?: number,
  ): void {
    if (muted || ctx === null || masterGain === null || ctx.state !== 'running') {
      return;
    }
    const start = ctx.currentTime + delayS;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), start + duration);
    gain.gain.setValueAtTime(gainPeak, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    if (lowpassHz !== undefined) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = lowpassHz;
      osc.connect(filter);
      filter.connect(gain);
    } else {
      osc.connect(gain);
    }
    gain.connect(masterGain);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function playNoiseBurst(
    duration: number,
    gainPeak: number,
    centerHz: number,
    q: number,
    delayS = 0,
  ): void {
    if (
      muted ||
      ctx === null ||
      masterGain === null ||
      ctx.state !== 'running' ||
      typeof ctx.createBufferSource !== 'function'
    ) {
      return;
    }
    const buffer = ensureNoiseBuffer(ctx);
    if (buffer === null) {
      return;
    }
    const start = ctx.currentTime + delayS;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = centerHz;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainPeak, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    src.start(start);
    src.stop(start + duration + 0.02);
  }

  function handleEvent(event: SimEvent): void {
    switch (event.kind) {
      case 'cannon_fired':
        if (event.faction === 'friendly') {
          // Layered 80 ms cannon recipe: saw sweep + sub punch + bandpass breech click.
          playTone(860, 165, 0.08, 0.08, 'sawtooth', 0, 3400);
          playTone(190, 68, 0.06, 0.07, 'sine');
          playNoiseBurst(0.028, 0.045, 2400, 1.3);
        }
        break;
      case 'missile_fired':
        playTone(460, 115, 0.32, 0.1, 'triangle', 0, 1800);
        playNoiseBurst(0.28, 0.07, 1200, 0.9);
        break;
      case 'target_locked':
        // Distinct upper-mid 2-step 110 ms chirp (1320 Hz -> 1760 Hz) cuts cleanly over engine & cannon fire.
        playTone(1320, 1320, 0.045, 0.075, 'sine', 0);
        playTone(1760, 1760, 0.06, 0.085, 'triangle', 0.045);
        break;
      case 'hit_confirmed':
        if (event.isKill) {
          playTone(155, 34, 0.42, 0.16, 'sawtooth', 0, 900);
          playNoiseBurst(0.36, 0.12, 480, 0.7);
        } else {
          playTone(980, 1280, 0.06, 0.055, 'square', 0, 3200);
        }
        break;
      case 'player_damaged':
        playTone(190, 58, 0.22, 0.14, 'square', 0, 1100);
        playNoiseBurst(0.14, 0.08, 700, 1.0);
        break;
      case 'boost_engaged':
        playTone(180, 440, 0.24, 0.075, 'triangle');
        playNoiseBurst(0.2, 0.045, 1600, 0.8);
        break;
      case 'drift_engaged':
        playTone(360, 135, 0.26, 0.075, 'sine');
        break;
      case 'subsystem_destroyed':
        playTone(125, 28, 0.58, 0.2, 'sawtooth', 0, 750);
        playNoiseBurst(0.52, 0.16, 360, 0.65);
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
    const targetFreq = 64 + len(world.player.velocity) * 0.72 + boostAdd + driftShift;
    engineOsc.frequency.setTargetAtTime(Math.max(40, targetFreq), now, 0.08);
    engineGain.gain.setTargetAtTime(isActive ? 0.042 : 0.008, now, 0.1);

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
