import { rfftMagnitude } from './fft.js';

export interface Image {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
}

type Rgb = readonly [number, number, number];

export const COLORS = {
  background: [12, 14, 24],
  frame: [70, 78, 104],
  grid: [34, 40, 58],
  zero: [48, 56, 78],
  text: [196, 204, 224],
  wave: [107, 229, 255],
  clip: [255, 76, 98],
  wrap: [255, 196, 64],
} as const satisfies Record<string, Rgb>;

// 5x7 glyphs, one 5-bit row per entry, most significant bit on the left.
const GLYPHS: Readonly<Record<string, readonly number[]>> = {
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
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
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
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  ' ': [0, 0, 0, 0, 0, 0, 0],
};

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
const GLYPH_ADVANCE = GLYPH_WIDTH + 1;

export function textWidth(text: string): number {
  return Math.max(0, text.length * GLYPH_ADVANCE - 1);
}

type Canvas = Image;

function createCanvas(width: number, height: number): Canvas {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    rgb.set(COLORS.background, i * 3);
  }
  return { width, height, rgb };
}

function setPixel(c: Canvas, x: number, y: number, color: Rgb): void {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) {
    return;
  }
  c.rgb.set(color, (Math.round(y) * c.width + Math.round(x)) * 3);
}

export function pixelAt(img: Image, x: number, y: number): Rgb {
  const i = (y * img.width + x) * 3;
  return [img.rgb[i] ?? 0, img.rgb[i + 1] ?? 0, img.rgb[i + 2] ?? 0];
}

function hline(c: Canvas, x0: number, x1: number, y: number, color: Rgb, dash = 0): void {
  for (let x = x0; x <= x1; x += 1) {
    if (dash === 0 || Math.floor((x - x0) / dash) % 2 === 0) {
      setPixel(c, x, y, color);
    }
  }
}

function vline(c: Canvas, x: number, y0: number, y1: number, color: Rgb, dash = 0): void {
  for (let y = y0; y <= y1; y += 1) {
    if (dash === 0 || Math.floor((y - y0) / dash) % 2 === 0) {
      setPixel(c, x, y, color);
    }
  }
}

function drawText(c: Canvas, text: string, x: number, y: number, color: Rgb = COLORS.text): void {
  let cx = Math.round(x);
  for (const ch of text.toUpperCase()) {
    const rows = GLYPHS[ch] ?? GLYPHS[' '] ?? [];
    for (const [ry, bits] of rows.entries()) {
      for (let rx = 0; rx < GLYPH_WIDTH; rx += 1) {
        if ((bits & (1 << (GLYPH_WIDTH - 1 - rx))) !== 0) {
          setPixel(c, cx + rx, Math.round(y) + ry, color);
        }
      }
    }
    cx += GLYPH_ADVANCE;
  }
}

/** A plot rectangle inside the canvas. Data loops and tick marks both map through it. */
export interface PlotArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const MARGIN = { left: 34, right: 10, top: 12, bottom: 14 } as const;

/** Time axis: column i of the plot covers frames [frameAtColumn(i), frameAtColumn(i + 1)). */
export interface TimeAxis {
  readonly frames: number;
  readonly sampleRate: number;
  readonly originS: number;
  readonly columns: number;
}

export function frameAtColumn(axis: TimeAxis, column: number): number {
  return Math.floor((column / axis.columns) * axis.frames);
}

export function columnAtTime(axis: TimeAxis, timeS: number): number {
  return Math.round((((timeS - axis.originS) * axis.sampleRate) / axis.frames) * axis.columns);
}

/** Log-frequency axis: row 0 is the top (highest frequency). */
export interface FreqAxis {
  readonly minHz: number;
  readonly maxHz: number;
  readonly rows: number;
}

export function freqAtRow(axis: FreqAxis, row: number): number {
  const frac = 1 - row / Math.max(1, axis.rows - 1);
  return Math.exp(Math.log(axis.minHz) + frac * (Math.log(axis.maxHz) - Math.log(axis.minHz)));
}

export function rowAtFreq(axis: FreqAxis, hz: number): number {
  const frac = (Math.log(hz) - Math.log(axis.minHz)) / (Math.log(axis.maxHz) - Math.log(axis.minHz));
  return Math.round((1 - frac) * Math.max(1, axis.rows - 1));
}

/** Amplitude axis: +1 at the top, -1 at the bottom, with 4% headroom. */
export function rowAtAmplitude(rows: number, value: number): number {
  const mid = Math.floor(rows / 2);
  return Math.max(0, Math.min(rows - 1, Math.round(mid - value * (rows * 0.46))));
}

export const FREQ_TICKS_HZ = [100, 500, 1000, 4000, 12000] as const;
const AMPLITUDE_TICKS = [
  { value: 1, label: '0' },
  { value: 0.5, label: '-6' },
  { value: 0.25, label: '-12' },
  { value: 0.1, label: '-20' },
] as const;

function niceStep(span: number, maxTicks: number): number {
  const raw = span / Math.max(1, maxTicks);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= raw) {
      return m * pow;
    }
  }
  return 10 * pow;
}

function formatTime(seconds: number, inMs: boolean, step: number): string {
  if (inMs) {
    const ms = seconds * 1000;
    const decimals = step * 1000 >= 1 ? 0 : Math.ceil(-Math.log10(step * 1000));
    return ms.toFixed(decimals).replace(/^-0$/, '0');
  }
  const decimals = step >= 1 ? 0 : Math.ceil(-Math.log10(step));
  return seconds.toFixed(decimals);
}

function formatHz(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}K` : String(hz);
}

/** Tick times in seconds, unit, and whether to label in ms. Shared by every time-axis plot. */
export function timeTicks(axis: TimeAxis): { readonly times: readonly number[]; readonly unit: 'MS' | 'S'; readonly step: number } {
  const durationS = axis.frames / axis.sampleRate;
  const inMs = durationS < 2;
  const step = niceStep(durationS, Math.max(2, Math.floor(axis.columns / 70)));
  const times: number[] = [];
  const first = Math.ceil(axis.originS / step - 1e-9) * step;
  for (let i = 0; first + i * step <= axis.originS + durationS + 1e-9; i += 1) {
    // toFixed strips binary noise such as 0.30000000000000004, and + 0 turns -0 into 0.
    times.push(Number((first + i * step).toFixed(9)) + 0);
  }
  return { times, unit: inMs ? 'MS' : 'S', step };
}

function drawFrame(c: Canvas, area: PlotArea): void {
  hline(c, area.x - 1, area.x + area.width, area.y - 1, COLORS.frame);
  hline(c, area.x - 1, area.x + area.width, area.y + area.height, COLORS.frame);
  vline(c, area.x - 1, area.y - 1, area.y + area.height, COLORS.frame);
  vline(c, area.x + area.width, area.y - 1, area.y + area.height, COLORS.frame);
}

function drawTimeAxis(c: Canvas, area: PlotArea, axis: TimeAxis, grid: boolean): void {
  const { times, unit, step } = timeTicks(axis);
  const inMs = unit === 'MS';
  for (const t of times) {
    const x = area.x + columnAtTime(axis, t);
    if (x < area.x || x > area.x + area.width - 1) {
      continue;
    }
    if (grid) {
      vline(c, x, area.y, area.y + area.height - 1, COLORS.grid, 2);
    }
    vline(c, x, area.y + area.height, area.y + area.height + 2, COLORS.frame);
    const label = formatTime(t, inMs, step);
    const lx = Math.max(0, Math.min(c.width - textWidth(label), x - Math.floor(textWidth(label) / 2)));
    drawText(c, label, lx, area.y + area.height + 5);
  }
  drawText(c, unit, c.width - textWidth(unit) - 1, 2);
}

function drawTitle(c: Canvas, title: string): void {
  drawText(c, title, MARGIN.left, 2);
}

function plotArea(width: number, height: number): PlotArea {
  return { x: MARGIN.left, y: MARGIN.top, width, height };
}

function canvasFor(area: PlotArea, extraBottom = 0): Canvas {
  return createCanvas(area.x + area.width + MARGIN.right, area.y + area.height + MARGIN.bottom + extraBottom);
}

function drawWaveformInto(
  c: Canvas,
  area: PlotArea,
  samples: Float64Array,
  axis: TimeAxis,
  labels: boolean,
): void {
  let lastLabelY = -Infinity;
  for (const tick of AMPLITUDE_TICKS) {
    for (const sign of [1, -1]) {
      const y = area.y + rowAtAmplitude(area.height, sign * tick.value);
      hline(c, area.x, area.x + area.width - 1, y, COLORS.grid, 2);
      if (labels && sign === 1 && y - lastLabelY >= GLYPH_HEIGHT + 2) {
        drawText(c, tick.label, area.x - 4 - textWidth(tick.label), y - 3);
        lastLabelY = y;
      }
    }
  }
  hline(c, area.x, area.x + area.width - 1, area.y + rowAtAmplitude(area.height, 0), COLORS.zero);

  const n = samples.length;
  if (n === 0) {
    return;
  }
  for (let col = 0; col < area.width; col += 1) {
    const start = frameAtColumn(axis, col);
    const end = Math.max(start + 1, frameAtColumn(axis, col + 1));
    let minV = 0;
    let maxV = 0;
    for (let i = start; i < Math.min(n, end); i += 1) {
      const v = samples[i] ?? 0;
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const clipped = Math.abs(maxV) >= 0.999 || Math.abs(minV) >= 0.999;
    vline(
      c,
      area.x + col,
      area.y + rowAtAmplitude(area.height, maxV),
      area.y + rowAtAmplitude(area.height, minV),
      clipped ? COLORS.clip : COLORS.wave,
    );
  }
}

function heatColor(norm: number): Rgb {
  const t = Math.max(0, Math.min(1, norm));
  const r = Math.round(Math.min(255, Math.max(0, (t - 0.2) * 340)));
  const g = Math.round(Math.min(255, Math.max(0, (t - 0.5) * 480)));
  const b = Math.round(Math.min(255, Math.max(0, t < 0.5 ? t * 380 : (1 - t) * 380)));
  return [r, g, b];
}

const SPECTRO_FFT = 1024;

export function spectrogramFreqAxis(sampleRate: number, rows: number): FreqAxis {
  return { minHz: 40, maxHz: sampleRate / 2, rows };
}

function drawSpectrogramInto(
  c: Canvas,
  area: PlotArea,
  samples: Float64Array,
  time: TimeAxis,
  freq: FreqAxis,
): void {
  const n = samples.length;
  const sampleRate = time.sampleRate;
  const win = new Float64Array(SPECTRO_FFT);
  for (let col = 0; col < area.width; col += 1) {
    const centre = frameAtColumn(time, col);
    const start = centre - SPECTRO_FFT / 2;
    for (let i = 0; i < SPECTRO_FFT; i += 1) {
      const idx = start + i;
      win[i] = idx >= 0 && idx < n ? (samples[idx] ?? 0) : 0;
    }
    const mag = rfftMagnitude(win, SPECTRO_FFT);
    for (let row = 0; row < area.height; row += 1) {
      const bin = Math.min(mag.length - 1, Math.max(0, Math.round((freqAtRow(freq, row) * SPECTRO_FFT) / sampleRate)));
      const db = 20 * Math.log10((mag[bin] ?? 0) / (SPECTRO_FFT * 0.25) + 1e-9);
      setPixel(c, area.x + col, area.y + row, heatColor((db + 96) / 96));
    }
  }
  for (const hz of FREQ_TICKS_HZ) {
    if (hz < freq.minHz || hz > freq.maxHz) {
      continue;
    }
    const y = area.y + rowAtFreq(freq, hz);
    hline(c, area.x - 3, area.x - 1, y, COLORS.frame);
    const label = formatHz(hz);
    drawText(c, label, area.x - 5 - textWidth(label), y - 3);
  }
}

/** The spectrogram's time axis maps column i to the frame its FFT is centred on, over width - 1 steps. */
function spectrogramTimeAxis(frames: number, sampleRate: number, columns: number, originS = 0): TimeAxis {
  return { frames: Math.max(1, frames - 1), sampleRate, originS, columns: Math.max(1, columns - 1) };
}

export function renderWaveformImage(samples: Float64Array, sampleRate: number, width = 640, height = 180): Image {
  const area = plotArea(width, height);
  const c = canvasFor(area);
  const axis: TimeAxis = { frames: Math.max(1, samples.length), sampleRate, originS: 0, columns: width };
  drawTitle(c, 'WAVEFORM  DBFS');
  drawWaveformInto(c, area, samples, axis, true);
  drawTimeAxis(c, area, axis, true);
  drawFrame(c, area);
  return c;
}

export function renderSpectrogramImage(samples: Float64Array, sampleRate: number, width = 640, height = 240): Image {
  const area = plotArea(width, height);
  const c = canvasFor(area);
  const time = spectrogramTimeAxis(samples.length, sampleRate, width);
  drawTitle(c, 'SPECTROGRAM  HZ (LOG)');
  drawSpectrogramInto(c, area, samples, time, spectrogramFreqAxis(sampleRate, height));
  drawTimeAxis(c, area, time, false);
  drawFrame(c, area);
  return c;
}

/**
 * The loop end joined to the loop start: a waveform strip over a spectrogram, both centred on the wrap.
 * Time ticks read in ms relative to the wrap; the wrap itself is marked in the margins so it never hides a click.
 */
export function renderSeamImage(stitched: Float64Array, sampleRate: number, width = 480): Image {
  const waveHeight = 90;
  const spectroHeight = 160;
  const gap = 20;
  const waveArea = plotArea(width, waveHeight);
  const spectroArea: PlotArea = { x: MARGIN.left, y: waveArea.y + waveHeight + gap, width, height: spectroHeight };
  const c = createCanvas(waveArea.x + width + MARGIN.right, spectroArea.y + spectroHeight + MARGIN.bottom);
  const halfS = stitched.length / 2 / sampleRate;

  drawTitle(c, 'LOOP SEAM  DBFS');
  const waveAxis: TimeAxis = { frames: Math.max(1, stitched.length), sampleRate, originS: -halfS, columns: width };
  const waveWrapX = waveArea.x + columnAtTime(waveAxis, 0);
  // Drawn first so the waveform stays on top of it.
  vline(c, waveWrapX, waveArea.y, waveArea.y + waveArea.height - 1, COLORS.wrap, 3);
  drawWaveformInto(c, waveArea, stitched, waveAxis, true);
  drawTimeAxis(c, waveArea, waveAxis, true);
  drawFrame(c, waveArea);

  const spectroAxis = spectrogramTimeAxis(stitched.length, sampleRate, width, -halfS);
  drawSpectrogramInto(c, spectroArea, stitched, spectroAxis, spectrogramFreqAxis(sampleRate, spectroHeight));
  drawFrame(c, spectroArea);

  for (const [area, axis] of [
    [waveArea, waveAxis],
    [spectroArea, spectroAxis],
  ] as const) {
    const x = area.x + columnAtTime(axis, 0);
    vline(c, x, area.y - 4, area.y - 2, COLORS.wrap);
    vline(c, x, area.y + area.height + 1, area.y + area.height + 3, COLORS.wrap);
  }
  const label = 'WRAP';
  drawText(c, label, waveWrapX - Math.floor(textWidth(label) / 2), spectroArea.y + spectroHeight + 5, COLORS.wrap);
  return c;
}
