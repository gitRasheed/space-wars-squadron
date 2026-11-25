import assert from 'node:assert/strict';
import { test } from 'node:test';
import { biquad, biquadRun, stereo } from '../src/dsp.js';
import { applyFx, loopSafeRate, type FxContext } from '../src/fx.js';
import { gateAudio } from '../src/gate.js';
import { measureTruePeak } from '../src/loudness.js';
import { limit, masterBus } from '../src/master.js';
import { parseProject, type FxConfig } from '../src/project.js';
import { renderProject, renderTrack } from '../src/render.js';
import { SR, centroid, peakHz, project, rmsOf, sine, track } from './helpers.js';

const ctx: FxContext = { sampleRate: SR, secondsPerBeat: 0.5, loopFrames: null };

function fx(raw: Record<string, unknown>): FxConfig {
  const r = parseProject({ format: 'agent-daw/v1', id: 'f', bars: 1, tracks: [{ id: 't', instrument: 'piano', fx: [raw] }] });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const f = r.value.tracks[0]?.fx[0];
  if (f === undefined) throw new Error('no fx');
  return f;
}

function impulse(frames: number): { left: Float64Array; right: Float64Array } {
  const b = stereo(frames);
  b.left[0] = 1;
  b.right[0] = 1;
  return b;
}

test('ping-pong delay bounces the echo left then right at the tempo-synced time', () => {
  const b = impulse(SR * 2);
  applyFx(b, fx({ type: 'delay', timeBeats: 0.5, feedback: 0.5, mix: 1, pingPong: true, dampHz: 20000 }), ctx);
  const d = 0.25 * SR;
  assert.ok(Math.abs(b.left[d]) > 0.3 && Math.abs(b.right[d]) < 1e-9, 'first echo on the left only');
  assert.ok(Math.abs(b.right[2 * d]) > 0.1, 'second echo on the right');
});

test('hall reverb leaves a decaying, decorrelated stereo tail', () => {
  const b = impulse(SR * 3);
  applyFx(b, fx({ type: 'reverb', preset: 'hall', decay: 0.85, mix: 1, predelayMs: 20 }), ctx);
  const early = rmsOf(b.left, SR * 0.1, SR * 0.6);
  const late = rmsOf(b.left, SR * 2, SR * 2.5);
  assert.ok(early > 1e-4 && late < early / 4, `tail ${early} -> ${late}`);
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = SR * 0.1; i < SR; i += 1) {
    lr += b.left[i] * b.right[i];
    ll += b.left[i] * b.left[i];
    rr += b.right[i] * b.right[i];
  }
  assert.ok(Math.abs(lr / Math.sqrt(ll * rr)) < 0.6, 'left and right tails should differ');
});

test('eq3 high shelf cut darkens and a low shelf boost adds weight', () => {
  const noise = stereo(SR);
  let seed = 1;
  for (let i = 0; i < SR; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    noise.left[i] = noise.right[i] = seed / 2147483648 - 0.5;
  }
  const before = centroid(noise.left);
  applyFx(noise, fx({ type: 'eq3', lowDb: 9, highDb: -12 }), ctx);
  assert.ok(centroid(noise.left) < before * 0.6);
});

test('compressor narrows the gap between loud and quiet passages', () => {
  const s = sine(220, 2, 0.05);
  const b = { left: s.channels[0] ?? new Float64Array(0), right: s.channels[1] ?? new Float64Array(0) };
  for (let i = SR; i < 2 * SR; i += 1) {
    b.left[i] *= 12;
    b.right[i] *= 12;
  }
  const before = rmsOf(b.left, SR + SR / 2, 2 * SR) / rmsOf(b.left, SR / 2, SR);
  applyFx(b, fx({ type: 'compressor', thresholdDb: -30, ratio: 6, attackMs: 5, releaseMs: 50 }), ctx);
  const after = rmsOf(b.left, SR + SR / 2, 2 * SR) / rmsOf(b.left, SR / 2, SR);
  assert.ok(after < before / 3, `ratio ${before.toFixed(2)} -> ${after.toFixed(2)}`);
});

test('overdrive and cab: drive adds harmonics, the cab rolls off the fizz above 8 kHz', () => {
  const s = sine(330, 1, 0.4);
  const b = { left: s.channels[0] ?? new Float64Array(0), right: s.channels[1] ?? new Float64Array(0) };
  applyFx(b, fx({ type: 'overdrive', drive: 30, tone: 1, mix: 1 }), ctx);
  const driven = centroid(b.left);
  assert.ok(driven > 330 * 1.25, `driven centroid ${driven}`);
  const fizz = (x: Float64Array): number => {
    const probe = x.slice();
    for (const f of [biquad('highpass', 8000, 0.7), biquad('highpass', 8000, 0.7), biquad('highpass', 8000, 0.7)]) biquadRun(f, probe);
    return rmsOf(probe) / rmsOf(x);
  };
  const before = fizz(b.left);
  applyFx(b, fx({ type: 'cab' }), ctx);
  assert.ok(fizz(b.left) < before / 2, `share above 8 kHz ${before} -> ${fizz(b.left)}`);
});

test('chorus LFO snaps to a whole number of cycles per loop', () => {
  const loopCtx: FxContext = { ...ctx, loopFrames: 32 * SR };
  const rate = loopSafeRate(0.37, loopCtx);
  assert.ok(Number.isInteger(Number((rate * 32).toFixed(9))), `rate ${rate} x 32 s`);
  assert.equal(loopSafeRate(0.37, ctx), 0.37);
});

test('lookahead limiter holds the ceiling without touching quiet material', () => {
  const s = sine(1000, 0.5, 0.2);
  const b = { left: s.channels[0] ?? new Float64Array(0), right: s.channels[1] ?? new Float64Array(0) };
  for (let i = 12000; i < 12100; i += 1) b.left[i] = 1.6 * Math.sin(i);
  const { out } = limit(b, -3);
  assert.ok(Math.max(...out.left.map(Math.abs)) <= Math.pow(10, -3 / 20) + 1e-9);
  assert.ok(Math.abs(out.left[2000] - b.left[2000]) < 1e-12, 'quiet passage untouched');
});

test('reverb tails and note releases wrap across the loop boundary', () => {
  const p = project({ bars: 2, tracks: [track('p', 'piano', [{ midi: 60, startBeat: 7, durationBeats: 1, velocity: 110 }], { fx: [{ type: 'reverb', preset: 'hall', decay: 0.9, mix: 0.5 }] })] });
  const r = renderProject(p);
  const head = rmsOf(r.mix.left, 0, SR / 10);
  assert.ok(head > 1e-3, `loop start should carry the wrapped tail (rms ${head})`);
});

test('loop-safe render and master keep the wrap as smooth as a bar line; a one-shot render and direct master do not', () => {
  // A loud chord in the last bar rings through hall reverb into bar 1, where only a quiet pad plays.
  const raw = {
    bars: 2,
    master: { targetLufs: -14, ceilingDbtp: -1 },
    tracks: [
      track('pad', 'synth-pad', [{ midi: 50, startBeat: 0, durationBeats: 8, velocity: 50 }]),
      track('brass', 'brass-horn', [{ midi: 62, startBeat: 5, durationBeats: 3, velocity: 120 }, { midi: 69, startBeat: 5, durationBeats: 3, velocity: 120 }], { fx: [{ type: 'reverb', preset: 'hall', decay: 0.9, mix: 0.5 }] }),
    ],
  };
  const step = (l: Float64Array, r: Float64Array): number => gateAudio({ sampleRate: SR, channels: [l, r] }, { loop: true, bpm: 120 }).seam?.wrapStep ?? Infinity;
  const safe = renderProject(project(raw));
  const oneShot = renderProject(project({ ...raw, loop: false, kind: 'cue' }), { tailS: 0 });
  const cut = stereo(safe.frames);
  cut.left.set(oneShot.mix.left.subarray(0, safe.frames));
  cut.right.set(oneShot.mix.right.subarray(0, safe.frames));
  const direct = masterBus(cut, project(raw).master, false).out;
  const safeStep = step(safe.mix.left, safe.mix.right);
  const directStep = step(direct.left, direct.right);
  assert.ok(safeStep < 6, `loop-safe wrap step ${safeStep}`);
  assert.ok(directStep > 3 * safeStep, `direct wrap step ${directStep} vs loop-safe ${safeStep}`);
});

test('master bus lands on the loudness target under the true-peak ceiling', () => {
  const p = project({ bars: 2, master: { targetLufs: -14, ceilingDbtp: -1 }, tracks: [track('b', 'brass-trumpet', [{ midi: 72, startBeat: 0, durationBeats: 8, velocity: 120 }])] });
  const r = renderProject(p);
  assert.ok(Math.abs((r.master.lufs ?? 0) + 14) < 0.3, `lufs ${String(r.master.lufs)}`);
  assert.ok((measureTruePeak([r.mix.left, r.mix.right]).truePeakDbtp ?? 0) <= -1);
});

test('the master bus on a seamless loop leaves the wrap seamless (compressor and filters see the wrapped audio)', () => {
  // 440 Hz over exactly 2 s is 880 whole cycles, so the input wraps perfectly.
  const s = sine(440, 2, 0.5);
  const input = { left: s.channels[0] ?? new Float64Array(0), right: s.channels[1] ?? new Float64Array(0) };
  const { out } = masterBus(input, { targetLufs: -14, ceilingDbtp: -1, hpfHz: 30, compressor: { thresholdDb: -30, ratio: 4, attackMs: 25, releaseMs: 250 } }, true);
  const seam = gateAudio({ sampleRate: SR, channels: [out.left, out.right] }, { loop: true, bpm: 120 }).seam;
  assert.ok(seam !== null && seam.wrapStep < 3 && seam.wrapJumpDb < 0.5, JSON.stringify(seam));
});

test('layer stems sum to the master when the limiter is idle', () => {
  const p = project({
    bars: 2,
    master: { targetLufs: -26, ceilingDbtp: -1, compressor: { thresholdDb: -40, ratio: 3, attackMs: 10, releaseMs: 200 } },
    tracks: [
      track('a', 'strings-ensemble', [{ midi: 62, startBeat: 0, durationBeats: 8, velocity: 100 }], { layer: 'base' }),
      track('b', 'brass-trumpet', [{ midi: 74, startBeat: 2, durationBeats: 4, velocity: 120 }], { layer: 'combat' }),
    ],
  });
  const r = renderProject(p);
  assert.equal(r.master.limiterGrDb, 0);
  assert.ok(r.master.compressorGrDb > 3, 'the compressor must be working for this test to mean anything');
  let maxDiff = 0;
  for (let i = 0; i < r.frames; i += 1) {
    const sum = (r.stems.base?.left[i] ?? 0) + (r.stems.combat?.left[i] ?? 0);
    maxDiff = Math.max(maxDiff, Math.abs(sum - r.mix.left[i]));
  }
  assert.ok(maxDiff < 1e-9, `stems differ from the mix by ${maxDiff}`);
});

test('chorus modulates the signal and its loop-snapped LFO keeps a looped tone seamless', () => {
  const s = sine(440, 2, 0.4);
  const b = { left: s.channels[0] ?? new Float64Array(0), right: s.channels[1] ?? new Float64Array(0) };
  const p = project({ bars: 1, tracks: [track('pad', 'synth-pad', [{ midi: 57, startBeat: 0, durationBeats: 4, velocity: 90 }], { fx: [{ type: 'chorus', rateHz: 0.7, depthMs: 4, mix: 0.5 }] })] });
  applyFx(b, fx({ type: 'chorus', rateHz: 0.7, depthMs: 4, mix: 0.5 }), ctx);
  let diffLR = 0;
  for (let i = SR / 2; i < SR; i += 1) diffLR = Math.max(diffLR, Math.abs(b.left[i] - b.right[i]));
  assert.ok(diffLR > 0.01, 'quadrature LFOs should make left and right differ');
  const r = renderProject(p);
  const seam = gateAudio({ sampleRate: SR, channels: [r.mix.left, r.mix.right] }, { loop: true, bpm: 120 }).seam;
  assert.ok(seam !== null && seam.wrapStep < 6, JSON.stringify(seam));
});

test('volume automation follows its points in dB', () => {
  const notes = [{ midi: 60, startBeat: 0, durationBeats: 8, velocity: 100 }];
  const flat = project({ bars: 2, master: { compressor: null }, tracks: [track('p', 'synth-pad', notes, { instrument: { type: 'synth-pad', params: { attack: 0.01 } } })] });
  const ducked = project({ bars: 2, master: { compressor: null }, tracks: [track('p', 'synth-pad', notes, { instrument: { type: 'synth-pad', params: { attack: 0.01 } }, automation: [{ param: 'volume', points: [{ beat: 0, value: 0 }, { beat: 3, value: 0 }, { beat: 3.01, value: -12 }, { beat: 5, value: -12 }, { beat: 5.01, value: 0 }] }] })] });
  const db = (x: number, y: number): number => 20 * Math.log10(x / y);
  const quiet = rmsOf(renderTrackAudio(ducked, 0), 3.5 * SR / 2, 4.5 * SR / 2);
  const loud = rmsOf(renderTrackAudio(flat, 0), 3.5 * SR / 2, 4.5 * SR / 2);
  assert.ok(Math.abs(db(quiet, loud) + 12) < 0.5, `${db(quiet, loud)} dB`);
});

test('per-note pan and pitch bend reach the audio', () => {
  const p = project({ bars: 1, loop: false, kind: 'cue', tracks: [track('s', 'synth-bass', [{ midi: 45, startBeat: 0, durationBeats: 2, velocity: 100, pan: -1, pitchBend: 12 }], { pan: 0 })] });
  const audio = renderTrackAudioStereo(p, 0);
  assert.ok(rmsOf(audio.left) > 20 * rmsOf(audio.right), 'hard-left note');
  const early = peakHz(audio.left, 90, 260, Math.round(0.02 * SR), Math.round(0.15 * SR));
  const late = peakHz(audio.left, 150, 260, Math.round(0.8 * SR), Math.round(0.15 * SR));
  assert.ok(Math.abs(early - 110) < 12 && late > 190, `bend ${early.toFixed(1)} -> ${late.toFixed(1)} Hz`);
});

function renderTrackAudioStereo(p: ReturnType<typeof project>, idx: number): { left: Float64Array; right: Float64Array } {
  const t = p.tracks[idx];
  if (t === undefined) throw new Error('no track');
  return renderTrack(p, t, 1).audio;
}

function renderTrackAudio(p: ReturnType<typeof project>, idx: number): Float64Array {
  return renderTrackAudioStereo(p, idx).left;
}
