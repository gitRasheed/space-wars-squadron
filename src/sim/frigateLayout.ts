import { vec3 } from './math';
import type { Vec3 } from './types';

/** A box that tapers linearly from its front (-z) face to its back (+z) face; widths and heights are full sizes. */
export interface TaperedSection {
  readonly centerY: number;
  readonly centerZ: number;
  readonly length: number;
  readonly frontWidth: number;
  readonly frontHeight: number;
  readonly backWidth: number;
  readonly backHeight: number;
  readonly frontYOffset: number;
  readonly backYOffset: number;
}

/** The frigate's main hull volumes, shared by its mesh and the shot hit test so the two cannot drift. */
export const FRIGATE_HULL_SECTIONS = {
  prow: { centerY: 2, centerZ: -46, length: 178, frontWidth: 12, frontHeight: 14, backWidth: 80, backHeight: 30, frontYOffset: 6, backYOffset: 0 },
  stern: { centerY: 2, centerZ: 85, length: 88, frontWidth: 80, frontHeight: 30, backWidth: 68, backHeight: 28, frontYOffset: 0, backYOffset: 0 },
  keel: { centerY: -14, centerZ: 24, length: 190, frontWidth: 16, frontHeight: 6, backWidth: 50, backHeight: 18, frontYOffset: 4, backYOffset: -2 },
  spine: { centerY: 20, centerZ: 22, length: 172, frontWidth: 14, frontHeight: 10, backWidth: 36, backHeight: 14, frontYOffset: 0, backYOffset: 0 },
} as const satisfies Record<string, TaperedSection>;

export interface LocalBox {
  readonly center: Vec3;
  readonly halfExtents: Vec3;
}

const SLICES_PER_SECTION = 6;

/** Cuts a tapered section into boxes along z, each just wide and tall enough to hold its slice. */
export function sliceTaperedSection(section: TaperedSection, slices: number): readonly LocalBox[] {
  const at = (t: number) => ({
    halfWidth: (section.frontWidth + (section.backWidth - section.frontWidth) * t) * 0.5,
    top: section.centerY + section.frontYOffset + (section.backYOffset - section.frontYOffset) * t +
      (section.frontHeight + (section.backHeight - section.frontHeight) * t) * 0.5,
    bottom: section.centerY + section.frontYOffset + (section.backYOffset - section.frontYOffset) * t -
      (section.frontHeight + (section.backHeight - section.frontHeight) * t) * 0.5,
  });
  const frontZ = section.centerZ - section.length * 0.5;
  return Array.from({ length: slices }, (_, i) => {
    const near = at(i / slices);
    const far = at((i + 1) / slices);
    const top = Math.max(near.top, far.top);
    const bottom = Math.min(near.bottom, far.bottom);
    return {
      center: vec3(0, (top + bottom) * 0.5, frontZ + section.length * ((i + 0.5) / slices)),
      halfExtents: vec3(Math.max(near.halfWidth, far.halfWidth), (top - bottom) * 0.5, section.length / slices / 2),
    };
  });
}

/** Stepped boxes that follow the tapered hull, so empty air beside the narrow prow never stops a shot. */
export const FRIGATE_HULL_PROXY: readonly LocalBox[] = Object.values(FRIGATE_HULL_SECTIONS).flatMap((section) =>
  sliceTaperedSection(section, SLICES_PER_SECTION),
);
