export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i] ?? 0;
      const ti = im[i] ?? 0;
      re[i] = re[j] ?? 0;
      im[i] = im[j] ?? 0;
      re[j] = tr;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wStepRe = Math.cos(angle);
    const wStepIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j += 1) {
        const uRe = re[i + j] ?? 0;
        const uIm = im[i + j] ?? 0;
        const vr = re[i + j + half] ?? 0;
        const vi = im[i + j + half] ?? 0;
        const tRe = vr * wRe - vi * wIm;
        const tIm = vr * wIm + vi * wRe;
        re[i + j] = uRe + tRe;
        im[i + j] = uIm + tIm;
        re[i + j + half] = uRe - tRe;
        im[i + j + half] = uIm - tIm;
        const nextWRe = wRe * wStepRe - wIm * wStepIm;
        wIm = wRe * wStepIm + wIm * wStepRe;
        wRe = nextWRe;
      }
    }
  }
}

export function rfftMagnitude(signal: Float64Array, fftSize: number): Float64Array {
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const count = Math.min(signal.length, fftSize);
  const denom = Math.max(1, count - 1);
  for (let i = 0; i < count; i += 1) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom));
    re[i] = (signal[i] ?? 0) * w;
  }
  fftInPlace(re, im);
  const bins = fftSize / 2 + 1;
  const mag = new Float64Array(bins);
  for (let k = 0; k < bins; k += 1) {
    const r = re[k] ?? 0;
    const m = im[k] ?? 0;
    mag[k] = Math.hypot(r, m);
  }
  return mag;
}
