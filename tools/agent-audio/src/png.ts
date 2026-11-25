import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { renderSeamImage, renderSpectrogramImage, renderWaveformImage, type Image } from './plot.js';
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

function encodeImage(img: Image): Uint8Array {
  return encodeRgbPng(img.width, img.height, img.rgb);
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
  fs.writeFileSync(waveformPath, encodeImage(renderWaveformImage(mono, audio.sampleRate)));
  fs.writeFileSync(spectrogramPath, encodeImage(renderSpectrogramImage(mono, audio.sampleRate)));

  if (includeSeamWrap && mono.length > 16) {
    const seamFrames = Math.min(Math.floor(mono.length / 2), Math.floor(audio.sampleRate * 0.08));
    const stitched = new Float64Array(seamFrames * 2);
    stitched.set(mono.subarray(mono.length - seamFrames), 0);
    stitched.set(mono.subarray(0, seamFrames), seamFrames);
    const seamWrapPath = path.join(outDir, `${baseName}_seam_wrap.png`);
    fs.writeFileSync(seamWrapPath, encodeImage(renderSeamImage(stitched, audio.sampleRate)));
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
