import { expandTrackNotes, scalePcs, tonicPc, type PlacedNote, type Project, type Track } from './project.js';

// Weights are fixed: revise the music to raise the score, never the weights.
export const CRITIC_WEIGHTS = { motifRecall: 0.25, harmonicFlow: 0.25, rhythmicVariety: 0.15, registerSeparation: 0.15, dynamicContrast: 0.2 } as const;

export interface Critique {
  readonly score: number;
  readonly subscores: Readonly<Record<keyof typeof CRITIC_WEIGHTS, number>>;
  readonly details: {
    readonly motif: { readonly grams: number; readonly recurring: number; readonly coverage: number; readonly variety: number; readonly topMotif: readonly number[] | null };
    readonly harmony: { readonly chords: readonly string[]; readonly distinct: number; readonly changeRate: number; readonly fit: number; readonly keyFit: number; readonly cadence: string; readonly cadenceScore: number };
    readonly rhythm: { readonly syncopation: number; readonly densityCv: number; readonly durationEntropy: number };
    readonly register: { readonly bassMedian: number | null; readonly harmonyMedian: number | null; readonly leadMedian: number | null; readonly mudRatio: number; readonly leadMasked: number; readonly spanSemitones: number };
    readonly dynamics: { readonly sectionDb: readonly number[]; readonly rangeDb: number; readonly peakSection: number; readonly leadVelocityStd: number; readonly articulations: readonly string[] };
  };
  readonly advice: readonly string[];
}

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const r3 = (v: number): number => Number(v.toFixed(3));

const isPitched = (t: Track): boolean => t.role !== 'percussion' && t.role !== 'fx';

interface Span {
  readonly startBeat: number;
  readonly beats: number;
}

function sectionSpans(p: Project): Span[] {
  const bpb = p.tempo.beatsPerBar;
  if (p.sections.length > 0) return p.sections.map((s) => ({ startBeat: s.startBar * bpb, beats: s.bars * bpb }));
  const phrase = Math.min(4, p.bars);
  const spans: Span[] = [];
  for (let b = 0; b < p.bars; b += phrase) spans.push({ startBeat: b * bpb, beats: Math.min(phrase, p.bars - b) * bpb });
  return spans;
}

function spanOf(spans: readonly Span[], beat: number): number {
  return spans.findIndex((s) => beat >= s.startBeat - 1e-6 && beat < s.startBeat + s.beats - 1e-6);
}

function weightedMedian(notes: readonly PlacedNote[]): number | null {
  if (notes.length === 0) return null;
  const sorted = [...notes].sort((a, b) => a.midi - b.midi);
  const total = sorted.reduce((s, n) => s + n.durationBeats, 0);
  let acc = 0;
  for (const n of sorted) {
    acc += n.durationBeats;
    if (acc >= total / 2) return n.midi;
  }
  return sorted[sorted.length - 1]?.midi ?? null;
}

// The highest note at each onset across the lead tracks: the line a listener follows.
function skyline(notes: readonly PlacedNote[]): PlacedNote[] {
  const out: PlacedNote[] = [];
  for (const n of [...notes].sort((a, b) => a.startBeat - b.startBeat || b.midi - a.midi)) {
    const last = out[out.length - 1];
    if (last !== undefined && Math.abs(last.startBeat - n.startBeat) < 0.06) continue;
    out.push(n);
  }
  return out;
}

function motif(lead: readonly PlacedNote[], spans: readonly Span[]): { score: number; details: Critique['details']['motif'] } {
  const line = skyline(lead);
  const where = new Map<string, Set<number>>();
  let grams = 0;
  for (let i = 0; i + 3 < line.length; i += 1) {
    const iv = [1, 2, 3].map((k) => line[i + k].midi - line[i + k - 1].midi);
    if (iv.every((x) => x === 0) || iv.some((x) => Math.abs(x) > 12)) continue;
    grams += 1;
    const key = iv.join(',');
    const s = spanOf(spans, line[i].startBeat);
    const set = where.get(key) ?? new Set<number>();
    set.add(s);
    where.set(key, set);
  }
  const withLead = new Set(line.map((n) => spanOf(spans, n.startBeat)));
  const recurring = [...where.entries()].filter(([, s]) => s.size >= 2);
  const covered = new Set<number>();
  for (const [, s] of recurring) for (const x of s) covered.add(x);
  const presence = Math.min(1, withLead.size / Math.max(1, 0.75 * spans.length));
  const coverage = grams < 4 ? 0 : (covered.size / Math.max(1, withLead.size)) * presence;
  const variety = grams === 0 ? 0 : where.size / grams;
  const varietyScore = variety < 0.25 ? variety / 0.25 : variety > 0.85 ? clamp01(1 - (variety - 0.85) / 0.15) : 1;
  const top = recurring.sort((a, b) => b[1].size - a[1].size)[0];
  return {
    score: grams < 4 ? 0 : 0.7 * coverage + 0.3 * varietyScore,
    details: { grams, recurring: recurring.length, coverage: r3(coverage), variety: r3(variety), topMotif: top === undefined ? null : top[0].split(',').map(Number) },
  };
}

const TEMPLATES: readonly { readonly name: string; readonly tones: readonly (readonly [number, number])[] }[] = [
  { name: '', tones: [[0, 1], [4, 0.8], [7, 0.8]] },
  { name: 'm', tones: [[0, 1], [3, 0.8], [7, 0.8]] },
  { name: 'dim', tones: [[0, 1], [3, 0.8], [6, 0.8]] },
  { name: 'sus4', tones: [[0, 1], [5, 0.8], [7, 0.8]] },
  { name: '7', tones: [[0, 1], [4, 0.8], [7, 0.8], [10, 0.6]] },
  { name: 'm7', tones: [[0, 1], [3, 0.8], [7, 0.8], [10, 0.6]] },
  { name: '5', tones: [[0, 1], [7, 0.9]] },
];

interface Chord {
  readonly root: number;
  readonly quality: string;
  readonly fit: number;
}

function chordOf(hist: Float64Array): Chord | null {
  const norm = Math.hypot(...hist);
  if (norm === 0) return null;
  let best: Chord | null = null;
  for (let root = 0; root < 12; root += 1) {
    for (const t of TEMPLATES) {
      let dot = 0;
      let tn = 0;
      for (const [iv, w] of t.tones) {
        dot += hist[(root + iv) % 12] * w;
        tn += w * w;
      }
      const fit = dot / (norm * Math.sqrt(tn));
      if (best === null || fit > best.fit + 1e-9) best = { root, quality: t.name, fit };
    }
  }
  return best;
}

function cadenceValue(from: Chord, to: Chord, tonic: number): { score: number; label: string } {
  const motion = (((to.root - from.root) % 12) + 12) % 12;
  const table: Readonly<Record<number, readonly [number, string]>> = {
    5: [from.quality === '' || from.quality === '7' ? 1 : 0.8, 'authentic (V-I)'],
    1: [0.9, 'leading-tone (vii-I)'],
    2: [0.85, 'aeolian (bVII-I)'],
    7: [0.7, 'plagal (IV-I)'],
    4: [0.7, 'submediant (bVI-I)'],
    0: [0.25, 'static (no motion into the wrap)'],
  };
  const [base, label] = table[motion] ?? [0.4, `weak (root motion ${motion} semitones)`];
  const onTonic = to.root === tonic ? 1 : 0.6;
  return { score: base * onTonic, label: `${NAMES[from.root]}${from.quality} -> ${NAMES[to.root]}${to.quality}: ${label}` };
}

function harmony(p: Project, pitched: readonly PlacedNote[], roles: ReadonlyMap<string, Track>): { score: number; details: Critique['details']['harmony'] } {
  const bpb = p.tempo.beatsPerBar;
  const chords: (Chord | null)[] = [];
  for (let bar = 0; bar < p.bars; bar += 1) {
    const hist = new Float64Array(12);
    const s = bar * bpb;
    const e = s + bpb;
    for (const n of pitched) {
      const overlap = Math.min(e, n.startBeat + n.durationBeats) - Math.max(s, n.startBeat);
      if (overlap <= 0) continue;
      const role = roles.get(n.trackId)?.role;
      const w = overlap * (n.velocity / 127) * (role === 'bass' ? 1.6 : role === 'lead' ? 0.6 : 1);
      hist[n.midi % 12] += w;
    }
    chords.push(chordOf(hist));
  }
  const present = chords.filter((c): c is Chord => c !== null);
  const labels = chords.map((c) => (c === null ? 'N' : `${NAMES[c.root]}${c.quality}`));
  const distinct = new Set(present.map((c) => `${c.root}${c.quality}`)).size;
  let changes = 0;
  for (let i = 1; i < chords.length; i += 1) if (labels[i] !== labels[i - 1]) changes += 1;
  const changeRate = chords.length > 1 ? changes / (chords.length - 1) : 0;
  const fit = present.length === 0 ? 0 : present.reduce((a, c) => a + c.fit, 0) / present.length;
  const scale = new Set(scalePcs(p));
  // Raised leading tone and the major IV of melodic minor count as in-key colour.
  if (p.key.mode === 'minor' || p.key.mode === 'aeolian') {
    scale.add((tonicPc(p) + 11) % 12);
    scale.add((tonicPc(p) + 9) % 12);
  }
  let inKey = 0;
  let total = 0;
  for (const n of pitched) {
    const w = n.durationBeats * (n.velocity / 127);
    total += w;
    if (scale.has(n.midi % 12)) inKey += w;
  }
  const keyFit = total > 0 ? inKey / total : 0;
  const first = present[0];
  const last = present[present.length - 1];
  const tonic = tonicPc(p);
  let cadence = { score: 0, label: 'no harmony' };
  if (first !== undefined && last !== undefined) {
    const penultimate = present[present.length - 2];
    cadence = p.loop ? cadenceValue(last, first, tonic) : penultimate !== undefined ? cadenceValue(penultimate, last, tonic) : { score: 0.2, label: 'single chord' };
  }
  const tooRandom = present.length >= 8 && distinct / present.length > 0.85 ? 0.7 : 1;
  const diversity = Math.min(1, distinct / 4) * tooRandom;
  const score = 0.25 * cadence.score + 0.2 * diversity + 0.15 * Math.min(1, changeRate / 0.4) + 0.2 * clamp01((fit - 0.55) / 0.3) + 0.2 * clamp01((keyFit - 0.6) / 0.3);
  return { score, details: { chords: labels, distinct, changeRate: r3(changeRate), fit: r3(fit), keyFit: r3(keyFit), cadence: cadence.label, cadenceScore: r3(cadence.score) } };
}

function rhythm(all: readonly PlacedNote[], lead: readonly PlacedNote[], spans: readonly Span[]): { score: number; details: Critique['details']['rhythm'] } {
  const onsets = [...new Set(all.map((n) => `${n.trackId}@${n.startBeat.toFixed(4)}`))].map((k) => Number(k.split('@')[1]));
  const off = onsets.filter((b) => Math.abs(b - Math.round(b)) > 1e-3).length;
  const sync = onsets.length === 0 ? 0 : off / onsets.length;
  const syncScore = sync < 0.15 ? sync / 0.15 : sync > 0.6 ? clamp01(1 - (sync - 0.6) / 0.4) : 1;
  const densities = spans.map((s) => onsets.filter((b) => b >= s.startBeat && b < s.startBeat + s.beats).length / s.beats);
  const mean = densities.reduce((a, b) => a + b, 0) / Math.max(1, densities.length);
  const sd = Math.sqrt(densities.reduce((a, d) => a + (d - mean) * (d - mean), 0) / Math.max(1, densities.length));
  const cv = mean > 0 ? sd / mean : 0;
  const classes = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, Infinity];
  const counts = new Array<number>(classes.length).fill(0);
  for (const n of skyline(lead)) counts[classes.findIndex((c) => n.durationBeats <= c + 1e-6)] += 1;
  const tot = counts.reduce((a, b) => a + b, 0);
  const entropy = tot === 0 ? 0 : -counts.reduce((a, c) => (c > 0 ? a + (c / tot) * Math.log(c / tot) : a), 0) / Math.log(classes.length);
  return { score: 0.4 * syncScore + 0.3 * Math.min(1, cv / 0.25) + 0.3 * Math.min(1, entropy / 0.55), details: { syncopation: r3(sync), densityCv: r3(cv), durationEntropy: r3(entropy) } };
}

function register(p: Project, byRole: Readonly<Record<'bass' | 'harmony' | 'lead', readonly PlacedNote[]>>, pitched: readonly PlacedNote[]): { score: number; details: Critique['details']['register'] } {
  const bassMed = weightedMedian(byRole.bass);
  const harmMed = weightedMedian(byRole.harmony);
  const leadMed = weightedMedian(byRole.lead);
  const lh = leadMed !== null && harmMed !== null ? clamp01((leadMed - harmMed) / 5) : 0.5;
  const hb = harmMed !== null && bassMed !== null ? clamp01((harmMed - bassMed) / 9) : 0.5;
  const totalBeats = p.bars * p.tempo.beatsPerBar;
  let lowSlices = 0;
  let muddy = 0;
  let masked = 0;
  for (let b = 0; b < totalBeats; b += 0.25) {
    const sounding = pitched.filter((n) => n.startBeat <= b + 1e-6 && n.startBeat + n.durationBeats > b + 1e-6);
    const low = [...new Set(sounding.filter((n) => n.midi < 52).map((n) => n.midi))].sort((x, y) => x - y);
    if (low.length > 0) lowSlices += 1;
    let mud = false;
    for (let i = 0; i < low.length && !mud; i += 1)
      for (let j = i + 1; j < low.length; j += 1) {
        const iv = low[j] - low[i];
        if (iv > 0 && iv < 7 && iv !== 12) {
          mud = true;
          break;
        }
      }
    if (mud) muddy += 1;
  }
  for (const n of byRole.lead) {
    const top = Math.max(-1, ...byRole.harmony.filter((h) => h.startBeat <= n.startBeat + 1e-6 && h.startBeat + h.durationBeats > n.startBeat + 1e-6).map((h) => h.midi));
    if (top > n.midi) masked += 1;
  }
  const mudRatio = lowSlices === 0 ? 0 : muddy / lowSlices;
  const leadMasked = byRole.lead.length === 0 ? 0 : masked / byRole.lead.length;
  const pitches = pitched.map((n) => n.midi).sort((a, b) => a - b);
  const span = pitches.length === 0 ? 0 : pitches[Math.floor(0.95 * (pitches.length - 1))] - pitches[Math.floor(0.05 * (pitches.length - 1))];
  const score = 0.3 * ((lh + hb) / 2) + 0.3 * (1 - clamp01(mudRatio / 0.3)) + 0.2 * (1 - clamp01(leadMasked / 0.5)) + 0.2 * clamp01(span / 36);
  return { score, details: { bassMedian: bassMed, harmonyMedian: harmMed, leadMedian: leadMed, mudRatio: r3(mudRatio), leadMasked: r3(leadMasked), spanSemitones: span } };
}

function dynamics(all: readonly PlacedNote[], lead: readonly PlacedNote[], spans: readonly Span[], roles: ReadonlyMap<string, Track>): { score: number; details: Critique['details']['dynamics'] } {
  const energy = spans.map(() => 0);
  for (const n of all) {
    const s = spanOf(spans, n.startBeat);
    if (s < 0) continue;
    const g = Math.pow(10, (roles.get(n.trackId)?.gainDb ?? 0) / 10);
    energy[s] += Math.pow(n.velocity / 127, 2) * Math.min(n.durationBeats, 2) * g;
  }
  const db = energy.map((e, i) => 10 * Math.log10(e / (spans[i]?.beats ?? 1) + 1e-9));
  const range = db.length > 1 ? Math.max(...db) - Math.min(...db) : 0;
  const peak = db.indexOf(Math.max(...db));
  const arc = peak === 0 && db.length > 1 ? 0.3 : peak >= (db.length - 1) / 2 ? 1 : 0.5;
  const vels = lead.map((n) => n.velocity);
  const vm = vels.reduce((a, b) => a + b, 0) / Math.max(1, vels.length);
  const vstd = Math.sqrt(vels.reduce((a, v) => a + (v - vm) * (v - vm), 0) / Math.max(1, vels.length));
  const arts = [...new Set(all.map((n) => n.articulation))];
  const artScore = arts.length >= 3 ? 1 : arts.length === 2 ? 0.6 : 0.2;
  const score = 0.45 * Math.min(1, range / 6) + 0.2 * arc + 0.2 * Math.min(1, vstd / 10) + 0.15 * artScore;
  return { score, details: { sectionDb: db.map((d) => Number(d.toFixed(2))), rangeDb: Number(range.toFixed(2)), peakSection: peak, leadVelocityStd: Number(vstd.toFixed(2)), articulations: arts } };
}

function adviceFor(c: Omit<Critique, 'advice' | 'score'>): string[] {
  const out: string[] = [];
  const { motif: m, harmony: h, rhythm: r, register: g, dynamics: d } = c.details;
  {
    if (m.grams < 4) out.push('motifRecall: the lead has fewer than 5 moving notes. Give a lead/counter track a real melody with steps and leaps.');
    else if (m.coverage < 0.7) out.push(`motifRecall: only ${Math.round(m.coverage * 100)}% of sections restate a motif. Bring the main hook's interval shape back in later sections (transposed or re-harmonised is fine).`);
    if (m.variety < 0.25) out.push('motifRecall: the lead repeats one figure almost exclusively. Develop it: sequence it, invert a leap, or vary the tail.');
    if (m.variety > 0.85) out.push('motifRecall: almost every 4-note figure is new. Pick a 4-6 note hook and repeat it so the ear has something to hold.');
  }
  {
    if (h.cadenceScore < 0.7) out.push(`harmonicFlow: cadence ${h.cadence}. End the loop on a V (major, with the leading tone) or bVII so the wrap resolves to the tonic.`);
    if (h.distinct < 4) out.push(`harmonicFlow: only ${h.distinct} distinct chords. Add a pre-dominant (iv, bVI or ii) and a dominant.`);
    if (h.fit < 0.75) out.push(`harmonicFlow: chord-tone fit ${h.fit}. Bars blur into clusters; keep each bar's sustained notes on one triad and move passing tones off strong beats.`);
    if (h.keyFit < 0.85) out.push(`harmonicFlow: ${Math.round((1 - h.keyFit) * 100)}% of note weight is outside the key. Use chromatic notes as brief colour, not sustained tones.`);
    if (h.changeRate < 0.4) out.push('harmonicFlow: the harmony rarely changes. Move the chord at least every bar or two.');
  }
  {
    if (r.syncopation < 0.15) out.push('rhythmicVariety: nearly every onset is on the beat. Add off-beat pushes (dotted rhythms, anticipations, 16th pickups).');
    if (r.densityCv < 0.25) out.push('rhythmicVariety: every section is equally busy. Thin out a breakdown and pile up the climax.');
    if (r.durationEntropy < 0.55) out.push('rhythmicVariety: the lead uses one or two note lengths. Mix long held notes with quick pickups.');
  }
  {
    if (g.mudRatio > 0.15) out.push(`registerSeparation: ${Math.round(g.mudRatio * 100)}% of low-register moments stack seconds or thirds below E3. Use octaves or fifths in the bass and move thirds up.`);
    if (g.leadMasked > 0.2) out.push(`registerSeparation: ${Math.round(g.leadMasked * 100)}% of lead notes sit under the harmony. Raise the lead or drop the pads.`);
    if (g.spanSemitones < 30) out.push(`registerSeparation: the arrangement spans only ${g.spanSemitones} semitones. Add a real bass line and a high line.`);
    if (g.bassMedian === null) out.push('registerSeparation: no bass-role track. Add strings-bass or synth-bass under the harmony.');
  }
  {
    if (d.rangeDb < 6) out.push(`dynamicContrast: section energy spans only ${d.rangeDb} dB. Drop layers or velocities in one section and build to a climax.`);
    if (d.peakSection === 0) out.push('dynamicContrast: the first section is the loudest. Build toward the peak instead.');
    if (d.leadVelocityStd < 10) out.push('dynamicContrast: lead velocities barely move. Shape phrases with crescendos and accents.');
    if (d.articulations.length < 3) out.push('dynamicContrast: use more articulations (staccato, accent, legato, sforzando).');
  }
  return out;
}

export function critique(p: Project): Critique {
  const spans = sectionSpans(p);
  const roles = new Map(p.tracks.map((t) => [t.id, t]));
  const live = p.tracks.filter((t) => !t.mute);
  const notesOf = (pred: (t: Track) => boolean): PlacedNote[] => live.filter(pred).flatMap((t) => expandTrackNotes(p, t));
  const all = notesOf(() => true);
  const pitched = notesOf(isPitched);
  let lead = notesOf((t) => t.role === 'lead');
  if (lead.length === 0) {
    const best = live.filter(isPitched).map((t) => ({ t, med: weightedMedian(expandTrackNotes(p, t)) ?? -1 })).sort((a, b) => b.med - a.med)[0];
    lead = best === undefined ? [] : expandTrackNotes(p, best.t);
  }
  const byRole = {
    bass: notesOf((t) => t.role === 'bass'),
    harmony: notesOf((t) => t.role === 'harmony' || t.role === 'pad' || t.role === 'counter'),
    lead,
  };
  const m = motif(lead, spans);
  const h = harmony(p, pitched, roles);
  const r = rhythm(all.filter((n) => roles.get(n.trackId)?.role !== 'fx'), lead, spans);
  const g = register(p, byRole, pitched);
  const d = dynamics(all, lead, spans, roles);
  const subscores = { motifRecall: r3(m.score), harmonicFlow: r3(h.score), rhythmicVariety: r3(r.score), registerSeparation: r3(g.score), dynamicContrast: r3(d.score) };
  const score = (Object.keys(CRITIC_WEIGHTS) as (keyof typeof CRITIC_WEIGHTS)[]).reduce((a, k) => a + CRITIC_WEIGHTS[k] * subscores[k], 0);
  const base = { subscores, details: { motif: m.details, harmony: h.details, rhythm: r.details, register: g.details, dynamics: d.details } };
  return { score: r3(score), ...base, advice: adviceFor(base) };
}
