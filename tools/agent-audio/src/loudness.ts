import type { LoudnessMetrics, SupportedSampleRate } from './types.js';

interface BiquadCoeffs {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

// ITU-R BS.1770-4 analog prototype parameters bilinearly mapped to sampleRate.
function kWeightingStages(sampleRate: SupportedSampleRate): readonly [BiquadCoeffs, BiquadCoeffs] {
  const f0Shelf = 1681.974450955533;
  const dbGain = 3.999843853973347;
  const qShelf = 0.7071752369554196;
  const kShelf = Math.tan((Math.PI * f0Shelf) / sampleRate);
  const vh = Math.pow(10, dbGain / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0Shelf = 1 + kShelf / qShelf + kShelf * kShelf;
  const stage1: BiquadCoeffs = {
    b0: (vh + (vb * kShelf) / qShelf + kShelf * kShelf) / a0Shelf,
    b1: (2 * (kShelf * kShelf - vh)) / a0Shelf,
    b2: (vh - (vb * kShelf) / qShelf + kShelf * kShelf) / a0Shelf,
    a1: (2 * (kShelf * kShelf - 1)) / a0Shelf,
    a2: (1 - kShelf / qShelf + kShelf * kShelf) / a0Shelf,
  };

  const f0Hp = 38.13547087602444;
  const qHp = 0.5003270373238773;
  const kHp = Math.tan((Math.PI * f0Hp) / sampleRate);
  const a0Hp = 1 + kHp / qHp + kHp * kHp;
  const stage2: BiquadCoeffs = {
    b0: 1.0,
    b1: -2.0,
    b2: 1.0,
    a1: (2 * (kHp * kHp - 1)) / a0Hp,
    a2: (1 - kHp / qHp + kHp * kHp) / a0Hp,
  };

  return [stage1, stage2];
}

function applyBiquad(input: Float64Array, c: BiquadCoeffs): Float64Array {
  const out = new Float64Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x0 = input[i] ?? 0;
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const halfX = x * 0.5;
  for (let k = 1; k <= 24; k += 1) {
    term *= (halfX / k) * (halfX / k);
    sum += term;
  }
  return sum;
}

// 4-phase, 16-tap/phase Kaiser-windowed sinc interpolator (4x oversampling) for accurate BS.1770-4 true peak.
const TAPS_PER_PHASE = 16;
const HALF_TAPS = TAPS_PER_PHASE / 2;
const TRUE_PEAK_PHASES: readonly (readonly number[])[] = (() => {
  const beta = 7.0;
  const i0Beta = besselI0(beta);
  const phases: number[][] = [];
  for (let phase = 0; phase < 4; phase += 1) {
    const frac = phase / 4;
    const taps: number[] = [];
    for (let k = 0; k < TAPS_PER_PHASE; k += 1) {
      const offset = k - (HALF_TAPS - 1) - frac;
      const sinc = Math.abs(offset) < 1e-12 ? 1 : Math.sin(Math.PI * offset) / (Math.PI * offset);
      const u = (2 * (k - frac)) / (TAPS_PER_PHASE - 1) - 1;
      const win = Math.abs(u) <= 1 ? besselI0(beta * Math.sqrt(Math.max(0, 1 - u * u))) / i0Beta : 0;
      taps.push(sinc * win);
    }
    const sum = taps.reduce((a, b) => a + b, 0);
    phases.push(taps.map((v) => v / sum));
  }
  return phases;
})();

export function measureTruePeak(channels: readonly Float64Array[]): {
  readonly truePeakLinear: number;
  readonly truePeakDbtp: number | null;
  readonly channel: number | null;
  readonly frame: number | null;
} {
  let maxVal = 0;
  let maxCh: number | null = null;
  let maxFrame: number | null = null;

  for (let c = 0; c < channels.length; c += 1) {
    const buf = channels[c];
    if (buf === undefined || buf.length === 0) {
      continue;
    }
    const n = buf.length;
    for (let i = -HALF_TAPS; i < n + HALF_TAPS; i += 1) {
      for (const taps of TRUE_PEAK_PHASES) {
        let acc = 0;
        for (let k = 0; k < TAPS_PER_PHASE; k += 1) {
          const idx = i + k - (HALF_TAPS - 1);
          if (idx >= 0 && idx < n) {
            acc += (buf[idx] ?? 0) * (taps[k] ?? 0);
          }
        }
        const abs = Math.abs(acc);
        if (abs > maxVal) {
          maxVal = abs;
          maxCh = c;
          maxFrame = Math.max(0, Math.min(n - 1, i));
        }
      }
    }
  }

  return {
    truePeakLinear: maxVal,
    truePeakDbtp: maxVal > 0 ? 20 * Math.log10(maxVal) : null,
    channel: maxCh,
    frame: maxFrame,
  };
}

function blockEnergies(
  weightedChannels: readonly Float64Array[],
  blockFrames: number,
  hopFrames: number,
): readonly number[] {
  const n = weightedChannels[0]?.length ?? 0;
  if (n < blockFrames) {
    return [];
  }
  const energies: number[] = [];
  for (let start = 0; start + blockFrames <= n; start += hopFrames) {
    let sumEnergy = 0;
    for (const ch of weightedChannels) {
      let sq = 0;
      for (let i = start; i < start + blockFrames; i += 1) {
        const v = ch[i] ?? 0;
        sq += v * v;
      }
      sumEnergy += sq / blockFrames;
    }
    energies.push(sumEnergy);
  }
  return energies;
}

export function measureLoudness(
  channels: readonly Float64Array[],
  sampleRate: SupportedSampleRate,
): LoudnessMetrics {
  const truePeak = measureTruePeak(channels);
  const frames = channels[0]?.length ?? 0;
  const blockFrames = Math.round(0.4 * sampleRate);
  const hopFrames = Math.round(0.1 * sampleRate);
  const [stage1, stage2] = kWeightingStages(sampleRate);

  const weighted = channels.map((ch) => applyBiquad(applyBiquad(ch, stage1), stage2));

  let momentaryMaxLufs: number | null = null;
  let momentaryPadded = false;
  let integratedLufs: number | null = null;
  let integratedReason: string | null = null;

  if (frames < blockFrames) {
    momentaryPadded = true;
    integratedReason = 'duration_below_400ms';
    const padded = channels.map((ch) => {
      const buf = new Float64Array(blockFrames);
      buf.set(ch);
      return applyBiquad(applyBiquad(buf, stage1), stage2);
    });
    const energies = blockEnergies(padded, blockFrames, hopFrames);
    const e0 = energies[0] ?? 0;
    if (e0 > 0) {
      momentaryMaxLufs = -0.691 + 10 * Math.log10(e0);
    }
  } else {
    const energies = blockEnergies(weighted, blockFrames, hopFrames);
    const blockLoudness = energies.map((e) => (e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity));
    let maxM = -Infinity;
    for (const l of blockLoudness) {
      if (l > maxM) {
        maxM = l;
      }
    }
    momentaryMaxLufs = Number.isFinite(maxM) ? maxM : null;

    // Relative gate operates strictly on blocks that already passed the -70 LUFS absolute gate.
    const absSurviving: { readonly energy: number; readonly lufs: number }[] = [];
    for (let i = 0; i < energies.length; i += 1) {
      const lufs = blockLoudness[i] ?? -Infinity;
      if (lufs > -70) {
        absSurviving.push({ energy: energies[i] ?? 0, lufs });
      }
    }
    if (absSurviving.length === 0) {
      integratedReason = 'below_absolute_gate';
    } else {
      const absMean = absSurviving.reduce((a, b) => a + b.energy, 0) / absSurviving.length;
      const relativeGate = -0.691 + 10 * Math.log10(absMean) - 10;
      const relSurviving = absSurviving.filter((b) => b.lufs > relativeGate);
      if (relSurviving.length === 0) {
        integratedReason = 'below_relative_gate';
      } else {
        const relMean = relSurviving.reduce((a, b) => a + b.energy, 0) / relSurviving.length;
        integratedLufs = -0.691 + 10 * Math.log10(relMean);
      }
    }
  }

  return {
    integratedLufs: integratedLufs !== null ? Number(integratedLufs.toFixed(3)) : null,
    integratedReason,
    momentaryMaxLufs: momentaryMaxLufs !== null ? Number(momentaryMaxLufs.toFixed(3)) : null,
    momentaryPadded,
    truePeakDbtp: truePeak.truePeakDbtp !== null ? Number(truePeak.truePeakDbtp.toFixed(3)) : null,
    truePeakChannel: truePeak.channel,
    truePeakFrame: truePeak.frame,
  };
}
