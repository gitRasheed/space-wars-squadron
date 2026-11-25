import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gateAudio, type GateReport } from '../src/gate.js';
import { renderProject } from '../src/render.js';
import { decodeWav, encodeWav, type Audio } from '../src/wav.js';
import { SR, project, tmpDir, track } from './helpers.js';

// A short, clean orchestral loop: strings, piano, timpani and snare through the loop-safe master.
const clean: Audio = (() => {
  const chords = [[50, 57, 65], [46, 53, 62], [48, 55, 64], [45, 52, 61]];
  const p = project({
    bars: 4,
    tracks: [
      track('str', 'strings-ensemble', chords.flatMap((c, b) => c.map((midi) => ({ midi: midi + 12, startBeat: b * 4, durationBeats: 4, velocity: 90, articulation: 'legato' }))), { fx: [{ type: 'reverb', preset: 'hall', mix: 0.3 }] }),
      track('pno', 'piano', chords.flatMap((c, b) => [0, 1, 2, 1, 0, 1, 2, 1].map((k, i) => ({ midi: (c[k] ?? 60) + 12, startBeat: b * 4 + i * 0.5, durationBeats: 0.5, velocity: 80, articulation: i % 2 === 0 ? 'staccato' : 'normal' })))),
      track('cb', 'strings-bass', chords.map((c, b) => ({ midi: (c[0] ?? 48) - 12, startBeat: b * 4, durationBeats: 4, velocity: 95 })), { gainDb: -6 }),
      track('tim', 'timpani', [0, 4, 8, 12, 14].map((s) => ({ midi: 38, startBeat: s, durationBeats: 1, velocity: 115 })), { gainDb: -6 }),
      track('sn', 'orchestral-perc', [1, 3, 5, 7, 9, 11, 13, 15].map((s) => ({ midi: 38, startBeat: s, durationBeats: 0.5, velocity: 105 }))),
    ],
  });
  const r = renderProject(p);
  // Round-trip through 24-bit PCM: the gate judges the file, not the float buffer.
  return decodeWav(encodeWav({ sampleRate: SR, channels: [r.mix.left, r.mix.right] }, 24));
})();

const opts = { loop: true, bpm: 120, targetLufs: -16 } as const;
const codes = (r: GateReport): string[] => r.findings.map((f) => f.code);
const copy = (a: Audio): Audio => ({ sampleRate: a.sampleRate, channels: a.channels.map((c) => c.slice()) });
const L = (a: Audio): Float64Array => a.channels[0] ?? new Float64Array(0);
const R = (a: Audio): Float64Array => a.channels[1] ?? new Float64Array(0);

test('a clean rendered loop passes the gate with zero findings', () => {
  const r = gateAudio(clean, opts);
  assert.deepEqual(r.findings, []);
  assert.ok(r.ok);
});

test('timpani, snare and staccato piano onsets are not mistaken for clicks', () => {
  const r = gateAudio(clean, opts);
  assert.ok(Math.max(...r.clickRatio) < 25, `click ratios ${r.clickRatio.join(', ')}`);
});

test('planted clipping is caught', () => {
  const a = copy(clean);
  for (let i = 30000; i < 30040; i += 1) L(a)[i] = 1;
  assert.ok(codes(gateAudio(a, opts)).includes('clipping'));
});

test('planted DC offset is caught', () => {
  const a = copy(clean);
  for (const ch of a.channels) for (let i = 0; i < ch.length; i += 1) ch[i] += 0.01;
  assert.ok(codes(gateAudio(a, opts)).includes('dc_offset'));
});

test('a single-sample click mid-file is caught', () => {
  const a = copy(clean);
  L(a)[100000] += 0.35;
  const r = gateAudio(a, opts);
  assert.ok(codes(r).includes('click'), JSON.stringify(r.clickRatio));
  assert.ok(Math.abs((r.findings.find((f) => f.code === 'click')?.timeS ?? 0) - 100000 / SR) < 0.001);
});

test('50 Hz mains hum with harmonics is caught', () => {
  const a = copy(clean);
  for (const ch of a.channels) for (let i = 0; i < ch.length; i += 1) ch[i] += 0.006 * Math.sin((2 * Math.PI * 50 * i) / SR) + 0.003 * Math.sin((2 * Math.PI * 100 * i) / SR) + 0.002 * Math.sin((2 * Math.PI * 150 * i) / SR);
  const r = gateAudio(a, opts);
  assert.ok(codes(r).includes('hum'), JSON.stringify(r.hum));
});

test('sustained G1 (49 Hz) and B1 (61.7 Hz) bass under a steady timpani pulse are not mistaken for hum', () => {
  const p = project({
    bars: 4,
    tracks: [
      track('cb', 'strings-bass', [{ midi: 31, startBeat: 0, durationBeats: 16, velocity: 110 }]),
      track('sub', 'synth-bass', [0, 4, 8, 12].map((s) => ({ midi: 35, startBeat: s, durationBeats: 3, velocity: 100 }))),
      track('tim', 'timpani', [0, 2, 4, 6, 8, 10, 12, 14].map((s) => ({ midi: 38, startBeat: s, durationBeats: 1, velocity: 110 }))),
    ],
  });
  const r = renderProject(p);
  const g = gateAudio({ sampleRate: SR, channels: [r.mix.left, r.mix.right] }, opts);
  assert.ok(!codes(g).includes('hum'), JSON.stringify(g.hum));
});

test('a silent channel is caught', () => {
  const a = copy(clean);
  R(a).fill(0);
  assert.ok(codes(gateAudio(a, opts)).includes('silent_channel'));
});

test('a polarity-inverted channel is caught as a phase problem', () => {
  const a = copy(clean);
  const r = R(a);
  const l = L(a);
  for (let i = 0; i < r.length; i += 1) r[i] = -l[i];
  assert.ok(codes(gateAudio(a, opts)).includes('phase'));
});

test('a loop cut mid-note (seam discontinuity) is caught', () => {
  const a = copy(clean);
  const cut = Math.round(a.channels[0]?.length ?? 0) - 7000;
  const cropped: Audio = { sampleRate: SR, channels: a.channels.map((c) => c.slice(0, cut)) };
  const r = gateAudio(cropped, opts);
  assert.ok(codes(r).includes('loop_seam'), JSON.stringify(r.seam));
});

test('too quiet and muffled audio is caught', () => {
  const a = copy(clean);
  let z = 0;
  for (const ch of a.channels) {
    z = 0;
    for (let i = 0; i < ch.length; i += 1) {
      z += 0.01 * (ch[i] - z);
      ch[i] = z * 0.3;
    }
  }
  const c = codes(gateAudio(a, opts));
  assert.ok(c.includes('too_quiet') && c.includes('dull'), c.join(','));
});

test('the gate writes labelled waveform and spectrogram PNGs', () => {
  const dir = tmpDir();
  const r = gateAudio(clean, { ...opts, pngDir: dir, title: 'clean' });
  for (const f of [r.pngs?.waveform, r.pngs?.spectrogram]) {
    assert.ok(f !== undefined && fs.existsSync(f));
    assert.deepEqual([...fs.readFileSync(f).subarray(1, 4)], [80, 78, 71]);
  }
  fs.rmSync(path.resolve(dir), { recursive: true, force: true });
});
