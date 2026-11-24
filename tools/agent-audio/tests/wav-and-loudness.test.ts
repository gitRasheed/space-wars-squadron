import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  checkAudio,
  decodeWav,
  encodeWav,
  measureLoudness,
  measureTruePeak,
  WavError,
  type SupportedSampleRate,
} from '../src/index.js';

function makeSine(freqHz: number, durationS: number, sr: SupportedSampleRate, amp: number): Float64Array {
  const frames = Math.round(durationS * sr);
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sr) * amp;
  }
  return out;
}

function measureWithFfmpeg(wavPath: string): {
  readonly integrated: number | null;
  readonly momentaryMax: number | null;
  readonly truePeak: number | null;
} | null {
  const res = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', wavPath, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  if (res.error !== undefined || res.status !== 0) {
    return null;
  }
  const text = `${res.stdout}${res.stderr}`;
  const summaryIdx = text.lastIndexOf('Summary:');
  const summary = summaryIdx >= 0 ? text.slice(summaryIdx) : text;
  const grab = (re: RegExp): number | null => {
    const m = summary.match(re);
    if (m === null || m[1] === undefined) {
      return null;
    }
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  const moms = [...text.matchAll(/\bM:\s*([+-]?\d+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]))
    .filter((v) => Number.isFinite(v) && v > -70);
  return {
    integrated: grab(/Integrated loudness:\s*I:\s*([+-]?\d+(?:\.\d+)?)\s*LUFS/i),
    momentaryMax: moms.length > 0 ? Math.max(...moms) : null,
    truePeak: grab(/True peak:\s*Peak:\s*([+-]?\d+(?:\.\d+)?)\s*dB/i),
  };
}

function buildPcm24WithOddMetadataChunk(samples: readonly number[], sr: SupportedSampleRate): Uint8Array {
  const metaBody = new TextEncoder().encode('ABC'); // 3 bytes (odd) -> requires 1 pad byte
  const dataSize = samples.length * 3;
  const totalSize = 12 + (8 + 16) + (8 + metaBody.length + 1) + (8 + dataSize);
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let pos = 0;

  out.set(new TextEncoder().encode('RIFF'), pos);
  view.setUint32(pos + 4, totalSize - 8, true);
  out.set(new TextEncoder().encode('WAVE'), pos + 8);
  pos += 12;

  out.set(new TextEncoder().encode('fmt '), pos);
  view.setUint32(pos + 4, 16, true);
  view.setUint16(pos + 8, 1, true);
  view.setUint16(pos + 10, 1, true);
  view.setUint32(pos + 12, sr, true);
  view.setUint32(pos + 16, sr * 3, true);
  view.setUint16(pos + 20, 3, true);
  view.setUint16(pos + 22, 24, true);
  pos += 24;

  out.set(new TextEncoder().encode('JUNK'), pos);
  view.setUint32(pos + 4, metaBody.length, true);
  out.set(metaBody, pos + 8);
  pos += 8 + metaBody.length + 1;

  out.set(new TextEncoder().encode('data'), pos);
  view.setUint32(pos + 4, dataSize, true);
  pos += 8;

  for (const s of samples) {
    const raw = Math.max(-8388608, Math.min(8388607, Math.round(s * 8388608)));
    const u = raw < 0 ? raw + 0x1000000 : raw;
    out[pos] = u & 0xff;
    out[pos + 1] = (u >> 8) & 0xff;
    out[pos + 2] = (u >> 16) & 0xff;
    pos += 3;
  }
  return out;
}

describe('WAV support matrix and error contracts', () => {
  it('decodes PCM24 with negative samples and odd-length padded metadata chunks', () => {
    const input = [-0.75, -0.25, 0, 0.25, 0.5];
    const wav = buildPcm24WithOddMetadataChunk(input, 48000);
    const decoded = decodeWav(wav);
    assert.equal(decoded.format, 'pcm24');
    assert.equal(decoded.sampleRate, 48000);
    assert.equal(decoded.channels.length, 1);
    for (let i = 0; i < input.length; i += 1) {
      assert.ok(Math.abs((decoded.channels[0]?.[i] ?? 0) - (input[i] ?? 0)) < 1e-5);
    }
  });

  it('rejects unsupported formats, truncated data, and non-finite float32 with distinct codes', () => {
    assert.throws(
      () => decodeWav(new Uint8Array(20)),
      (err: unknown) => err instanceof WavError && err.code === 'INVALID_HEADER',
    );

    const validFloat = encodeWav([new Float64Array([0.1, 0.2, 0.3])], 44100, 'float32');
    const badRate = new Uint8Array(validFloat);
    new DataView(badRate.buffer).setUint32(24, 22050, true);
    assert.throws(
      () => decodeWav(badRate),
      (err: unknown) => err instanceof WavError && err.code === 'UNSUPPORTED_SAMPLE_RATE',
    );

    const truncated = validFloat.subarray(0, validFloat.byteLength - 2);
    assert.throws(
      () => decodeWav(truncated),
      (err: unknown) => err instanceof WavError && err.code === 'TRUNCATED_DATA',
    );

    const nanWav = new Uint8Array(validFloat);
    new DataView(nanWav.buffer).setFloat32(44, Number.NaN, true);
    assert.throws(
      () => decodeWav(nanWav),
      (err: unknown) => err instanceof WavError && err.code === 'NONFINITE_SAMPLE',
    );

    // Declared RIFF size exceeding file length must fail TRUNCATED_DATA.
    const oneSample = encodeWav([new Float64Array([0.5])], 48000, 'pcm16');
    const badRiffSize = new Uint8Array(oneSample);
    new DataView(badRiffSize.buffer).setUint32(4, 999, true);
    assert.throws(
      () => decodeWav(badRiffSize),
      (err: unknown) => err instanceof WavError && err.code === 'TRUNCATED_DATA',
    );

    // Trailing empty data chunk appended OUTSIDE the declared RIFF container must be ignored.
    const trailing = new Uint8Array(oneSample.byteLength + 8);
    trailing.set(oneSample, 0);
    trailing.set(new TextEncoder().encode('data'), oneSample.byteLength);
    new DataView(trailing.buffer).setUint32(oneSample.byteLength + 4, 0, true);
    const decodedTrailing = decodeWav(trailing);
    assert.equal(decodedTrailing.channels[0]?.length, 1);
    assert.ok(Math.abs((decodedTrailing.channels[0]?.[0] ?? 0) - 0.5) < 1e-4);
  });

  it('decodes WAVE_FORMAT_EXTENSIBLE (tag 0xFFFE) PCM24 WAVs produced by ffmpeg', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audio-ext-'));
    try {
      const outPath = path.join(tmpDir, 'ext24.wav');
      const res = spawnSync(
        'ffmpeg',
        ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.05:sample_rate=48000', '-c:a', 'pcm_s24le', outPath],
        { encoding: 'utf8' },
      );
      if (res.error !== undefined || res.status !== 0) {
        return;
      }
      const decoded = decodeWav(fs.readFileSync(outPath));
      assert.equal(decoded.format, 'pcm24');
      assert.equal(decoded.sampleRate, 48000);
      assert.ok((decoded.channels[0]?.length ?? 0) >= 2000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('BS.1770-4 loudness and 4x true peak contracts', () => {
  it('handles silence, <400ms padding boundary, gated quiet passages, and duplicated stereo', () => {
    const sr: SupportedSampleRate = 48000;
    const silence = measureLoudness([new Float64Array(sr)], sr);
    assert.equal(silence.integratedLufs, null);
    assert.equal(silence.integratedReason, 'below_absolute_gate');
    assert.equal(silence.momentaryMaxLufs, null);
    assert.equal(silence.truePeakDbtp, null);

    const short80 = measureLoudness([makeSine(1000, 0.08, sr, 0.25)], sr);
    assert.equal(short80.integratedLufs, null);
    assert.equal(short80.integratedReason, 'duration_below_400ms');
    assert.equal(short80.momentaryPadded, true);
    assert.ok(short80.momentaryMaxLufs !== null && short80.momentaryMaxLufs > -30);

    const under400 = measureLoudness([new Float64Array(Math.round(0.4 * sr) - 1)], sr);
    const exact400 = measureLoudness([makeSine(1000, 0.4, sr, 0.25)], sr);
    const over400 = measureLoudness([makeSine(1000, 0.401, sr, 0.25)], sr);
    assert.equal(under400.integratedReason, 'duration_below_400ms');
    assert.ok(exact400.integratedLufs !== null);
    assert.ok(over400.integratedLufs !== null);

    const mono = makeSine(1000, 1.0, sr, 0.25);
    const monoLoud = measureLoudness([mono], sr);
    const stereoLoud = measureLoudness([mono, mono], sr);
    assert.ok(monoLoud.integratedLufs !== null && stereoLoud.integratedLufs !== null);
    assert.ok(Math.abs(stereoLoud.integratedLufs - monoLoud.integratedLufs - 3.01) < 0.05);

    // 1 s loud (-12 dBFS) + 2 s quiet (-32 dBFS): relative -10 LU gate excludes quiet blocks (ungated would drop ~4.7 LU).
    const loudPart = makeSine(1000, 1.0, sr, 0.25);
    const quietPart = makeSine(1000, 2.0, sr, 0.025);
    const combined = new Float64Array(loudPart.length + quietPart.length);
    combined.set(loudPart, 0);
    combined.set(quietPart, loudPart.length);
    const gated = measureLoudness([combined], sr);
    assert.ok(gated.integratedLufs !== null && monoLoud.integratedLufs !== null);
    assert.ok(
      Math.abs(gated.integratedLufs - monoLoud.integratedLufs) < 1.3,
      `Expected relative gate near loud level ${monoLoud.integratedLufs}, got ${gated.integratedLufs}`,
    );
    assert.ok(
      gated.integratedLufs > monoLoud.integratedLufs - 2.0,
      `Expected relative gate to reject quiet blocks (got ${gated.integratedLufs})`,
    );
  });

  it('detects intersample peaks above 0 dBFS and file-edge peaks', () => {
    // Classic Nyquist/4 intersample peak: [+0.9, +0.9, -0.9, -0.9] oversamples > 1.0 (> 0 dBTP).
    const pattern = new Float64Array(128);
    for (let i = 0; i < pattern.length; i += 4) {
      pattern[i] = 0.9;
      pattern[i + 1] = 0.9;
      pattern[i + 2] = -0.9;
      pattern[i + 3] = -0.9;
    }
    const isp = measureTruePeak([pattern]);
    assert.ok(isp.truePeakDbtp !== null && isp.truePeakDbtp > 0.5, `Expected ISP > 0.5 dBTP, got ${isp.truePeakDbtp}`);

    const edgeSpike = new Float64Array(64);
    edgeSpike[0] = 0.95;
    const edge = measureTruePeak([edgeSpike]);
    assert.ok(edge.truePeakDbtp !== null && edge.truePeakDbtp > -1.0);
    assert.equal(edge.frame, 0);

    // Astra regression: repeated [0.7, 0.7, -0.7, -0.7] with 200-frame end fades has true peak ~ -0.09 dBTP (> -1.0 ceiling).
    const fadedIsp = new Float64Array(4800);
    for (let i = 0; i < fadedIsp.length; i += 4) {
      fadedIsp[i] = 0.7;
      fadedIsp[i + 1] = 0.7;
      fadedIsp[i + 2] = -0.7;
      fadedIsp[i + 3] = -0.7;
    }
    for (let i = 0; i < 200; i += 1) {
      const f = i / 200;
      fadedIsp[i] = (fadedIsp[i] ?? 0) * f;
      fadedIsp[fadedIsp.length - 1 - i] = (fadedIsp[fadedIsp.length - 1 - i] ?? 0) * f;
    }
    const ispReport = checkAudio({ sampleRate: 48000, channels: [fadedIsp], format: 'float32' }, 'isp.wav');
    assert.ok(
      ispReport.loudness.truePeakDbtp !== null && ispReport.loudness.truePeakDbtp > -0.3,
      `Expected true peak > -0.3 dBTP, got ${ispReport.loudness.truePeakDbtp}`,
    );
    assert.equal(ispReport.ok, false);
    assert.ok(ispReport.findings.some((f) => f.code === 'TRUE_PEAK_EXCEEDED'));

    // Astra regression: integrated loudness must not admit blocks below -70 LUFS during relative gating.
    const above = makeSine(1000, 1.0, 48000, 0.0005);
    const below = makeSine(1000, 5.0, 48000, 0.00019);
    const mixed = new Float64Array(above.length + below.length);
    mixed.set(above, 0);
    mixed.set(below, above.length);
    const mixedLoud = measureLoudness([mixed], 48000);
    assert.ok(
      mixedLoud.integratedLufs !== null && mixedLoud.integratedLufs > -70.0,
      `Expected integrated > -70 LUFS, got ${mixedLoud.integratedLufs}`,
    );

    // Astra regression: momentary loudness must report measurable quiet signals (< -70 LUFS).
    const quiet = makeSine(1000, 1.0, 48000, 0.0001);
    const quietLoud = measureLoudness([quiet], 48000);
    assert.ok(
      quietLoud.momentaryMaxLufs !== null && quietLoud.momentaryMaxLufs < -80 && quietLoud.momentaryMaxLufs > -86,
      `Expected quiet momentary around -83 LUFS, got ${quietLoud.momentaryMaxLufs}`,
    );
  });

  it('matches ffmpeg ebur128 within 0.25 LU at both 44.1 kHz and 48 kHz', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audio-ff-'));
    try {
      for (const sr of [44100, 48000] as const) {
        const ch = makeSine(1000, 1.2, sr, 0.3);
        const wavPath = path.join(tmpDir, `sine_${sr}.wav`);
        fs.writeFileSync(wavPath, encodeWav([ch, ch], sr, 'float32'));
        const ff = measureWithFfmpeg(wavPath);
        if (ff === null) {
          return;
        }
        const report = checkAudio({ sampleRate: sr, channels: [ch, ch], format: 'float32' }, wavPath);
        assert.ok(report.loudness.integratedLufs !== null && ff.integrated !== null);
        assert.ok(
          Math.abs(report.loudness.integratedLufs - ff.integrated) < 0.25,
          `sr=${sr}: TS ${report.loudness.integratedLufs} vs ffmpeg ${ff.integrated}`,
        );
        assert.ok(report.loudness.truePeakDbtp !== null && ff.truePeak !== null);
        assert.ok(
          Math.abs(report.loudness.truePeakDbtp - ff.truePeak) < 0.35,
          `sr=${sr}: TS TP ${report.loudness.truePeakDbtp} vs ffmpeg ${ff.truePeak}`,
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
