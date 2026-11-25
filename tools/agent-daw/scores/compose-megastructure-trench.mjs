// Level 2, Megastructure Trench Run: a rock-orchestral assault in E minor. Run from tools/agent-daw: node scores/compose-megastructure-trench.mjs
import { clip, eq, line, loopProject, midi, note, reverb, steadyPiano, writeProject } from './lib.mjs';

const SECTIONS = [
  { id: 'entry', startBar: 0, bars: 4, layer: 'base' },
  { id: 'shadow', startBar: 4, bars: 4, layer: 'tension' },
  { id: 'run', startBar: 8, bars: 4, layer: 'combat' },
  { id: 'breakout', startBar: 12, bars: 4, layer: 'climax' },
];

// Per chord: the guitar's power-chord root, the riff's two answering roots (semitones above it),
// a viola voicing at or above E3, a tenor pair for the cellos and the piano's pedal figure.
const CHORD = {
  Em: { root: 'E2', answers: [3, 5], mid: ['G3', 'B3', 'E4'], tenor: ['E3', 'B3'], piano: ['E4', 'G4', 'B4'] },
  C: { root: 'C3', answers: [2, 4], mid: ['G3', 'C4', 'E4'], tenor: ['G3', 'E3'], piano: ['E4', 'G4', 'C5'] },
  D: { root: 'D3', answers: [2, 5], mid: ['F#3', 'A3', 'D4'], tenor: ['A3', 'F#3'], piano: ['D4', 'F#4', 'A4'] },
  G: { root: 'G2', answers: [2, 4], mid: ['G3', 'B3', 'D4'], tenor: ['G3', 'B3'], piano: ['D4', 'G4', 'B4'] },
  Am: { root: 'A2', answers: [3, 5], mid: ['A3', 'C4', 'E4'], tenor: ['E3', 'A3'], piano: ['E4', 'A4', 'C5'] },
  // Over the dominant the riff leans on the flat second, the menace note.
  B: { root: 'B2', answers: [1, 0], mid: ['F#3', 'B3', 'D#4'], tenor: ['F#3', 'B3'], piano: ['D#4', 'F#4', 'B4'] },
};
const NAMES = ['Em', 'Em', 'C', 'D', 'Am', 'C', 'D', 'B', 'Em', 'C', 'G', 'D', 'Em', 'C', 'D', 'B'];
const BARS = NAMES.map((name) => CHORD[name]);
const sectionOf = (bar) => Math.floor(bar / 4);

// The riff on a 16th grid: [step, length, which root, open accent]. Chugs gallop into every accent
// and the second half answers on two higher power chords.
const RIFF = [
  [0, 2, 0, true], [2, 1, 0, false], [3, 1, 0, false],
  [4, 2, 0, true], [6, 1, 0, false], [7, 1, 0, false],
  [8, 2, 1, true], [10, 1, 0, false], [11, 1, 0, false],
  [12, 2, 2, true], [14, 2, 1, true],
];
function riffRoots(bar) {
  const chord = BARS[bar];
  const root = midi(chord.root);
  return RIFF.map(([step, length, which, open]) => ({
    beat: bar * 4 + step / 4,
    beats: length / 4,
    root: root + (which === 0 ? 0 : chord.answers[which - 1]),
    open,
  }));
}

function guitar() {
  const notes = [];
  for (let bar = 0; bar < 16; bar += 1) {
    if (sectionOf(bar) === 1) {
      // Shadow: one chord per bar, left to ring.
      const root = midi(BARS[bar].root);
      for (const p of [root, root + 7, root + 12]) notes.push(note(p, bar * 4, 3.5, 62, 'accent'));
      continue;
    }
    const v = sectionOf(bar) === 3 ? 112 : 104;
    for (const hit of riffRoots(bar)) {
      for (const p of [hit.root, hit.root + 7]) notes.push(note(p, hit.beat, hit.beats, hit.open ? v : v * 0.82, hit.open ? 'accent' : 'staccato'));
    }
  }
  return {
    id: 'guitar', name: 'Rhythm guitar (double-tracked)', role: 'counter', layer: 'base', gainDb: -4,
    instrument: { type: 'guitar-electric', params: { drive: 11, double: true } },
    fx: [eq(-2, -2.5, 1, { lowHz: 140, midHz: 500, highHz: 4200, midQ: 0.9 }), reverb('room', 0.1, { decay: 0.45, predelayMs: 8, damping: 0.6 })],
    clips: [clip('riff', notes)],
  };
}

function bass() {
  const notes = [];
  for (let bar = 0; bar < 16; bar += 1) {
    if (sectionOf(bar) === 1) {
      notes.push(note(midi(BARS[bar].root) - 12, bar * 4, 4, 84, 'legato'));
      continue;
    }
    for (const hit of riffRoots(bar)) notes.push(note(hit.root - 12, hit.beat, hit.beats, hit.open ? 104 : 86, hit.open ? 'accent' : 'staccato'));
  }
  return {
    id: 'bass', name: 'Synth bass', role: 'bass', layer: 'base', gainDb: -5,
    instrument: { type: 'synth-bass', params: { cutoff: 600, envAmount: 1400 } },
    fx: [],
    clips: [clip('riff', notes)],
  };
}

// The anthem: a fourth and a third up to a held note, then two steps back. Each phrase lands higher.
const ANTHEM = [
  'B4:.5:104:n E5:.5:106 G5:2:112:l F#5:.5:102:n E5:.5:100',
  'E5:.5:106:n G5:.5:108 C6:2:116:l B5:.5:106:n A5:.5:104',
];

function hornCall() {
  // The riff's first answer: the anthem's second phrase an octave down, then a held dominant.
  const entry = line(2, 'E4:.5:92:n G4:.5:94 C5:2:100:l B4:.5:92:n A4:.5:90  F#4:.75:96:a G4:.75:94:n A4:2.5:104:l');
  const shadow = line(4, [
    'E4:.5:66:n A4:.5:68 C5:2:74:l B4:.5:66:n A4:.5:64',
    'G4:1:66:l C5:1:70 E5:2:76',
    'A4:.5:70:n D5:.5:74 F#5:2:82:l E5:.5:74:n D5:.5:72',
    'D#5:2:86:z B4:1:78:n F#4:.5:76 B4:.25:84:a B4:.25:88',
  ].join(' '));
  return {
    id: 'horn-call', name: 'French horns (call)', role: 'lead', layer: 'base', gainDb: -4,
    instrument: { type: 'brass-horn', params: { players: 4 } },
    fx: [eq(-3, 1.5, 3, { lowHz: 180, midHz: 700, highHz: 3500 }), reverb('hall', 0.3, { decay: 0.82, predelayMs: 26, damping: 0.45 })],
    clips: [clip('entry', entry), clip('shadow', shadow)],
  };
}

function hornCounter() {
  // A slow line that climbs under the anthem and takes the top of the horn in the breakout.
  const run = line(8, 'E4:3:92:l F#4:1:90  G4:3:96 A4:1:94  B4:2:100 A4:1:94 G4:1:92  A4:2:98 D5:2:106');
  const breakout = line(12, 'G4:2:104:l B4:1:104 E5:1:108  E5:2:112 C5:1:106 E5:1:110  D5:2:112 F#5:2:118  F#5:2.5:122:z D#5:.5:112:n B4:1:116:a');
  return {
    id: 'horn-counter', name: 'French horns (counter-melody)', role: 'counter', layer: 'combat', gainDb: -6,
    instrument: { type: 'brass-horn', params: { players: 4 } },
    fx: [eq(-3, 1.5, 3, { lowHz: 180, midHz: 700, highHz: 3500 }), reverb('hall', 0.32, { decay: 0.84, predelayMs: 28, damping: 0.45 })],
    clips: [clip('run', run), clip('breakout', breakout)],
  };
}

function violins() {
  const run = line(8, `${ANTHEM.join(' ')}  B5:1.5:112:l A5:.5:104:n G5:.75:106 D5:1.25:102  F#5:.75:108:a G5:.75:106:n A5:2.5:116:l`);
  const breakout = line(12, `${ANTHEM.join(' ')}  F#5:.5:112:n A5:.5:114 D6:2:120:l E6:1:122:a  D#6:2.5:124:z B5:.5:114:n F#5:.5:110 B4:.5:108`, { gain: 1.06 });
  return {
    id: 'violins', name: 'Violins I', role: 'lead', layer: 'combat', gainDb: -2,
    instrument: { type: 'strings-ensemble', params: { players: 6 } },
    fx: [eq(-2, 0, 4.5, { lowHz: 220, midHz: 1200, highHz: 4500 }), reverb('hall', 0.34, { decay: 0.86, predelayMs: 30, damping: 0.4 })],
    clips: [clip('run', run), clip('breakout', breakout)],
  };
}

function trumpets() {
  // Breakout only: in unison for the anthem, then a sixth under the violins where they leave the trumpet's range.
  const breakout = line(12, `${ANTHEM.join(' ')}  D5:.5:112:n F#5:.5:114 A5:2:120:l B5:1:122:a  B5:2.5:124:z F#5:.5:114:n D#5:.5:110 B4:.5:108`, { gain: 1.04 });
  return {
    id: 'trumpets', name: 'Trumpets (a3)', role: 'lead', layer: 'climax', gainDb: -6,
    instrument: { type: 'brass-trumpet', params: { players: 3 } },
    fx: [eq(-3, 0, 2, { lowHz: 250, midHz: 1500, highHz: 6000 }), reverb('hall', 0.3, { decay: 0.84, predelayMs: 24, damping: 0.4 })],
    clips: [clip('breakout', breakout)],
  };
}

function violas() {
  const notes = [];
  for (let bar = 2; bar < 16; bar += 1) {
    const section = sectionOf(bar);
    if (section < 2) {
      // Entry: a swell under the horn call. Shadow: held and quiet.
      const v = section === 0 ? 70 + (bar - 2) * 12 : 50;
      for (const p of BARS[bar].mid) notes.push(note(p, bar * 4, 4, v, 'legato'));
      continue;
    }
    const v = section === 2 ? 88 : 100;
    for (let k = 0; k < 8; k += 1) {
      const pushed = k % 4 === 0 || k === 3;
      for (const p of BARS[bar].mid) notes.push(note(p, bar * 4 + k / 2, 0.5, pushed ? v * 1.1 : v * 0.84, pushed ? 'accent' : 'staccato'));
    }
  }
  return {
    id: 'violas', name: 'Violas and violins II', role: 'harmony', layer: 'base', gainDb: -10, pan: -0.2,
    instrument: { type: 'strings-ensemble', params: { players: 5 } },
    fx: [eq(-3, 0, 3.5, { lowHz: 200, midHz: 1000, highHz: 4000 }), reverb('hall', 0.32, { decay: 0.85, predelayMs: 30, damping: 0.4 })],
    clips: [clip('all', notes)],
  };
}

function cellos() {
  const notes = [];
  for (let bar = 4; bar < 16; bar += 1) {
    const [a, b] = BARS[bar].tenor;
    const section = sectionOf(bar);
    if (section === 1) notes.push(note(a, bar * 4, 4, 64, 'legato'));
    else if (section === 2) notes.push(note(a, bar * 4, 2, 88, 'legato'), note(b, bar * 4 + 2, 2, 90, 'legato'));
    else for (let k = 0; k < 8; k += 1) notes.push(note(k < 4 ? a : b, bar * 4 + k / 2, 0.5, k % 4 === 0 ? 108 : 90, k % 4 === 0 ? 'accent' : 'staccato'));
  }
  return {
    id: 'cellos', name: 'Cellos', role: 'counter', layer: 'tension', gainDb: -10,
    instrument: { type: 'strings-cello', params: { players: 4 } },
    fx: [reverb('hall', 0.28, { decay: 0.84, predelayMs: 26, damping: 0.45 })],
    clips: [clip('all', notes)],
  };
}

function piano() {
  const notes = [];
  for (let bar = 4; bar < 16; bar += 1) {
    const [pedal, near, far] = BARS[bar].piano;
    const section = sectionOf(bar);
    // An urgent pedal figure: the lower note never moves inside a bar, the upper one flicks out on the fourth eighth.
    const octave = section === 1 ? 0 : -12;
    const v = section === 1 ? 72 : section === 2 ? 86 : 96;
    [pedal, near, pedal, far, pedal, near, pedal, near].forEach((p, k) => {
      notes.push(note(midi(p) + octave, bar * 4 + k / 2, 0.5, k % 2 === 0 ? v * 0.8 : k === 3 ? v * 1.1 : v, k === 3 ? 'accent' : 'normal'));
    });
  }
  return {
    id: 'piano', name: 'Concert grand', role: 'harmony', layer: 'tension', gainDb: -9, pan: 0.15,
    instrument: { type: 'piano', params: { pedal: false, brightness: 0.8 } },
    fx: [reverb('plate', 0.2, { decay: 0.7, predelayMs: 10, damping: 0.3 })],
    clips: [clip('ostinato', notes)],
  };
}

const TAIKO = 36, TAIKO_LOW = 35, SNARE = 38, RIM = 40, HIT = 39, HAT = 42, HAT_OPEN = 46, CRASH = 49, RIDE = 51, SWELL = 55;
const TOMS = [45, 45, 47, 47, 48, 48, 50, 50];

function drums() {
  const notes = [note(HIT, 0, 2, 112, 'accent'), note(CRASH, 0, 2, 104), note(CRASH, 32, 2, 112), note(HIT, 32, 2, 116, 'accent'), note(CRASH, 48, 2, 122), note(HIT, 48, 2, 120, 'accent'), note(CRASH, 56, 2, 112), note(SWELL, 29, 3, 96)];
  for (let bar = 0; bar < 16; bar += 1) {
    const at = bar * 4;
    const section = sectionOf(bar);
    if (section === 1) {
      // Half time: the floor drops out and the ride keeps count.
      notes.push(note(TAIKO_LOW, at, 0.5, 104, 'accent'), note(TAIKO, at + 2.5, 0.5, 84), note(RIM, at + 2, 0.5, 92, 'accent'));
      for (let k = 0; k < 4; k += 1) notes.push(note(RIDE, at + k, 0.5, k === 0 ? 76 : 62));
      continue;
    }
    const loud = section === 3;
    const v = section === 0 ? 104 : section === 2 ? 108 : 116;
    for (const beat of loud ? [0, 0.75, 1.5, 2, 2.75, 3.5] : [0, 0.75, 2, 2.75]) notes.push(note(TAIKO, at + beat, 0.25, beat % 1 === 0 ? v : v * 0.8, beat % 1 === 0 ? 'accent' : 'normal'));
    notes.push(note(TAIKO_LOW, at, 0.5, v, 'accent'));
    if (bar === 15) continue;
    notes.push(note(SNARE, at + 1, 0.5, v, 'accent'), note(SNARE, at + 3, 0.5, v, 'accent'));
    if (loud) notes.push(note(SNARE, at + 3.75, 0.25, v * 0.7));
    for (let k = 0; k < 8; k += 1) notes.push(note(loud && k % 2 === 1 ? HAT_OPEN : HAT, at + k / 2, 0.25, k % 2 === 0 ? v * 0.62 : v * 0.5));
  }
  // Tom fills into the run and around the wrap.
  TOMS.forEach((tom, k) => notes.push(note(tom, 30 + k / 4, 0.25, 84 + k * 5, k % 2 === 0 ? 'accent' : 'normal')));
  notes.push(note(SNARE, 61, 0.5, 116, 'accent'));
  TOMS.forEach((tom, k) => notes.push(note(k % 4 === 3 ? SNARE : tom, 62 + k / 4, 0.25, 96 + k * 4, k % 2 === 0 ? 'accent' : 'normal')));
  return {
    id: 'drums', name: 'Taiko, snare and cymbals', role: 'percussion', layer: 'base', gainDb: -13,
    instrument: { type: 'orchestral-perc', params: {} },
    fx: [{ type: 'compressor', thresholdDb: -20, ratio: 3, attackMs: 8, releaseMs: 120, makeupDb: 2, kneeDb: 6 }, reverb('room', 0.16, { decay: 0.6, predelayMs: 10, damping: 0.5 })],
    clips: [clip('all', notes)],
  };
}

function pad() {
  const notes = [];
  for (let bar = 4; bar < 8; bar += 1) for (const p of BARS[bar].mid) notes.push(note(p, bar * 4, 4, 62, 'legato'));
  return {
    id: 'pad', name: 'Cold pad', role: 'pad', layer: 'tension', gainDb: -19,
    instrument: { type: 'synth-pad', params: { attack: 0.4, release: 1.0, cutoff: 2400 } },
    fx: [{ type: 'chorus', rateHz: 0.25, depthMs: 4, delayMs: 14, mix: 0.4 }, reverb('hall', 0.4, { decay: 0.9, predelayMs: 40, damping: 0.5 })],
    clips: [clip('shadow', notes)],
  };
}

function riser() {
  return {
    id: 'riser', name: 'Riser into the run', role: 'fx', layer: 'tension', gainDb: -18,
    instrument: { type: 'cinematic-sfx', params: { preset: 'riser' } },
    fx: [reverb('hall', 0.25, { decay: 0.8, predelayMs: 20, damping: 0.5 })],
    clips: [clip('rise', [note('E3', 28, 4, 96)])],
  };
}

writeProject(await steadyPiano(loopProject({
  id: 'megastructure-trench',
  title: 'Megastructure Trench Run (Level 2 assault)',
  tonic: 'E',
  mode: 'minor',
  sections: SECTIONS,
  tracks: [guitar(), bass(), drums(), hornCall(), violins(), trumpets(), hornCounter(), violas(), cellos(), piano(), pad(), riser()],

})));
