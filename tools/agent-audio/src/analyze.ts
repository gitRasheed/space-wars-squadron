import { fftInPlace } from './fft.js';
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
  minStereoCorrelation: -0.5,
};

export const DEFAULT_LOOP_DISCONTINUITY_RATIO = 12.0;

// Below -70 dBFS a single PCM16 quantisation step reaches the click gate, so level-relative checks stop.
const MIN_JUDGED_LEVEL = Math.pow(10, -70 / 20);

// Curvature gates, as fractions of the reference level.
const CLICK_GATE = 0.08;
const CLICK_FLOOR = 0.004;
const CLICK_MIN_SPIKE_RATIO = 4;
// A discontinuity that repeats at a steady period of 50 ms or less (20 Hz or faster) is pitch, not a click.
const CLICK_MAX_PITCH_PERIOD_S = 0.05;
const CLICK_PEER_MIN_SIZE = 0.5;
const CLICK_PERIOD_TOLERANCE = 0.25;
const CLICK_MERGE_FRAMES = 4;

const SEAM_ACTIVE_FLOOR = Math.pow(10, -50 / 20);
const SEAM_ERROR_FLOOR = 1e-4;

const SPECTRAL_FFT_SIZE = 4096;

function roundNum(value: number, digits = 4): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function linearToDbfs(value: number): number | null {
  return value > 0 ? roundNum(20 * Math.log10(value), 3) : null;
}

function percentileInPlace(values: Float64Array, p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? 0;
}

// sqrt(2) x the loudest 10 ms RMS: the peak of a steady sine, and nearly unmoved by a one-sample click.
function measureReferenceLevel(channels: readonly Float64Array[], sampleRate: number): number {
  const n = channels[0]?.length ?? 0;
  if (n === 0) {
    return 0;
  }
  const half = Math.max(1, Math.round(sampleRate * 0.005));
  let maxWindowSq = 0;
  for (const buf of channels) {
    let prevSq = 0;
    for (let start = 0; start < n; start += half) {
      const end = Math.min(n, start + half);
      let sq = 0;
      for (let i = start; i < end; i += 1) {
        const v = buf[i] ?? 0;
        sq += v * v;
      }
      maxWindowSq = Math.max(maxWindowSq, prevSq + sq);
      prevSq = sq;
    }
  }
  return Math.sqrt((2 * maxWindowSq) / Math.min(2 * half, n));
}

function measureChannelLoopSeam(
  buf: Float64Array,
  sampleRate: number,
  level: number,
): LoopSeamMetrics | null {
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

  // Only non-silent samples set the reference, so a sparse loop is judged against its notes.
  const edgeGuard = Math.min(Math.floor(n / 6), Math.max(2, Math.floor(sampleRate * 0.01)));
  const startIdx = Math.max(2, edgeGuard);
  const endIdx = Math.min(n - 1, n - edgeGuard);
  const activeFloor = level * SEAM_ACTIVE_FLOOR;
  const interiorErr = new Float64Array(Math.max(0, endIdx - startIdx));
  let activeCount = 0;
  for (let idx = startIdx; idx < endIdx; idx += 1) {
    const v = buf[idx] ?? 0;
    if (Math.abs(v) > activeFloor) {
      const pred = 2 * (buf[idx - 1] ?? 0) - (buf[idx - 2] ?? 0);
      interiorErr[activeCount] = Math.abs(v - pred);
      activeCount += 1;
    }
  }
  const interiorP95 = percentileInPlace(interiorErr.subarray(0, activeCount), 0.95);
  const floor = Math.max(interiorP95, level * SEAM_ERROR_FLOOR, 1e-9);
  const discontinuityRatio = wrapPredictionError / floor;

  return {
    wrapDelta: roundNum(wrapDelta, 5),
    wrapPredictionError: roundNum(wrapPredictionError, 5),
    interiorPredictionP95: roundNum(interiorP95, 6),
    discontinuityRatio: roundNum(discontinuityRatio, 3),
  };
}

// True when spike s has similar-sized spikes one period either side, or one and two periods to one side.
function repeatsAsPitch(
  frames: readonly number[],
  sizes: readonly number[],
  s: number,
  maxPeriod: number,
): boolean {
  const frame = frames[s] ?? 0;
  const minSize = (sizes[s] ?? 0) * CLICK_PEER_MIN_SIZE;
  const distance = (j: number): number => Math.abs((frames[j] ?? 0) - frame);
  const inWindow = (j: number): boolean => j >= 0 && j < frames.length && distance(j) <= 2 * maxPeriod;
  const isPeer = (j: number): boolean => (sizes[j] ?? 0) >= minSize;
  const samePeriod = (a: number, b: number): boolean =>
    Math.abs(a - b) <= CLICK_PERIOD_TOLERANCE * Math.max(a, b);

  const hasPeerNear = (from: number, step: number, target: number): boolean => {
    for (let k = from; inWindow(k); k += step) {
      if (isPeer(k) && samePeriod(distance(k), target)) {
        return true;
      }
    }
    return false;
  };

  for (const step of [-1, 1]) {
    for (let j = s + step; inWindow(j) && distance(j) <= maxPeriod; j += step) {
      if (!isPeer(j)) {
        continue;
      }
      const period = distance(j);
      if (hasPeerNear(j + step, step, 2 * period) || hasPeerNear(s - step, -step, period)) {
        return true;
      }
    }
  }
  return false;
}

function detectImpulseClick(
  buf: Float64Array,
  sampleRate: number,
  level: number,
): {
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
  if (n < 16 || level < MIN_JUDGED_LEVEL) {
    return { maxFirstDiff, clickRatio: 0, clickFrame: 0 };
  }

  const curvatureAt = (i: number): number =>
    Math.abs((buf[i] ?? 0) - 0.5 * ((buf[i - 1] ?? 0) + (buf[i + 1] ?? 0)));

  // Spikes: samples whose curvature stands out from the surrounding 1 ms, merged across adjacent frames.
  const spikeFrames: number[] = [];
  const spikeSizes: number[] = [];
  const spikeRatios: number[] = [];
  const halfWin = Math.max(16, Math.min(64, Math.floor(sampleRate * 0.001)));
  const excl = 2;
  const spikeGate = level * CLICK_GATE * CLICK_PEER_MIN_SIZE;
  const ratioFloor = level * CLICK_FLOOR;
  let lo = 1;
  let hi = 0;
  let windowSum = 0;
  let lastSpikeFrame = -Infinity;

  for (let i = 2; i < n - 2; i += 1) {
    const nextLo = Math.max(1, i - halfWin);
    const nextHi = Math.min(n - 2, i + halfWin);
    for (; hi < nextHi; hi += 1) {
      windowSum += curvatureAt(hi + 1);
    }
    for (; lo < nextLo; lo += 1) {
      windowSum -= curvatureAt(lo);
    }
    const c = curvatureAt(i);
    if (c < spikeGate) {
      continue;
    }
    const exclLo = Math.max(lo, i - excl);
    const exclHi = Math.min(hi, i + excl);
    let exclSum = 0;
    for (let j = exclLo; j <= exclHi; j += 1) {
      exclSum += curvatureAt(j);
    }
    const count = hi - lo + 1 - (exclHi - exclLo + 1);
    const localMean = count > 0 ? (windowSum - exclSum) / count : 0;
    const ratio = c / Math.max(localMean, ratioFloor);
    if (ratio < CLICK_MIN_SPIKE_RATIO) {
      continue;
    }
    const last = spikeFrames.length - 1;
    if (i - lastSpikeFrame > CLICK_MERGE_FRAMES) {
      spikeFrames.push(i);
      spikeSizes.push(c);
      spikeRatios.push(ratio);
    } else if (c > (spikeSizes[last] ?? 0)) {
      spikeFrames[last] = i;
      spikeSizes[last] = c;
      spikeRatios[last] = ratio;
    }
    lastSpikeFrame = i;
  }

  const maxPeriod = Math.round(sampleRate * CLICK_MAX_PITCH_PERIOD_S);
  const clickGate = level * CLICK_GATE;
  let bestRatio = 0;
  let bestFrame = 0;
  for (let s = 0; s < spikeFrames.length; s += 1) {
    const ratio = spikeRatios[s] ?? 0;
    if (
      (spikeSizes[s] ?? 0) >= clickGate &&
      ratio > bestRatio &&
      !repeatsAsPitch(spikeFrames, spikeSizes, s, maxPeriod)
    ) {
      bestRatio = ratio;
      bestFrame = spikeFrames[s] ?? 0;
    }
  }

  return { maxFirstDiff, clickRatio: bestRatio, clickFrame: bestFrame };
}

function analyzeChannel(
  buf: Float64Array,
  channelIndex: number,
  sampleRate: number,
  level: number,
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

  const click = detectImpulseClick(buf, sampleRate, level);

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
    loopSeam: checkLoop ? measureChannelLoopSeam(buf, sampleRate, level) : null,
  };
}

// Power-weighted centroid and rolloff of the average spectrum over every 50%-overlapped Hann frame.
function measureSpectral(channels: readonly Float64Array[], sampleRate: number): SpectralMetrics {
  const left = channels[0];
  const right = channels[1];
  const n = left?.length ?? 0;
  if (left === undefined || n < 16) {
    return { centroidHz: 0, rolloff85Hz: 0, rolloff95Hz: 0 };
  }

  const size = SPECTRAL_FFT_SIZE;
  const hop = size / 2;
  const bins = hop + 1;
  const window = new Float64Array(size);
  for (let j = 0; j < size; j += 1) {
    window[j] = 0.5 * (1 - Math.cos((2 * Math.PI * j) / size));
  }
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const power = new Float64Array(bins);

  // Frames are centred on 0, hop, 2*hop, ... so the first and last samples get full weight.
  for (let start = -hop; start < n; start += hop) {
    for (let j = 0; j < size; j += 1) {
      const idx = start + j;
      const inside = idx >= 0 && idx < n;
      const w = window[j] ?? 0;
      re[j] = inside ? (left[idx] ?? 0) * w : 0;
      im[j] = inside && right !== undefined ? (right[idx] ?? 0) * w : 0;
    }
    fftInPlace(re, im);
    // Left rides the real part and right the imaginary part: |Z[k]|^2 + |Z[size-k]|^2 = 2(|L[k]|^2 + |R[k]|^2).
    for (let k = 0; k < bins; k += 1) {
      const m = (size - k) % size;
      const zr = re[k] ?? 0;
      const zi = im[k] ?? 0;
      const mr = re[m] ?? 0;
      const mi = im[m] ?? 0;
      power[k] = (power[k] ?? 0) + zr * zr + zi * zi + mr * mr + mi * mi;
    }
  }

  const binHz = sampleRate / size;
  let powerSum = 0;
  let weightedFreq = 0;
  for (let k = 0; k < bins; k += 1) {
    const p = power[k] ?? 0;
    powerSum += p;
    weightedFreq += k * binHz * p;
  }
  if (powerSum <= 0) {
    return { centroidHz: 0, rolloff85Hz: 0, rolloff95Hz: 0 };
  }

  let acc = 0;
  let rolloff85Hz = 0;
  let rolloff95Hz = 0;
  let got85 = false;
  for (let k = 0; k < bins; k += 1) {
    acc += power[k] ?? 0;
    const frac = acc / powerSum;
    if (!got85 && frac >= 0.85) {
      rolloff85Hz = k * binHz;
      got85 = true;
    }
    if (frac >= 0.95) {
      rolloff95Hz = k * binHz;
      break;
    }
  }

  return {
    centroidHz: roundNum(weightedFreq / powerSum, 1),
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
  const level = measureReferenceLevel(audio.channels, audio.sampleRate);
  const channels = audio.channels.map((buf, idx) =>
    analyzeChannel(buf, idx, audio.sampleRate, level, loopChecked),
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
      level >= MIN_JUDGED_LEVEL &&
      ch.endEdgePeak >= level * thresholds.maxEndEdgeRatio
    ) {
      findings.push({
        code: 'CUT_TAIL',
        severity: 'fail',
        channel: ch.channel,
        frame: Math.max(0, frames - 1),
        timeS: durationS,
        message: `Channel ${ch.channel} final 0.5 ms peak ${ch.endEdgePeak} is ${Math.round((ch.endEdgePeak / level) * 100)}% of the reference level (limit ${Math.round(thresholds.maxEndEdgeRatio * 100)}%)`,
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
    stereo !== null &&
    stereo.correlation !== null &&
    thresholds.minStereoCorrelation !== undefined &&
    level >= MIN_JUDGED_LEVEL &&
    stereo.correlation < thresholds.minStereoCorrelation
  ) {
    findings.push({
      code: 'STEREO_PHASE_INVERTED',
      severity: 'fail',
      message: `Stereo L/R correlation ${stereo.correlation} is below ${thresholds.minStereoCorrelation}; the channels cancel when summed to mono`,
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
    referenceLevelDbfs: linearToDbfs(level),
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
