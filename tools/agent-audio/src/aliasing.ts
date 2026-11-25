import { fftInPlace } from './fft.js';

const FFT_SIZE = 2048;
// Below this the harmonic grid is too dense to tell an alias from a harmonic.
const MIN_F0_HZ = 300;
// A pitched frame has at least this share of its energy on the harmonic or alias grid of its f0.
const MIN_EXPLAINED_FRACTION = 0.9;
const HARMONIC_TOLERANCE_BINS = 2.5;
const MIN_FRAME_ENERGY_RATIO = 1e-3;
const STEADY_PITCH_TOLERANCE = 0.002;
// Harmonics at least this strong (-20 dB) refine f0; folded partials of raw waves stay below it.
const REFINE_MIN_POWER_RATIO = 0.01;
// Too little steady pitched material (busy mixes, chords) gives an unstable estimate, so it reports null instead.
const MIN_PITCHED_SHARE = 0.2;

// Hann power spectrum of the frame starting at `start`, bins 1..FFT_SIZE/2; writes into `power` and returns its sum.
function framePower(mono: Float64Array, start: number, window: Float64Array, power: Float64Array): number {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let j = 0; j < FFT_SIZE; j += 1) {
    re[j] = (mono[start + j] ?? 0) * (window[j] ?? 0);
  }
  fftInPlace(re, im);
  let energy = 0;
  for (let k = 1; k < power.length; k += 1) {
    const p = (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;
    power[k] = p;
    energy += p;
  }
  return energy;
}

// Peak position in bins, refined by a parabola through the log power of its neighbours.
function refinePeak(power: Float64Array, k: number): number {
  const a = Math.log((power[k - 1] ?? 0) + 1e-30);
  const b = Math.log((power[k] ?? 0) + 1e-30);
  const c = Math.log((power[k + 1] ?? 0) + 1e-30);
  const denom = a - 2 * b + c;
  return denom < 0 ? k + (0.5 * (a - c)) / denom : k;
}

function localMaxNear(power: Float64Array, centre: number, radius: number): number {
  const lo = Math.max(1, Math.floor(centre - radius));
  const hi = Math.min(power.length - 2, Math.ceil(centre + radius));
  let best = lo;
  for (let k = lo; k <= hi; k += 1) {
    if ((power[k] ?? 0) > (power[best] ?? 0)) {
      best = k;
    }
  }
  return best;
}

// Fundamental in bins: the strongest peak, sharpened against each strong harmonic in turn (a square has no even ones).
function estimateF0Bins(power: Float64Array, minF0Bins: number): number {
  let strongest = 1;
  for (let k = 1; k < power.length - 1; k += 1) {
    if ((power[k] ?? 0) > (power[strongest] ?? 0)) {
      strongest = k;
    }
  }
  const minHarmonicPower = (power[strongest] ?? 0) * REFINE_MIN_POWER_RATIO;
  let f0 = refinePeak(power, strongest);
  if (f0 < minF0Bins) {
    return f0;
  }
  for (let h = 2; h * f0 < power.length - 2; h += 1) {
    const k = localMaxNear(power, h * f0, HARMONIC_TOLERANCE_BINS);
    if ((power[k] ?? 0) >= minHarmonicPower) {
      f0 = refinePeak(power, k) / h;
    }
  }
  return f0;
}

function gridDistance(k: number, offset: number, spacing: number): number {
  const r = (((k - offset) % spacing) + spacing) % spacing;
  return Math.min(r, spacing - r);
}

// Partials of f0 folded at Nyquist land on f = m*sr +- h*f0, a grid offset from the harmonics by sr mod f0.
// Energy there beyond what the rest of the off-harmonic spectrum would put there by chance is the alias estimate.
function frameAliasEnergy(power: Float64Array, f0: number, srBins: number): { readonly alias: number; readonly unexplained: number } {
  const residue = srBins % f0;
  let aliasEnergy = 0;
  let aliasBins = 0;
  let otherEnergy = 0;
  let otherBins = 0;
  for (let k = 1; k < power.length; k += 1) {
    if (gridDistance(k, 0, f0) <= HARMONIC_TOLERANCE_BINS) {
      continue;
    }
    const p = power[k] ?? 0;
    if (Math.min(gridDistance(k, residue, f0), gridDistance(k, -residue, f0)) <= HARMONIC_TOLERANCE_BINS) {
      aliasEnergy += p;
      aliasBins += 1;
    } else {
      otherEnergy += p;
      otherBins += 1;
    }
  }
  const chance = otherBins > 0 ? (otherEnergy * aliasBins) / otherBins : 0;
  return { alias: Math.max(0, aliasEnergy - chance), unexplained: otherEnergy };
}

/**
 * Share of energy in steady pitched frames (f0 >= 300 Hz, 90% of the energy on the harmonic or alias grid) that sits
 * where folded-back partials of that f0 land, above chance. Noise, sweeps, chords and inharmonic FM fail the
 * pitched-frame test. Null when such frames hold under 20% of the file's energy.
 */
export function measureAliasingRatio(channels: readonly Float64Array[], sampleRate: number): number | null {
  const n = channels[0]?.length ?? 0;
  const mono = new Float64Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i += 1) {
      mono[i] = (mono[i] ?? 0) + (ch[i] ?? 0) / channels.length;
    }
  }
  const hop = FFT_SIZE / 2;
  const window = Float64Array.from({ length: FFT_SIZE }, (_, j) => 0.5 * (1 - Math.cos((2 * Math.PI * j) / FFT_SIZE)));
  const power = new Float64Array(hop + 1);
  const minF0Bins = (MIN_F0_HZ * FFT_SIZE) / sampleRate;
  const starts: number[] = [];
  for (let start = 0; start + FFT_SIZE <= n; start += hop) {
    starts.push(start);
  }
  // Spectra are recomputed in the second pass rather than kept, so memory stays flat on long files.
  const energies = new Float64Array(starts.length);
  const f0s = new Float64Array(starts.length);
  let loudest = 0;
  let totalEnergy = 0;
  for (const [i, start] of starts.entries()) {
    const energy = framePower(mono, start, window, power);
    energies[i] = energy;
    f0s[i] = estimateF0Bins(power, minF0Bins);
    loudest = Math.max(loudest, energy);
    totalEnergy += energy;
  }
  if (loudest <= 0) {
    return null;
  }
  const steady = (i: number, j: number): boolean =>
    j >= 0 && j < f0s.length && Math.abs((f0s[i] ?? 0) - (f0s[j] ?? 0)) <= STEADY_PITCH_TOLERANCE * (f0s[i] ?? 0);
  let pitchedEnergy = 0;
  let aliasEnergy = 0;
  for (const [i, start] of starts.entries()) {
    const energy = energies[i] ?? 0;
    const f0 = f0s[i] ?? 0;
    // Aliases only sit on a predictable grid under a steady pitch, so sweeps are skipped.
    if (energy < loudest * MIN_FRAME_ENERGY_RATIO || f0 < minF0Bins || !(steady(i, i - 1) || steady(i, i + 1))) {
      continue;
    }
    framePower(mono, start, window, power);
    const { alias, unexplained } = frameAliasEnergy(power, f0, FFT_SIZE);
    if (unexplained > energy * (1 - MIN_EXPLAINED_FRACTION)) {
      continue;
    }
    pitchedEnergy += energy;
    aliasEnergy += alias;
  }
  return pitchedEnergy > 0 && pitchedEnergy >= totalEnergy * MIN_PITCHED_SHARE ? aliasEnergy / pitchedEnergy : null;
}
