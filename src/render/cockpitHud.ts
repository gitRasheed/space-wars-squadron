import {
  computePlayerFireSolution,
  findTargetContact,
  listHostileContacts,
  subsystemWorldPosition,
  type PlayerFireSolution,
} from '../sim/combat';
import { add, clamp, distance, dot, forwardOf, len, rightOf, scale, sub, upOf } from '../sim/math';
import { ENERGY_RULES, inHotZone } from '../sim/energy';
import { HULL_ALARM_INTERVAL_SECONDS, HULL_CRITICAL_FRACTION, type GroundTargetState, type LevelId, type SupplyDrop, type Vec3, type WorldState } from '../sim/types';
import { LEVEL_PRESENTATION } from '../levelPresentation';
import { briefingLayout, briefingLevelAt, hudScaleFor } from './overlayLayout';
import { HUD_PALETTE } from './palette';
import type { ProjectedPoint } from './sceneRenderer';

type Project = (point: Vec3, width: number, height: number) => ProjectedPoint;

interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

function playerFireSolution(world: WorldState): PlayerFireSolution {
  const selected = findTargetContact(world.player.selectedTargetId, world.enemies, world.hostileFrigate, world.reactors, groundTargetsOf(world));
  return computePlayerFireSolution(world.player, selected);
}

function groundTargetsOf(world: WorldState): readonly GroundTargetState[] {
  return world.planetary?.groundTargets ?? [];
}

function isShielded(world: WorldState, target: GroundTargetState): boolean {
  return target.shieldedBy !== null && groundTargetsOf(world).some((g) => g.id === target.shieldedBy && g.hull > 0);
}

function reticlePoint(solution: PlayerFireSolution, project: Project, width: number, height: number): ScreenPoint {
  const projected = project(solution.convergencePoint, width, height);
  if (!projected.inFront) {
    return { x: width * 0.5, y: height * 0.5 };
  }
  return { x: projected.x, y: projected.y };
}

export function computeHudReticlePoint(
  world: WorldState,
  project: Project,
  width: number,
  height: number,
): ScreenPoint {
  return reticlePoint(playerFireSolution(world), project, width, height);
}

export interface DrawnBriefing {
  readonly level: LevelId;
  readonly title: string;
  readonly objective: string;
}

export interface CockpitHud {
  readonly resize: (width: number, height: number) => void;
  readonly render: (
    world: WorldState,
    project: Project,
    audioMuted: boolean,
    musicEnabled: boolean,
  ) => void;
  /** The mission button under a viewport point while the briefing card is up. */
  readonly levelAt: (world: WorldState, clientX: number, clientY: number) => LevelId | null;
  /** What the last frame's briefing card showed, or null when no briefing was drawn. */
  readonly drawnBriefing: () => DrawnBriefing | null;
}

// One hue per meaning: amber for the player's own systems and aim, gold for peaks and rewards, cyan for shields
// and friends, crimson for hostiles, magenta for objectives, cream for neutral readouts.
const AMBER = HUD_PALETTE.amber;
const CYAN = HUD_PALETTE.cyan;
const CRIMSON = HUD_PALETTE.crimson;
const GOLD = HUD_PALETTE.boostGold;
const CREAM = HUD_PALETTE.cream;
const MAGENTA = HUD_PALETTE.subsystemMagenta;
const INK = HUD_PALETTE.inkStroke;
const TRACK = 'rgba(255, 255, 255, 0.16)';
const FONT = '"JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, Consolas, "Courier New", monospace';
const RADAR_RADIUS = 38;
const RADAR_RANGE = 760;
const BOTTOM_SAFE_HEIGHT = 104;
const RETICLE_ARC_RADIUS = 46;
const RETICLE_ARC_SPAN = 0.72;
// Threat chevrons ride a ring outside the arcs, pips and state word, so nothing new enters the aim point.
const THREAT_RING_RADIUS = 78;
const THREAT_TICKS = 36;
const MAX_THREATS = 3;
const SHIELD_DOWN_TICKS = 40;
const SUPPLY_TICKS = 84;
const WARNING_BLINK_TICKS = 60;

interface HitMarkerStyle {
  readonly color: string;
  readonly ticks: number;
  readonly scale: number;
  readonly weight: number;
  /** A marker only gives way to one of equal or higher rank, so a crit keeps its full flash. */
  readonly rank: number;
}

const HIT_MARKERS = {
  hit: { color: CREAM, ticks: 6, scale: 1, weight: 1.7, rank: 0 },
  shield: { color: CYAN, ticks: 6, scale: 1, weight: 1.7, rank: 0 },
  crit: { color: GOLD, ticks: 7, scale: 1.4, weight: 2.2, rank: 1 },
  kill: { color: GOLD, ticks: 18, scale: 1.15, weight: 2.2, rank: 2 },
  objective: { color: MAGENTA, ticks: 18, scale: 1.15, weight: 2.2, rank: 2 },
} as const satisfies Record<string, HitMarkerStyle>;

const SUPPLY_LABELS: Readonly<Record<SupplyDrop, string>> = {
  heat_flush: 'HEAT FLUSH',
  shield_surge: 'SHIELD SURGE',
  missile_resupply: 'MISSILE +1',
};

type Status =
  | { readonly kind: 'warning'; readonly text: string; readonly sinceTick: number }
  | { readonly kind: 'supply'; readonly drop: SupplyDrop }
  | { readonly kind: 'word'; readonly text: string; readonly color: string };
const GROUND_MARKER_COUNT = 6;
const GROUND_STEM_RANGE = 600;

interface TextStyle {
  readonly size?: number;
  readonly align?: CanvasTextAlign;
  readonly bold?: boolean;
  readonly alpha?: number;
}

export function createCockpitHud(canvas: HTMLCanvasElement): CockpitHud {
  const maybeCtx = canvas.getContext('2d');
  if (maybeCtx === null) {
    throw new Error('2D HUD canvas context unavailable');
  }
  const ctx: CanvasRenderingContext2D = maybeCtx;

  let cssWidth = 1280;
  let cssHeight = 720;
  let lastHudTick = -1;
  let hitMarker: { readonly style: HitMarkerStyle; readonly bornTick: number } | null = null;
  let shieldDownUntil = 0;
  let supply: { readonly drop: SupplyDrop; readonly untilTick: number } | null = null;
  let threats: readonly { readonly position: Vec3; readonly untilTick: number }[] = [];
  // When each own-system warning came on, so its pill can blink in and then hold.
  let briefingShown: DrawnBriefing | null = null;
  let overheatSince: number | null = null;
  let hullLowSince: number | null = null;
  let proximitySince: number | null = null;
  let pullUpSince: number | null = null;

  function hudScale(): number {
    return hudScaleFor(cssHeight);
  }

  function canopyBounds(): Rect {
    return {
      left: 34,
      right: cssWidth - 34,
      top: 56,
      bottom: cssHeight - Math.round(BOTTOM_SAFE_HEIGHT * hudScale()) - 16,
    };
  }

  function inCanopy(point: ProjectedPoint): boolean {
    const bounds = canopyBounds();
    return (
      point.inFront &&
      point.x >= bounds.left &&
      point.x <= bounds.right &&
      point.y >= bounds.top &&
      point.y <= bounds.bottom
    );
  }

  function resize(width: number, height: number): void {
    cssWidth = Math.max(1, width);
    cssHeight = Math.max(1, height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setFont(style: TextStyle): void {
    ctx.font = `${style.bold === false ? 500 : 700} ${Math.round((style.size ?? 11) * hudScale())}px ${FONT}`;
  }

  // Every label carries its own ink outline, so it stays legible over the planet without a backing box.
  function drawText(text: string, x: number, y: number, color: string, style: TextStyle = {}): void {
    setFont(style);
    ctx.textAlign = style.align ?? 'left';
    ctx.globalAlpha = style.alpha ?? 1;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    ctx.strokeText(text, Math.round(x), Math.round(y));
    ctx.fillStyle = color;
    ctx.fillText(text, Math.round(x), Math.round(y));
    ctx.globalAlpha = 1;
  }

  function textWidth(text: string, style: TextStyle = {}): number {
    setFont(style);
    return ctx.measureText(text).width;
  }

  // Every glass mark sits on an ink underlay one pixel proud of it, so it survives a bright sky.
  function strokeInked(path: Path2D, color: string, width: number, alpha = 1): void {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = INK;
    ctx.lineWidth = width + 2;
    ctx.stroke(path);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke(path);
    ctx.globalAlpha = 1;
  }

  function fillInked(path: Path2D, color: string): void {
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.stroke(path);
    ctx.fillStyle = color;
    ctx.fill(path);
  }

  function diamondPath(x: number, y: number, size: number): Path2D {
    const path = new Path2D();
    path.moveTo(x, y - size);
    path.lineTo(x + size, y);
    path.lineTo(x, y + size);
    path.lineTo(x - size, y);
    path.closePath();
    return path;
  }

  /** Own-system warning: amber plate with dark text, blinking at 2 Hz for its first second and then steady. */
  function drawWarningPill(text: string, x: number, y: number, sinceTick: number, tick: number, align: CanvasTextAlign = 'center'): void {
    const age = tick - sinceTick;
    const plate = age >= WARNING_BLINK_TICKS || Math.floor(age / 15) % 2 === 0;
    const style: TextStyle = { size: 11, align };
    const width = textWidth(text, style);
    const height = Math.round(11 * hudScale());
    const left = align === 'center' ? x - width * 0.5 : align === 'right' ? x - width : x;
    ctx.fillStyle = INK;
    ctx.fillRect(left - 6, y - height - 3, width + 12, height + 8);
    if (!plate) {
      drawText(text, x, y, AMBER, style);
      return;
    }
    ctx.fillStyle = AMBER;
    ctx.fillRect(left - 5, y - height - 2, width + 10, height + 6);
    setFont(style);
    ctx.textAlign = align;
    ctx.fillStyle = INK;
    ctx.fillText(text, Math.round(x), Math.round(y));
  }

  function drawBar(x: number, y: number, w: number, h: number, ratio: number, color: string, fillFromRight = false): void {
    ctx.fillStyle = INK;
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = TRACK;
    ctx.fillRect(x, y, w, h);
    const fillW = w * clamp(ratio, 0, 1);
    ctx.fillStyle = color;
    ctx.fillRect(fillFromRight ? x + w - fillW : x, y, fillW, h);
  }

  function drawEdgeChevron(projected: ProjectedPoint, color: string, label: string): void {
    const bounds = canopyBounds();
    const cx = cssWidth * 0.5;
    const cy = (bounds.top + bounds.bottom) * 0.5;
    let dx = projected.x - cx;
    let dy = projected.y - cy;
    if (!projected.inFront) {
      dx = -dx;
      dy = -dy;
    }
    if (Math.hypot(dx, dy) < 1e-3) {
      dy = -1;
    }
    const angle = Math.atan2(dy, dx);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const halfW = (bounds.right - bounds.left) * 0.5 - 12;
    const halfH = (bounds.bottom - bounds.top) * 0.5 - 12;
    const reach = Math.min(
      Math.abs(cos) > 1e-4 ? halfW / Math.abs(cos) : Infinity,
      Math.abs(sin) > 1e-4 ? halfH / Math.abs(sin) : Infinity,
    );
    const edgeX = cx + cos * reach;
    const edgeY = cy + sin * reach;

    ctx.save();
    ctx.translate(edgeX, edgeY);
    ctx.rotate(angle);
    const arrow = new Path2D();
    arrow.moveTo(11, 0);
    arrow.lineTo(-6, -6);
    arrow.lineTo(-3.5, 0);
    arrow.lineTo(-6, 6);
    arrow.closePath();
    fillInked(arrow, color);
    ctx.restore();

    const align = edgeX > cssWidth * 0.65 ? 'right' : edgeX < cssWidth * 0.35 ? 'left' : 'center';
    const offsetX = align === 'right' ? -15 : align === 'left' ? 15 : 0;
    drawText(label, edgeX + offsetX, edgeY + (edgeY > bounds.bottom - 26 ? -12 : 4), color, { align });
  }

  /** The reticle, its two arcs, the missile pips and the status line above or below them. */
  function reticleCluster(reticle: ScreenPoint): Rect {
    const reach = (RETICLE_ARC_RADIUS + 8) * hudScale();
    return { left: reticle.x - reach, right: reticle.x + reach, top: reticle.y - reach, bottom: reticle.y + reach };
  }

  /** The one state word by the reticle: danger first, then reward, then state. */
  function currentStatus(world: WorldState): Status | null {
    // Hull never regenerates, so the word holds the slot for one alarm beat and the dash pill carries it after.
    if (hullLowSince !== null && world.tick - hullLowSince < HULL_ALARM_INTERVAL_SECONDS * 60) {
      return { kind: 'warning', text: 'HULL CRITICAL', sinceTick: hullLowSince };
    }
    if (overheatSince !== null) {
      return { kind: 'warning', text: 'OVERHEAT', sinceTick: overheatSince };
    }
    if (supply !== null) {
      return { kind: 'supply', drop: supply.drop };
    }
    if (world.player.energy.overdrive) {
      return { kind: 'word', text: 'OVERDRIVE', color: GOLD };
    }
    if (world.player.energy.recharging) {
      return { kind: 'word', text: 'RECHARGING', color: CYAN };
    }
    if (inHotZone(world.player.energy)) {
      return { kind: 'word', text: 'HOT ZONE', color: GOLD };
    }
    if (world.tick < shieldDownUntil) {
      return { kind: 'word', text: 'SHIELD DOWN', color: CYAN };
    }
    return null;
  }

  function drawStatus(status: Status, x: number, y: number, tick: number): void {
    if (status.kind === 'warning') {
      drawWarningPill(status.text, x, y, status.sinceTick, tick);
    } else if (status.kind === 'word') {
      drawText(status.text, x, y, status.color, { align: 'center' });
    } else {
      const label = SUPPLY_LABELS[status.drop];
      const lead = 'SUPPLY ';
      const left = x - (textWidth(lead) + textWidth(label)) * 0.5;
      drawText(lead, left, y, GOLD);
      drawText(label, left + textWidth(lead), y, CREAM);
    }
  }

  /** One chevron per recent shooter, on the ring outside the reticle, pointing at where the fire came from. */
  function drawThreats(project: Project, reticle: ScreenPoint): void {
    const s = hudScale();
    const ring = THREAT_RING_RADIUS * s;
    for (const threat of threats) {
      const projected = project(threat.position, cssWidth, cssHeight);
      let dx = projected.x - reticle.x;
      let dy = projected.y - reticle.y;
      if (!projected.inFront) {
        dx = -dx;
        dy = -dy;
      } else if (Math.hypot(dx, dy) < ring + 16 * s) {
        // The shooter is already in the sights; its bolts speak for themselves.
        continue;
      }
      if (Math.hypot(dx, dy) < 1e-3) {
        dy = 1;
      }
      ctx.save();
      ctx.translate(reticle.x, reticle.y);
      ctx.rotate(Math.atan2(dy, dx));
      const chevron = new Path2D();
      chevron.moveTo(ring, -7 * s);
      chevron.lineTo(ring + 7 * s, 0);
      chevron.lineTo(ring, 7 * s);
      ctx.lineJoin = 'miter';
      strokeInked(chevron, CRIMSON, 2.2);
      ctx.restore();
    }
  }

  function drawReticle(world: WorldState, project: Project, reticle: ScreenPoint, bracket: Rect | null): void {
    const { x: cx, y: cy } = reticle;
    const p = world.player;
    const s = hudScale();
    const overdrive = p.energy.overdrive;
    const overheated = p.energy.weaponState === 'overheated';
    const tone = overdrive ? GOLD : AMBER;

    const gap = 7 * s;
    const arm = 9 * s;
    const cross = new Path2D();
    cross.moveTo(cx - gap - arm, cy);
    cross.lineTo(cx - gap, cy);
    cross.moveTo(cx + gap, cy);
    cross.lineTo(cx + gap + arm, cy);
    cross.moveTo(cx, cy - gap - arm);
    cross.lineTo(cx, cy - gap);
    cross.moveTo(cx, cy + gap);
    cross.lineTo(cx, cy + gap + arm);
    // Locked-out guns dim the cross; the warning itself is the amber pill.
    strokeInked(cross, tone, 1.7, overheated ? 0.55 : 1);
    ctx.fillStyle = INK;
    ctx.fillRect(cx - 2.5, cy - 2.5, 5, 5);
    ctx.fillStyle = tone;
    ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);

    if (hitMarker !== null) {
      const { style, bornTick } = hitMarker;
      const spread = (world.tick - bornTick) / style.ticks;
      const inner = (6 + spread * 3) * s * style.scale;
      const outer = (14 + spread * 5) * s * style.scale;
      const marker = new Path2D();
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        marker.moveTo(cx + sx * outer, cy + sy * outer);
        marker.lineTo(cx + sx * inner, cy + sy * inner);
      }
      strokeInked(marker, style.color, style.weight);
    }

    // Both arcs fill upward from the bottom: shields on the left, cannon heat on the right.
    const radius = RETICLE_ARC_RADIUS * s;
    const leftBottom = Math.PI - RETICLE_ARC_SPAN;
    const rightBottom = RETICLE_ARC_SPAN;
    const sweep = RETICLE_ARC_SPAN * 2;
    const tracks = new Path2D();
    tracks.arc(cx, cy, radius, leftBottom, leftBottom + sweep);
    tracks.moveTo(cx + Math.cos(rightBottom - sweep) * radius, cy + Math.sin(rightBottom - sweep) * radius);
    tracks.arc(cx, cy, radius, rightBottom - sweep, rightBottom);
    strokeInked(tracks, TRACK, 3);

    ctx.lineWidth = 3;
    const shield = clamp(p.energy.shieldCharge / 100, 0, 1);
    ctx.strokeStyle = CYAN;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, leftBottom, leftBottom + sweep * shield);
    ctx.stroke();
    const heat = clamp(p.energy.weaponHeat / ENERGY_RULES.maxHeat, 0, 1);
    const hotStart = ENERGY_RULES.hotZoneHeat / ENERGY_RULES.maxHeat;
    ctx.strokeStyle = overheated ? CRIMSON : AMBER;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, rightBottom - sweep * (overheated ? heat : Math.min(heat, hotStart)), rightBottom);
    ctx.stroke();
    if (!overheated && heat > hotStart) {
      // The Hot Zone: the top fifth of the gauge, where crits hit twice as hard.
      ctx.strokeStyle = GOLD;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, rightBottom - sweep * heat, rightBottom - sweep * hotStart);
      ctx.stroke();
    }

    const pipW = 8 * s;
    const pipGap = 4 * s;
    const pipsLeft = cx - (p.maxMissiles * pipW + (p.maxMissiles - 1) * pipGap) * 0.5;
    const pipY = cy + radius + 8 * s;
    for (let i = 0; i < p.maxMissiles; i += 1) {
      const pipX = pipsLeft + i * (pipW + pipGap);
      ctx.fillStyle = INK;
      ctx.fillRect(pipX - 1, pipY - 1, pipW + 2, 5);
      ctx.fillStyle = i < p.missilesReady ? HUD_PALETTE.missileOrange : TRACK;
      ctx.fillRect(pipX, pipY, pipW, 3);
    }

    // The status line sits above the arcs unless the target bracket is already there.
    const status = currentStatus(world);
    if (status !== null) {
      const above = cy - radius - 9 * s;
      const crowded = bracket !== null && bracket.top < above + 4 && bracket.bottom > above - 14 * s
        && bracket.left < cx + 60 * s && bracket.right > cx - 60 * s;
      drawStatus(status, cx, crowded ? pipY + 18 * s : above, world.tick);
    }
    drawThreats(project, reticle);

    // Drift marker: only drawn once the flight path has slid away from the nose, so the centre stays clear.
    const drift = project(add(p.position, scale(p.velocity, 3)), cssWidth, cssHeight);
    if (inCanopy(drift) && Math.hypot(drift.x - cx, drift.y - cy) > radius * 0.5) {
      const marker = new Path2D();
      marker.arc(drift.x, drift.y, 5, 0, Math.PI * 2);
      marker.moveTo(drift.x - 10, drift.y);
      marker.lineTo(drift.x - 5, drift.y);
      marker.moveTo(drift.x + 5, drift.y);
      marker.lineTo(drift.x + 10, drift.y);
      strokeInked(marker, tone, 1.2, 0.8);
    }
  }

  function bracketPath(x: number, y: number, half: number): Path2D {
    const corner = Math.min(7, half * 0.4);
    const path = new Path2D();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      path.moveTo(x + sx * half, y + sy * (half - corner));
      path.lineTo(x + sx * half, y + sy * half);
      path.lineTo(x + sx * (half - corner), y + sy * half);
    }
    return path;
  }

  /** Draws hostile markers and returns the selected target's bracket so the reticle can keep clear of it. */
  function drawTargets(world: WorldState, project: Project, reticle: ScreenPoint, solution: PlayerFireSolution): Rect | null {
    const selectedId = world.player.selectedTargetId;
    const s = hudScale();
    let selectedBracket: Rect | null = null;

    const contacts = listHostileContacts(world.enemies, world.hostileFrigate, world.reactors, groundTargetsOf(world));
    const markedGround = new Set(
      contacts
        .filter((c) => c.kind === 'ground')
        .map((c) => ({ id: c.id, dist: distance(world.player.position, c.position) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, GROUND_MARKER_COUNT)
        .map((c) => c.id),
    );
    for (const contact of contacts) {
      const projected = project(contact.position, cssWidth, cssHeight);
      const isSelected = contact.id === selectedId;
      const label = `${contact.label} ${Math.round(distance(world.player.position, contact.position))}M`;
      if (!inCanopy(projected)) {
        if (isSelected) drawEdgeChevron(projected, CRIMSON, label);
        continue;
      }
      const { x, y } = projected;

      if (!isSelected && contact.kind === 'ground') {
        if (!markedGround.has(contact.id)) continue;
        // Down-caret above the target; beyond stem range a thin stem pins it to the exact spot on the ground.
        const tipY = y - 14 * s;
        const caret = new Path2D();
        caret.moveTo(x - 6 * s, tipY - 8 * s);
        caret.lineTo(x, tipY);
        caret.lineTo(x + 6 * s, tipY - 8 * s);
        if (distance(world.player.position, contact.position) > GROUND_STEM_RANGE) {
          caret.moveTo(x, tipY);
          caret.lineTo(x, y);
        }
        strokeInked(caret, CRIMSON, 1.7, 0.9);
        continue;
      }
      if (!isSelected) {
        // Over the bright sunset sky the faint orbital diamond disappears, so it gets the middle stroke weight.
        strokeInked(diamondPath(x, y, 6 * s), CRIMSON, world.planetary === null ? 1.2 : 1.7, 0.9);
        continue;
      }

      const lock = world.player.lockState;
      const acquiring = lock.kind === 'acquiring' && lock.targetId === contact.id;
      const locked = lock.kind === 'locked' && lock.targetId === contact.id;
      const half = (acquiring ? 30 - lock.progress * 9 : locked ? 19 : 22) * s;
      strokeInked(bracketPath(x, y, half), acquiring ? AMBER : CRIMSON, locked ? 2.2 : 1.7);
      selectedBracket = { left: x - half, right: x + half, top: y - half, bottom: y + half };
      // A manual pick is the pilot's own call, so its pin is amber and solid.
      const pinned = world.player.targetPinned;
      if (pinned) {
        fillInked(diamondPath(x, y - half, 5.5 * s), AMBER);
      }

      // The pip is the same lead point the guns' fire solution uses.
      const leadProjected = solution.leadPoint === null ? null : project(solution.leadPoint, cssWidth, cssHeight);
      const lead =
        leadProjected !== null && inCanopy(leadProjected) && Math.hypot(leadProjected.x - x, leadProjected.y - y) > 12
          ? leadProjected
          : null;

      // The label takes the first slot around the bracket that is clear of the reticle cluster and the lead pip;
      // with the target dead in the sights it steps just outside the cluster instead.
      const ground = contact.kind === 'ground' ? groundTargetsOf(world).find((g) => g.id === contact.id) : undefined;
      const shielded = ground !== undefined && isShielded(world, ground);
      const text = locked ? `${label} · LOCK` : shielded ? `${label} · SHIELDED` : label;
      const width = textWidth(text);
      const cluster = reticleCluster(reticle);
      const obstacles = lead === null
        ? [cluster]
        : [cluster, { left: lead.x - 12 * s, right: lead.x + 12 * s, top: lead.y - 12 * s, bottom: lead.y + 12 * s }];
      const beside = y + 4 * s;
      const slots: readonly ScreenPoint[] = [
        { x: x + half + 8, y: beside },
        { x: x - half - 8 - width, y: beside },
        { x: x - width * 0.5, y: y + half + 26 * s },
        { x: x - width * 0.5, y: y - half - (pinned ? 11 : 7) * s },
      ];
      const isClear = (slot: ScreenPoint): boolean =>
        slot.x >= 8 && slot.x + width <= cssWidth - 8 && obstacles.every((box) =>
          slot.x >= box.right || slot.x + width <= box.left || slot.y - 11 * s >= box.bottom || slot.y + 3 * s <= box.top);
      const slot = slots.find(isClear)
        ?? { x: x >= reticle.x ? cluster.right + 6 : cluster.left - 6 - width, y: beside };
      drawText(text, slot.x, slot.y, shielded ? CYAN : CRIMSON);

      const barW = 36 * s;
      const barX = x - barW * 0.5;
      const barY = y + half + 6;
      const enemy = contact.kind === 'enemy' ? world.enemies.find((e) => e.id === contact.id) : undefined;
      if (enemy !== undefined) {
        if (enemy.maxShields > 0) {
          drawBar(barX, barY, barW, 3, enemy.shields / enemy.maxShields, CYAN);
        }
        drawBar(barX, barY + 6, barW, 3, enemy.hull / enemy.maxHull, CRIMSON);
      } else if (ground !== undefined) {
        drawBar(barX, barY, barW, 4, shielded ? 1 : ground.hull / ground.maxHull, shielded ? CYAN : CRIMSON);
      } else {
        const subsystem =
          world.hostileFrigate?.subsystems.find((sub) => sub.id === contact.id) ?? world.reactors.find((r) => r.id === contact.id);
        if (subsystem !== undefined) {
          drawBar(barX, barY, barW, 4, subsystem.hull / subsystem.maxHull, MAGENTA);
        }
      }

      if (lead === null) continue;
      const onSolution = Math.hypot(lead.x - reticle.x, lead.y - reticle.y) < 16;
      const pipColor = onSolution ? GOLD : AMBER;

      const tether = new Path2D();
      tether.moveTo(x, y);
      tether.lineTo(lead.x, lead.y);
      ctx.setLineDash([3, 4]);
      strokeInked(tether, pipColor, 1.2, 0.6);
      ctx.setLineDash([]);

      const pip = new Path2D();
      pip.arc(lead.x, lead.y, 7 * s, 0, Math.PI * 2);
      strokeInked(pip, pipColor, onSolution ? 2.2 : 1.7);
      ctx.fillStyle = INK;
      ctx.fillRect(lead.x - 2.5, lead.y - 2.5, 5, 5);
      ctx.fillStyle = pipColor;
      ctx.fillRect(lead.x - 1.5, lead.y - 1.5, 3, 3);
    }

    const wingmate = project(world.wingmate.position, cssWidth, cssHeight);
    if (inCanopy(wingmate)) {
      const caret = new Path2D();
      caret.moveTo(wingmate.x - 5 * s, wingmate.y - 16 * s);
      caret.lineTo(wingmate.x, wingmate.y - 10 * s);
      caret.lineTo(wingmate.x + 5 * s, wingmate.y - 16 * s);
      strokeInked(caret, CYAN, 1.7);
      drawText(world.wingmate.callsign, wingmate.x, wingmate.y - 21 * s, CYAN, { align: 'center' });
    }
    return selectedBracket;
  }

  function drawRadar(world: WorldState, cx: number, cy: number, radius: number): void {
    ctx.fillStyle = HUD_PALETTE.panelBg;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    const rim = new Path2D();
    rim.arc(cx, cy, radius, 0, Math.PI * 2);
    strokeInked(rim, AMBER, 1.2, 0.7);

    const grid = new Path2D();
    grid.arc(cx, cy, radius * 0.5, 0, Math.PI * 2);
    for (let i = 0; i < 4; i += 1) {
      const angle = (i / 4) * Math.PI * 2;
      grid.moveTo(cx + Math.cos(angle) * radius * 0.86, cy + Math.sin(angle) * radius * 0.86);
      grid.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    }
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 1;
    ctx.stroke(grid);
    ctx.globalAlpha = 1;
    ctx.fillStyle = AMBER;
    ctx.fillRect(cx - 1, cy - 1, 2, 2);

    const fwd = forwardOf(world.player.orientation);
    const right = rightOf(world.player.orientation);
    const up = upOf(world.player.orientation);

    function drawBlip(pos: Vec3, color: string, size: number, shape: 'dot' | 'square' | 'selected' = 'dot'): void {
      const rel = sub(pos, world.player.position);
      const lx = dot(rel, right) / RADAR_RANGE;
      const lz = dot(rel, fwd) / RADAR_RANGE;
      const planar = Math.hypot(lx, lz);
      const fit = planar > 0.88 ? 0.88 / planar : 1;
      const bx = cx + lx * fit * radius;
      const groundY = cy - lz * fit * radius;
      const by = groundY - clamp((dot(rel, up) / RADAR_RANGE) * radius * 0.38, -14, 14);

      // The stalk shows height above or below the player's plane.
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx, groundY);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.fillStyle = INK;
      ctx.fillRect(bx - size - 1, by - size - 1, size * 2 + 2, size * 2 + 2);
      ctx.fillStyle = color;
      if (shape === 'dot') {
        ctx.beginPath();
        ctx.arc(bx, by, size, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(bx - size, by - size, size * 2, size * 2);
      }
      if (shape === 'selected') {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(bx - 5.5, by - 5.5, 11, 11);
      }
    }

    function drawGroundBlip(pos: Vec3, color: string): void {
      const rel = sub(pos, world.player.position);
      const lx = dot(rel, right) / RADAR_RANGE;
      const lz = dot(rel, fwd) / RADAR_RANGE;
      const planar = Math.hypot(lx, lz);
      const fit = planar > 0.88 ? 0.88 / planar : 1;
      const bx = cx + lx * fit * radius;
      const by = cy - lz * fit * radius;
      const tri = new Path2D();
      tri.moveTo(bx, by - 3.4);
      tri.lineTo(bx + 3.2, by + 2.4);
      tri.lineTo(bx - 3.2, by + 2.4);
      tri.closePath();
      strokeInked(tri, color, 1.2);
    }

    if (world.planetary === null) {
      drawBlip(world.friendlyCarrier.position, CYAN, 3, 'square');
      if (world.hostileFrigate !== null) {
        drawBlip(world.hostileFrigate.position, CRIMSON, 3.5, 'square');
      }
    } else {
      drawBlip(world.friendlyCarrier.position, CYAN, 3, 'square');
      for (const target of world.planetary.groundTargets) {
        if (target.hull > 0) drawGroundBlip(target.position, target.id === world.player.selectedTargetId ? CREAM : CRIMSON);
      }
    }
    drawBlip(world.wingmate.position, CYAN, 2.2, 'square');

    const selectedId = world.player.selectedTargetId;
    let selectedPos: Vec3 | null = null;
    for (const enemy of world.enemies) {
      if (enemy.id === selectedId) {
        selectedPos = enemy.position;
      } else {
        drawBlip(enemy.position, CRIMSON, 2.2);
      }
    }
    const frigate = world.hostileFrigate;
    const objectives = [
      ...(frigate === null ? [] : frigate.subsystems.map((sub) => ({ id: sub.id, hull: sub.hull, pos: subsystemWorldPosition(frigate, sub) }))),
      ...world.reactors.map((r) => ({ id: r.id, hull: r.hull, pos: r.position })),
    ];
    for (const { id, hull, pos } of objectives) {
      if (hull <= 0) continue;
      if (id === selectedId) {
        selectedPos = pos;
      } else {
        drawBlip(pos, MAGENTA, 2);
      }
    }
    if (selectedPos !== null) {
      drawBlip(selectedPos, HUD_PALETTE.warmWhite, 2.2, 'selected');
    }
  }

  function drawDash(world: WorldState, audioMuted: boolean, musicEnabled: boolean): void {
    const s = hudScale();
    const radarRadius = Math.round(RADAR_RADIUS * s);
    const cx = cssWidth * 0.5;
    const radarY = cssHeight - radarRadius - 16;
    const p = world.player;
    const overdrive = p.energy.overdrive;

    drawRadar(world, cx, radarY, radarRadius);

    const barW = Math.round(108 * s);
    const leftX = cx - radarRadius - barW - 18;
    const rightX = cx + radarRadius + 18;

    const speed = `${Math.round(len(p.velocity))}`;
    drawText('M/S', leftX + barW, radarY + 2 * s, overdrive ? GOLD : AMBER, { align: 'right' });
    drawText(speed, leftX + barW - 30 * s, radarY + 2 * s, overdrive ? GOLD : AMBER, { size: 19, align: 'right' });

    // Throttle spans 0..120% with a tick at the 100% detent.
    const throttleY = radarY + 12 * s;
    drawBar(leftX, throttleY, barW, 5, p.throttle / 1.2, overdrive ? GOLD : AMBER, true);
    ctx.fillStyle = HUD_PALETTE.warmWhite;
    ctx.fillRect(leftX + barW * (1 - 1 / 1.2) - 0.5, throttleY - 2, 1.5, 9);
    if (!overdrive && p.throttle >= 0.995) {
      drawText('TAP W · OVERDRIVE', leftX + barW, throttleY + 20 * s, GOLD, { align: 'right' });
    }

    drawBar(rightX, radarY - 11 * s, barW, 6, p.energy.shieldCharge / 100, CYAN);
    drawBar(rightX, radarY + 4 * s, barW, 6, p.hull / p.maxHull, hullLowSince === null ? CREAM : AMBER);
    drawText('SHD', rightX + barW + 9, radarY - 11 * s + 8, CYAN);
    if (hullLowSince === null) {
      drawText('HUL', rightX + barW + 9, radarY + 4 * s + 9, CREAM);
    } else {
      drawWarningPill('HUL', rightX + barW + 9, radarY + 4 * s + 9, hullLowSince, world.tick, 'left');
    }

    if (pullUpSince !== null) {
      drawWarningPill('PULL UP', cx, radarY - radarRadius - 12 * s, pullUpSince, world.tick);
    } else if (proximitySince !== null) {
      drawWarningPill('PROXIMITY', cx, radarY - radarRadius - 12 * s, proximitySince, world.tick);
    }

    // Audio is only mentioned when it is not in its default state.
    const audioNote = audioMuted ? 'MUTED · M' : musicEnabled ? null : 'MUSIC OFF · N';
    if (audioNote !== null) {
      drawText(audioNote, cssWidth - 18, cssHeight - 14, CREAM, { align: 'right', alpha: 0.7 });
    }
  }

  function drawTopStrip(world: WorldState): void {
    const cores = world.sortie.level === 'trench'
      ? world.reactors.filter((r) => r.hull > 0).length
      : (world.hostileFrigate?.subsystems.filter((sub) => sub.hull > 0).length ?? 0);
    const s = hudScale();
    if (world.planetary !== null) {
      const ground = `GROUND ${world.planetary.groundTargets.filter((t) => t.hull > 0).length}`;
      drawText(ground, 18, 26 * s, CREAM);
      if (world.planetary.stage.kind === 'air_superiority') {
        drawText(`AIR ${world.enemies.length}`, 18 + textWidth(ground) + 14 * s, 26 * s, CRIMSON);
      }
      const outpost = world.friendlyCarrier.hull / world.friendlyCarrier.maxHull;
      drawBar(18, 34 * s, 128 * s, 4, outpost, outpost < 0.35 ? AMBER : CYAN);
      drawText('OUTPOST', 18 + 128 * s + 8, 34 * s + 7, CYAN);
      drawRadio(world);
      return;
    }
    const hostiles = `${world.sortie.level === 'trench' ? 'HOSTILES' : 'RAIDERS'} ${world.enemies.length}`;
    drawText(hostiles, 18, 26 * s, CREAM);
    drawText(`${world.sortie.level === 'trench' ? 'REACTORS' : 'CORES'} ${cores}`, 18 + textWidth(hostiles) + 14 * s, 26 * s, MAGENTA);
    const carrier = world.friendlyCarrier.hull / world.friendlyCarrier.maxHull;
    drawBar(18, 34 * s, 128 * s, 4, carrier, carrier < 0.35 ? AMBER : CYAN);
    drawText('HEARTHSTONE', 18 + 128 * s + 8, 34 * s + 7, CYAN);

    drawRadio(world);
  }

  function drawRadio(world: WorldState): void {
    const s = hudScale();
    if (world.radio !== null) {
      const speaker = `${world.radio.speaker} `;
      const right = cssWidth - 18;
      const bodyWidth = textWidth(world.radio.text, { bold: false });
      drawText(world.radio.text, right, 26 * s, HUD_PALETTE.radioText, { align: 'right', bold: false });
      drawText(speaker, right - bodyWidth, 26 * s, CYAN, { align: 'right' });
    }
  }

  interface CardLine {
    readonly text: string;
    readonly color: string;
    readonly size?: number;
    readonly bold?: boolean;
    readonly alpha?: number;
  }

  function drawCard(title: string, titleColor: string, lines: readonly CardLine[], prompt: CardLine): void {
    ctx.fillStyle = 'rgba(6, 7, 15, 0.7)';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const s = hudScale();
    const cardW = Math.min(560 * s, cssWidth - 40);
    const cardH = Math.max(236, 140 + lines.length * 24) * s;
    const cardX = (cssWidth - cardW) * 0.5;
    const cardY = (cssHeight - cardH) * 0.5;
    ctx.fillStyle = 'rgba(11, 13, 24, 0.95)';
    ctx.fillRect(cardX, cardY, cardW, cardH);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 6;
    ctx.strokeRect(cardX, cardY, cardW, cardH);
    ctx.strokeStyle = titleColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(cardX, cardY, cardW, cardH);
    ctx.fillStyle = titleColor;
    ctx.fillRect(cardX + 28 * s, cardY + 66 * s, cardW - 56 * s, 1.5);

    const mid = cssWidth * 0.5;
    drawText(title, mid, cardY + 48 * s, titleColor, { size: 25, align: 'center' });
    let y = cardY + 98 * s;
    for (const line of lines) {
      drawText(line.text, mid, y, line.color, { size: line.size ?? 12, align: 'center', bold: line.bold ?? false, alpha: line.alpha ?? 1 });
      y += 24 * s;
    }
    drawText(prompt.text, mid, cardY + cardH - 24 * s, prompt.color, { size: 14, align: 'center' });
  }

  function drawBriefing(world: WorldState): void {
    ctx.fillStyle = 'rgba(6, 7, 15, 0.7)';
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    const s = hudScale();
    const layout = briefingLayout(cssWidth, cssHeight);
    const { card } = layout;
    const mid = card.x + card.w * 0.5;
    ctx.fillStyle = 'rgba(11, 13, 24, 0.95)';
    ctx.fillRect(card.x, card.y, card.w, card.h);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 6;
    ctx.strokeRect(card.x, card.y, card.w, card.h);
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 2;
    ctx.strokeRect(card.x, card.y, card.w, card.h);
    drawText('SPACE WAR SQUADRONS', mid, card.y + 44 * s, AMBER, { size: 25, align: 'center' });
    ctx.fillStyle = AMBER;
    ctx.fillRect(card.x + 22 * s, card.y + 62 * s, card.w - 44 * s, 1.5);

    const selected = world.sortie.level;
    layout.missions.forEach(({ level, box }, i) => {
      const on = level === selected;
      ctx.fillStyle = on ? 'rgba(30, 24, 12, 0.95)' : 'rgba(11, 13, 24, 0.6)';
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeStyle = on ? GOLD : TRACK;
      ctx.lineWidth = on ? 2 : 1;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      drawText(`${i + 1}  ${LEVEL_PRESENTATION[level].title}`, box.x + box.w * 0.5, box.y + box.h * 0.5 + 4 * s, on ? GOLD : CREAM, {
        size: 11, align: 'center', alpha: on ? 1 : 0.6,
      });
    });

    const { title, objective } = LEVEL_PRESENTATION[selected];
    let y = layout.detailY;
    drawText(title, mid, y, GOLD, { size: 16, align: 'center' });
    y += 24 * s;
    drawText(objective, mid, y, CREAM, { size: 13, align: 'center' });
    y += 34 * s;
    const controls = [
      'MOUSE steer  ·  LMB cannons, fire hot for harder crits  ·  RMB / E lock-on missile',
      'W / S throttle, tap W at 100% for overdrive  ·  A / D roll  ·  hold C recharge shields',
      'T target  ·  ESC / P pause  ·  R restart  ·  M / N audio',
    ];
    for (const line of controls) {
      drawText(line, mid, y, HUD_PALETTE.warmWhite, { size: 10, align: 'center', bold: false, alpha: 0.75 });
      y += 17 * s;
    }
    drawText('1 2 3 OR CLICK A MISSION  ·  ENTER OR CLICK TO LAUNCH', mid, card.y + card.h - 20 * s, CREAM, { size: 13, align: 'center' });
    briefingShown = { level: selected, title, objective };
  }

  function levelAt(world: WorldState, clientX: number, clientY: number): LevelId | null {
    if (world.phase.kind !== 'briefing') return null;
    const rect = canvas.getBoundingClientRect();
    return briefingLevelAt(briefingLayout(cssWidth, cssHeight), clientX - rect.left, clientY - rect.top);
  }

  function drawOverlay(world: WorldState): void {
    const phase = world.phase;
    const cream = CREAM;
    if (phase.kind === 'briefing') {
      drawBriefing(world);
    } else if (phase.kind === 'paused') {
      drawCard('SORTIE PAUSED', AMBER, [
        {
          text: world.sortie.level === 'planetary'
            ? `Flight time ${phase.elapsedSeconds.toFixed(1)}s  ·  Hostiles left ${world.enemies.length + (world.planetary?.groundTargets.filter((t) => t.hull > 0).length ?? 0)}`
            : `Flight time ${phase.elapsedSeconds.toFixed(1)}s  ·  Raiders left ${world.enemies.length}`,
          color: cream,
          size: 13,
        },
        { text: 'ESC / P / ENTER or click to resume  ·  R restart', color: HUD_PALETTE.warmWhite },
        { text: 'M mute all  ·  N toggle soundtrack', color: AMBER },
      ], { text: 'CLICK OR PRESS ESC TO RESUME', color: cream });
    } else if (phase.kind === 'victory') {
      drawCard('SORTIE COMPLETE', GOLD, [
        {
          text: world.sortie.level === 'trench'
            ? `Hostiles down ${phase.enemiesDestroyed}  ·  Conduit cores dark ${phase.reactorsDestroyed}`
            : world.sortie.level === 'planetary'
            ? `Ground targets ${phase.subsystemsDestroyed}  ·  Air kills ${phase.enemiesDestroyed}`
            : `Raiders down ${phase.enemiesDestroyed}  ·  Cores neutralized ${phase.subsystemsDestroyed}`,
          color: cream,
          size: 14,
        },
        { text: `Flight time ${phase.elapsedSeconds.toFixed(1)}s`, color: cream, size: 14 },
      ], { text: 'R OR ENTER TO FLY AGAIN  ·  B BRIEFING', color: cream });
    } else if (phase.kind === 'failed') {
      drawCard('SORTIE FAILED', AMBER, [{ text: phase.reason, color: cream, size: 14 }], {
        text: 'R OR ENTER TO RETRY  ·  B BRIEFING',
        color: cream,
      });
    }
  }

  // Tints the canopy edge and leaves the middle of the view clear.
  function drawEdgeFlash(rgb: string, alpha: number): void {
    const glow = ctx.createRadialGradient(
      cssWidth * 0.5, cssHeight * 0.5, cssHeight * 0.32,
      cssWidth * 0.5, cssHeight * 0.5, Math.hypot(cssWidth, cssHeight) * 0.55,
    );
    glow.addColorStop(0, `rgba(${rgb}, 0)`);
    glow.addColorStop(1, `rgba(${rgb}, ${clamp(alpha, 0, 1)})`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  function showHitMarker(style: HitMarkerStyle, tick: number): void {
    if (hitMarker === null || style.rank >= hitMarker.style.rank) {
      hitMarker = { style, bornTick: tick };
    }
  }

  function readEvents(world: WorldState): void {
    const tick = world.tick;
    if (tick < lastHudTick) {
      hitMarker = null;
      shieldDownUntil = 0;
      supply = null;
      threats = [];
      overheatSince = null;
      hullLowSince = null;
      proximitySince = null;
      pullUpSince = null;
    } else if (tick > lastHudTick) {
      if (hitMarker !== null && tick - hitMarker.bornTick >= hitMarker.style.ticks) hitMarker = null;
      if (supply !== null && tick >= supply.untilTick) supply = null;
      threats = threats.filter((threat) => tick < threat.untilTick);
      for (const evt of world.events) {
        if (evt.kind === 'subsystem_destroyed' || evt.kind === 'ground_target_destroyed') {
          showHitMarker(HIT_MARKERS.objective, tick);
        } else if (evt.kind === 'shield_broken' && evt.attackerId === 'player') {
          showHitMarker(HIT_MARKERS.shield, tick);
          shieldDownUntil = tick + SHIELD_DOWN_TICKS;
        } else if (evt.kind === 'hit_confirmed') {
          showHitMarker(evt.isKill ? HIT_MARKERS.kill : evt.shieldHit === true ? HIT_MARKERS.shield : HIT_MARKERS.hit, tick);
        } else if (evt.kind === 'crit_hit') {
          showHitMarker(HIT_MARKERS.crit, tick);
        } else if (evt.kind === 'supply_drop') {
          supply = { drop: evt.drop, untilTick: tick + SUPPLY_TICKS };
        } else if (evt.kind === 'incoming_fire') {
          threats = [...threats, { position: evt.position, untilTick: tick + THREAT_TICKS }].slice(-MAX_THREATS);
        }
      }
    }
    const p = world.player;
    overheatSince = p.energy.weaponState === 'overheated' ? (overheatSince ?? tick) : null;
    hullLowSince = p.hull > 0 && p.hull <= p.maxHull * HULL_CRITICAL_FRACTION ? (hullLowSince ?? tick) : null;
    proximitySince = p.proximityWarning ? (proximitySince ?? tick) : null;
    pullUpSince = world.planetary?.terrainWarning === true ? (pullUpSince ?? tick) : null;
    lastHudTick = tick;
  }

  function render(world: WorldState, project: Project, audioMuted: boolean, musicEnabled: boolean): void {
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    briefingShown = null;
    readEvents(world);

    if (world.player.hitFlash > 0.01) {
      drawEdgeFlash('255, 65, 85', world.player.hitFlash * 0.6);
    } else if (hullLowSince !== null && world.phase.kind === 'active') {
      // A slow red breath at the canopy edge, in step with the alarm, so low hull reads without a glance at the dash.
      const breath = 0.5 - 0.5 * Math.cos(((world.tick - hullLowSince) / (HULL_ALARM_INTERVAL_SECONDS * 60)) * Math.PI * 2);
      drawEdgeFlash('255, 65, 85', 0.08 + breath * 0.16);
    }

    const solution = playerFireSolution(world);
    const reticle = reticlePoint(solution, project, cssWidth, cssHeight);
    const bracket = drawTargets(world, project, reticle, solution);
    drawReticle(world, project, reticle, bracket);
    drawTopStrip(world);
    drawDash(world, audioMuted, musicEnabled);
    drawOverlay(world);
  }

  return { resize, render, levelAt, drawnBriefing: () => briefingShown };
}
