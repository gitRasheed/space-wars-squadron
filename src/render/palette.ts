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

type Rgb = readonly [number, number, number];

/** Per-biome light bands and grade; every biome keeps the band edges and changes only the hue of each step. */
export interface BiomeCard {
  /** Direction toward the key light; cel bands, the bounce side and the sky's sun disc all derive from it. */
  readonly sun: Rgb;
  readonly shadow: Rgb;
  readonly bounce: Rgb;
  readonly base: Rgb;
  readonly highlight: Rgb;
  readonly inkTint: Rgb;
  readonly vignetteTint: Rgb;
  readonly gradeShadows: Rgb;
  readonly gradeHighlights: Rgb;
}

export const SATURN_BIOME: BiomeCard = {
  sun: [SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z],
  shadow: CEL_SHADING.shadow,
  bounce: CEL_SHADING.bounce,
  base: CEL_SHADING.base,
  highlight: CEL_SHADING.highlight,
  inkTint: INK_PALETTE.tint,
  vignetteTint: [0.78, 0.74, 1.0],
  gradeShadows: [0.92, 0.97, 1.12],
  gradeHighlights: [1.05, 1.0, 0.93],
};

// Saturn's bands scaled by the art bible's C/A card ratios: violet shadows, peach light, a warmer core.
export const SUNSET_BIOME: BiomeCard = {
  // About 12° up and just right of the canyon axis, so the sun disc sits over the valley you fly down.
  sun: [0.32, 0.215, -0.92],
  shadow: [0.17, 0.15, 0.36],
  bounce: [0.3, 0.26, 0.5],
  base: [0.6, 0.45, 0.48],
  highlight: [1.0, 0.8, 0.56],
  inkTint: [0.012, 0.008, 0.022],
  vignetteTint: [0.86, 0.72, 0.9],
  gradeShadows: [0.95, 0.94, 1.1],
  gradeHighlights: [1.06, 0.99, 0.9],
};

export const SUNSET_PALETTE = {
  skyZenith: 0x2b2f5e,
  skyHigh: 0x7a4f7c,
  skyLow: 0xe8866a,
  skyHorizon: 0xe9ab78,
  sunHalo: 0xf2bf86,
  sunDisc: 0xffc48a,
  cloudLit: 0xe0a58c,
  cloudShadow: 0x6a4a78,
  mesaLight: 0xb88a68,
  mesaMid: 0x7d5560,
  mesaDark: 0x3d2f52,
  /** The lightest terrain tone: pads and the walker road, so dark hostile bodies pop by value. */
  pad: 0xe2bd94,
  padMarking: 0x7d5560,
  hostileHull: 0x3b314d,
  hostilePlate: 0x57566e,
  hostileGlow: 0xf04c48,
  flakCharge: 0x5dffb3,
  friendlyHull: 0xede6d5,
  friendlyTrim: 0x2a3456,
  friendlyLight: 0x52d4ff,
  wreck: 0x1b1922,
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
