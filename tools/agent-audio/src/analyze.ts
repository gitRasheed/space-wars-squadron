import { nextPowerOfTwo, rfftMagnitude } from './fft.js';
import { measureLoudness } from './loudness.js';
import type {
  AudioBufferData,
  ChannelMetrics,
  CheckFinding,
  CheckReport,
  CheckThresholds,
  LoopSeamMetrics,
  SpectralMetrics,
  StereoMetrics,
} from './types.js';

export const DEFAULT_THRESHOLDS: CheckThresholds = {
  maxTruePeakDbtp: -1.0,
  maxDcOffset: 0.005,
  maxFullScaleSamples: 7,
  maxLeadingSilenceS: 0.02,
  maxEndEdgeRatio: 0.4,
  maxClickRatio: 25.0,
  maxStereoBalanceDb: 12.0,
};

export const DEFAULT_LOOP_DISCONTINUITY_RATIO = 12.0;

function roundNum(value: number, digits = 4): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function linearToDbfs(value: number): number | null {
  return value > 0 ? roundNum(20 * Math.log10(value), 3) : null;
}

function percentile(values: Float64Array, p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = Float64Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? 0;
}

function measureChannelLoopSeam(buf: Float64Array, sampleRate: number): LoopSeamMetrics | null {
  const n = buf.length;
  if (n < 4) {
    return null;
  }

  const wrapDelta = Math.abs((buf[0] ?? 0) - (buf[n - 1] ?? 0));
  const predicted0 = 2 * (buf[n - 1] ?? 0) - (buf[n - 2] ?? 0);
  const predictedLast = 2 * (buf[0] ?? 0) - (buf[1] ?? 0);
  const wrapErrForward = Math.abs((buf[0] ?? 0) - predicted0);
  const wrapErrBackward = Math.abs((buf[n - 1] ?? 0) - predictedLast);
  const wrapPredictionError = Math.max(wrapErrForward, wrapErrBackward);

  const edgeGuard = Math.min(Math.floor(n / 6), Math.max(2, Math.floor(sampleRate * 0.01)));
  const startIdx = Math.max(2, edgeGuard);
  const endIdx = Math.min(n - 1, n - edgeGuard);
  const interiorCount = Math.max(0, endIdx - startIdx);
  const interiorErr = new Float64Array(interiorCount);
  for (let i = 0; i < interiorCount; i += 1) {
    const idx = startIdx + i;
    const pred = 2 * (buf[idx - 1] ?? 0) - (buf[idx - 2] ?? 0);
    interiorErr[i] = Math.abs((buf[idx] ?? 0) - pred);
  }
  const interiorP95 = percentile(interiorErr, 0.95);
  const floor = Math.max(interiorP95, 1e-6);
  const discontinuityRatio = wrapPredictionError / floor;

  return {
    wrapDelta: roundNum(wrapDelta, 5),
    wrapPredictionError: roundNum(wrapPredictionError, 5),
    interiorPredictionP95: roundNum(interiorP95, 6),
    discontinuityRatio: roundNum(discontinuityRatio, 3),
  };
}

function detectImpulseClick(buf: Float64Array, sampleRate: number): {
  readonly maxFirstDiff: number;
  readonly clickRatio: number;
  readonly clickFrame: number;
} {
  const n = buf.length;
  let maxFirstDiff = 0;
  for (let i = 0; i < n - 1; i += 1) {
    const d = Math.abs((buf[i + 1] ?? 0) - (buf[i] ?? 0));
    if (d > maxFirstDiff) {
      maxFirstDiff = d;
    }
  }
  if (n < 16) {
    return { maxFirstDiff, clickRatio: 0, clickFrame: 0 };
  }

  // Local-window 2nd-difference curvature detects isolated clicks in silence without tripping on smooth percussive attacks.
  const curv = new Float64Array(n);
  for (let i = 1; i < n - 1; i += 1) {
    curv[i] = Math.abs((buf[i] ?? 0) - 0.5 * ((buf[i - 1] ?? 0) + (buf[i + 1] ?? 0)));
  }

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    prefix[i + 1] = (prefix[i] ?? 0) + (curv[i] ?? 0);
  }

  const halfWin = Math.max(16, Math.min(64, Math.floor(sampleRate * 0.001)));
  const excl = 2;
  let bestRatio = 0;
  let bestFrame = 0;

  for (let i = 2; i < n - 2; i += 1) {
    const c = curv[i] ?? 0;
    if (c < 0.08) {
      continue;
    }
    const lo = Math.max(1, i - halfWin);
    const hi = Math.min(n - 2, i + halfWin);
    const exclLo = Math.max(lo, i - excl);
    const exclHi = Math.min(hi, i + excl);
    const totalSum = (prefix[hi + 1] ?? 0) - (prefix[lo] ?? 0);
    const exclSum = (prefix[exclHi + 1] ?? 0) - (prefix[exclLo] ?? 0);
    const count = hi - lo + 1 - (exclHi - exclLo + 1);
    const localMean = count > 0 ? (totalSum - exclSum) / count : 0;
    const floor = Math.max(localMean, 0.004);
    const ratio = c / floor;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestFrame = i;
    }
  }

  return { maxFirstDiff, clickRatio: bestRatio, clickFrame: bestFrame };
}

function analyzeChannel(
  buf: Float64Array,
  channelIndex: number,
  sampleRate: number,
  checkLoop: boolean,
): ChannelMetrics {
  const n = buf.length;
  let peak = 0;
  let sum = 0;
  let sumSq = 0;
  let fullScaleSamples = 0;
  let fullScaleRun = 0;
  let fullScaleMaxRun = 0;

  for (let i = 0; i < n; i += 1) {
    const v = buf[i] ?? 0;
    const abs = Math.abs(v);
    if (abs > peak) {
      peak = abs;
    }
    sum += v;
    sumSq += v * v;
    if (abs >= 0.999) {
      fullScaleSamples += 1;
      fullScaleRun += 1;
      if (fullScaleRun > fullScaleMaxRun) {
        fullScaleMaxRun = fullScaleRun;
      }
    } else {
      fullScaleRun = 0;
    }
  }

  const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
  const dcOffset = n > 0 ? sum / n : 0;

  // Measure edges over 0.5 ms so clean >= 2 ms fades to zero are not misclassified as cut tails.
  const edgeFrames = Math.max(1, Math.floor(sampleRate * 0.0005));
  let startEdgePeak = 0;
  for (let i = 0; i < Math.min(n, edgeFrames); i += 1) {
    const abs = Math.abs(buf[i] ?? 0);
    if (abs > startEdgePeak) {
      startEdgePeak = abs;
    }
  }
  let endEdgePeak = 0;
  for (let i = Math.max(0, n - edgeFrames); i < n; i += 1) {
    const abs = Math.abs(buf[i] ?? 0);
    if (abs > endEdgePeak) {
      endEdgePeak = abs;
    }
  }

  const silenceThreshold = peak > 0 ? Math.max(1e-4, peak * Math.pow(10, -50 / 20)) : 1e-4;
  let firstActive = n;
  for (let i = 0; i < n; i += 1) {
    if (Math.abs(buf[i] ?? 0) > silenceThreshold) {
      firstActive = i;
      break;
    }
  }
  let lastActive = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (Math.abs(buf[i] ?? 0) > silenceThreshold) {
      lastActive = i;
      break;
    }
  }
  const leadingSilenceS = n > 0 ? firstActive / sampleRate : 0;
  const trailingSilenceS = lastActive >= 0 ? (n - 1 - lastActive) / sampleRate : n / sampleRate;

  const click = detectImpulseClick(buf, sampleRate);

  return {
    channel: channelIndex,
    peakLinear: roundNum(peak, 5),
    peakDbfs: linearToDbfs(peak),
    rmsLinear: roundNum(rms, 6),
    rmsDbfs: linearToDbfs(rms),
    dcOffset: roundNum(dcOffset, 6),
    fullScaleSamples,
    fullScaleMaxRun,
    startEdgePeak: roundNum(startEdgePeak, 5),
    endEdgePeak: roundNum(endEdgePeak, 5),
    leadingSilenceS: roundNum(leadingSilenceS, 4),
    trailingSilenceS: roundNum(trailingSilenceS, 4),
    maxFirstDiff: roundNum(click.maxFirstDiff, 5),
    clickRatio: roundNum(click.clickRatio, 3),
    clickFrame: click.clickFrame,
    clickTimeS: roundNum(click.clickFrame / sampleRate, 4),
    loopSeam: checkLoop ? measureChannelLoopSeam(buf, sampleRate) : null,
  };
}

function measureSpectral(channels: readonly Float64Array[], sampleRate: number): SpectralMetrics {
  const n = channels[0]?.length ?? 0;
  const take = Math.min(n, sampleRate * 2);
  if (take < 16) {
    return { centroidHz: 0, rolloff85Hz: 0, rolloff95Hz: 0 };
  }
  const mono = new Float64Array(take);
  const chCount = channels.length;
  for (let i = 0; i < take; i += 1) {
    let sum = 0;
    for (let c = 0; c < chCount; c += 1) {
      sum += channels[c]?.[i] ?? 0;
    }
    mono[i] = sum / chCount;
  }

  const fftSize = Math.min(65536, nextPowerOfTwo(take));
  const mag = rfftMagnitude(mono, fftSize);
  const binHz = sampleRate / fftSize;

  let magSum = 0;
  let weightedFreq = 0;
  let powerSum = 0;
  for (let k = 0; k < mag.length; k += 1) {
    const m = mag[k] ?? 0;
    const f = k * binHz;
    magSum += m;
    weightedFreq += f * m;
    powerSum += m * m;
  }
  if (magSum <= 0 || powerSum <= 0) {
    return { centroidHz: 0, rolloff85Hz: 0, rolloff95Hz: 0 };
  }

  let acc = 0;
  let rolloff85Hz = 0;
  let rolloff95Hz = 0;
  let got85 = false;
  let got95 = false;
  for (let k = 0; k < mag.length; k += 1) {
    const m = mag[k] ?? 0;
    acc += m * m;
    const frac = acc / powerSum;
    if (!got85 && frac >= 0.85) {
      rolloff85Hz = k * binHz;
      got85 = true;
    }
    if (!got95 && frac >= 0.95) {
      rolloff95Hz = k * binHz;
      got95 = true;
      break;
    }
  }

  return {
    centroidHz: roundNum(weightedFreq / magSum, 1),
    rolloff85Hz: roundNum(rolloff85Hz, 1),
    rolloff95Hz: roundNum(rolloff95Hz, 1),
  };
}

function measureStereo(channels: readonly Float64Array[]): StereoMetrics | null {
  if (channels.length < 2) {
    return null;
  }
  const left = channels[0];
  const right = channels[1];
  if (left === undefined || right === undefined || left.length === 0) {
    return null;
  }
  let lSq = 0;
  let rSq = 0;
  let lr = 0;
  for (let i = 0; i < left.length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    lSq += l * l;
    rSq += r * r;
    lr += l * r;
  }
  const lRms = Math.sqrt(lSq / left.length);
  const rRms = Math.sqrt(rSq / right.length);
  const balanceDb =
    lRms === 0 && rRms === 0
      ? null
      : roundNum(20 * Math.log10((lRms + 1e-12) / (rRms + 1e-12)), 3);
  const denom = Math.sqrt(lSq * rSq);
  const correlation = denom > 1e-12 ? roundNum(lr / denom, 4) : null;
  return { balanceDb, correlation };
}

export function checkAudio(
  audio: AudioBufferData,
  fileLabel: string,
  options?: {
    readonly loop?: boolean;
    readonly thresholds?: CheckThresholds;
  },
): CheckReport {
  const loopChecked = options?.loop ?? false;
  const thresholds: CheckThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(loopChecked ? { maxLoopDiscontinuityRatio: DEFAULT_LOOP_DISCONTINUITY_RATIO } : {}),
    ...options?.thresholds,
  };
  const frames = audio.channels[0]?.length ?? 0;
  const durationS = roundNum(frames / audio.sampleRate, 4);
  const loudness = measureLoudness(audio.channels, audio.sampleRate);
  const stereo = measureStereo(audio.channels);
  const spectral = measureSpectral(audio.channels, audio.sampleRate);
  const channels = audio.channels.map((buf, idx) =>
    analyzeChannel(buf, idx, audio.sampleRate, loopChecked),
  );

  const findings: CheckFinding[] = [];

  if (frames === 0 || channels.every((c) => c.peakLinear < 1e-6)) {
    findings.push({
      code: 'SILENT_AUDIO',
      severity: 'fail',
      message: 'Audio buffer is empty or effectively silent (peak < -120 dBFS)',
    });
  }

  if (
    thresholds.maxTruePeakDbtp !== undefined &&
    loudness.truePeakDbtp !== null &&
    loudness.truePeakDbtp > thresholds.maxTruePeakDbtp
  ) {
    const finding: CheckFinding = {
      code: 'TRUE_PEAK_EXCEEDED',
      severity: 'fail',
      message: `True peak ${loudness.truePeakDbtp} dBTP exceeds limit ${thresholds.maxTruePeakDbtp} dBTP`,
      ...(loudness.truePeakChannel !== null ? { channel: loudness.truePeakChannel } : {}),
      ...(loudness.truePeakFrame !== null
        ? {
            frame: loudness.truePeakFrame,
            timeS: roundNum(loudness.truePeakFrame / audio.sampleRate, 4),
          }
        : {}),
    };
    findings.push(finding);
  }

  for (const ch of channels) {
    if (
      thresholds.maxFullScaleSamples !== undefined &&
      ch.fullScaleSamples > thresholds.maxFullScaleSamples
    ) {
      findings.push({
        code: 'FULL_SCALE_SAMPLES',
        severity: 'fail',
        channel: ch.channel,
        message: `Channel ${ch.channel} has ${ch.fullScaleSamples} near-full-scale samples (limit ${thresholds.maxFullScaleSamples}, max run ${ch.fullScaleMaxRun})`,
      });
    }

    if (thresholds.maxDcOffset !== undefined && Math.abs(ch.dcOffset) > thresholds.maxDcOffset) {
      findings.push({
        code: 'DC_OFFSET',
        severity: 'fail',
        channel: ch.channel,
        message: `Channel ${ch.channel} DC offset ${ch.dcOffset} exceeds ±${thresholds.maxDcOffset}`,
      });
    }

    if (
      !loopChecked &&
      thresholds.maxLeadingSilenceS !== undefined &&
      ch.peakLinear >= 1e-4 &&
      ch.leadingSilenceS > thresholds.maxLeadingSilenceS
    ) {
      findings.push({
        code: 'LEADING_SILENCE',
        severity: 'fail',
        channel: ch.channel,
        frame: Math.round(ch.leadingSilenceS * audio.sampleRate),
        timeS: ch.leadingSilenceS,
        message: `Channel ${ch.channel} leading silence ${ch.leadingSilenceS} s exceeds limit ${thresholds.maxLeadingSilenceS} s`,
      });
    }

    if (
      !loopChecked &&
      thresholds.maxEndEdgeRatio !== undefined &&
      durationS > 0.05 &&
      ch.peakLinear > 0.12 &&
      ch.endEdgePeak > 0.08 &&
      ch.endEdgePeak >= ch.peakLinear * thresholds.maxEndEdgeRatio
    ) {
      findings.push({
        code: 'CUT_TAIL',
        severity: 'fail',
        channel: ch.channel,
        frame: Math.max(0, frames - 1),
        timeS: durationS,
        message: `Channel ${ch.channel} final 0.5 ms peak ${ch.endEdgePeak} (${Math.round((ch.endEdgePeak / ch.peakLinear) * 100)}% of peak)`,
      });
    }

    if (
      thresholds.maxClickRatio !== undefined &&
      durationS > 0.05 &&
      ch.fullScaleSamples <= (thresholds.maxFullScaleSamples ?? 7) &&
      ch.clickRatio >= thresholds.maxClickRatio
    ) {
      findings.push({
        code: 'IMPULSE_CLICK',
        severity: 'fail',
        channel: ch.channel,
        frame: ch.clickFrame,
        timeS: ch.clickTimeS,
        message: `Channel ${ch.channel} impulse curvature ratio ${ch.clickRatio} at ${ch.clickTimeS} s (limit ${thresholds.maxClickRatio})`,
      });
    }

    if (loopChecked && ch.loopSeam !== null) {
      const ratioLimit = thresholds.maxLoopDiscontinuityRatio;
      const deltaLimit = thresholds.maxLoopWrapDelta;
      if (ratioLimit !== undefined && ch.loopSeam.discontinuityRatio > ratioLimit) {
        findings.push({
          code: 'LOOP_SEAM_DISCONTINUITY',
          severity: 'fail',
          channel: ch.channel,
          frame: 0,
          timeS: 0,
          message: `Channel ${ch.channel} loop wrap discontinuity ratio ${ch.loopSeam.discontinuityRatio} exceeds ${ratioLimit}`,
        });
      }
      if (deltaLimit !== undefined && ch.loopSeam.wrapDelta > deltaLimit) {
        findings.push({
          code: 'LOOP_WRAP_DELTA',
          severity: 'fail',
          channel: ch.channel,
          frame: 0,
          timeS: 0,
          message: `Channel ${ch.channel} loop wrap delta ${ch.loopSeam.wrapDelta} exceeds ${deltaLimit}`,
        });
      }
    }
  }

  if (
    stereo !== null &&
    stereo.balanceDb !== null &&
    thresholds.maxStereoBalanceDb !== undefined &&
    Math.abs(stereo.balanceDb) > thresholds.maxStereoBalanceDb
  ) {
    findings.push({
      code: 'STEREO_IMBALANCE',
      severity: 'fail',
      message: `Stereo L/R balance ${stereo.balanceDb} dB exceeds ±${thresholds.maxStereoBalanceDb} dB`,
    });
  }

  if (
    thresholds.minMomentaryLufs !== undefined &&
    (loudness.momentaryMaxLufs === null || loudness.momentaryMaxLufs < thresholds.minMomentaryLufs)
  ) {
    findings.push({
      code: 'LOUDNESS_MOMENTARY_LOW',
      severity: 'fail',
      message: `Max momentary loudness ${String(loudness.momentaryMaxLufs)} LUFS below ${thresholds.minMomentaryLufs} LUFS`,
    });
  }
  if (
    thresholds.maxMomentaryLufs !== undefined &&
    loudness.momentaryMaxLufs !== null &&
    loudness.momentaryMaxLufs > thresholds.maxMomentaryLufs
  ) {
    findings.push({
      code: 'LOUDNESS_MOMENTARY_HIGH',
      severity: 'fail',
      message: `Max momentary loudness ${loudness.momentaryMaxLufs} LUFS above ${thresholds.maxMomentaryLufs} LUFS`,
    });
  }
  if (
    thresholds.minIntegratedLufs !== undefined &&
    (loudness.integratedLufs === null || loudness.integratedLufs < thresholds.minIntegratedLufs)
  ) {
    findings.push({
      code: 'LOUDNESS_INTEGRATED_LOW',
      severity: 'fail',
      message: `Integrated loudness ${String(loudness.integratedLufs)} LUFS (${loudness.integratedReason ?? 'measured'}) below ${thresholds.minIntegratedLufs} LUFS`,
    });
  }
  if (
    thresholds.maxIntegratedLufs !== undefined &&
    loudness.integratedLufs !== null &&
    loudness.integratedLufs > thresholds.maxIntegratedLufs
  ) {
    findings.push({
      code: 'LOUDNESS_INTEGRATED_HIGH',
      severity: 'fail',
      message: `Integrated loudness ${loudness.integratedLufs} LUFS above ${thresholds.maxIntegratedLufs} LUFS`,
    });
  }

  return {
    schemaVersion: 'agent-audio/check/v1',
    ok: findings.every((f) => f.severity !== 'fail'),
    file: fileLabel,
    loopChecked,
    format: {
      sampleRateHz: audio.sampleRate,
      channels: audio.channels.length as 1 | 2,
      encoding: audio.format,
      frames,
      durationS,
    },
    loudness,
    stereo,
    spectral,
    channels,
    thresholds,
    findings,
  };
}
