// Level 3, Planetary Sunset close air support: a G-Dorian anthem. Run from tools/agent-daw: node scores/compose-sunset-ground-support.mjs
import { clip, eq, line, loopProject, note, reverb, shift, writeProject } from './lib.mjs';

const SECTIONS = [
  { id: 'dusk', startBar: 0, bars: 4, layer: 'base' },
  { id: 'wingmen', startBar: 4, bars: 4, layer: 'tension' },
  { id: 'anthem', startBar: 8, bars: 4, layer: 'combat' },
  { id: 'triumph', startBar: 12, bars: 4, layer: 'climax' },
];

// Per chord: contrabass root, a low root-fifth pair, a viola voicing at or above F3, and the broken chord the piano and acoustic guitar roll.
const CHORD = {
  Gm: { bass: 'G2', low: ['G2', 'D3'], mid: ['G3', 'Bb3', 'D4'], roll: ['G2', 'D3', 'G3', 'Bb3', 'D4', 'Bb3', 'G3', 'D3'], timpani: 'G2' },
  C: { bass: 'C2', low: ['C3', 'G3'], mid: ['G3', 'C4', 'E4'], roll: ['C3', 'G3', 'C4', 'E4', 'C4', 'E4', 'C4', 'G3'], timpani: 'C3' },
  Bb: { bass: 'Bb1', low: ['Bb2', 'F3'], mid: ['F3', 'Bb3', 'D4'], roll: ['Bb2', 'F3', 'Bb3', 'D4', 'F4', 'D4', 'Bb3', 'F3'], timpani: 'Bb2' },
  F: { bass: 'F2', low: ['F2', 'C3'], mid: ['F3', 'A3', 'C4'], roll: ['F2', 'C3', 'F3', 'A3', 'C4', 'A3', 'F3', 'C3'], timpani: 'F2' },
  Dm: { bass: 'D2', low: ['D3', 'A3'], mid: ['F3', 'A3', 'D4'], roll: ['D3', 'A3', 'D4', 'F4', 'D4', 'F4', 'D4', 'A3'], timpani: 'D3' },
};
const NAMES = ['Gm', 'C', 'Bb', 'F', 'Gm', 'Bb', 'C', 'Dm', 'Gm', 'C', 'Bb', 'F', 'Bb', 'C', 'Dm', 'F'];
const BARS = NAMES.map((name) => CHORD[name]);
const sectionOf = (bar) => Math.floor(bar / 4);
const PUSH = [0, 1.5, 3];

// The song: five steps up the Dorian scale through its bright sixth, then a falling answer.
const SONG = 'D5:1.5:n E5:.5 F5:1 G5:1  A5:2:l G5:1:n E5:1  F5:1.5 E5:.5 D5:1 Bb4:1';

function pianoLead() {
  const dusk = line(0, `${SONG}  C5:2.5:l A4:.5:n C5:1`, { vel: 78 });
  return {
    id: 'piano-lead', name: 'Concert grand (melody)', role: 'lead', layer: 'base', gainDb: -3, pan: 0.05,
    instrument: { type: 'piano', params: { pedal: true, brightness: 0.55 } },
    fx: [reverb('plate', 0.3, { decay: 0.8, predelayMs: 14, damping: 0.3 })],
    clips: [clip('dusk', dusk)],
  };
}

function piano() {
  const notes = [];
  BARS.forEach((chord, bar) => {
    const section = sectionOf(bar);
    if (section === 1) return;
    const v = [62, 0, 84, 94][section];
    chord.roll.forEach((p, k) => notes.push(note(p, bar * 4 + k / 2, 0.5, k === 0 ? v * 1.12 : v, 'legato')));
  });
  return {
    id: 'piano', name: 'Concert grand (left hand)', role: 'harmony', layer: 'base', gainDb: -8, pan: 0.05,
    instrument: { type: 'piano', params: { pedal: true, brightness: 0.55 } },
    fx: [reverb('plate', 0.3, { decay: 0.8, predelayMs: 14, damping: 0.3 })],
    clips: [clip('all', notes)],
  };
}

function acoustic() {
  const notes = [];
  for (let bar = 4; bar < 16; bar += 1) {
    const chord = BARS[bar];
    if (sectionOf(bar) === 1) {
      // Wingmen: a rolled chord under the electric guitar's line.
      chord.roll.forEach((p, k) => notes.push(note(p, bar * 4 + k / 2, 0.75, k === 0 ? 92 : 76 + (k % 2) * 6, 'normal')));
      continue;
    }
    // Anthem and triumph: strummed eighths, down strokes on the pushes.
    const v = sectionOf(bar) === 2 ? 76 : 86;
    for (let k = 0; k < 8; k += 1) {
      const pushed = PUSH.includes(k / 2);
      for (const p of chord.mid) notes.push(note(p, bar * 4 + k / 2, 0.5, pushed ? v * 1.1 : v * 0.8, pushed ? 'accent' : 'normal'));
    }
  }
  return {
    id: 'acoustic', name: 'Acoustic guitar', role: 'harmony', layer: 'tension', gainDb: -9, pan: 0.35,
    instrument: { type: 'guitar-acoustic', params: { brightness: 0.6 } },
    fx: [eq(-2, 0, 2, { lowHz: 160, midHz: 900, highHz: 5000 }), reverb('room', 0.18, { decay: 0.55, predelayMs: 10, damping: 0.4 })],
    clips: [clip('all', notes)],
  };
}

function electricLead() {
  // Wingmen: the electric guitar takes the song down an octave and turns its answer upward toward the anthem.
  const wingmen = line(4, 'D4:1.5:88:l E4:.5:86 F4:1:90 G4:1:92  Bb4:2:98 A4:1:92 F4:1:88  G4:1.5:94 E4:.5:88 C4:1:86 E4:1:90  D4:1:92 F4:1:96 A4:2:104');
  const anthem = shift(line(8, `${SONG}  C5:2:l D5:1:n F5:1`, { vel: 100 }), -12);
  return {
    id: 'electric-lead', name: 'Electric guitar (lead)', role: 'lead', layer: 'tension', gainDb: -4, pan: -0.1,
    instrument: { type: 'guitar-electric', params: { drive: 5, double: false, t60: 6, brightness: 0.6 } },
    fx: [eq(-2, 1, 0, { lowHz: 160, midHz: 900, highHz: 4500 }), { type: 'delay', timeBeats: 0.75, feedback: 0.28, mix: 0.16, pingPong: true, dampHz: 3500 }, reverb('hall', 0.24, { decay: 0.8, predelayMs: 20, damping: 0.5 })],
    clips: [clip('wingmen', wingmen), clip('anthem', anthem)],
  };
}

function electricRhythm() {
  const notes = [];
  for (let bar = 8; bar < 16; bar += 1) {
    const [root, fifth] = BARS[bar].low.map((p) => note(p, 0, 1, 1).midi);
    for (const p of [root, fifth, root + 12]) notes.push(note(p, bar * 4, 3.75, bar < 12 ? 96 : 108, 'accent'));
  }
  return {
    id: 'electric-rhythm', name: 'Electric guitar (chords)', role: 'counter', layer: 'combat', gainDb: -12,
    instrument: { type: 'guitar-electric', params: { drive: 8, double: true } },
    fx: [eq(-2, -2, -1, { lowHz: 140, midHz: 500, highHz: 4500, midQ: 0.9 }), reverb('room', 0.12, { decay: 0.5, predelayMs: 8, damping: 0.6 })],
    clips: [clip('chords', notes)],
  };
}

function violins() {
  const anthem = line(8, `${SONG}  C5:2:l D5:1:n F5:1`, { vel: 104 });
  // Triumph: the song a fourth higher, where the same steps stay inside the mode.
  const triumph = line(12, 'G5:1.5:118:a A5:.5:112:n Bb5:1:116 C6:1:118  D6:2:124:z C6:1:116:n A5:1:112  A5:1.5:118:l G5:.5:112:n F5:1:114 D5:1:112  F5:1:116:a A5:1:120:n C6:2:126:z');
  return {
    id: 'violins', name: 'Violins I', role: 'lead', layer: 'combat', gainDb: 0,
    instrument: { type: 'strings-ensemble', params: { players: 6 } },
    fx: [eq(-2, 0, 4.5, { lowHz: 220, midHz: 1200, highHz: 4500 }), reverb('hall', 0.36, { decay: 0.86, predelayMs: 30, damping: 0.4 })],
    clips: [clip('anthem', anthem), clip('triumph', triumph)],
  };
}

function trumpets() {
  const triumph = line(12, 'G4:1.5:116:a A4:.5:110:n Bb4:1:114 C5:1:116  D5:2:122:z C5:1:114:n A4:1:110  A4:1.5:116:l G4:.5:110:n F4:1:112 D4:1:110  F4:1:114:a A4:1:118:n C5:2:124:z');
  return {
    id: 'trumpets', name: 'Trumpets (a3)', role: 'lead', layer: 'climax', gainDb: -5,
    instrument: { type: 'brass-trumpet', params: { players: 3 } },
    fx: [eq(-3, 0, 2, { lowHz: 250, midHz: 1500, highHz: 6000 }), reverb('hall', 0.3, { decay: 0.84, predelayMs: 24, damping: 0.4 })],
    clips: [clip('triumph', triumph)],
  };
}

function horns() {
  const notes = [];
  // Two-bar swells: the volume lane below does the crescendo, so each chord is one held breath.
  for (let bar = 8; bar < 16; bar += 1) {
    const [, third, fifth] = BARS[bar].mid;
    for (const p of [third, fifth]) notes.push(note(p, bar * 4, 4, bar < 12 ? 96 : 110, 'legato'));
  }
  return {
    id: 'horns', name: 'French horns (swells)', role: 'harmony', layer: 'combat', gainDb: -9,
    instrument: { type: 'brass-horn', params: { players: 4 } },
    fx: [eq(-3, 1.5, 3, { lowHz: 180, midHz: 700, highHz: 3500 }), reverb('hall', 0.32, { decay: 0.84, predelayMs: 28, damping: 0.45 })],
    automation: [{ param: 'volume', points: [
      { beat: 0, value: -9 }, { beat: 32, value: -9 }, { beat: 39.5, value: 0 }, { beat: 40, value: -8 }, { beat: 47.5, value: 0 },
      { beat: 48, value: -6 }, { beat: 55.5, value: 1 }, { beat: 56, value: -5 }, { beat: 63.5, value: 1.5 }, { beat: 64, value: -9 },
    ] }],
    clips: [clip('swells', notes)],
  };
}

function violas() {
  const notes = [];
  for (let bar = 6; bar < 16; bar += 1) {
    const section = sectionOf(bar);
    if (section === 1) {
      for (const p of BARS[bar].mid) notes.push(note(p, bar * 4, 4, 52 + (bar - 6) * 14, 'legato'));
      continue;
    }
    const v = section === 2 ? 90 : 102;
    for (let k = 0; k < 8; k += 1) {
      const pushed = PUSH.includes(k / 2);
      for (const p of BARS[bar].mid) notes.push(note(p, bar * 4 + k / 2, 0.5, pushed ? v * 1.1 : v * 0.84, pushed ? 'accent' : 'staccato'));
    }
  }
  return {
    id: 'violas', name: 'Violas and violins II', role: 'harmony', layer: 'combat', gainDb: -10, pan: -0.2,
    instrument: { type: 'strings-ensemble', params: { players: 5 } },
    fx: [eq(-3, 0, 3.5, { lowHz: 200, midHz: 1000, highHz: 4000 }), reverb('hall', 0.34, { decay: 0.85, predelayMs: 30, damping: 0.4 })],
    clips: [clip('all', notes)],
  };
}

function cellos() {
  // Dusk: one inner voice under the piano. Later the section drives root and fifth.
  const notes = line(0, 'G3:4:58:l G3:4:60 F3:4:60 F3:4:62  G3:4:66 F3:4:66 G3:4:70 A3:4:74');
  for (let bar = 8; bar < 16; bar += 1) {
    const [root, fifth] = BARS[bar].low;
    const v = bar < 12 ? 94 : 106;
    for (let k = 0; k < 8; k += 1) {
      const pushed = PUSH.includes(k / 2);
      notes.push(note(k === 5 || k === 7 ? fifth : root, bar * 4 + k / 2, 0.5, pushed ? v * 1.1 : v * 0.86, pushed ? 'accent' : 'staccato'));
    }
  }
  return {
    id: 'cellos', name: 'Cellos', role: 'counter', layer: 'base', gainDb: -9,
    instrument: { type: 'strings-cello', params: { players: 4 } },
    fx: [reverb('hall', 0.3, { decay: 0.84, predelayMs: 26, damping: 0.45 })],
    clips: [clip('all', notes)],
  };
}

function basses() {
  const notes = [];
  for (let bar = 4; bar < 16; bar += 1) {
    const section = sectionOf(bar);
    if (section === 1) notes.push(note(BARS[bar].bass, bar * 4, 4, 72, 'legato'));
    else for (let k = 0; k < 8; k += 1) notes.push(note(BARS[bar].bass, bar * 4 + k / 2, 0.5, (section === 2 ? 94 : 106) * (PUSH.includes(k / 2) ? 1 : 0.8), PUSH.includes(k / 2) ? 'accent' : 'staccato'));
  }
  return {
    id: 'basses', name: 'Contrabasses', role: 'bass', layer: 'tension', gainDb: -10,
    instrument: { type: 'strings-bass', params: { players: 3 } },
    fx: [reverb('hall', 0.18, { decay: 0.8, predelayMs: 20, damping: 0.6 })],
    clips: [clip('all', notes)],
  };
}

const TAIKO = 36, SNARE = 38, RIM = 40, HAT = 42, CRASH = 49, SWELL = 55;

function drums() {
  const notes = [note(SWELL, 29, 3, 92), note(CRASH, 32, 2, 108), note(SWELL, 45, 3, 100), note(CRASH, 48, 2, 122), note(CRASH, 56, 2, 110), note(SWELL, 61, 3, 108)];
  for (let bar = 4; bar < 16; bar += 1) {
    const at = bar * 4;
    const section = sectionOf(bar);
    if (section === 1) {
      notes.push(note(TAIKO, at, 0.5, 78), note(RIM, at + 2, 0.5, 70));
      for (let k = 0; k < 8; k += 1) notes.push(note(HAT, at + k / 2, 0.25, k % 2 === 0 ? 52 : 40));
      continue;
    }
    const v = section === 2 ? 104 : 116;
    for (const beat of section === 2 ? [0, 2.5] : PUSH) notes.push(note(TAIKO, at + beat, 0.5, v, 'accent'));
    notes.push(note(SNARE, at + 1, 0.5, v * 0.92, 'accent'), note(SNARE, at + 3, 0.5, v * 0.96, 'accent'));
    for (let k = 0; k < 8; k += 1) notes.push(note(HAT, at + k / 2, 0.25, k % 2 === 0 ? v * 0.56 : v * 0.44));
  }
  // A field-drum crescendo carries the last half bar into the wrap.
  for (let k = 0; k < 8; k += 1) notes.push(note(SNARE, 62 + k / 4, 0.25, 84 + k * 5, k % 2 === 0 ? 'accent' : 'normal'));
  return {
    id: 'drums', name: 'Taiko, snare and cymbals', role: 'percussion', layer: 'tension', gainDb: -13,
    instrument: { type: 'orchestral-perc', params: {} },
    fx: [{ type: 'compressor', thresholdDb: -20, ratio: 3, attackMs: 8, releaseMs: 120, makeupDb: 2, kneeDb: 6 }, reverb('hall', 0.22, { decay: 0.8, predelayMs: 16, damping: 0.5 })],
    clips: [clip('all', notes)],
  };
}

function timpani() {
  const notes = [];
  for (let bar = 12; bar < 16; bar += 1) {
    const p = BARS[bar].timpani;
    notes.push(note(p, bar * 4, 0.5, 114, 'accent'), note(p, bar * 4 + 1.5, 0.5, 96));
    if (bar < 15) notes.push(note(p, bar * 4 + 3, 0.5, 104, 'accent'));
  }
  for (let k = 0; k < 16; k += 1) notes.push(note('F2', 62 + k / 8, 0.125, 72 + k * 3.2));
  return {
    id: 'timpani', name: 'Timpani', role: 'percussion', layer: 'climax', gainDb: -12,
    instrument: { type: 'timpani', params: {} },
    fx: [reverb('hall', 0.3, { decay: 0.85, predelayMs: 20, damping: 0.5 })],
    clips: [clip('triumph', notes)],
  };
}

function pad() {
  const level = [54, 60, 66, 74];
  const notes = BARS.flatMap((chord, bar) => chord.mid.map((p) => note(p, bar * 4, 4, level[sectionOf(bar)], 'legato')));
  return {
    id: 'pad', name: 'Warm pad', role: 'pad', layer: 'base', gainDb: -18,
    instrument: { type: 'synth-pad', params: { attack: 0.6, release: 1.4, cutoff: 2400 } },
    fx: [{ type: 'chorus', rateHz: 0.25, depthMs: 4, delayMs: 14, mix: 0.4 }, reverb('hall', 0.42, { decay: 0.9, predelayMs: 40, damping: 0.5 })],
    clips: [clip('all', notes)],
  };
}

writeProject(loopProject({
  id: 'sunset-ground-support',
  title: 'Planetary Sunset Ground Support (Level 3 anthem)',
  tonic: 'G',
  mode: 'dorian',
  sections: SECTIONS,
  tracks: [pianoLead(), piano(), acoustic(), electricLead(), electricRhythm(), violins(), trumpets(), horns(), violas(), cellos(), basses(), drums(), timpani(), pad()],

}));
