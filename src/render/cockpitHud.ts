import {
  computePlayerFireSolution,
  findTargetContact,
  listHostileContacts,
  subsystemWorldPosition,
  type PlayerFireSolution,
} from '../sim/combat';
import { add, clamp, distance, dot, forwardOf, len, rightOf, scale, sub, upOf } from '../sim/math';
import type { Vec3, WorldState } from '../sim/types';
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
  const selected = findTargetContact(world.player.selectedTargetId, world.enemies, world.hostileFrigate);
  return computePlayerFireSolution(world.player, selected);
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

export interface CockpitHud {
  readonly resize: (width: number, height: number) => void;
  readonly render: (
    world: WorldState,
    project: Project,
    audioMuted: boolean,
    musicEnabled: boolean,
  ) => void;
}

// One hue per meaning: cyan shields and friends, amber guns and heat, emerald hull and lead, crimson hostiles.
const AMBER = HUD_PALETTE.amber;
const CYAN = HUD_PALETTE.cyan;
const CRIMSON = HUD_PALETTE.crimson;
const EMERALD = HUD_PALETTE.emerald;
const GOLD = HUD_PALETTE.boostGold;
const INK = HUD_PALETTE.inkStroke;
const TRACK = 'rgba(255, 255, 255, 0.16)';
const FONT = '"JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, Consolas, "Courier New", monospace';
const RADAR_RADIUS = 38;
const RADAR_RANGE = 760;
const BOTTOM_SAFE_HEIGHT = 104;
const RETICLE_ARC_RADIUS = 46;
const RETICLE_ARC_SPAN = 0.72;

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
  let hitMarkerAlpha = 0;
  let hitMarkerColor: string = GOLD;
  let hitMarkerHeavy = false;
  let shieldBreakAlpha = 0;
  let nearMissAlpha = 0;
  let resupplyAlpha = 0;

  function hudScale(): number {
    return clamp(cssHeight / 720, 0.85, 1.45);
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

  function strokeInked(path: Path2D, color: string, width: number, alpha = 1): void {
    ctx.globalAlpha = alpha * 0.7;
    ctx.strokeStyle = INK;
    ctx.lineWidth = width + 2.4;
    ctx.stroke(path);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke(path);
    ctx.globalAlpha = 1;
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
    ctx.fillStyle = color;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(-6, -6);
    ctx.lineTo(-3.5, 0);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
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

  function statusLine(world: WorldState): { readonly text: string; readonly color: string; readonly alpha: number } | null {
    if (world.player.energy.weaponState === 'overheated') {
      return { text: 'OVERHEAT', color: CRIMSON, alpha: 1 };
    }
    if (resupplyAlpha > 0.05) {
      return { text: 'RESUPPLY', color: EMERALD, alpha: clamp(resupplyAlpha * 2, 0, 1) };
    }
    if (world.player.energy.overdrive) {
      return { text: 'OVERDRIVE', color: GOLD, alpha: 1 };
    }
    if (shieldBreakAlpha > 0.05) {
      return { text: 'SHIELD DOWN', color: CYAN, alpha: clamp(shieldBreakAlpha, 0, 1) };
    }
    return null;
  }

  function drawReticle(world: WorldState, project: Project, reticle: ScreenPoint, bracket: Rect | null): void {
    const { x: cx, y: cy } = reticle;
    const p = world.player;
    const s = hudScale();
    const overdrive = p.energy.overdrive;
    const overheated = p.energy.weaponState === 'overheated';
    const tone = overheated ? CRIMSON : overdrive ? GOLD : AMBER;

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
    strokeInked(cross, tone, 1.6);
    ctx.fillStyle = INK;
    ctx.fillRect(cx - 2.5, cy - 2.5, 5, 5);
    ctx.fillStyle = tone;
    ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);

    if (hitMarkerAlpha > 0.02) {
      const inner = (6 + (1 - hitMarkerAlpha) * 3) * s;
      const outer = (14 + (1 - hitMarkerAlpha) * 5 + (hitMarkerHeavy ? 3 : 0)) * s;
      const marker = new Path2D();
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        marker.moveTo(cx + sx * outer, cy + sy * outer);
        marker.lineTo(cx + sx * inner, cy + sy * inner);
      }
      strokeInked(marker, hitMarkerColor, hitMarkerHeavy ? 2.4 : 1.9, clamp(hitMarkerAlpha, 0, 1));
    }

    // Both arcs fill upward from the bottom: shields on the left, gun charge on the right.
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
    ctx.strokeStyle = shield < 0.25 ? CRIMSON : CYAN;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, leftBottom, leftBottom + sweep * shield);
    ctx.stroke();
    const charge = clamp(p.energy.weaponCharge / 100, 0, 1);
    ctx.strokeStyle = overheated ? CRIMSON : charge < 0.25 ? HUD_PALETTE.missileOrange : AMBER;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, rightBottom - sweep * charge, rightBottom);
    ctx.stroke();

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
    const status = statusLine(world);
    if (status !== null) {
      const above = cy - radius - 9 * s;
      const crowded = bracket !== null && bracket.top < above + 4 && bracket.bottom > above - 14 * s
        && bracket.left < cx + 60 * s && bracket.right > cx - 60 * s;
      drawText(status.text, cx, crowded ? pipY + 20 * s : above, status.color, { size: 10, align: 'center', alpha: status.alpha });
    }

    // Drift marker: only drawn once the flight path has slid away from the nose, so the centre stays clear.
    const drift = project(add(p.position, scale(p.velocity, 3)), cssWidth, cssHeight);
    if (inCanopy(drift) && Math.hypot(drift.x - cx, drift.y - cy) > radius * 0.5) {
      const marker = new Path2D();
      marker.arc(drift.x, drift.y, 5, 0, Math.PI * 2);
      marker.moveTo(drift.x - 10, drift.y);
      marker.lineTo(drift.x - 5, drift.y);
      marker.moveTo(drift.x + 5, drift.y);
      marker.lineTo(drift.x + 10, drift.y);
      strokeInked(marker, overdrive ? GOLD : CYAN, 1.3, 0.7);
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

    for (const contact of listHostileContacts(world.enemies, world.hostileFrigate)) {
      const projected = project(contact.position, cssWidth, cssHeight);
      const isSelected = contact.id === selectedId;
      const label = `${contact.label} ${Math.round(distance(world.player.position, contact.position))}M`;
      if (!inCanopy(projected)) {
        if (isSelected) drawEdgeChevron(projected, CRIMSON, label);
        continue;
      }
      const { x, y } = projected;

      if (!isSelected) {
        const size = 6 * s;
        const diamond = new Path2D();
        diamond.moveTo(x, y - size);
        diamond.lineTo(x + size, y);
        diamond.lineTo(x, y + size);
        diamond.lineTo(x - size, y);
        diamond.closePath();
        strokeInked(diamond, CRIMSON, 1.2, 0.6);
        continue;
      }

      const lock = world.player.lockState;
      const acquiring = lock.kind === 'acquiring' && lock.targetId === contact.id;
      const locked = lock.kind === 'locked' && lock.targetId === contact.id;
      const half = (acquiring ? 30 - lock.progress * 9 : locked ? 19 : 22) * s;
      strokeInked(bracketPath(x, y, half), acquiring ? AMBER : CRIMSON, locked ? 2.4 : 1.7);
      selectedBracket = { left: x - half, right: x + half, top: y - half, bottom: y + half };

      // The pip is the same lead point the guns' fire solution uses.
      const leadProjected = solution.leadPoint === null ? null : project(solution.leadPoint, cssWidth, cssHeight);
      const lead =
        leadProjected !== null && inCanopy(leadProjected) && Math.hypot(leadProjected.x - x, leadProjected.y - y) > 12
          ? leadProjected
          : null;

      // The label takes the first slot around the bracket that is clear of the reticle cluster and the lead pip;
      // with the target dead in the sights it steps just outside the cluster instead.
      const text = locked ? `${label} · LOCK` : label;
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
        { x: x - width * 0.5, y: y - half - 7 * s },
      ];
      const isClear = (slot: ScreenPoint): boolean =>
        slot.x >= 8 && slot.x + width <= cssWidth - 8 && obstacles.every((box) =>
          slot.x >= box.right || slot.x + width <= box.left || slot.y - 11 * s >= box.bottom || slot.y + 3 * s <= box.top);
      const slot = slots.find(isClear)
        ?? { x: x >= reticle.x ? cluster.right + 6 : cluster.left - 6 - width, y: beside };
      drawText(text, slot.x, slot.y, CRIMSON);

      const barW = 36 * s;
      const barX = x - barW * 0.5;
      const barY = y + half + 6;
      const enemy = contact.kind === 'enemy' ? world.enemies.find((e) => e.id === contact.id) : undefined;
      if (enemy !== undefined) {
        if (enemy.maxShields > 0) {
          drawBar(barX, barY, barW, 3, enemy.shields / enemy.maxShields, CYAN);
        }
        drawBar(barX, barY + 6, barW, 3, enemy.hull / enemy.maxHull, enemy.hull < enemy.maxHull * 0.35 ? CRIMSON : EMERALD);
      } else {
        const subsystem = world.hostileFrigate.subsystems.find((sub) => sub.id === contact.id);
        if (subsystem !== undefined) {
          drawBar(barX, barY, barW, 4, subsystem.hull / subsystem.maxHull, CRIMSON);
        }
      }

      if (lead === null) continue;
      const onSolution = Math.hypot(lead.x - reticle.x, lead.y - reticle.y) < 16;
      const pipColor = onSolution ? GOLD : EMERALD;

      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = pipColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(lead.x, lead.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      const pip = new Path2D();
      pip.arc(lead.x, lead.y, 7 * s, 0, Math.PI * 2);
      strokeInked(pip, pipColor, onSolution ? 2.2 : 1.8);
      ctx.fillStyle = pipColor;
      ctx.fillRect(lead.x - 1.5, lead.y - 1.5, 3, 3);
    }

    const wingmate = project(world.wingmate.position, cssWidth, cssHeight);
    if (inCanopy(wingmate)) {
      const caret = new Path2D();
      caret.moveTo(wingmate.x - 5 * s, wingmate.y - 16 * s);
      caret.lineTo(wingmate.x, wingmate.y - 10 * s);
      caret.lineTo(wingmate.x + 5 * s, wingmate.y - 16 * s);
      strokeInked(caret, CYAN, 1.5);
      drawText(world.wingmate.callsign, wingmate.x, wingmate.y - 21 * s, CYAN, { size: 9, align: 'center', alpha: 0.85 });
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
    strokeInked(rim, AMBER, 1.3, 0.7);

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

    drawBlip(world.friendlyCarrier.position, AMBER, 3, 'square');
    drawBlip(world.hostileFrigate.position, HUD_PALETTE.frigateOrange, 3, 'square');
    drawBlip(world.wingmate.position, CYAN, 2.2);

    const selectedId = world.player.selectedTargetId;
    let selectedPos: Vec3 | null = null;
    for (const enemy of world.enemies) {
      if (enemy.id === selectedId) {
        selectedPos = enemy.position;
      } else {
        drawBlip(enemy.position, CRIMSON, 2.2);
      }
    }
    for (const subsystem of world.hostileFrigate.subsystems) {
      if (subsystem.hull <= 0) continue;
      const pos = subsystemWorldPosition(world.hostileFrigate, subsystem);
      if (subsystem.id === selectedId) {
        selectedPos = pos;
      } else {
        drawBlip(pos, HUD_PALETTE.subsystemMagenta, 2);
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
    drawText('M/S', leftX + barW, radarY + 2 * s, overdrive ? GOLD : AMBER, { size: 9, align: 'right', alpha: 0.8 });
    drawText(speed, leftX + barW - 26 * s, radarY + 2 * s, overdrive ? GOLD : HUD_PALETTE.warmWhite, { size: 19, align: 'right' });

    // Throttle spans 0..120% with a tick at the 100% detent.
    const throttleY = radarY + 12 * s;
    drawBar(leftX, throttleY, barW, 5, p.throttle / 1.2, overdrive ? GOLD : AMBER, true);
    ctx.fillStyle = HUD_PALETTE.warmWhite;
    ctx.fillRect(leftX + barW * (1 - 1 / 1.2) - 0.5, throttleY - 2, 1.5, 9);
    if (!overdrive && p.throttle >= 0.995) {
      drawText('TAP W · OVERDRIVE', leftX + barW, throttleY + 20 * s, GOLD, { size: 9, align: 'right', alpha: 0.8 });
    }

    const hullColor = p.hull < p.maxHull * 0.35 ? CRIMSON : EMERALD;
    drawBar(rightX, radarY - 11 * s, barW, 6, p.energy.shieldCharge / 100, CYAN);
    drawBar(rightX, radarY + 4 * s, barW, 6, p.hull / p.maxHull, hullColor);
    drawText('SHD', rightX + barW + 7, radarY - 11 * s + 7, CYAN, { size: 9 });
    drawText('HUL', rightX + barW + 7, radarY + 4 * s + 7, hullColor, { size: 9 });

    if (p.proximityWarning) {
      drawText('PROXIMITY', cx, radarY - radarRadius - 10 * s, CRIMSON, { size: 10, align: 'center' });
    }

    // Audio is only mentioned when it is not in its default state.
    const audioNote = audioMuted ? 'MUTED · M' : musicEnabled ? null : 'MUSIC OFF · N';
    if (audioNote !== null) {
      drawText(audioNote, cssWidth - 18, cssHeight - 14, HUD_PALETTE.cream, { size: 9, align: 'right', alpha: 0.6 });
    }
  }

  function drawTopStrip(world: WorldState): void {
    const cores = world.hostileFrigate.subsystems.filter((sub) => sub.hull > 0).length;
    const s = hudScale();
    drawText(`RAIDERS ${world.enemies.length}`, 18, 26 * s, AMBER);
    drawText(`CORES ${cores}`, 18 + textWidth(`RAIDERS ${world.enemies.length}`) + 14 * s, 26 * s, HUD_PALETTE.frigateOrange);
    const carrier = world.friendlyCarrier.hull / world.friendlyCarrier.maxHull;
    drawBar(18, 34 * s, 128 * s, 4, carrier, carrier < 0.35 ? CRIMSON : CYAN);
    drawText('HEARTHSTONE', 18 + 128 * s + 8, 34 * s + 6, CYAN, { size: 9, alpha: 0.85 });

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
  }

  function drawCard(title: string, titleColor: string, lines: readonly CardLine[], prompt: CardLine): void {
    ctx.fillStyle = 'rgba(6, 7, 15, 0.7)';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const s = hudScale();
    const cardW = Math.min(560 * s, cssWidth - 40);
    const cardH = 236 * s;
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
      drawText(line.text, mid, y, line.color, { size: line.size ?? 12, align: 'center', bold: line.bold ?? false });
      y += 24 * s;
    }
    drawText(prompt.text, mid, cardY + cardH - 24 * s, prompt.color, { size: 14, align: 'center' });
  }

  function drawOverlay(world: WorldState): void {
    const phase = world.phase;
    const cream = HUD_PALETTE.cream;
    if (phase.kind === 'briefing') {
      drawCard('SPACE WAR SQUADRONS', AMBER, [
        { text: 'Defend Hearthstone. Destroy the raiders and both frigate cores.', color: cream, size: 13 },
        { text: 'MOUSE steer  ·  LMB cannons, watch the heat  ·  RMB / E lock-on missile', color: HUD_PALETTE.warmWhite },
        { text: 'W / S throttle, tap W at 100% for overdrive  ·  A / D roll', color: CYAN },
        { text: 'T target  ·  ESC / P pause  ·  R restart  ·  M / N audio', color: AMBER },
      ], { text: 'PRESS ENTER OR CLICK TO LAUNCH', color: EMERALD });
    } else if (phase.kind === 'paused') {
      drawCard('SORTIE PAUSED', AMBER, [
        { text: `Flight time ${phase.elapsedSeconds.toFixed(1)}s  ·  Raiders left ${world.enemies.length}`, color: cream, size: 13 },
        { text: 'ESC / P / ENTER or click to resume  ·  R restart', color: CYAN },
        { text: 'M mute all  ·  N toggle soundtrack', color: AMBER },
      ], { text: 'CLICK OR PRESS ESC TO RESUME', color: EMERALD });
    } else if (phase.kind === 'victory') {
      drawCard('SORTIE COMPLETE', EMERALD, [
        { text: `Raiders down ${phase.enemiesDestroyed}  ·  Cores neutralized ${phase.subsystemsDestroyed}`, color: cream, size: 14 },
        { text: `Flight time ${phase.elapsedSeconds.toFixed(1)}s`, color: cream, size: 14 },
      ], { text: 'PRESS R OR ENTER TO FLY AGAIN', color: AMBER });
    } else if (phase.kind === 'failed') {
      drawCard('SORTIE FAILED', CRIMSON, [{ text: phase.reason, color: cream, size: 14 }], {
        text: 'PRESS R OR ENTER FOR INSTANT RETRY',
        color: AMBER,
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

  function readEvents(world: WorldState): void {
    if (world.tick < lastHudTick) {
      hitMarkerAlpha = 0;
      shieldBreakAlpha = 0;
      nearMissAlpha = 0;
      resupplyAlpha = 0;
    } else if (world.tick > lastHudTick) {
      const ticks = Math.min(world.tick - lastHudTick, 10);
      hitMarkerAlpha = Math.max(0, hitMarkerAlpha - ticks * 0.09);
      shieldBreakAlpha = Math.max(0, shieldBreakAlpha - ticks * 0.025);
      nearMissAlpha = Math.max(0, nearMissAlpha - ticks * 0.12);
      resupplyAlpha = Math.max(0, resupplyAlpha - ticks * 0.012);
      for (const evt of world.events) {
        // Widened on purpose: the sim may gain event kinds this build does not know yet.
        const kind: string = evt.kind;
        if (evt.kind === 'subsystem_destroyed') {
          hitMarkerAlpha = 1;
          hitMarkerColor = CRIMSON;
          hitMarkerHeavy = true;
        } else if (evt.kind === 'shield_broken') {
          hitMarkerAlpha = 1;
          hitMarkerColor = CYAN;
          hitMarkerHeavy = false;
          shieldBreakAlpha = 1;
        } else if (evt.kind === 'hit_confirmed') {
          hitMarkerAlpha = 1;
          hitMarkerColor = evt.isKill ? CRIMSON : evt.shieldHit === true ? CYAN : GOLD;
          hitMarkerHeavy = evt.isKill;
        } else if (kind === 'crit_hit') {
          hitMarkerAlpha = 1;
          hitMarkerColor = HUD_PALETTE.warmWhite;
          hitMarkerHeavy = true;
        } else if (kind === 'near_miss') {
          nearMissAlpha = 1;
        } else if (kind === 'supply_drop') {
          resupplyAlpha = 1;
        }
      }
    }
    lastHudTick = world.tick;
  }

  function render(world: WorldState, project: Project, audioMuted: boolean, musicEnabled: boolean): void {
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    readEvents(world);

    if (world.player.hitFlash > 0.01) {
      drawEdgeFlash('255, 65, 85', world.player.hitFlash * 0.6);
    }
    if (nearMissAlpha > 0.02) {
      drawEdgeFlash('244, 180, 89', nearMissAlpha * 0.22);
    }

    const solution = playerFireSolution(world);
    const reticle = reticlePoint(solution, project, cssWidth, cssHeight);
    const bracket = drawTargets(world, project, reticle, solution);
    drawReticle(world, project, reticle, bracket);
    drawTopStrip(world);
    drawDash(world, audioMuted, musicEnabled);
    drawOverlay(world);
  }

  return { resize, render };
}
