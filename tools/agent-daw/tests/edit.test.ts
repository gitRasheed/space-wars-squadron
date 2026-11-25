import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { hasBinary, runEdit } from '../src/edit.js';
import { integratedLufs } from '../src/loudness.js';
import { readWav, writeWav, type Audio } from '../src/wav.js';
import { SR, peakHz, sine, tmpDir } from './helpers.js';

const dir = tmpDir();
const file = (name: string): string => path.join(dir, name);

function withSilence(a: Audio, leadS: number, tailS: number): Audio {
  return { sampleRate: SR, channels: a.channels.map((c) => {
    const out = new Float64Array(c.length + Math.round((leadS + tailS) * SR));
    out.set(c, Math.round(leadS * SR));
    return out;
  }) };
}

const len = (a: Audio): number => (a.channels[0]?.length ?? 0) / SR;
const ch0 = (a: Audio): Float64Array => a.channels[0] ?? new Float64Array(0);

test('trim-silence removes leading and trailing silence to within 20 ms', () => {
  writeWav(file('pad.wav'), withSilence(sine(440, 0.5), 0.3, 0.4));
  runEdit({ op: 'trim-silence', inputs: [file('pad.wav')], out: file('trim.wav') });
  assert.ok(Math.abs(len(readWav(file('trim.wav'))) - 0.5) < 0.02);
});

test('fade ramps the ends to silence', () => {
  writeWav(file('tone.wav'), sine(440, 1, 0.5));
  runEdit({ op: 'fade', inputs: [file('tone.wav')], out: file('fade.wav'), params: { in: 0.05, out: 0.1 } });
  const a = ch0(readWav(file('fade.wav')));
  assert.ok(Math.abs(a[0] ?? 1) < 1e-3 && Math.abs(a[a.length - 1] ?? 1) < 1e-3);
  assert.ok(Math.max(...a.subarray(SR / 2, SR / 2 + 200).map(Math.abs)) > 0.45);
});

test('normalize hits the LUFS target with constant gain', () => {
  writeWav(file('quiet.wav'), sine(440, 3, 0.02));
  runEdit({ op: 'normalize', inputs: [file('quiet.wav')], out: file('norm.wav'), params: { lufs: -16 } });
  const a = readWav(file('norm.wav'));
  assert.ok(Math.abs((integratedLufs(a.channels, SR) ?? 0) + 16) < 0.2);
});

test('native pitch shift moves 440 Hz up three semitones within 4 Hz and keeps the duration', () => {
  writeWav(file('a440.wav'), sine(440, 1.5, 0.4));
  runEdit({ op: 'pitch', inputs: [file('a440.wav')], out: file('pitch.wav'), params: { semitones: 3 } });
  const a = readWav(file('pitch.wav'));
  const f = peakHz(ch0(a), 400, 650, SR / 4, SR);
  assert.ok(Math.abs(f - 440 * Math.pow(2, 3 / 12)) < 4, `got ${f} Hz`);
  assert.ok(Math.abs(len(a) - 1.5) < 0.01);
});

test('native stretch changes duration but not pitch', () => {
  writeWav(file('s.wav'), sine(330, 1, 0.4));
  runEdit({ op: 'stretch', inputs: [file('s.wav')], out: file('st.wav'), params: { ratio: 1.5 } });
  const a = readWav(file('st.wav'));
  assert.ok(Math.abs(len(a) - 1.5) < 0.01);
  assert.ok(Math.abs(peakHz(ch0(a), 280, 380, SR / 4, SR / 2) - 330) < 4);
});

test('layer mixes inputs with gains and offsets', () => {
  writeWav(file('l1.wav'), sine(220, 0.5, 0.2));
  writeWav(file('l2.wav'), sine(660, 0.5, 0.2));
  runEdit({ op: 'layer', inputs: [file('l1.wav'), file('l2.wav')], out: file('layer.wav'), params: { gainsDb: [0, -6], offsetsS: [0, 0.25] } });
  assert.ok(Math.abs(len(readWav(file('layer.wav'))) - 0.75) < 0.001);
});

test('rubberband backend pitch-shifts when the binary is installed', { skip: !hasBinary('rubberband') }, () => {
  runEdit({ op: 'pitch', backend: 'rubberband', inputs: [file('a440.wav')], out: file('rb.wav'), params: { semitones: 3 } });
  const f = peakHz(ch0(readWav(file('rb.wav'))), 400, 650, SR / 4, SR);
  assert.ok(Math.abs(f - 523.25) < 4, `got ${f}`);
});

test('sox backend stretches when the binary is installed', { skip: !hasBinary('sox') }, () => {
  runEdit({ op: 'stretch', backend: 'sox', inputs: [file('s.wav')], out: file('sox.wav'), params: { ratio: 2 } });
  assert.ok(Math.abs(len(readWav(file('sox.wav'))) - 2) < 0.05);
});
