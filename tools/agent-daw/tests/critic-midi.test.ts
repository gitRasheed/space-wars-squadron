import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { critique } from '../src/critic.js';
import { exportMidi, parseMidi, PPQ } from '../src/midi.js';
import { expandTrackNotes, parseProject, type Project } from '../src/project.js';
import { project, track } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function demo(): Project {
  const r = parseProject(JSON.parse(fs.readFileSync(path.join(root, 'examples/star-wars-overture.daw.json'), 'utf8')));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

function edited(p: Project, edit: (raw: { tracks: { id: string; clips: { startBeat: number; notes: { midi: number; startBeat: number }[] }[] }[] }) => void): Project {
  const raw = JSON.parse(JSON.stringify(p)) as Parameters<typeof edit>[0];
  edit(raw);
  const r = parseProject(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

test('the demo overture scores at least 0.85 with no subscore below 0.8', () => {
  const c = critique(demo());
  assert.ok(c.score >= 0.85, `score ${c.score}`);
  for (const [k, v] of Object.entries(c.subscores)) assert.ok(v >= 0.8, `${k} ${v}`);
});

test('a monotonic piece (one note, quarter notes, one velocity) scores low and gets advice', () => {
  const notes = Array.from({ length: 32 }, (_, i) => ({ midi: 62, startBeat: i, durationBeats: 1, velocity: 90 }));
  const c = critique(project({ bars: 8, tracks: [track('p', 'piano', notes)] }));
  assert.ok(c.score < 0.35, `score ${c.score}`);
  assert.equal(c.subscores.motifRecall, 0);
  assert.equal(c.subscores.rhythmicVariety, 0);
  assert.ok(c.advice.length >= 4);
});

test('random notes score far below the composed demo, mostly on motif and harmony', () => {
  let seed = 42;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
  const notes = Array.from({ length: 64 }, (_, i) => ({ midi: 48 + Math.floor(rnd() * 36), startBeat: i * 0.5, durationBeats: 0.5, velocity: 60 + Math.floor(rnd() * 60) }));
  const c = critique(project({ bars: 8, tracks: [track('lead', 'piano', notes, { role: 'lead' })] }));
  const good = critique(demo());
  assert.ok(c.score < good.score - 0.3, `random ${c.score} vs demo ${good.score}`);
  assert.ok(c.subscores.motifRecall < 0.4 && c.subscores.harmonicFlow < 0.6, JSON.stringify(c.subscores));
});

test('removing the dominant before the wrap weakens the cadence', () => {
  const base = critique(demo());
  // Bar 16's A major (V) becomes D minor over A (C# -> D, E -> F), so the loop sits on the tonic into the wrap.
  const noCadence = edited(demo(), (raw) => {
    for (const t of raw.tracks)
      for (const c of t.clips)
        for (const n of c.notes) {
          const pc = n.midi % 12;
          if (c.startBeat + n.startBeat >= 60 && (pc === 1 || pc === 4)) n.midi += 1;
        }
  });
  const c = critique(noCadence);
  assert.ok(c.details.harmony.cadenceScore < base.details.harmony.cadenceScore, `${c.details.harmony.cadence}`);
  assert.ok(c.advice.some((a) => a.startsWith('harmonicFlow: cadence')));
});

test('low close-voiced chords are flagged as mud', () => {
  const chords = [36, 38, 41, 43].flatMap((r, b) => [r, r + 3, r + 7, r + 10].map((midi) => ({ midi, startBeat: b * 4, durationBeats: 4, velocity: 90 })));
  const c = critique(project({ bars: 4, tracks: [track('pad', 'synth-pad', chords), track('bass', 'synth-bass', [36, 38, 41, 43].map((midi, b) => ({ midi: midi - 12, startBeat: b * 4, durationBeats: 4, velocity: 90 })))] }));
  assert.ok(c.details.register.mudRatio > 0.5, `mud ${c.details.register.mudRatio}`);
  assert.ok(c.advice.some((a) => a.includes('below E3')));
});

test('MIDI export is a valid type-1 SMF that round-trips every note, the tempo and track names', () => {
  const p = demo();
  const bytes = exportMidi(p);
  const m = parseMidi(bytes);
  assert.equal(m.format, 1);
  assert.equal(m.ppq, PPQ);
  assert.equal(m.tracks, p.tracks.length + 1);
  assert.equal(m.tempoUsPerBeat, 500000);
  assert.deepEqual(m.trackNames.slice(1), p.tracks.map((t) => t.name));
  const expected = p.tracks.flatMap((t, i) => expandTrackNotes(p, t).map((n) => `${i + 1}:${n.midi}:${Math.round(n.startBeat * PPQ)}:${Math.max(Math.round(n.startBeat * PPQ) + 1, Math.round((n.startBeat + n.durationBeats) * PPQ))}`));
  // Overlapping repeats of the same key on one channel are legal in the project but merge in MIDI, so compare as multisets of onsets.
  const got = m.notes.map((n) => `${n.track}:${n.midi}:${n.startTick}`).sort();
  const want = expected.map((e) => e.split(':').slice(0, 3).join(':')).sort();
  assert.deepEqual(got, want);
  assert.ok(m.notes.filter((n) => n.track === p.tracks.findIndex((t) => t.instrument.type === 'orchestral-perc') + 1).every((n) => n.channel === 9), 'percussion on channel 10');
});

test('pitch bends export as pitch-wheel sweeps', () => {
  const p = project({ bars: 1, tracks: [track('g', 'guitar-electric', [{ midi: 52, startBeat: 0, durationBeats: 2, velocity: 100, pitchBend: 2 }])] });
  const bytes = exportMidi(p);
  let bends = 0;
  for (let i = 0; i + 2 < bytes.length; i += 1) if ((bytes[i] ?? 0) === 0xe0) bends += 1;
  assert.ok(bends >= 9, `found ${bends} bend events`);
});
