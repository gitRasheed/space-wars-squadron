import { expandTrackNotes, tonicPc, type InstrumentType, type Project } from './project.js';

export const PPQ = 480;

// General MIDI programs, so an exported file previews sensibly in any GM player.
const GM_PROGRAM: Readonly<Record<InstrumentType, number>> = {
  piano: 0,
  'brass-horn': 60,
  'brass-trumpet': 56,
  'strings-ensemble': 48,
  'strings-cello': 42,
  'strings-bass': 43,
  'guitar-electric': 30,
  'guitar-acoustic': 25,
  timpani: 47,
  'orchestral-perc': 0,
  'synth-pad': 89,
  'synth-bass': 38,
  'cinematic-sfx': 98,
};

function vlq(n: number): number[] {
  const bytes = [n & 0x7f];
  let v = n >>> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return bytes;
}

interface TimedEvent {
  readonly tick: number;
  readonly order: number;
  readonly bytes: readonly number[];
}

function trackChunk(events: TimedEvent[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let last = 0;
  for (const e of events) {
    body.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  body.push(0, 0xff, 0x2f, 0x00);
  return [0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff, ...body];
}

function text(type: number, s: string): number[] {
  const bytes = [...Buffer.from(s, 'utf8')];
  return [0xff, type, ...vlq(bytes.length), ...bytes];
}

// MIDI key signature: sharps/flats count of the relative major, plus a minor flag.
function keySignature(p: Project): [number, number] {
  const minorModes = new Set(['minor', 'aeolian', 'dorian', 'phrygian', 'harmonic-minor']);
  const minor = minorModes.has(p.key.mode);
  const majorPc = minor ? (tonicPc(p) + 3) % 12 : tonicPc(p);
  const fifths = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5][majorPc] ?? 0;
  return [fifths, minor ? 1 : 0];
}

export function exportMidi(p: Project): Uint8Array {
  const tempo = Math.round(60_000_000 / p.tempo.bpm);
  const [sf, mi] = keySignature(p);
  const conductor: TimedEvent[] = [
    { tick: 0, order: 0, bytes: text(0x03, p.title) },
    { tick: 0, order: 1, bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff] },
    { tick: 0, order: 2, bytes: [0xff, 0x58, 0x04, p.tempo.beatsPerBar, 2, 24, 8] },
    { tick: 0, order: 3, bytes: [0xff, 0x59, 0x02, sf & 0xff, mi] },
  ];
  p.sections.forEach((s, i) => conductor.push({ tick: s.startBar * p.tempo.beatsPerBar * PPQ, order: 10 + i, bytes: text(0x06, s.id) }));
  const chunks = [trackChunk(conductor)];
  let nextChannel = 0;
  for (const t of p.tracks) {
    const drums = t.instrument.type === 'orchestral-perc';
    const ch = drums ? 9 : nextChannel;
    if (!drums) nextChannel = nextChannel + 1 === 9 ? 10 : (nextChannel + 1) % 16;
    const events: TimedEvent[] = [
      { tick: 0, order: 0, bytes: text(0x03, t.name) },
      { tick: 0, order: 1, bytes: [0xc0 | ch, GM_PROGRAM[t.instrument.type]] },
      { tick: 0, order: 2, bytes: [0xb0 | ch, 7, Math.max(0, Math.min(127, Math.round(100 * Math.pow(10, t.gainDb / 40))))] },
      { tick: 0, order: 3, bytes: [0xb0 | ch, 10, Math.max(0, Math.min(127, Math.round(64 + t.pan * 63)))] },
    ];
    // Pitch-bend range of 12 semitones (RPN 0) so per-note bends up to an octave export faithfully.
    const rpn: readonly (readonly [number, number])[] = [[101, 0], [100, 0], [6, 12], [38, 0]];
    rpn.forEach(([cc, v], i) => events.push({ tick: 0, order: 5 + i, bytes: [0xb0 | ch, cc, v] }));
    for (const n of expandTrackNotes(p, t)) {
      const on = Math.round(n.startBeat * PPQ);
      const off = Math.max(on + 1, Math.round((n.startBeat + n.durationBeats) * PPQ));
      events.push({ tick: on, order: 20, bytes: [0x90 | ch, n.midi, n.velocity] });
      events.push({ tick: off, order: 10, bytes: [0x80 | ch, n.midi, 0] });
      const bend = n.pitchBend ?? 0;
      if (bend !== 0 && !drums) {
        const steps = 8;
        for (let k = 0; k <= steps; k += 1) {
          const v = Math.max(0, Math.min(16383, Math.round(8192 + ((bend * k) / steps / 12) * 8191)));
          events.push({ tick: on + Math.round(((off - on) * k) / steps), order: 15, bytes: [0xe0 | ch, v & 0x7f, (v >> 7) & 0x7f] });
        }
        events.push({ tick: off, order: 11, bytes: [0xe0 | ch, 0, 64] });
      }
    }
    chunks.push(trackChunk(events));
  }
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (chunks.length >> 8) & 0xff, chunks.length & 0xff, (PPQ >> 8) & 0xff, PPQ & 0xff];
  return Uint8Array.from([...header, ...chunks.flat()]);
}

export interface MidiNote {
  readonly track: number;
  readonly channel: number;
  readonly midi: number;
  readonly velocity: number;
  readonly startTick: number;
  readonly endTick: number;
}

export interface ParsedMidi {
  readonly format: number;
  readonly ppq: number;
  readonly tracks: number;
  readonly tempoUsPerBeat: number | null;
  readonly trackNames: readonly string[];
  readonly notes: readonly MidiNote[];
}

export function parseMidi(bytes: Uint8Array): ParsedMidi {
  const u32 = (o: number): number => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  const u16 = (o: number): number => (bytes[o] << 8) | bytes[o + 1];
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'MThd') throw new Error('not a MIDI file');
  const format = u16(8);
  const ntracks = u16(10);
  const ppq = u16(12);
  let o = 8 + u32(4);
  const notes: MidiNote[] = [];
  const names: string[] = [];
  let tempo: number | null = null;
  for (let t = 0; t < ntracks; t += 1) {
    if (String.fromCharCode(...bytes.subarray(o, o + 4)) !== 'MTrk') throw new Error(`track ${t} has no MTrk header`);
    const end = o + 8 + u32(o + 4);
    let i = o + 8;
    let tick = 0;
    let status = 0;
    const open = new Map<string, { velocity: number; start: number }>();
    const readVlq = (): number => {
      let v = 0;
      for (;;) {
        const b = bytes[i++];
        v = (v << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) return v;
      }
    };
    while (i < end) {
      tick += readVlq();
      let b = bytes[i];
      if (b >= 0x80) {
        status = b;
        i += 1;
      } else b = status;
      if (status === 0xff) {
        const type = bytes[i++];
        const len = readVlq();
        if (type === 0x51) tempo = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        if (type === 0x03) names[t] = Buffer.from(bytes.subarray(i, i + len)).toString('utf8');
        i += len;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        i += readVlq();
        continue;
      }
      const kind = status & 0xf0;
      const ch = status & 0x0f;
      const d1 = bytes[i++];
      const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[i++];
      const key = `${ch}:${d1}`;
      if (kind === 0x90 && d2 > 0) open.set(key, { velocity: d2, start: tick });
      else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
        const s = open.get(key);
        if (s !== undefined) {
          notes.push({ track: t, channel: ch, midi: d1, velocity: s.velocity, startTick: s.start, endTick: tick });
          open.delete(key);
        }
      }
    }
    names[t] ??= '';
    o = end;
  }
  return { format, ppq, tracks: ntracks, tempoUsPerBeat: tempo, trackNames: names, notes };
}
