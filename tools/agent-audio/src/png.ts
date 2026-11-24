import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { rfftMagnitude } from './fft.js';
import type { AudioBufferData } from './types.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput), false);
  return out;
}

export function encodeRgbPng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = zlib.deflateSync(raw, { level: 6 });

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array(0))];
  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function setPixel(rgb: Uint8Array, width: number, x: number, y: number, r: number, g: number, b: number): void {
  const idx = (y * width + x) * 3;
  rgb[idx] = r;
  rgb[idx + 1] = g;
  rgb[idx + 2] = b;
}

function heatColor(norm: number): readonly [number, number, number] {
  const t = Math.max(0, Math.min(1, norm));
  const r = Math.round(Math.min(255, Math.max(0, (t - 0.2) * 340)));
  const g = Math.round(Math.min(255, Math.max(0, (t - 0.5) * 480)));
  const b = Math.round(Math.min(255, Math.max(0, t < 0.5 ? t * 380 : (1 - t) * 380)));
  return [r, g, b];
}

function monoMix(audio: AudioBufferData): Float64Array {
  const n = audio.channels[0]?.length ?? 0;
  const out = new Float64Array(n);
  const chCount = audio.channels.length;
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let c = 0; c < chCount; c += 1) {
      sum += audio.channels[c]?.[i] ?? 0;
    }
    out[i] = sum / chCount;
  }
  return out;
}

function renderWaveformPng(samples: Float64Array, width = 640, height = 180): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = 12;
    rgb[i * 3 + 1] = 14;
    rgb[i * 3 + 2] = 24;
  }
  const midY = Math.floor(height / 2);
  for (let x = 0; x < width; x += 1) {
    setPixel(rgb, width, x, midY, 48, 56, 78);
  }
  const n = samples.length;
  if (n > 0) {
    for (let x = 0; x < width; x += 1) {
      const start = Math.floor((x / width) * n);
      const end = Math.max(start + 1, Math.floor(((x + 1) / width) * n));
      let minV = 0;
      let maxV = 0;
      for (let i = start; i < Math.min(n, end); i += 1) {
        const v = samples[i] ?? 0;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
      const yTop = Math.max(0, Math.min(height - 1, Math.round(midY - maxV * (height * 0.46))));
      const yBot = Math.max(0, Math.min(height - 1, Math.round(midY - minV * (height * 0.46))));
      const clipped = Math.abs(maxV) >= 0.999 || Math.abs(minV) >= 0.999;
      for (let y = yTop; y <= yBot; y += 1) {
        if (clipped) {
          setPixel(rgb, width, x, y, 255, 76, 98);
        } else {
          setPixel(rgb, width, x, y, 107, 229, 255);
        }
      }
    }
  }
  return encodeRgbPng(width, height, rgb);
}

function renderSpectrogramPng(
  samples: Float64Array,
  sampleRate: number,
  width = 640,
  height = 240,
): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  const fftSize = 1024;
  const n = samples.length;
  const fMin = 40;
  const fMax = sampleRate / 2;
  const logMin = Math.log(fMin);
  const logSpan = Math.log(fMax) - logMin;

  for (let x = 0; x < width; x += 1) {
    const center = Math.floor((x / Math.max(1, width - 1)) * Math.max(0, n - 1));
    const win = new Float64Array(fftSize);
    const start = center - fftSize / 2;
    for (let i = 0; i < fftSize; i += 1) {
      const idx = start + i;
      win[i] = idx >= 0 && idx < n ? (samples[idx] ?? 0) : 0;
    }
    const mag = rfftMagnitude(win, fftSize);
    for (let y = 0; y < height; y += 1) {
      const frac = 1 - y / Math.max(1, height - 1);
      const freq = Math.exp(logMin + frac * logSpan);
      const bin = Math.min(mag.length - 1, Math.max(0, Math.round((freq * fftSize) / sampleRate)));
      const db = 20 * Math.log10((mag[bin] ?? 0) / (fftSize * 0.25) + 1e-9);
      const norm = (db + 96) / 96;
      const [r, g, b] = heatColor(norm);
      setPixel(rgb, width, x, y, r, g, b);
    }
  }
  return encodeRgbPng(width, height, rgb);
}

export function writeInspectionPngs(
  audio: AudioBufferData,
  outDir: string,
  baseName: string,
  includeSeamWrap: boolean,
): { readonly waveform: string; readonly spectrogram: string; readonly seamWrap?: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const mono = monoMix(audio);

  const waveformPath = path.join(outDir, `${baseName}_waveform.png`);
  const spectrogramPath = path.join(outDir, `${baseName}_spectrogram.png`);
  fs.writeFileSync(waveformPath, renderWaveformPng(mono));
  fs.writeFileSync(spectrogramPath, renderSpectrogramPng(mono, audio.sampleRate));

  if (includeSeamWrap && mono.length > 16) {
    const seamFrames = Math.min(Math.floor(mono.length / 2), Math.floor(audio.sampleRate * 0.08));
    const stitched = new Float64Array(seamFrames * 2);
    stitched.set(mono.subarray(mono.length - seamFrames), 0);
    stitched.set(mono.subarray(0, seamFrames), seamFrames);
    const seamWrapPath = path.join(outDir, `${baseName}_seam_wrap.png`);
    fs.writeFileSync(seamWrapPath, renderSpectrogramPng(stitched, audio.sampleRate, 480, 200));
    return {
      waveform: waveformPath,
      spectrogram: spectrogramPath,
      seamWrap: seamWrapPath,
    };
  }

  return {
    waveform: waveformPath,
    spectrogram: spectrogramPath,
  };
}
