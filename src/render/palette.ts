export const SUN_DIRECTION = {
  x: 0.84,
  y: 0.18,
  z: -0.51,
} as const;

// Light multipliers per cel band, keyed on N·L against SUN_DIRECTION: warm highlight, saturated base, indigo shadow.
// Faces in shadow that look toward the sky opposite the sun step up to `bounce`, so backlit shapes keep their form.
export const CEL_SHADING = {
  highlight: [1.0, 0.84, 0.64],
  base: [0.52, 0.47, 0.52],
  shadow: [0.14, 0.16, 0.36],
  bounce: [0.24, 0.27, 0.54],
  bounceEdge: 0.6,
  highlightEdge: 0.42,
  shadowEdge: -0.12,
  rimEdge: 0.78,
  glint: [1.0, 0.9, 0.76],
  muzzleFlash: [1.0, 0.6, 0.22],
} as const;

// Rim light doubles as figure-ground separation, so its hue says whose ship it is.
export const RIM_PALETTE = {
  neutral: 0x7c96d8,
  friendly: 0x9fdcff,
  hostile: 0xff8fb0,
  rock: 0x9a8fd0,
} as const;

export const INK_PALETTE = {
  tint: [0.007, 0.008, 0.02],
  keep: 0.1,
} as const;

export const SCENE_PALETTE = {
  playerStripe: 0xe88332,
  wingmateStripe: 0x4bc5e8,
  wingmateTrail: 0x52d4ff,
  friendlyBolt: 0xffe07d,
  hostileBolt: 0x5dffb3,
  missile: 0xff7740,
  missileTrail: 0xffaa55,
  enemyTrail: 0x5dffb3,
  destroyedSubsystem: 0x1b1922,
  explosionCrimson: 0xff4560,
  explosionEmerald: 0x6bffb8,
  explosionAmber: 0xffb84d,
  explosionShardHighlight: 0xffe8b0,
  dust: 0xd4e2ff,
  streakBoost: 0xa6e8ff,
  streakDrift: 0x5dffdb,
  hostileAccent: 0xf04c48,
  hostileEmissive: 0x941e1a,
  frigateAccent: 0xf04d5c,
  frigateGlow: 0xff6b7a,
  shieldDome: 0xff5ec0,
  enemyShield: 0x52e5ff,
  enemyShieldEdge: 0xc8fbff,
  heatWisp: 0xffd9bd,
  heatWispCool: 0xb9c4de,
  clampCore: 0xff843b,
} as const;

export const HUD_PALETTE = {
  amber: '#f4b459',
  cyan: '#6be5ff',
  crimson: '#ff4d63',
  emerald: '#5dffb0',
  warmWhite: '#fff0d4',
  cream: '#f6e8cf',
  radioText: '#f2e6cf',
  boostGold: '#ffd966',
  missileOrange: '#ff8e4d',
  frigateOrange: '#ff8040',
  subsystemMagenta: '#ff52b8',
  panelBg: 'rgba(7, 10, 18, 0.68)',
  inkStroke: '#070812',
} as const;

export const TEXTURE_PALETTE = {
  fighter: {
    base: '#ede6d5',
    alt: '#dbd4c6',
    seam: '#96969c',
    rivet: '#f7f3e8',
    band: '#c4baa8',
    trim: '#6c6f7d',
  },
  carrier: {
    base: '#e2d9c8',
    alt: '#d4c9b4',
    seam: '#918b80',
    rivet: '#f7f1e3',
    light: '#ffd88a',
    band: '#c2b59d',
  },
  frigate: {
    base: '#67647c',
    alt: '#57566e',
    seam: '#36374c',
    rivet: '#8577a3',
    light: '#ff6478',
    band: '#3b314d',
  },
  solarVane: {
    bg: '#292d43',
    grid: '#53627c',
    cell: '#3c4962',
    border: '#71869a',
  },
  asteroidIce: {
    base: '#8f84ab',
    mid: '#827a9f',
    dark: '#695e82',
    highlight: '#bfb7d9',
  },
  asteroidOchre: {
    base: '#8f5f4e',
    mid: '#845846',
    dark: '#6c463c',
    highlight: '#bd866d',
  },
  asteroidSlate: {
    base: '#555c73',
    mid: '#51576e',
    dark: '#41465a',
    highlight: '#828ca8',
  },
} as const;
