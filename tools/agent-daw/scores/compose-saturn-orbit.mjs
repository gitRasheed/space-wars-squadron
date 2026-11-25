// Level 1, Saturn Dusk Orbit: a heroic D-minor overture. Run from tools/agent-daw: node scores/compose-saturn-orbit.mjs
import { clip, eq, line, loopProject, note, reverb, shift, writeProject } from './lib.mjs';

const SECTIONS = [
  { id: 'fanfare', startBar: 0, bars: 4, layer: 'base' },
  { id: 'rings', startBar: 4, bars: 4, layer: 'tension' },
  { id: 'ascent', startBar: 8, bars: 4, layer: 'combat' },
  { id: 'tutti', startBar: 12, bars: 4, layer: 'climax' },
];

// Per chord: contrabass root, cello root and fifth, and a close viola voicing that never drops under E3.
const CHORD = {
  Dm: { bass: 'D2', low: ['D3', 'A3'], mid: ['F3', 'A3', 'D4'] },
  Gm: { bass: 'G2', low: ['G2', 'D3'], mid: ['G3', 'Bb3', 'D4'] },
  Bb: { bass: 'Bb1', low: ['Bb2', 'F3'], mid: ['F3', 'Bb3', 'D4'] },
  A: { bass: 'A1', low: ['A2', 'E3'], mid: ['E3', 'A3', 'C#4'] },
  F: { bass: 'F2', low: ['F3', 'C4'], mid: ['F3', 'A3', 'C4'] },
  C: { bass: 'C2', low: ['C3', 'G3'], mid: ['E3', 'G3', 'C4'] },
};
const BARS = ['Dm', 'Gm', 'Bb', 'A', 'Bb', 'F', 'Gm', 'A', 'Dm', 'C', 'Bb', 'C', 'Dm', 'Bb', 'Gm', 'A'].map((name) => CHORD[name]);
const sectionOf = (bar) => Math.floor(bar / 4);
// The 3+3+2 push that drives the ascent and the tutti.
const PUSH = [0, 1.5, 3];

// The theme: a rising D-minor triad in a noble dotted rhythm, a turn pushed up by a fanfare triplet, the high D, then the dominant.
const THEME_HEAD = 'D4:1.5:104:a F4:.5:92:n A4:2:104:l  Bb4:1.5:100:a A4:.5:90:n G4:1:94 G4:t:92:s A4:t:96 Bb4:t:100  D5:2:110:z C5:1:100:n Bb4:1:96:l';

function horns() {
  const fanfare = line(0, `${THEME_HEAD}  A4:2:102:l E4:1:94:n C#4:1:90:l`);
  // Ascent: the section holds the harmony under the trumpet calls and swells into each bar line.
  const swells = line(8, 'F4+A4:3.5:92:z -:.5  E4+G4:3.5:96:z -:.5  F4+Bb4:3.5:100:z -:.5  G4+C5:4:108:z');
  const tutti = line(12, `${THEME_HEAD}  A4:2:116:l E4:1:108:n A4:1:120:z`, { gain: 1.12 });
  return {
    id: 'horns', name: 'French horns (a4)', role: 'lead', layer: 'base', gainDb: -3,
    instrument: { type: 'brass-horn', params: { players: 4 } },
    fx: [eq(-3, 1.5, 3, { lowHz: 180, midHz: 700, highHz: 3500 }), reverb('hall', 0.32, { decay: 0.84, predelayMs: 28, damping: 0.45 })],
    clips: [clip('fanfare', fanfare), clip('ascent', swells), clip('tutti', tutti)],
  };
}

function trumpets() {
  // Calls built from the theme's opening triad, each landing a step higher until the high C.
  const calls = line(8, [
    'D5:1.5:108:a F5:.5:96:s A5:1:112:n A5:t:100:s G5:t F5:t',
    'E5:1.5:108:a G5:.5:96:s E5:1:106:n E5:t:100:s F5:t G5:t',
    'D5:1.5:110:a F5:.5:98:s Bb5:1:116:n Bb5:t:104:s A5:t G5:t',
    'G5:1.5:114:a E5:.5:100:s G5:1:116:n G5:t:112:s A5:t:116 C6:t:122',
  ].join(' '));
  const tutti = line(12, `${THEME_HEAD}  A4:2:116:l E4:1:108:n A4:1:120:z`, { gain: 1.14 });
  return {
    id: 'trumpets', name: 'Trumpets (a3)', role: 'lead', layer: 'combat', gainDb: -4,
    instrument: { type: 'brass-trumpet', params: { players: 3 } },
    fx: [eq(-3, 0, 2.5, { lowHz: 250, midHz: 1500, highHz: 6000 }), reverb('hall', 0.3, { decay: 0.84, predelayMs: 24, damping: 0.4 })],
    clips: [clip('calls', calls), clip('tutti', tutti)],
  };
}

function violins() {
  // Rings: the theme's triad floats over B-flat as a major seventh, answers downward, then climbs the sequence onto G minor.
  const rings = line(4, [
    'D5:1.5:76:l F5:.5:72 A5:1.5:82 Bb5:.5:76',
    'C6:1:80:l A5:1:74 F5:2:72',
    'G5:1.5:80:l Bb5:.5:78 D6:2:90',
    'C#6:2:88:l A5:1:82 E5:1:86',
  ].join(' '));
  const tutti = shift(line(12, `${THEME_HEAD}  A4:1.5:118:l C#5:.5:112:n E5:2:124:z`, { gain: 1.1 }), 12);
  return {
    id: 'violins', name: 'Violins I', role: 'lead', layer: 'tension', gainDb: -2,
    instrument: { type: 'strings-ensemble', params: { players: 6 } },
    fx: [eq(-2, 0, 4.5, { lowHz: 220, midHz: 1200, highHz: 4500 }), reverb('hall', 0.36, { decay: 0.86, predelayMs: 30, damping: 0.4 })],
    clips: [clip('rings', rings), clip('tutti', tutti)],
  };
}

function violas() {
  const notes = [];
  BARS.forEach((chord, bar) => {
    const section = sectionOf(bar);
    if (section < 2) {
      const v = section === 0 ? 72 : 62;
      for (const p of chord.mid) notes.push(note(p, bar * 4, 4, v, 'legato'));
      return;
    }
    const v = section === 2 ? 84 : 96;
    for (let k = 0; k < 8; k += 1) {
      const pushed = PUSH.includes(k / 2);
      for (const p of chord.mid) notes.push(note(p, bar * 4 + k / 2, 0.5, pushed ? v * 1.12 : v * 0.86, pushed ? 'accent' : 'staccato'));
    }
  });
  return {
    id: 'violas', name: 'Violas and violins II', role: 'harmony', layer: 'base', gainDb: -9, pan: -0.2,
    instrument: { type: 'strings-ensemble', params: { players: 5 } },
    fx: [eq(-3, 0, 3.5, { lowHz: 200, midHz: 1000, highHz: 4000 }), reverb('hall', 0.34, { decay: 0.85, predelayMs: 30, damping: 0.4 })],
    clips: [clip('all', notes)],
  };
}

function cellos() {
  const fanfare = line(0, 'D3:2:78:l A3:2:74  G3:2:76 Bb3:2:74  Bb3:2:78 F3:2:74  A3:2:80 E3:1:76 A3:1:80');
  const rings = line(4, 'D4:3:70:l C4:1:66  A3:2:68 C4:2:70  Bb3:3:72 A3:1:68  A3:2:74 C#4:1:76 E4:1:80');
  const drive = [];
  for (let bar = 8; bar < 16; bar += 1) {
    const [root, fifth] = BARS[bar].low;
    const v = bar < 12 ? 92 : 104;
    for (let k = 0; k < 8; k += 1) {
      const pushed = PUSH.includes(k / 2);
      drive.push(note(k === 5 || k === 7 ? fifth : root, bar * 4 + k / 2, 0.5, pushed ? v * 1.1 : v * 0.86, pushed ? 'accent' : 'staccato'));
    }
  }
  return {
    id: 'cellos', name: 'Cellos', role: 'counter', layer: 'base', gainDb: -9,
    instrument: { type: 'strings-cello', params: { players: 4 } },
    fx: [reverb('hall', 0.3, { decay: 0.84, predelayMs: 26, damping: 0.45 })],
    clips: [clip('fanfare', fanfare), clip('rings', rings), clip('drive', drive)],
  };
}

function basses() {
  const notes = [];
  BARS.forEach((chord, bar) => {
    const section = sectionOf(bar);
    if (section === 0) notes.push(note(chord.bass, bar * 4, 4, 84, 'legato'));
    else if (section === 1) notes.push(note(chord.bass, bar * 4, 4, 70, 'legato'));
    else {
      const v = section === 2 ? 92 : 104;
      for (let k = 0; k < 8; k += 1) notes.push(note(chord.bass, bar * 4 + k / 2, 0.5, PUSH.includes(k / 2) ? v : v * 0.8, PUSH.includes(k / 2) ? 'accent' : 'staccato'));
    }
  });
  return {
    id: 'basses', name: 'Contrabasses', role: 'bass', layer: 'base', gainDb: -14,
    instrument: { type: 'strings-bass', params: { players: 3 } },
    fx: [reverb('hall', 0.18, { decay: 0.8, predelayMs: 20, damping: 0.6 })],
    clips: [clip('all', notes)],
  };
}

function piano() {
  const notes = [];
  // Rings: each bar climbs its chord from the tenor and peaks in the gap after the violins' long note.
  const climbs = [
    ['Bb3', 'D4', 'F4', 'Bb4', 'D5', 'F5', 'Bb5', 'F5'],
    ['A3', 'C4', 'F4', 'A4', 'C5', 'F5', 'A5', 'F5'],
    ['G3', 'Bb3', 'D4', 'G4', 'Bb4', 'D5', 'G5', 'Bb5'],
  ];
  climbs.forEach((tones, i) => tones.forEach((p, k) => notes.push(note(p, (4 + i) * 4 + k / 2, 0.5, (k === 0 ? 80 : 66) + k * 2, 'legato'))));
  ['A3', 'C#4', 'E4', 'A4'].forEach((p, k) => notes.push(note(p, 28 + k / 2, 0.5, 70 + k * 3, 'legato')));
  ['C#5', 'E5', 'A5', 'C#6', 'E6', 'A6', 'C#7', 'E7'].forEach((p, k) => notes.push(note(p, 30 + k / 4, 0.25, 72 + k * 4, 'legato')));
  // Tutti: hammered chords on the pushes, under the brass.
  for (let bar = 12; bar < 16; bar += 1) {
    for (const beat of PUSH) for (const p of [...BARS[bar].mid, BARS[bar].low[0]]) notes.push(note(p, bar * 4 + beat, 0.75, 90, 'accent'));
  }
  return {
    id: 'piano', name: 'Concert grand', role: 'harmony', layer: 'tension', gainDb: -5, pan: 0.15,
    instrument: { type: 'piano', params: { pedal: true, brightness: 0.75 } },
    fx: [reverb('plate', 0.26, { decay: 0.75, predelayMs: 12, damping: 0.3 })],
    clips: [clip('all', notes)],
  };
}

function guitar() {
  const notes = [];
  for (let bar = 12; bar < 16; bar += 1) {
    const [root, fifth] = BARS[bar].low;
    for (let k = 0; k < 8; k += 1) {
      const pushed = PUSH.includes(k / 2);
      for (const p of [root, fifth]) notes.push(note(p, bar * 4 + k / 2, 0.5, pushed ? 108 : 88, pushed ? 'accent' : 'staccato'));
    }
  }
  return {
    id: 'guitar', name: 'Rhythm guitar (double-tracked)', role: 'counter', layer: 'climax', gainDb: -15,
    instrument: { type: 'guitar-electric', params: { drive: 9, double: true } },
    fx: [eq(-2, -2, -2, { lowHz: 140, midHz: 500, highHz: 4500, midQ: 0.9 }), reverb('room', 0.12, { decay: 0.5, predelayMs: 8, damping: 0.6 })],
    clips: [clip('drive', notes)],
  };
}

const TIMPANI = { Dm: 'D3', Gm: 'G2', Bb: 'Bb2', A: 'A2', F: 'F2', C: 'C3' };
const NAMES = ['Dm', 'Gm', 'Bb', 'A', 'Bb', 'F', 'Gm', 'A', 'Dm', 'C', 'Bb', 'C', 'Dm', 'Bb', 'Gm', 'A'];
const roll = (pitch, startBeat, beats, from, to) => {
  const strokes = Math.round(beats * 8);
  return Array.from({ length: strokes }, (_, k) => note(pitch, startBeat + k / 8, 0.125, from + ((to - from) * k) / (strokes - 1)));
};

function timpani() {
  const notes = [note('D2', 0, 1, 108, 'accent'), note('D3', 2.5, 0.5, 74), note('A2', 3, 1, 84)];
  notes.push(note('G2', 4, 1, 92, 'accent'), note('Bb2', 8, 1, 96, 'accent'), note('A2', 12, 1, 98, 'accent'), note('A2', 14, 0.5, 80), note('A2', 15, 0.5, 86), note('A2', 15.5, 0.5, 92));
  notes.push(...roll('A2', 30, 2, 48, 96));
  for (let bar = 8; bar < 16; bar += 1) {
    const pitch = TIMPANI[NAMES[bar]];
    const v = bar < 12 ? 100 : 114;
    notes.push(note(bar === 12 ? 'D2' : pitch, bar * 4, 0.5, v, 'accent'), note(pitch, bar * 4 + 1.5, 0.5, v * 0.84));
    if (bar !== 15) notes.push(note(pitch, bar * 4 + 3, 0.5, v * 0.92, 'accent'));
  }
  notes.push(...roll('A2', 62, 2, 70, 122));
  return {
    id: 'timpani', name: 'Timpani', role: 'percussion', layer: 'base', gainDb: -12,
    instrument: { type: 'timpani', params: {} },
    fx: [reverb('hall', 0.3, { decay: 0.85, predelayMs: 20, damping: 0.5 })],
    clips: [clip('all', notes)],
  };
}

const SNARE = 38, TAIKO = 36, HIT = 39, CRASH = 49, SWELL = 55;

function percussion() {
  const notes = [note(CRASH, 0, 2, 92), note(SWELL, 30, 2, 84), note(CRASH, 32, 2, 96), note(SWELL, 46, 2, 92), note(CRASH, 48, 2, 122), note(HIT, 48, 2, 116, 'accent'), note(SWELL, 61, 3, 104)];
  for (let bar = 8; bar < 16; bar += 1) {
    const v = bar < 12 ? 84 : 104;
    // A field-drum figure: dotted pushes with a drag into each bar line.
    for (const [beat, scale, art] of [[0, 1, 'accent'], [0.75, 0.6, 'normal'], [1, 0.8, 'normal'], [1.5, 1, 'accent'], [2.5, 0.7, 'normal'], [3, 1, 'accent'], [3.5, 0.66, 'normal'], [3.75, 0.74, 'normal']]) {
      notes.push(note(SNARE, bar * 4 + beat, 0.25, v * scale, art));
    }
    for (const beat of bar < 12 ? [0, 3] : PUSH) notes.push(note(TAIKO, bar * 4 + beat, 0.5, bar < 12 ? 100 : 114, 'accent'));
  }
  return {
    id: 'percussion', name: 'Field drum, taiko and cymbals', role: 'percussion', layer: 'base', gainDb: -10,
    instrument: { type: 'orchestral-perc', params: {} },
    fx: [{ type: 'compressor', thresholdDb: -20, ratio: 3, attackMs: 8, releaseMs: 120, makeupDb: 2, kneeDb: 6 }, reverb('hall', 0.26, { decay: 0.82, predelayMs: 18, damping: 0.5 })],
    clips: [clip('all', notes)],
  };
}

function pad() {
  const level = [58, 50, 64, 74];
  const notes = BARS.flatMap((chord, bar) => chord.mid.map((p) => note(p, bar * 4, 4, level[sectionOf(bar)], 'legato')));
  return {
    id: 'pad', name: 'Warm pad', role: 'pad', layer: 'base', gainDb: -19,
    instrument: { type: 'synth-pad', params: { attack: 0.5, release: 1.2, cutoff: 2600 } },
    fx: [{ type: 'chorus', rateHz: 0.25, depthMs: 4, delayMs: 14, mix: 0.4 }, reverb('hall', 0.4, { decay: 0.9, predelayMs: 40, damping: 0.5 })],
    clips: [clip('all', notes)],
  };
}

writeProject(loopProject({
  id: 'saturn-orbit',
  title: 'Saturn Dusk Orbit (Level 1 overture)',
  tonic: 'D',
  mode: 'minor',
  sections: SECTIONS,
  // A firmer bus compressor keeps the quiet rings section audible under gameplay.
  compressor: { thresholdDb: -20, ratio: 2.5, attackMs: 25, releaseMs: 250 },
  tracks: [horns(), trumpets(), violins(), violas(), cellos(), basses(), piano(), guitar(), timpani(), percussion(), pad()],

}));
