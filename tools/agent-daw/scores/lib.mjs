// Shared helpers for the level-score composers in this folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ARTS = { n: 'normal', l: 'legato', s: 'staccato', a: 'accent', z: 'sforzando' };

export const BPB = 4;

export function midi(name) {
  if (typeof name === 'number') return name;
  const match = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!match) throw new Error(`bad pitch "${name}"`);
  const [, letter, accidental, octave] = match;
  return 12 * (Number(octave) + 1) + PC[letter] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0);
}

export function note(pitch, startBeat, durationBeats, velocity, articulation = 'normal') {
  return {
    midi: midi(pitch),
    startBeat: Number(startBeat.toFixed(4)),
    durationBeats: Number(durationBeats.toFixed(4)),
    velocity: Math.max(1, Math.min(127, Math.round(velocity))),
    articulation,
  };
}

const DURATIONS = { t: 1 / 3, T: 2 / 3 };

/**
 * A line written left to right: "D4:1.5:104:a F4:.5 -:1 D4+A4:2:90:l".
 * Each token is pitch(es):beats[:velocity][:articulation]; "-" rests, "t" is a triplet eighth,
 * and a token without a velocity or an articulation keeps the previous one.
 */
export function line(startBar, text, { vel = 96, art = 'n', gain = 1, transpose = 0, offset = 0 } = {}) {
  const notes = [];
  let beat = startBar * BPB + offset;
  let velocity = vel;
  let articulation = art;
  for (const token of text.trim().split(/\s+/)) {
    const [pitches, length, ...marks] = token.split(':');
    const beats = DURATIONS[length] ?? Number(length);
    if (!(beats > 0)) throw new Error(`bad length in "${token}"`);
    for (const mark of marks) {
      if (mark in ARTS) articulation = mark;
      else if (Number(mark) > 0) velocity = Number(mark);
      else if (mark !== '') throw new Error(`bad velocity or articulation in "${token}"`);
    }
    if (pitches !== '-') {
      for (const p of pitches.split('+')) notes.push(note(midi(p) + transpose, beat, beats, velocity * gain, ARTS[articulation]));
    }
    beat += beats;
  }
  return notes;
}

export const shift = (notes, semitones) => notes.map((n) => ({ ...n, midi: n.midi + semitones }));
export const scaleVel = (notes, factor) => notes.map((n) => ({ ...n, velocity: Math.max(1, Math.min(127, Math.round(n.velocity * factor))) }));

/** One clip holding notes placed in absolute beats. */
export const clip = (id, notes) => ({ id, startBeat: 0, notes: [...notes].sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi) });

export const reverb = (preset, mix, extra = {}) => ({ type: 'reverb', preset, mix, ...extra });
export const eq = (lowDb, midDb, highDb, extra = {}) => ({ type: 'eq3', lowDb, midDb, highDb, ...extra });

export function writeProject(project) {
  const file = path.join(here, `${project.id}.daw.json`);
  // One note per line keeps the file reviewable without five lines per note.
  const noteBlock = /\{\s+"midi": (\d+),\s+"startBeat": ([\d.]+),\s+"durationBeats": ([\d.]+),\s+"velocity": (\d+),\s+"articulation": "(\w+)"\s+\}/g;
  const text = JSON.stringify(project, null, 2).replace(noteBlock, '{ "midi": $1, "startBeat": $2, "durationBeats": $3, "velocity": $4, "articulation": "$5" }');
  fs.writeFileSync(file, `${text}\n`);
  const notes = project.tracks.reduce((sum, t) => sum + t.clips.reduce((s, c) => s + c.notes.length, 0), 0);
  process.stdout.write(`${path.basename(file)}: ${project.tracks.length} tracks, ${notes} notes\n`);
}

export function loopProject({ id, title, tonic, mode, sections, tracks, compressor = { thresholdDb: -16, ratio: 2, attackMs: 25, releaseMs: 250 } }) {
  return {
    format: 'agent-daw/v1',
    id,
    title,
    kind: 'loop',
    loop: true,
    tempo: { bpm: 120, beatsPerBar: BPB },
    key: { tonic, mode },
    bars: 16,
    master: { targetLufs: -16, ceilingDbtp: -1.5, hpfHz: 30, compressor },
    sections,
    patterns: {},
    tracks,
  };
}
