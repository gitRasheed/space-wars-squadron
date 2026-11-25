// Builds examples/star-wars-overture.daw.json: an original heroic overture in D minor
// (brass fanfare, soaring strings, timpani, rock guitar counter-riff, piano arpeggios).
// Run from tools/agent-daw: node examples/compose-overture.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const m = (name) => {
  const [, pc, oct] = /^([A-G](?:#|b)?)(-?\d)$/.exec(name);
  return 12 * (Number(oct) + 1) + NOTE[pc];
};
const note = (pitch, startBeat, durationBeats, velocity, articulation = 'normal', extra = {}) => ({
  midi: typeof pitch === 'number' ? pitch : m(pitch),
  startBeat,
  durationBeats,
  velocity: Math.max(1, Math.min(127, Math.round(velocity))),
  articulation,
  ...extra,
});

// Bars 1-16: fanfare | flight | dogfight | climax. Each chord is [bass root, triad tones in the middle register].
const CHORDS = [
  ['D2', ['D4', 'F4', 'A4']], ['Bb1', ['D4', 'F4', 'Bb4']], ['F2', ['C4', 'F4', 'A4']], ['C2', ['C4', 'E4', 'G4']],
  ['D2', ['D4', 'F4', 'A4']], ['Bb1', ['D4', 'F4', 'Bb4']], ['G1', ['D4', 'G4', 'Bb4']], ['A1', ['C#4', 'E4', 'A4']],
  ['D2', ['D4', 'F4', 'A4']], ['C2', ['C4', 'E4', 'G4']], ['Bb1', ['D4', 'F4', 'Bb4']], ['A1', ['C#4', 'E4', 'A4']],
  ['Bb1', ['D4', 'F4', 'Bb4']], ['C2', ['C4', 'E4', 'G4']], ['D2', ['D4', 'F4', 'A4']], ['A1', ['C#4', 'E4', 'A4']],
];
const SECTIONS = [
  { id: 'fanfare', startBar: 0, bars: 4, layer: 'base' },
  { id: 'flight', startBar: 4, bars: 4, layer: 'tension' },
  { id: 'dogfight', startBar: 8, bars: 4, layer: 'combat' },
  { id: 'climax', startBar: 12, bars: 4, layer: 'climax' },
];
const BPB = 4;
const sectionDyn = { fanfare: 1, flight: 0.72, dogfight: 1.08, climax: 1.18 };

// The hook: a repeated-note pickup that leaps a fifth, then falls by step. Reused transposed in every section.
function hook(root, start, vel, art = 'accent') {
  return [
    note(root, start, 0.75, vel, art),
    note(root, start + 0.75, 0.25, vel * 0.85, 'staccato'),
    note(root + 7, start + 1, 2, vel * 1.05, 'legato'),
    note(root + 5, start + 3, 0.5, vel * 0.9),
    note(root + 3, start + 3.5, 0.5, vel * 0.88),
  ];
}
function hookTail(root, start, vel) {
  return [
    note(root + 3, start, 1.5, vel, 'legato'),
    note(root + 5, start + 1.5, 0.5, vel * 0.85),
    note(root + 3, start + 2, 1, vel * 0.9),
    note(root, start + 3, 1, vel * 0.8, 'legato'),
  ];
}

const clip = (id, startBar, notes) => ({ id, startBeat: startBar * BPB, notes });

const MINOR = new Set(['D2', 'G1']);
// Open voicing (root and fifth in the tenor, third an octave up) keeps thirds out of the low register.
function openVoicing(bar) {
  const root = m(CHORDS[bar][0]) + 12;
  return [root, root + 7, root + 12 + (MINOR.has(CHORDS[bar][0]) ? 3 : 4)];
}

function hornsTrack() {
  const D4 = m('D4');
  const fanfare = [
    ...hook(D4, 0, 104),
    ...hookTail(D4, 4, 98),
    note('A4', 8, 0.75, 100, 'accent'), note('A4', 8.75, 0.25, 88, 'staccato'), note('C5', 9, 1.5, 106, 'legato'), note('Bb4', 10.5, 0.5, 92), note('A4', 11, 1, 96),
    note('G4', 12, 2, 98, 'legato'), note('E4', 14, 1, 90), note('G4', 15, 0.5, 86), note('A4', 15.5, 0.5, 92, 'accent'),
  ];
  // Dogfight: the hook head sequenced down by step, horns answering the trumpets.
  const dogfight = [
    note('A3', 2, 1, 96, 'sforzando'), note('A3', 3.5, 0.5, 90, 'accent'),
    note('G3', 6, 1, 94, 'sforzando'), note('G3', 7.5, 0.5, 88, 'accent'),
    note('F3', 10, 1, 94, 'sforzando'), note('F3', 11.5, 0.5, 88, 'accent'),
    note('E3', 12, 2, 98, 'legato'), note('C#4', 14, 2, 102, 'accent'),
  ];
  // Climax: the full hook in octaves with the trumpets, re-harmonised over Bb and C.
  const climax = [
    ...hook(m('D4'), 0, 112),
    ...hookTail(m('D4'), 4, 108),
    ...hook(m('D4'), 8, 116),
    note('E4', 12, 1.5, 112, 'legato'), note('F4', 13.5, 0.5, 106), note('E4', 14, 1, 110), note('C#4', 15, 1, 118, 'sforzando'),
  ];
  return {
    id: 'horns', name: 'French horns (a4)', role: 'lead', layer: 'base', gainDb: -2,
    instrument: { type: 'brass-horn', params: { players: 4 } },
    fx: [{ type: 'eq3', lowDb: -2, midDb: 1.5, highDb: 0, lowHz: 180, midHz: 700, highHz: 5000, midQ: 0.8 }, { type: 'reverb', preset: 'hall', decay: 0.84, mix: 0.32, predelayMs: 28, damping: 0.45 }],
    clips: [clip('fanfare', 0, fanfare), clip('dogfight', 8, dogfight), clip('climax', 12, climax)],
  };
}

function trumpetsTrack() {
  const dogfight = [
    ...hook(m('D5'), 0, 108),
    note('C5', 4, 0.75, 104, 'accent'), note('C5', 4.75, 0.25, 92, 'staccato'), note('G5', 5, 2, 110, 'legato'), note('F5', 7, 0.5, 96), note('E5', 7.5, 0.5, 94),
    ...hook(m('Bb4'), 8, 106),
    note('A5', 12, 1, 112, 'sforzando'), note('G5', 13, 0.5, 100), note('F5', 13.5, 0.5, 98), note('E5', 14, 2, 108, 'legato'),
  ];
  const climax = [
    ...hook(m('D5'), 0, 120),
    ...hookTail(m('D5'), 4, 114),
    ...hook(m('D5'), 8, 124),
    note('E5', 12, 1.5, 120, 'legato'), note('F5', 13.5, 0.5, 112), note('E5', 14, 1, 116), note('C#5', 15, 0.5, 122, 'sforzando'), note('E5', 15.5, 0.5, 124, 'accent'),
  ];
  return {
    id: 'trumpets', name: 'Trumpets (a3)', role: 'lead', layer: 'combat', gainDb: -4, pan: 0.22,
    instrument: { type: 'brass-trumpet', params: { players: 3 } },
    fx: [{ type: 'eq3', lowDb: -3, midDb: 0, highDb: -1.5, lowHz: 250, midHz: 1500, highHz: 6000, midQ: 0.8 }, { type: 'reverb', preset: 'hall', decay: 0.84, mix: 0.3, predelayMs: 24, damping: 0.4 }],
    clips: [clip('dogfight', 8, dogfight), clip('climax', 12, climax)],
  };
}

function violinsTrack() {
  // Flight: the strings take the hook an octave up, then sequence it onto G minor.
  const flight = [
    ...hook(m('D5'), 0, 82, 'legato'),
    ...hookTail(m('D5'), 4, 78),
    ...hook(m('G4'), 8, 86, 'legato'),
    note('A5', 12, 1.5, 90, 'legato'), note('Bb5', 13.5, 0.5, 84), note('A5', 14, 1, 88), note('C#5', 15, 1, 92, 'legato'),
  ];
  // Climax: the violins double the trumpets' hook in unison for the big tutti.
  const climax = [
    ...hook(m('D5'), 0, 104, 'legato'),
    ...hookTail(m('D5'), 4, 100),
    ...hook(m('D5'), 8, 108, 'legato'),
    note('E5', 12, 1.5, 106, 'legato'), note('F5', 13.5, 0.5, 100), note('E5', 14, 1, 104), note('C#5', 15, 1, 110, 'legato'),
  ];
  return {
    id: 'violins', name: 'Violins I', role: 'lead', layer: 'tension', gainDb: -3,
    instrument: { type: 'strings-ensemble', params: { players: 6 } },
    fx: [{ type: 'reverb', preset: 'hall', decay: 0.86, mix: 0.36, predelayMs: 30, damping: 0.4 }],
    clips: [clip('flight', 4, flight), clip('climax', 12, climax)],
  };
}

function stringsTrack() {
  const notes = [];
  CHORDS.forEach((_, bar) => {
    const sec = SECTIONS[Math.floor(bar / 4)].id;
    const v = 78 * sectionDyn[sec];
    const voicing = openVoicing(bar);
    if (sec === 'fanfare' || sec === 'flight') {
      for (const t of voicing) notes.push(note(t, bar * 4, 4, v * 0.9, 'legato'));
    } else {
      // Driving 8th-note ostinato on the chord, accented on the off-beat pushes.
      for (let k = 0; k < 8; k += 1) {
        const accent = k === 3 || k === 6;
        for (const t of voicing.slice(1)) notes.push(note(t, bar * 4 + k * 0.5, 0.5, v * (accent ? 1.1 : 0.88), accent ? 'accent' : 'staccato'));
      }
    }
  });
  return {
    id: 'strings', name: 'Violas and violins II', role: 'harmony', layer: 'base', gainDb: -7, pan: -0.2,
    instrument: { type: 'strings-ensemble', params: { players: 5 } },
    fx: [{ type: 'eq3', lowDb: -3, midDb: 0, highDb: -1, lowHz: 200, midHz: 1000, highHz: 6000, midQ: 0.8 }, { type: 'reverb', preset: 'hall', decay: 0.85, mix: 0.34, predelayMs: 30, damping: 0.4 }],
    clips: [clip('all', 0, notes)],
  };
}

function celloTrack() {
  const flight = [
    note('F3', 0, 1.5, 70, 'legato'), note('E3', 1.5, 0.5, 64), note('D3', 2, 2, 68, 'legato'),
    note('D3', 4, 1.5, 68, 'legato'), note('F3', 5.5, 0.5, 64), note('Bb3', 6, 2, 70, 'legato'),
    note('Bb3', 8, 1.5, 72, 'legato'), note('A3', 9.5, 0.5, 66), note('G3', 10, 2, 70, 'legato'),
    note('A3', 12, 2, 76, 'legato'), note('E3', 14, 1, 72), note('C#4', 15, 1, 78),
  ];
  // Dogfight and climax: a syncopated counter-riff in the tenor register.
  const riff = (bar, root, v) => [
    note(root, bar * 4, 0.75, v, 'accent'), note(root + 3, bar * 4 + 0.75, 0.75, v * 0.9), note(root + 5, bar * 4 + 1.5, 0.5, v * 0.95, 'staccato'),
    note(root + 7, bar * 4 + 2, 0.75, v, 'accent'), note(root + 5, bar * 4 + 2.75, 0.75, v * 0.9), note(root + 3, bar * 4 + 3.5, 0.5, v * 0.85, 'staccato'),
  ];
  const roots = ['D3', 'C3', 'Bb2', 'A2'];
  const dogfight = roots.flatMap((r, b) => riff(b, m(r) + 12, 96));
  const climaxRoots = ['Bb2', 'C3', 'D3', 'A2'];
  const climax = climaxRoots.flatMap((r, b) => riff(b, m(r) + 12, 104));
  return {
    id: 'celli', name: 'Cellos', role: 'counter', layer: 'tension', gainDb: -5,
    instrument: { type: 'strings-cello', params: { players: 4 } },
    fx: [{ type: 'reverb', preset: 'hall', decay: 0.84, mix: 0.3, predelayMs: 26, damping: 0.45 }],
    clips: [clip('flight', 4, flight), clip('dogfight', 8, dogfight), clip('climax', 12, climax)],
  };
}

function bassTrack() {
  const notes = [];
  CHORDS.forEach(([root], bar) => {
    const sec = SECTIONS[Math.floor(bar / 4)].id;
    const r = m(root);
    const v = 92 * sectionDyn[sec];
    if (sec === 'fanfare') notes.push(note(r, bar * 4, 4, v * 0.85, 'legato'));
    else if (sec === 'flight') notes.push(note(r, bar * 4, 2.5, v, 'legato'), note(r + 12, bar * 4 + 2.5, 1.5, v * 0.9, 'legato'));
    else for (let k = 0; k < 8; k += 1) notes.push(note(k % 4 === 3 ? r + 12 : r, bar * 4 + k * 0.5, 0.5, v * (k % 2 === 0 ? 1 : 0.85), 'staccato'));
  });
  return {
    id: 'basses', name: 'Contrabasses', role: 'bass', layer: 'base', gainDb: -7,
    instrument: { type: 'strings-bass', params: { players: 3 } },
    fx: [{ type: 'reverb', preset: 'hall', decay: 0.8, mix: 0.18, predelayMs: 20, damping: 0.6 }],
    clips: [clip('all', 0, notes)],
  };
}

function pianoTrack() {
  const notes = [];
  CHORDS.forEach(([root, triad], bar) => {
    const sec = SECTIONS[Math.floor(bar / 4)].id;
    if (sec === 'fanfare') return;
    const tones = [m(root) + 24, ...triad.map(m)];
    const order = [0, 1, 2, 3, 2, 1, 3, 2];
    const v = 70 * sectionDyn[sec];
    for (let k = 0; k < 8; k += 1) notes.push(note(tones[order[k]], bar * 4 + k * 0.5, 0.5, v * (k % 4 === 0 ? 1.12 : 0.92), sec === 'flight' ? 'legato' : 'normal'));
  });
  return {
    id: 'piano', name: 'Concert grand', role: 'harmony', layer: 'tension', gainDb: -8, pan: 0.15,
    instrument: { type: 'piano', params: { pedal: true, brightness: 0.55 } },
    fx: [{ type: 'reverb', preset: 'plate', decay: 0.75, mix: 0.24, predelayMs: 12, damping: 0.3 }],
    clips: [clip('all', 0, notes)],
  };
}

function guitarTrack() {
  const notes = [];
  for (let bar = 8; bar < 16; bar += 1) {
    const r = m(CHORDS[bar][0]) + 12;
    const v = bar < 12 ? 100 : 108;
    // Palm-muted 16th gallop with open power-chord stabs on the pushes.
    const cells = [[0, 0.5, 'staccato'], [0.5, 0.25, 'staccato'], [0.75, 0.25, 'staccato'], [1, 0.5, 'staccato'], [1.5, 0.5, 'accent'], [2.5, 0.25, 'staccato'], [2.75, 0.25, 'staccato'], [3, 1, 'accent']];
    for (const [s, d, art] of cells) {
      notes.push(note(r, bar * 4 + s, d, art === 'accent' ? v * 1.1 : v * 0.9, art));
      notes.push(note(r + 7, bar * 4 + s, d, art === 'accent' ? v * 1.05 : v * 0.85, art));
    }
  }
  return {
    id: 'guitar', name: 'Rhythm guitar (double-tracked)', role: 'counter', layer: 'combat', gainDb: -12,
    instrument: { type: 'guitar-electric', params: { drive: 10, double: true } },
    fx: [{ type: 'eq3', lowDb: -2, midDb: -2, highDb: -2, lowHz: 140, midHz: 500, highHz: 4500, midQ: 0.9 }, { type: 'reverb', preset: 'room', decay: 0.5, mix: 0.12, predelayMs: 8, damping: 0.6 }],
    clips: [clip('riff', 0, notes)],
  };
}

function timpaniTrack() {
  const notes = [];
  // Fanfare: downbeat strokes and a crescendo roll into the flight.
  for (const bar of [0, 1, 2, 3]) notes.push(note(m(CHORDS[bar][0]) + 12 > m('A2') ? m('D2') : m('A1'), bar * 4, 1, 110, 'accent'));
  for (let k = 0; k < 16; k += 1) notes.push(note('A1', 14 + k * 0.125, 0.125, 60 + k * 3.5));
  notes.push(note('D2', 4 * 4, 2, 96, 'accent'));
  for (let bar = 8; bar < 16; bar += 1) {
    const r = CHORDS[bar][0].startsWith('D') || CHORDS[bar][0].startsWith('C') ? 'D2' : 'A1';
    notes.push(note(r, bar * 4, 0.5, 112, 'accent'), note(r, bar * 4 + 1.5, 0.5, 96));
    // The last half bar belongs to the roll into the wrap.
    if (bar < 15) notes.push(note('A1', bar * 4 + 2.5, 0.5, 100), note(r, bar * 4 + 3, 0.5, 104, 'accent'));
  }
  for (let k = 0; k < 16; k += 1) notes.push(note('A1', 62 + k * 0.125, 0.125, 70 + k * 3.2));
  return {
    id: 'timpani', name: 'Timpani', role: 'percussion', layer: 'base', gainDb: -9,
    instrument: { type: 'timpani', params: {} },
    fx: [{ type: 'reverb', preset: 'hall', decay: 0.85, mix: 0.3, predelayMs: 20, damping: 0.5 }],
    clips: [clip('all', 0, notes)],
  };
}

function percTrack() {
  const notes = [
    note(39, 0, 2, 118, 'accent'),
    note(55, 12, 4, 90),
    note(49, 32, 2, 112),
    note(55, 44, 4, 96),
    note(49, 48, 2, 120),
    note(39, 48, 2, 112),
  ];
  for (let bar = 8; bar < 16; bar += 1) {
    const v = bar < 12 ? 104 : 114;
    notes.push(note(36, bar * 4, 0.5, v), note(36, bar * 4 + 1.5, 0.5, v * 0.85), note(36, bar * 4 + 2.5, 0.5, v * 0.9));
    notes.push(note(38, bar * 4 + 1, 0.5, v, 'accent'), note(38, bar * 4 + 3, 0.5, v, 'accent'), note(38, bar * 4 + 3.75, 0.25, v * 0.6));
    for (let k = 0; k < 8; k += 1) notes.push(note(42, bar * 4 + k * 0.5, 0.25, v * (k % 2 === 0 ? 0.7 : 0.5)));
  }
  return {
    id: 'perc', name: 'Orchestral and hybrid percussion', role: 'percussion', layer: 'base', gainDb: -8,
    instrument: { type: 'orchestral-perc', params: {} },
    fx: [{ type: 'compressor', thresholdDb: -20, ratio: 3, attackMs: 8, releaseMs: 120, makeupDb: 2, kneeDb: 6 }, { type: 'reverb', preset: 'hall', decay: 0.82, mix: 0.26, predelayMs: 18, damping: 0.5 }],
    clips: [clip('all', 0, notes)],
  };
}

function padTrack() {
  const notes = CHORDS.map((_, bar) => openVoicing(bar).map((t) => note(t, bar * 4, 4, 60 * sectionDyn[SECTIONS[Math.floor(bar / 4)].id], 'legato'))).flat();
  return {
    id: 'pad', name: 'Warm analog pad', role: 'pad', layer: 'base', gainDb: -16,
    instrument: { type: 'synth-pad', params: { attack: 0.5, release: 1.2, cutoff: 1600 } },
    fx: [{ type: 'chorus', rateHz: 0.25, depthMs: 4, delayMs: 14, mix: 0.4 }, { type: 'reverb', preset: 'hall', decay: 0.9, mix: 0.4, predelayMs: 40, damping: 0.5 }],
    automation: [{ param: 'cutoff', points: [{ beat: 0, value: 5000 }, { beat: 30, value: 2500 }, { beat: 48, value: 7000 }, { beat: 64, value: 5000 }] }],
    clips: [clip('all', 0, notes)],
  };
}

function synthBassTrack() {
  const notes = [];
  for (let bar = 8; bar < 16; bar += 1) {
    const r = m(CHORDS[bar][0]);
    for (let k = 0; k < 8; k += 1) notes.push(note(r + (k === 7 ? 12 : 0), bar * 4 + k * 0.5, 0.45, k % 2 === 0 ? 100 : 82, 'staccato'));
  }
  return {
    id: 'subbass', name: 'Hybrid sub bass', role: 'bass', layer: 'combat', gainDb: -15,
    instrument: { type: 'synth-bass', params: { cutoff: 500, envAmount: 900 } },
    fx: [],
    clips: [clip('drive', 0, notes)],
  };
}

function flybyTrack() {
  return {
    id: 'flyby', name: 'Fighter fly-by', role: 'fx', layer: 'combat', gainDb: -14,
    instrument: { type: 'cinematic-sfx', params: { preset: 'doppler' } },
    fx: [{ type: 'reverb', preset: 'hall', decay: 0.8, mix: 0.25, predelayMs: 20, damping: 0.5 }],
    clips: [clip('pass', 9, [note('A2', 2, 3, 100)])],
  };
}

const project = {
  format: 'agent-daw/v1',
  id: 'star-wars-overture',
  title: 'Squadron Overture (original, in a heroic space-opera and rock-orchestral style)',
  kind: 'loop',
  loop: true,
  tempo: { bpm: 120, beatsPerBar: 4 },
  key: { tonic: 'D', mode: 'minor' },
  bars: 16,
  master: { targetLufs: -16, ceilingDbtp: -1.5, hpfHz: 30, compressor: { thresholdDb: -16, ratio: 2, attackMs: 30, releaseMs: 250 } },
  sections: SECTIONS,
  patterns: {},
  tracks: [hornsTrack(), trumpetsTrack(), violinsTrack(), stringsTrack(), celloTrack(), bassTrack(), pianoTrack(), guitarTrack(), timpaniTrack(), percTrack(), padTrack(), synthBassTrack(), flybyTrack()],
};

const out = path.join(here, 'star-wars-overture.daw.json');
fs.writeFileSync(out, `${JSON.stringify(project, null, 2)}\n`);
console.log(out);
