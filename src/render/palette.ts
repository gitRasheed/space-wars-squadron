export type Rgb = readonly [number, number, number];

/** Everything about the look that belongs to a place rather than to a ship: light, ink and grade. */
export interface BiomeCard {
  readonly sunDirection: { readonly x: number; readonly y: number; readonly z: number };
  /** Light multipliers per cel band, keyed on N·L. Shadowed faces looking at the sky step up to `bounce`. */
  readonly bands: {
    readonly highlight: Rgb;
    readonly base: Rgb;
    readonly shadow: Rgb;
    readonly bounce: Rgb;
  };
  readonly glint: Rgb;
  /** Rim on surfaces that carry no faction rim of their own. */
  readonly rim: number;
  readonly inkTint: Rgb;
  readonly vignetteTint: Rgb;
  /** Display-space grade: shadows are multiplied and lifted, highlights multiplied. */
  readonly grade: {
    readonly shadowGain: Rgb;
    readonly shadowLift: Rgb;
    readonly highlightGain: Rgb;
  };
}

// Band lumas stay near 0.85 / 0.48 / 0.17 / 0.28 in every biome; a card moves hue only.
export const BIOME_CARDS = {
  saturnOrbit: {
    sunDirection: { x: 0.84, y: 0.18, z: -0.51 },
    bands: {
      highlight: [1.0, 0.84, 0.64],
      base: [0.52, 0.47, 0.52],
      shadow: [0.14, 0.16, 0.36],
      bounce: [0.24, 0.27, 0.54],
    },
    glint: [1.0, 0.9, 0.76],
    rim: 0x7c96d8,
    inkTint: [0.007, 0.008, 0.02],
    vignetteTint: [0.78, 0.74, 1.0],
    grade: {
      shadowGain: [0.92, 0.97, 1.12],
      shadowLift: [0.008, 0.004, 0.024],
      highlightGain: [1.05, 1.0, 0.93],
    },
  },
  megastructureTrench: {
    sunDirection: { x: 0.35, y: 0.85, z: -0.4 },
    bands: {
      highlight: [1.0, 0.82, 0.5],
      base: [0.56, 0.45, 0.38],
      shadow: [0.07, 0.18, 0.24],
      bounce: [0.36, 0.26, 0.2],
    },
    glint: [1.0, 0.86, 0.6],
    rim: 0x9fb0f0,
    inkTint: [0.004, 0.009, 0.014],
    vignetteTint: [0.7, 0.86, 0.92],
    grade: {
      shadowGain: [0.9, 1.0, 1.06],
      shadowLift: [0.002, 0.01, 0.014],
      highlightGain: [1.06, 1.0, 0.9],
    },
  },
  sunsetGroundSupport: {
    // About 12° up and just right of the canyon axis, so the sky's sun disc sits over the valley you fly down.
    sunDirection: { x: 0.32, y: 0.215, z: -0.92 },
    bands: {
      highlight: [1.0, 0.82, 0.6],
      base: [0.6, 0.44, 0.5],
      shadow: [0.2, 0.13, 0.38],
      bounce: [0.32, 0.24, 0.56],
    },
    glint: [1.0, 0.88, 0.7],
    rim: 0x8f8fe0,
    inkTint: [0.012, 0.007, 0.022],
    vignetteTint: [0.82, 0.72, 0.98],
    grade: {
      shadowGain: [0.96, 0.93, 1.12],
      shadowLift: [0.012, 0.004, 0.024],
      highlightGain: [1.06, 0.99, 0.92],
    },
  },
} as const satisfies Record<string, BiomeCard>;

export type BiomeId = keyof typeof BIOME_CARDS;

// Band edges and the rim shape are the house style, the same in every biome.
export const CEL_SHADING = {
  bounceEdge: 0.6,
  highlightEdge: 0.42,
  shadowEdge: -0.12,
  rimEdge: 0.78,
  // A flat face crosses the rim edge all at once, so it waits until it is nearly edge-on and lights at part strength.
  rimFlatEdge: 0.9,
  rimFlatGain: 0.6,
  muzzleFlash: [1.0, 0.6, 0.22],
} as const;

// Rim light doubles as figure-ground separation, so its hue says whose ship it is.
export const RIM_PALETTE = {
  friendly: 0x9fdcff,
  hostile: 0xff8fb0,
  rock: 0x9a8fd0,
} as const;

/** Share of the colour under an ink line that survives; the rest is the biome's ink tint. */
export const INK_KEEP = 0.1;

/** Biome B surfaces. Walls stay matte and under 0.45 luma; the guide ribs are the one cold light inside. */
export const TRENCH_PALETTE = {
  wallDeep: 0x33262a,
  wall: 0x6e4a3c,
  wallLit: 0x8a6650,
  void: 0x05070f,
  guideRib: 0xaab8ff,
  coldGap: 0xaab8ff,
  coldGapCore: 0xe4e9ff,
  pylon: 0x3b314d,
  pylonTrim: 0x67647c,
  reactorCore: 0xff5ec0,
} as const;

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
  barrelHot: 0xff3b18,
  barrelReady: 0xf4b459,
  ledCyan: 0x6be5ff,
  ledAmber: 0xf4b459,
  rewardGold: 0xffd966,
  nearMissGlint: 0x5dffb3,
  buzzGlint: 0xfff0d4,
} as const;

export const HUD_PALETTE = {
  amber: '#f4b459',
  cyan: '#6be5ff',
  crimson: '#ff4d63',
  warmWhite: '#fff0d4',
  cream: '#f6e8cf',
  radioText: '#f2e6cf',
  boostGold: '#ffd966',
  missileOrange: '#ff8e4d',
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
