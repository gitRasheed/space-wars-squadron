export interface LabColor {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

export function srgbChannelToLinear(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.04045 ? clamped / 12.92 : Math.pow((clamped + 0.055) / 1.055, 2.4);
}

export function linearChannelToSrgb(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

export function hexSrgbToLinearRgb(hex: string): readonly [number, number, number] {
  const clean = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`Invalid sRGB hex color: ${hex}`);
  }
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b)];
}

export function linearRgbToHexSrgb(r: number, g: number, b: number): string {
  const toByte = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(linearChannelToSrgb(v) * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

// Converts linear sRGB primaries to CIE Lab with D65 white point (X=0.95047, Y=1.00000, Z=1.08883).
export function linearRgbToLabD65(r: number, g: number, b: number): LabColor {
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;

  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / 0.95047);
  const fy = f(y / 1.0);
  const fz = f(z / 1.08883);
  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

export function deltaE76(c1: LabColor, c2: LabColor): number {
  return Math.hypot(c1.l - c2.l, c1.a - c2.a, c1.b - c2.b);
}

export function nearestPaletteMatch(
  linearRgb: readonly [number, number, number],
  palette: Readonly<Record<string, string>>,
): { readonly role: string; readonly hex: string; readonly deltaE76: number } {
  const targetLab = linearRgbToLabD65(linearRgb[0], linearRgb[1], linearRgb[2]);
  let bestRole = '';
  let bestHex = '#000000';
  let bestDist = Infinity;
  for (const [role, hex] of Object.entries(palette)) {
    const palLin = hexSrgbToLinearRgb(hex);
    const palLab = linearRgbToLabD65(palLin[0], palLin[1], palLin[2]);
    const dist = deltaE76(targetLab, palLab);
    if (dist < bestDist) {
      bestDist = dist;
      bestRole = role;
      bestHex = hex;
    }
  }
  return { role: bestRole, hex: bestHex, deltaE76: bestDist };
}
