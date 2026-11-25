import fs from 'node:fs';
import path from 'node:path';
import { makeRng } from './dsp.js';

export interface Audio {
  readonly sampleRate: number;
  readonly channels: readonly Float64Array[];
}

export type BitDepth = 16 | 24 | 32;

export function decodeWav(bytes: Uint8Array): Audio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number): string => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: { offset: number; size: number } | null = null;
  for (let o = 12; o + 8 <= bytes.byteLength; ) {
    const id = tag(o);
    const size = view.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the first two bytes of the subformat GUID.
      if (format === 0xfffe && size >= 40) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, bytes.byteLength - body) };
    }
    o = body + size + (size % 2);
  }
  if (data === null || channels === 0) throw new Error('WAV has no fmt or data chunk');
  const bytesPer = bits / 8;
  const frames = Math.floor(data.size / (bytesPer * channels));
  const out = Array.from({ length: channels }, () => new Float64Array(frames));
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const p = data.offset + (i * channels + c) * bytesPer;
      let v: number;
      if (format === 3 && bits === 32) v = view.getFloat32(p, true);
      else if (format === 3 && bits === 64) v = view.getFloat64(p, true);
      else if (format === 1 && bits === 16) v = view.getInt16(p, true) / 32768;
      else if (format === 1 && bits === 24) {
        const x = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
        v = ((x << 8) >> 8) / 8388608;
      } else if (format === 1 && bits === 32) v = view.getInt32(p, true) / 2147483648;
      else if (format === 1 && bits === 8) v = (bytes[p] - 128) / 128;
      else throw new Error(`unsupported WAV encoding: format ${format}, ${bits} bits`);
      out[c][i] = v;
    }
  }
  return { sampleRate, channels: out };
}

// PCM at 16 or 24 bits with seeded TPDF dither, or 32-bit float.
export function encodeWav(audio: Audio, bitDepth: BitDepth = 24): Uint8Array {
  const ch = audio.channels.length;
  const frames = audio.channels[0]?.length ?? 0;
  const bytesPer = bitDepth / 8;
  const dataSize = frames * ch * bytesPer;
  const buf = new Uint8Array(44 + dataSize);
  const view = new DataView(buf.buffer);
  const writeTag = (o: number, s: string): void => {
    for (let i = 0; i < 4; i += 1) buf[o + i] = s.charCodeAt(i);
  };
  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  view.setUint16(22, ch, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * ch * bytesPer, true);
  view.setUint16(32, ch * bytesPer, true);
  view.setUint16(34, bitDepth, true);
  writeTag(36, 'data');
  view.setUint32(40, dataSize, true);
  const rng = makeRng(0x5eed);
  const full = bitDepth === 16 ? 32767 : 8388607;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < ch; c += 1) {
      const x = audio.channels[c][i];
      const p = 44 + (i * ch + c) * bytesPer;
      if (bitDepth === 32) {
        view.setFloat32(p, x, true);
        continue;
      }
      const q = Math.max(-full - 1, Math.min(full, Math.round(x * full + rng() - rng())));
      if (bitDepth === 16) view.setInt16(p, q, true);
      else {
        buf[p] = q & 0xff;
        buf[p + 1] = (q >> 8) & 0xff;
        buf[p + 2] = (q >> 16) & 0xff;
      }
    }
  }
  return buf;
}

export function readWav(file: string): Audio {
  return decodeWav(new Uint8Array(fs.readFileSync(file)));
}

export function writeWav(file: string, audio: Audio, bitDepth: BitDepth = 24): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, encodeWav(audio, bitDepth));
}
