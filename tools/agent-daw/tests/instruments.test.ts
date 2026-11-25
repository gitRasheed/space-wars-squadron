import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRng, midiToHz } from '../src/dsp.js';
import { INSTRUMENT_MODELS } from '../src/instruments/index.js';
import type { NoteEvent } from '../src/instruments/common.js';
import { pluck, tubeAmp } from '../src/instruments/guitar.js';
import { pianoInharmonicity, pianoPartialFreq } from '../src/instruments/piano.js';
import { INSTRUMENTS, type Articulation } from '../src/project.js';
import { renderTrack } from '../src/render.js';
import { SR, cents, centroid, mono, peakHz, project, rmsOf, sine, track } from './helpers.js';

function ev(midi: number, velocity = 0.8, durationS = 1, articulation: Articulation = 'normal', seed = 1): NoteEvent {
  return { midi, freq: midiToHz(midi), durationS, velocity, articulation, bendSemis: 0, slurred: false, rng: makeRng(seed) };
}

test('every instrument renders a finite, audible note that ends quieter than it peaks', () => {
  for (const type of INSTRUMENTS) {
    const midi = type === 'orchestral-perc' ? 38 : type.includes('bass') || type === 'timpani' ? 40 : 62;
    const out = INSTRUMENT_MODELS[type].render(ev(midi), type === 'cinematic-sfx' ? { preset: 'chime' } : {});
    const m = mono(out);
    assert.ok(m.every(Number.isFinite), `${type} produced NaN`);
    const loud = rmsOf(m, 0, Math.min(m.length, SR / 2));
    assert.ok(loud > 1e-3, `${type} is silent (rms ${loud})`);
    assert.ok(rmsOf(m, m.length - 2400) < loud, `${type} does not decay`);
  }
});

test('renders are deterministic for the same seed', () => {
  const a = INSTRUMENT_MODELS['strings-ensemble'].render(ev(64, 0.8, 0.5, 'normal', 7), {});
  const b = INSTRUMENT_MODELS['strings-ensemble'].render(ev(64, 0.8, 0.5, 'normal', 7), {});
  assert.deepEqual(a.left, b.left);
});

test('piano partials sit at the stiff-string stretched frequencies, not the harmonic ones', () => {
  const midi = 33;
  const out = INSTRUMENT_MODELS.piano.render(ev(midi, 0.9, 2), {});
  const n = 15;
  const stretched = pianoPartialFreq(midiToHz(midi), n, pianoInharmonicity(midi));
  const harmonic = n * midiToHz(midi);
  assert.ok(stretched - harmonic > 3, 'test note should be measurably inharmonic');
  const measured = peakHz(out.left, harmonic - 6, stretched + 6, 0, SR);
  assert.ok(Math.abs(measured - stretched) < 1.2, `partial ${n} at ${measured.toFixed(2)} Hz, expected ${stretched.toFixed(2)} (harmonic ${harmonic})`);
});

test('Karplus-Strong guitar strings are in tune within 5 cents across the neck', () => {
  for (const midi of [40, 52, 64, 76, 88]) {
    const f = midiToHz(midi);
    const s = pluck({ freq: f, velocity: 0.8, soundS: 1.5, t60: 3, brightness: 0.6, pickPosition: 0.13, muted: false, rng: makeRng(3) });
    const measured = peakHz(s, f * 0.97, f * 1.03, 2400, SR / 2);
    assert.ok(Math.abs(cents(measured, f)) < 5, `midi ${midi}: ${measured.toFixed(2)} Hz vs ${f.toFixed(2)} (${cents(measured, f).toFixed(1)} cents)`);
  }
});

test('brass gets brighter as it gets louder', () => {
  for (const type of ['brass-horn', 'brass-trumpet'] as const) {
    const soft = centroid(mono(INSTRUMENT_MODELS[type].render(ev(60, 0.3, 0.8), {})));
    const loud = centroid(mono(INSTRUMENT_MODELS[type].render(ev(60, 1.0, 0.8), {})));
    assert.ok(loud > soft * 1.25, `${type}: centroid ${soft.toFixed(0)} Hz soft vs ${loud.toFixed(0)} Hz loud`);
  }
});

test('string sections sit in orchestral seating: violins left, cellos right', () => {
  const side = (type: string): number => {
    const p = project({ bars: 1, loop: false, kind: 'cue', tracks: [track('s', type, [{ midi: type === 'strings-cello' ? 48 : 67, startBeat: 0, durationBeats: 2, velocity: 90 }])] });
    const t = p.tracks[0];
    if (t === undefined) throw new Error('no track');
    const { audio } = renderTrack(p, t, 1);
    return 20 * Math.log10(rmsOf(audio.left) / rmsOf(audio.right));
  };
  assert.ok(side('strings-ensemble') > 3, 'violins should lean left');
  assert.ok(side('strings-cello') < -3, 'cellos should lean right');
});

test('timpani rings at its tuned pitch', () => {
  const out = INSTRUMENT_MODELS.timpani.render(ev(43, 0.9, 1), {});
  const f = midiToHz(43);
  const measured = peakHz(mono(out), f * 0.9, f * 1.1, 4800, SR);
  assert.ok(Math.abs(cents(measured, f)) < 15, `timpani at ${measured.toFixed(2)} Hz vs ${f.toFixed(2)}`);
});

test('percussion map: snare is brighter than taiko, and the cymbal swell grows into its crash', () => {
  const taiko = centroid(mono(INSTRUMENT_MODELS['orchestral-perc'].render(ev(36), {})));
  const snare = centroid(mono(INSTRUMENT_MODELS['orchestral-perc'].render(ev(38), {})));
  assert.ok(snare > taiko * 3, `snare ${snare.toFixed(0)} Hz vs taiko ${taiko.toFixed(0)} Hz`);
  const swell = mono(INSTRUMENT_MODELS['orchestral-perc'].render(ev(55, 0.8, 2), {}));
  assert.ok(rmsOf(swell, SR * 1.5, SR * 2) > 3 * rmsOf(swell, 0, SR / 2), 'swell should rise');
});

test('doppler fly-by falls in pitch as it passes', () => {
  const out = mono(INSTRUMENT_MODELS['cinematic-sfx'].render(ev(57, 0.9, 2), { preset: 'doppler' }));
  const early = peakHz(out, 150, 400, Math.round(0.1 * SR), Math.round(0.5 * SR));
  const late = peakHz(out, 150, 400, Math.round(1.25 * SR), Math.round(0.5 * SR));
  assert.ok(early > late * 1.2, `approach ${early.toFixed(0)} Hz vs recede ${late.toFixed(0)} Hz`);
});

test('every cinematic-sfx preset renders, and an unknown preset is an error', () => {
  for (const preset of ['doppler', 'bell-impact', 'glass', 'shield-shatter', 'chime', 'riser', 'sub-drop']) {
    const out = mono(INSTRUMENT_MODELS['cinematic-sfx'].render(ev(60, 0.8, 1), { preset }));
    assert.ok(rmsOf(out) > 1e-4, `${preset} is silent`);
  }
  assert.throws(() => INSTRUMENT_MODELS['cinematic-sfx'].render(ev(60), { preset: 'kazoo' }), /unknown cinematic-sfx preset/);
});

test('the tube amp turns a pure tone into a harmonic-rich one as drive rises', () => {
  const thd = (drive: number): number => {
    const x = sine(220, 1, 0.3);
    const buf = { left: x.channels[0] ?? new Float64Array(0), right: x.channels[1] ?? new Float64Array(0) };
    tubeAmp(buf, drive);
    const seg = buf.left.subarray(SR / 2);
    const total = rmsOf(seg) ** 2;
    const fund = peakPower(seg, 220);
    return (total - fund) / total;
  };
  assert.ok(thd(20) > 10 * thd(1), `THD ${thd(1).toFixed(4)} at drive 1 vs ${thd(20).toFixed(4)} at drive 20`);
});

// Power of one sinusoid component by projection onto sin and cos at that frequency.
function peakPower(x: Float64Array, f: number): number {
  let c = 0;
  let s = 0;
  for (let i = 0; i < x.length; i += 1) {
    c += x[i] * Math.cos((2 * Math.PI * f * i) / SR);
    s += x[i] * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return (2 * (c * c + s * s)) / (x.length * x.length);
}
