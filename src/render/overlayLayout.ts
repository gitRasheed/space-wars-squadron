import { MISSION_ORDER } from '../levelPresentation';
import { clamp } from '../sim/math';
import type { LevelId } from '../sim/types';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface BriefingLayout {
  readonly card: Box;
  readonly missions: readonly { readonly level: LevelId; readonly box: Box }[];
  /** Baseline of the first line under the mission buttons. */
  readonly detailY: number;
}

export function hudScaleFor(height: number): number {
  return clamp(height / 720, 0.85, 1.45);
}

/** The briefing card and its mission buttons; drawing and click hit-tests both read this. */
export function briefingLayout(width: number, height: number): BriefingLayout {
  const s = hudScaleFor(height);
  const w = Math.min(640 * s, width - 32);
  const h = 340 * s;
  const card = { x: (width - w) * 0.5, y: Math.max(16, (height - h) * 0.5), w, h };
  const pad = 22 * s;
  const gap = 8 * s;
  const buttonW = (card.w - pad * 2 - gap * (MISSION_ORDER.length - 1)) / MISSION_ORDER.length;
  const buttonY = card.y + 80 * s;
  const missions = MISSION_ORDER.map((level, i) => ({
    level,
    box: { x: card.x + pad + i * (buttonW + gap), y: buttonY, w: buttonW, h: 34 * s },
  }));
  return { card, missions, detailY: buttonY + 34 * s + 34 * s };
}

export function briefingLevelAt(layout: BriefingLayout, x: number, y: number): LevelId | null {
  const hit = layout.missions.find(({ box }) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h);
  return hit?.level ?? null;
}
