import fs from 'node:fs';
import {
  WavError,
  type AudioBufferData,
  type SupportedBitFormat,
  type SupportedChannels,
  type SupportedSampleRate,
} from './types.js';

export const SUPPORTED_SAMPLE_RATES: readonly SupportedSampleRate[] = [44100, 48000];
export const SUPPORTED_CHANNELS: readonly SupportedChannels[] = [1, 2];

const GUID_SUBTYPE_PCM = [
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];
const GUID_SUBTYPE_IEEE_FLOAT = [
  0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

function guidEquals(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  for (let i = 0; i < 16; i += 1) {
    if (bytes[offset + i] !== expected[i]) {
      return false;
    }
  }
  return true;
}

function isSupportedSampleRate(rate: number): rate is SupportedSampleRate {
  return rate === 44100 || rate === 48000;
}

function isSupportedChannels(ch: number): ch is SupportedChannels {
  return ch === 1 || ch === 2;
}

export function decodeWav(bytes: Uint8Array): AudioBufferData {
  if (bytes.byteLength < 44) {
    throw new WavError('INVALID_HEADER', `WAV buffer too small (${bytes.byteLength} bytes)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  const riffSize = view.getUint32(4, true);
  const wave = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new WavError('INVALID_HEADER', `Expected RIFF/WAVE header, got ${riff}/${wave}`);
  }
  const containerEnd = 8 + riffSize;
  if (riffSize < 4 || containerEnd > bytes.byteLength) {
    throw new WavError(
      'TRUNCATED_DATA',
      `RIFF container declares ${containerEnd} bytes, but file has ${bytes.byteLength} bytes`,
    );
  }

  let audioFormat: number | null = null;
  let numChannels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let dataOffset: number | null = null;
  let dataSize: number | null = null;

  let offset = 12;
  while (offset + 8 <= containerEnd) {
    const chunkId = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0,
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + chunkSize;

    if (bodyEnd > containerEnd) {
      throw new WavError(
        'TRUNCATED_DATA',
        `Chunk '${chunkId}' declares ${chunkSize} bytes past declared RIFF container end`,
      );
    }

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new WavError('INVALID_HEADER', `fmt chunk too small (${chunkSize} bytes)`);
      }
      let tag = view.getUint16(bodyStart, true);
      numChannels = view.getUint16(bodyStart + 2, true);
      sampleRate = view.getUint32(bodyStart + 4, true);
      bitsPerSample = view.getUint16(bodyStart + 14, true);

      if (tag === 0xfffe) {
        if (chunkSize < 40) {
          throw new WavError('INVALID_HEADER', `WAVE_FORMAT_EXTENSIBLE fmt chunk too small (${chunkSize} bytes)`);
        }
        const validBits = view.getUint16(bodyStart + 18, true);
        if (validBits !== 0 && validBits !== bitsPerSample) {
          throw new WavError(
            'UNSUPPORTED_FORMAT',
            `Unsupported validBitsPerSample=${validBits} for container ${bitsPerSample}-bit`,
          );
        }
        if (guidEquals(bytes, bodyStart + 24, GUID_SUBTYPE_PCM)) {
          tag = 1;
        } else if (guidEquals(bytes, bodyStart + 24, GUID_SUBTYPE_IEEE_FLOAT)) {
          tag = 3;
        } else {
          throw new WavError('UNSUPPORTED_FORMAT', 'Unsupported WAVE_FORMAT_EXTENSIBLE SubFormat GUID');
        }
      }
      audioFormat = tag;
    } else if (chunkId === 'data') {
      dataOffset = bodyStart;
      dataSize = chunkSize;
    }

    // RIFF chunks with odd sizes are followed by a 1-byte pad.
    offset = bodyEnd + (chunkSize & 1);
  }

  if (audioFormat === null || numChannels === null || sampleRate === null || bitsPerSample === null) {
    throw new WavError('INVALID_HEADER', 'Missing fmt chunk');
  }
  if (dataOffset === null || dataSize === null) {
    throw new WavError('MISSING_DATA_CHUNK', 'Missing data chunk');
  }

  if (!isSupportedChannels(numChannels)) {
    throw new WavError(
      'UNSUPPORTED_CHANNELS',
      `Unsupported channel count ${numChannels}; supported: 1, 2`,
    );
  }
  if (!isSupportedSampleRate(sampleRate)) {
    throw new WavError(
      'UNSUPPORTED_SAMPLE_RATE',
      `Unsupported sample rate ${sampleRate} Hz; supported: 44100, 48000`,
    );
  }

  let format: SupportedBitFormat;
  let bytesPerSample: number;
  if (audioFormat === 1 && bitsPerSample === 16) {
    format = 'pcm16';
    bytesPerSample = 2;
  } else if (audioFormat === 1 && bitsPerSample === 24) {
    format = 'pcm24';
    bytesPerSample = 3;
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    format = 'float32';
    bytesPerSample = 4;
  } else {
    throw new WavError(
      'UNSUPPORTED_FORMAT',
      `Unsupported WAV format tag=${audioFormat} bits=${bitsPerSample}; supported: PCM16, PCM24, IEEE float32`,
    );
  }

  const blockAlign = numChannels * bytesPerSample;
  if (dataSize % blockAlign !== 0) {
    throw new WavError(
      'TRUNCATED_DATA',
      `Data chunk size ${dataSize} is not a multiple of frame size ${blockAlign}`,
    );
  }
  const frames = dataSize / blockAlign;
  const channels: Float64Array[] = [];
  for (let c = 0; c < numChannels; c += 1) {
    channels.push(new Float64Array(frames));
  }

  let cursor = dataOffset;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      let sample: number;
      if (format === 'pcm16') {
        sample = view.getInt16(cursor, true) / 32768;
      } else if (format === 'pcm24') {
        const b0 = bytes[cursor] ?? 0;
        const b1 = bytes[cursor + 1] ?? 0;
        const b2 = bytes[cursor + 2] ?? 0;
        let raw = b0 | (b1 << 8) | (b2 << 16);
        if ((raw & 0x800000) !== 0) {
          raw |= ~0xffffff;
        }
        sample = raw / 8388608;
      } else {
        sample = view.getFloat32(cursor, true);
        if (!Number.isFinite(sample)) {
          throw new WavError(
            'NONFINITE_SAMPLE',
            `Non-finite float32 sample at channel ${c}, frame ${i}`,
          );
        }
      }
      const chBuf = channels[c];
      if (chBuf !== undefined) {
        chBuf[i] = sample;
      }
      cursor += bytesPerSample;
    }
  }

  return {
    sampleRate,
    channels,
    format,
  };
}

export function readWavFile(filePath: string): AudioBufferData {
  if (!fs.existsSync(filePath)) {
    throw new WavError('FILE_NOT_FOUND', `File not found: ${filePath}`);
  }
  const bytes = fs.readFileSync(filePath);
  return decodeWav(bytes);
}

function quantizePcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  const scaled = clamped * 32768;
  return Math.max(-32768, Math.min(32767, Math.round(scaled)));
}

export function encodeWav(
  channels: readonly Float64Array[],
  sampleRate: SupportedSampleRate,
  encoding: 'pcm16' | 'float32' = 'pcm16',
): Uint8Array {
  const numChannels = channels.length;
  if (!isSupportedChannels(numChannels)) {
    throw new WavError('UNSUPPORTED_CHANNELS', `Cannot encode ${numChannels} channels`);
  }
  const frames = channels[0]?.length ?? 0;
  for (let c = 1; c < numChannels; c += 1) {
    if (channels[c]?.length !== frames) {
      throw new WavError('TRUNCATED_DATA', 'Channel lengths do not match');
    }
  }

  const audioFormat = encoding === 'float32' ? 3 : 1;
  const bitsPerSample = encoding === 'float32' ? 32 : 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frames * blockAlign;
  const totalSize = 44 + dataSize;

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  out.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, totalSize - 8, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);

  out.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  out.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, dataSize, true);

  let cursor = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      const value = channels[c]?.[i] ?? 0;
      if (!Number.isFinite(value)) {
        throw new WavError('NONFINITE_SAMPLE', `Non-finite sample at channel ${c}, frame ${i}`);
      }
      if (encoding === 'float32') {
        view.setFloat32(cursor, value, true);
      } else {
        view.setInt16(cursor, quantizePcm16(value), true);
      }
      cursor += bytesPerSample;
    }
  }
  return out;
}
