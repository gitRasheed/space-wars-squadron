import { clamp } from './math';
import type { EnemyKind } from './types';

interface ShieldStats {
  readonly hull: number;
  readonly shields: number;
  readonly shieldRegenDelay: number;
  readonly shieldRegenPerSecond: number;
  /** Sphere radius, sized to the mesh's solid core rather than its antennae or vane tips. */
  readonly hitRadius: number;
}

export interface EnemyStats extends ShieldStats {
  readonly approachSpeed: number;
  readonly breakAwaySpeed: number;
  readonly turnRate: number;
  readonly fireRangeMin: number;
  readonly fireRangeMax: number;
}

// Mesh bounds: raider 15.1 x 11.6 x 9.6 m (thin solar vanes), striker 14.2 x 5.4 x 16.9 m,
// player 14.2 x 4.0 x 20.4 m (thin wings).
export const SHIP_STATS: {
  readonly player: ShieldStats;
  readonly enemies: Readonly<Record<EnemyKind, EnemyStats>>;
} = {
  player: {
    hull: 80,
    shields: 100,
    shieldRegenDelay: 1.8,
    shieldRegenPerSecond: 15,
    hitRadius: 5.5,
  },
  enemies: {
    raider: {
      hull: 75,
      shields: 70,
      shieldRegenDelay: 4.5,
      shieldRegenPerSecond: 6,
      hitRadius: 5.8,
      approachSpeed: 98,
      breakAwaySpeed: 112,
      turnRate: 2.45,
      fireRangeMin: 130,
      fireRangeMax: 560,
    },
    striker: {
      hull: 100,
      shields: 80,
      shieldRegenDelay: 4.5,
      shieldRegenPerSecond: 6,
      hitRadius: 6.8,
      approachSpeed: 66,
      breakAwaySpeed: 76,
      turnRate: 1.35,
      fireRangeMin: 180,
      fireRangeMax: 620,
    },
  },
};

export interface ShieldAbsorb {
  readonly shield: number;
  readonly hullDamage: number;
  readonly broke: boolean;
}

export function absorbIntoShield(shield: number, damage: number): ShieldAbsorb {
  const absorbed = Math.min(shield, damage);
  const next = shield - absorbed;
  return { shield: next, hullDamage: damage - absorbed, broke: shield > 0 && next <= 0 };
}

export function regenShield(
  shield: number,
  maxShield: number,
  regenDelay: number,
  regenPerSecond: number,
  dt: number,
): { readonly shield: number; readonly regenDelay: number } {
  const nextDelay = Math.max(0, regenDelay - dt);
  return {
    shield: nextDelay <= 0 ? clamp(shield + regenPerSecond * dt, 0, maxShield) : shield,
    regenDelay: nextDelay,
  };
}
