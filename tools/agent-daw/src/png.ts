import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fftInPlace } from './fft.js';
import type { Audio } from './wav.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

export class Canvas {
  readonly rgb: Uint8Array;
  constructor(readonly width: number, readonly height: number, bg: readonly [number, number, number]) {
    this.rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i += 1) this.rgb.set(bg, i * 3);
  }
  set(x: number, y: number, c: readonly [number, number, number]): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.rgb.set(c, (Math.floor(y) * this.width + Math.floor(x)) * 3);
  }
  vline(x: number, y0: number, y1: number, c: readonly [number, number, number]): void {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1) this.set(x, y, c);
  }
  hline(y: number, x0: number, x1: number, c: readonly [number, number, number]): void {
    for (let x = x0; x <= x1; x += 1) this.set(x, y, c);
  }
  text(x: number, y: number, s: string, c: readonly [number, number, number]): void {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const glyph = FONT[ch] ?? FONT[' '];
      glyph?.forEach((row, ry) => {
        for (let rx = 0; rx < 5; rx += 1) if ((row >> (4 - rx)) & 1) this.set(cx + rx, y + ry, c);
      });
      cx += 6;
    }
  }
  png(): Uint8Array {
    const stride = this.width * 3;
    const raw = new Uint8Array((stride + 1) * this.height);
    for (let y = 0; y < this.height; y += 1) raw.set(this.rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, this.width, false);
    v.setUint32(4, this.height, false);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

const FONT: Readonly<Record<string, readonly number[]>> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x11, 0x1f, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '.': [0, 0, 0, 0, 0, 0x0c, 0x0c],
  '-': [0, 0, 0, 0x1f, 0, 0, 0],
  '+': [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0],
  ':': [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0],
  '/': [0, 0x01, 0x02, 0x04, 0x08, 0x10, 0],
  '=': [0, 0, 0x1f, 0, 0x1f, 0, 0],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '%': [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03],
};

const BG = [12, 14, 24] as const;
const GRID = [44, 52, 74] as const;
const LABEL = [190, 200, 220] as const;
const WAVE = [107, 229, 255] as const;
const CLIP = [255, 76, 98] as const;
const SEAM = [255, 200, 60] as const;

export interface PlotOptions {
  readonly title: string;
  readonly barS?: number;
}

function drawTimeAxis(c: Canvas, x0: number, w: number, y: number, durS: number, barS: number | undefined, top: number): void {
  const step = barS ?? (durS > 20 ? 5 : durS > 5 ? 1 : 0.25);
  let k = 0;
  for (let t = 0; t <= durS + 1e-9; t += step, k += 1) {
    const x = x0 + Math.round((t / durS) * (w - 1));
    for (let yy = top; yy < y; yy += 3) c.set(x, yy, GRID);
    const label = barS !== undefined ? `${k + 1}` : `${Number(t.toFixed(2))}S`;
    if (barS === undefined || k % Math.max(1, Math.ceil((durS / barS) / 16)) === 0) c.text(x + 2, y + 3, label, LABEL);
  }
  c.text(x0 + w - 6 * (barS !== undefined ? 3 : 4), y + 13, barS !== undefined ? 'BAR' : 'TIME', LABEL);
}

export function waveformPng(audio: Audio, o: PlotOptions): Uint8Array {
  const W = 1100;
  const lanes = audio.channels.length;
  const laneH = 130;
  const left = 48;
  const top = 22;
  const H = top + laneH * lanes + 34;
  const c = new Canvas(W, H, BG);
  const plotW = W - left - 12;
  const n = audio.channels[0]?.length ?? 0;
  const durS = n / audio.sampleRate;
  c.text(left, 6, o.title, LABEL);
  audio.channels.forEach((ch, li) => {
    const mid = top + li * laneH + laneH / 2;
    const half = laneH * 0.45;
    c.hline(Math.round(mid), left, left + plotW - 1, GRID);
    c.text(4, Math.round(mid) - 3, li === 0 ? (lanes === 1 ? 'M' : 'L') : 'R', LABEL);
    c.text(4, Math.round(mid - half), '+1', LABEL);
    c.text(4, Math.round(mid + half) - 6, '-1', LABEL);
    for (let x = 0; x < plotW; x += 1) {
      const s = Math.floor((x / plotW) * n);
      const e = Math.max(s + 1, Math.floor(((x + 1) / plotW) * n));
      let lo = 0;
      let hi = 0;
      for (let i = s; i < Math.min(n, e); i += 1) {
        lo = Math.min(lo, ch[i]);
        hi = Math.max(hi, ch[i]);
      }
      const clipped = hi >= 0.999 || lo <= -0.999;
      c.vline(left + x, Math.round(mid - hi * half), Math.round(mid - lo * half), clipped ? CLIP : WAVE);
    }
  });
  const axisY = top + laneH * lanes;
  drawTimeAxis(c, left, plotW, axisY, durS, o.barS, top);
  c.vline(left + plotW - 1, top, axisY, SEAM);
  return c.png();
}

function heat(t: number): readonly [number, number, number] {
  const v = Math.max(0, Math.min(1, t));
  return [Math.round(Math.min(255, Math.max(0, (v - 0.15) * 330))), Math.round(Math.min(255, Math.max(0, (v - 0.45) * 460))), Math.round(Math.min(255, Math.max(0, v < 0.45 ? v * 400 : (1 - v) * 330)))];
}

export function spectrogramPng(audio: Audio, o: PlotOptions): Uint8Array {
  const W = 1100;
  const H = 400;
  const left = 48;
  const top = 22;
  const plotW = W - left - 12;
  const plotH = H - top - 34;
  const c = new Canvas(W, H, BG);
  const sr = audio.sampleRate;
  const n = audio.channels[0]?.length ?? 0;
  const mono = new Float64Array(n);
  for (const ch of audio.channels) for (let i = 0; i < n; i += 1) mono[i] += ch[i] / audio.channels.length;
  const size = 4096;
  const fMin = 30;
  const fMax = Math.min(20000, sr / 2);
  const lmin = Math.log(fMin);
  const lspan = Math.log(fMax) - lmin;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const columns: Float64Array[] = [];
  let maxDb = -200;
  for (let x = 0; x < plotW; x += 1) {
    const centre = Math.floor(((x + 0.5) / plotW) * n);
    for (let j = 0; j < size; j += 1) {
      const idx = centre - size / 2 + j;
      re[j] = idx >= 0 && idx < n ? mono[idx] * 0.5 * (1 - Math.cos((2 * Math.PI * j) / size)) : 0;
      im[j] = 0;
    }
    fftInPlace(re, im);
    const col = new Float64Array(plotH);
    for (let y = 0; y < plotH; y += 1) {
      const fLo = Math.exp(lmin + ((plotH - y - 1) / plotH) * lspan);
      const fHi = Math.exp(lmin + ((plotH - y) / plotH) * lspan);
      const b0 = Math.max(1, Math.floor((fLo * size) / sr));
      const b1 = Math.max(b0, Math.ceil((fHi * size) / sr));
      let p = 0;
      for (let b = b0; b <= b1; b += 1) p = Math.max(p, re[b] * re[b] + im[b] * im[b]);
      const db = 10 * Math.log10(p / ((size / 4) * (size / 4)) + 1e-14);
      col[y] = db;
      maxDb = Math.max(maxDb, db);
    }
    columns.push(col);
  }
  columns.forEach((col, x) => col.forEach((db, y) => c.set(left + x, top + y, heat((db - maxDb + 90) / 90))));
  c.text(left, 6, `${o.title}  (0 TO -90 DB REL)`, LABEL);
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (f > fMax) continue;
    const y = top + Math.round(plotH - 1 - ((Math.log(f) - lmin) / lspan) * (plotH - 1));
    for (let x = left; x < left + plotW; x += 4) c.set(x, y, GRID);
    c.text(2, y - 3, f >= 1000 ? `${f / 1000}K` : `${f}`, LABEL);
  }
  drawTimeAxis(c, left, plotW, top + plotH, n / sr, o.barS, top);
  return c.png();
}

export function writePngs(audio: Audio, outDir: string, base: string, o: PlotOptions): { readonly waveform: string; readonly spectrogram: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const waveform = path.join(outDir, `${base}_waveform.png`);
  const spectrogram = path.join(outDir, `${base}_spectrogram.png`);
  fs.writeFileSync(waveform, waveformPng(audio, o));
  fs.writeFileSync(spectrogram, spectrogramPng(audio, o));
  return { waveform, spectrogram };
}
