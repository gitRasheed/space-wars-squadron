import { measureTruePeak, truePeakEnvelope } from './loudness.js';
import type { DelaySpec } from './types.js';

// Loop buffers are periodic: every effect here treats frame -1 as the last frame, so a wrapped loop stays seamless.

const DC_BLOCK_CUTOFF_HZ = 10;
const DC_BLOCK_SETTLE_S = 0.5;

export function applyDcBlock(channels: readonly Float64Array[], sampleRate: number, periodic: boolean): void {
  const r = 1 - (2 * Math.PI * DC_BLOCK_CUTOFF_HZ) / sampleRate;
  for (const buf of channels) {
    const n = buf.length;
    if (n === 0) {
      continue;
    }
    const input = Float64Array.from(buf);
    // Periodic loops run warm-up passes so the filter state at frame 0 is the state the loop end leaves.
    const passes = periodic ? 1 + Math.ceil((DC_BLOCK_SETTLE_S * sampleRate) / n) : 1;
    let xPrev = periodic ? (input[n - 1] ?? 0) : 0;
    let yPrev = 0;
    for (let pass = 0; pass < passes; pass += 1) {
      const write = pass === passes - 1;
      for (let i = 0; i < n; i += 1) {
        const x = input[i] ?? 0;
        const y = x - xPrev + r * yPrev;
        xPrev = x;
        yPrev = y;
        if (write) {
          buf[i] = y;
        }
      }
    }
  }
}

const DELAY_SETTLE = 1e-7;
const DELAY_MAX_PASSES = 400;

// Feedback delay send: returns the wet signal only, already scaled by mix.
export function renderDelaySend(
  dry: readonly Float64Array[],
  spec: DelaySpec,
  sampleRate: number,
  periodic: boolean,
): Float64Array[] {
  const n = dry[0]?.length ?? 0;
  const d = Math.max(1, Math.round(spec.timeS * sampleRate));
  const fb = spec.feedback;
  const pingPong = spec.pingPong === true && dry.length === 2;
  const passes =
    !periodic || fb === 0
      ? 1
      : Math.min(DELAY_MAX_PASSES, 1 + Math.ceil(Math.log(DELAY_SETTLE) / ((n / d) * Math.log(fb))));
  const back = (i: number): number => {
    const j = i - d;
    if (!periodic) {
      return j;
    }
    return ((j % n) + n) % n;
  };
  const at = (buf: Float64Array, j: number): number => (j >= 0 ? (buf[j] ?? 0) : 0);

  let wet: Float64Array[];
  if (pingPong) {
    const left = dry[0] ?? new Float64Array(n);
    const right = dry[1] ?? new Float64Array(n);
    const monoIn = Float64Array.from(left, (v, i) => 0.5 * (v + (right[i] ?? 0)));
    const wl = new Float64Array(n);
    const wr = new Float64Array(n);
    for (let pass = 0; pass < passes; pass += 1) {
      for (let i = 0; i < n; i += 1) {
        const j = back(i);
        const prevL = at(wl, j);
        wl[i] = at(monoIn, j) + fb * at(wr, j);
        wr[i] = fb * prevL;
      }
    }
    wet = [wl, wr];
  } else {
    wet = dry.map((x) => {
      const w = new Float64Array(n);
      for (let pass = 0; pass < passes; pass += 1) {
        for (let i = 0; i < n; i += 1) {
          const j = back(i);
          w[i] = at(x, j) + fb * at(w, j);
        }
      }
      return w;
    });
  }
  for (const w of wet) {
    for (let i = 0; i < n; i += 1) {
      w[i] = (w[i] ?? 0) * spec.mix;
    }
  }
  return wet;
}

const LIMITER_LOOKAHEAD_S = 0.0015;
const LIMITER_RELEASE_S = 0.06;
const LIMITER_MAX_PASSES = 4;

function slidingMin(values: Float64Array, half: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i += 1) {
    const hi = Math.min(n - 1, i + half);
    for (; next <= hi; next += 1) {
      const v = values[next] ?? 1;
      while (tail > head && (values[deque[tail - 1] ?? 0] ?? 1) >= v) {
        tail -= 1;
      }
      deque[tail] = next;
      tail += 1;
    }
    while ((deque[head] ?? 0) < i - half) {
      head += 1;
    }
    out[i] = values[deque[head] ?? 0] ?? 1;
  }
  return out;
}

// Smooth gain that never exceeds ceiling / truePeak at any frame: a centred min filter, a box average of the
// same width (each box only averages minima that already include the frame), then a release that only slows rises.
function limiterGain(padded: readonly Float64Array[], sampleRate: number, ceiling: number): Float64Array {
  const n = padded[0]?.length ?? 0;
  const env = new Float64Array(n);
  for (const buf of padded) {
    const e = truePeakEnvelope(buf);
    for (let i = 0; i < n; i += 1) {
      env[i] = Math.max(env[i] ?? 0, e[i] ?? 0);
    }
  }
  const target = Float64Array.from(env, (e) => (e > ceiling ? ceiling / e : 1));
  const half = Math.max(1, Math.round(LIMITER_LOOKAHEAD_S * sampleRate));
  const minned = slidingMin(target, half);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    prefix[i + 1] = (prefix[i] ?? 0) + (minned[i] ?? 1);
  }
  const release = 1 - Math.exp(-1 / (LIMITER_RELEASE_S * sampleRate));
  const gain = new Float64Array(n);
  let g = 1;
  for (let i = 0; i < n; i += 1) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    const smoothed = Math.min(1, ((prefix[hi + 1] ?? 0) - (prefix[lo] ?? 0)) / (hi - lo + 1));
    g = smoothed < g ? smoothed : g + release * (smoothed - g);
    gain[i] = g;
  }
  return gain;
}

function limitOnce(channels: readonly Float64Array[], sampleRate: number, ceiling: number, periodic: boolean): void {
  const n = channels[0]?.length ?? 0;
  // A loop is limited as three back-to-back copies and the middle one kept, so its gain wraps with the audio.
  const pad = periodic ? n : Math.round(LIMITER_LOOKAHEAD_S * sampleRate) + 16;
  const padded = channels.map((buf) => {
    const out = new Float64Array(n + 2 * pad);
    if (periodic) {
      out.set(buf, 0);
      out.set(buf, n);
      out.set(buf, 2 * n);
    } else {
      out.set(buf, pad);
    }
    return out;
  });
  const gain = limiterGain(padded, sampleRate, ceiling);
  for (const [c, buf] of channels.entries()) {
    const src = padded[c] ?? new Float64Array(0);
    for (let i = 0; i < n; i += 1) {
      buf[i] = (src[i + pad] ?? 0) * (gain[i + pad] ?? 1);
    }
  }
}

export function applyTruePeakLimiter(
  channels: readonly Float64Array[],
  sampleRate: number,
  ceilingDb: number,
  periodic: boolean,
): void {
  if ((channels[0]?.length ?? 0) === 0) {
    return;
  }
  // Gain modulation can lift an intersample peak slightly, so aim under the ceiling and re-check.
  let aimDb = ceilingDb - 0.05;
  for (let pass = 0; pass < LIMITER_MAX_PASSES; pass += 1) {
    limitOnce(channels, sampleRate, Math.pow(10, aimDb / 20), periodic);
    const measured = measureTruePeak(channels).truePeakDbtp;
    if (measured === null || measured <= ceilingDb - 0.01) {
      return;
    }
    aimDb -= measured - ceilingDb + 0.05;
  }
}
