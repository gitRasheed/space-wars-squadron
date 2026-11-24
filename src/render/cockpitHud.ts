import {
  COMBAT_TUNING,
  computePlayerFireSolution,
  findTargetContact,
  listHostileContacts,
  subsystemWorldPosition,
} from '../sim/combat';
import {
  add,
  clamp,
  computeLeadPoint,
  distance,
  dot,
  forwardOf,
  len,
  rightOf,
  scale,
  sub,
  upOf,
} from '../sim/math';
import type { Vec3, WorldState } from '../sim/types';
import { HUD_PALETTE } from './palette';
import type { ProjectedPoint } from './sceneRenderer';

export function computeHudReticlePoint(
  world: WorldState,
  project: (point: Vec3, width: number, height: number) => ProjectedPoint,
  width: number,
  height: number,
): { readonly x: number; readonly y: number } {
  const selected = findTargetContact(
    world.player.selectedTargetId,
    world.enemies,
    world.hostileFrigate,
  );
  const solution = computePlayerFireSolution(world.player, selected);
  const projected = project(solution.convergencePoint, width, height);
  if (!projected.inFront) {
    return { x: width * 0.5, y: height * 0.5 };
  }
  return { x: projected.x, y: projected.y };
}

export interface CockpitHud {
  readonly resize: (width: number, height: number) => void;
  readonly render: (
    world: WorldState,
    project: (point: Vec3, width: number, height: number) => ProjectedPoint,
    audioMuted: boolean,
    musicEnabled: boolean,
  ) => void;
}

const AMBER = HUD_PALETTE.amber;
const CYAN = HUD_PALETTE.cyan;
const CRIMSON = HUD_PALETTE.crimson;
const EMERALD = HUD_PALETTE.emerald;
const LABEL_BG = HUD_PALETTE.labelBg;
const RADAR_RADIUS = 38;
const BOTTOM_SAFE_HEIGHT = 104;

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
  let hitMarkerKill = false;
  let hitMarkerShield = false;
  let shieldBreakBannerAlpha = 0;

  function hudScale(): number {
    return clamp(cssHeight / 720, 0.85, 1.45);
  }

  function canopyBounds(): {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  } {
    const s = hudScale();
    return {
      left: 34,
      right: cssWidth - 34,
      top: 56,
      bottom: cssHeight - Math.round(BOTTOM_SAFE_HEIGHT * s) - 16,
    };
  }

  function resize(width: number, height: number): void {
    cssWidth = Math.max(1, width);
    cssHeight = Math.max(1, height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawPillLabel(
    text: string,
    x: number,
    y: number,
    color: string,
    align: 'left' | 'right' | 'center' = 'left',
  ): void {
    ctx.font = 'bold 11px "Courier New", monospace';
    const textWidth = ctx.measureText(text).width;
    const padX = 5;
    const boxW = textWidth + padX * 2;
    const boxH = 16;
    const boxX = align === 'left' ? x : align === 'right' ? x - boxW : x - boxW * 0.5;
    const boxY = y - 12;

    ctx.fillStyle = LABEL_BG;
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(text, boxX + padX, y);
  }

  function drawEdgeChevron(
    projected: ProjectedPoint,
    color: string,
    label: string | null,
  ): void {
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
    const scaleX = Math.abs(cos) > 1e-4 ? halfW / Math.abs(cos) : Infinity;
    const scaleY = Math.abs(sin) > 1e-4 ? halfH / Math.abs(sin) : Infinity;
    const dist = Math.min(scaleX, scaleY);
    const edgeX = cx + cos * dist;
    const edgeY = cy + sin * dist;

    ctx.save();
    ctx.translate(edgeX, edgeY);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.strokeStyle = '#070812';
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

    if (label !== null) {
      const labelAlign = edgeX > cssWidth * 0.65 ? 'right' : edgeX < cssWidth * 0.35 ? 'left' : 'center';
      const offsetX = labelAlign === 'right' ? -15 : labelAlign === 'left' ? 15 : 0;
      const offsetY = edgeY > bounds.bottom - 26 ? -12 : 4;
      drawPillLabel(label, edgeX + offsetX, edgeY + offsetY, color, labelAlign);
    }
  }

  function resolveReticleScreenPos(
    world: WorldState,
    project: (point: Vec3, width: number, height: number) => ProjectedPoint,
  ): { readonly x: number; readonly y: number } {
    return computeHudReticlePoint(world, project, cssWidth, cssHeight);
  }

  function drawReticleCluster(
    world: WorldState,
    project: (point: Vec3, width: number, height: number) => ProjectedPoint,
    reticle: { readonly x: number; readonly y: number },
  ): void {
    const cx = reticle.x;
    const cy = reticle.y;
    const p = world.player;
    const overdrive = p.energy.overdrive;
    const overheated = p.energy.weaponState === 'overheated';

    const s = hudScale();
    ctx.strokeStyle = overheated
      ? 'rgba(255, 77, 99, 0.85)'
      : overdrive
        ? HUD_PALETTE.boostGold
        : 'rgba(244, 180, 89, 0.88)';
    ctx.lineWidth = 1.5;

    const gap = 8 * s;
    const arm = 10 * s;
    ctx.beginPath();
    ctx.moveTo(cx - gap - arm, cy);
    ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy);
    ctx.lineTo(cx + gap + arm, cy);
    ctx.moveTo(cx, cy - gap - arm);
    ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap);
    ctx.lineTo(cx, cy + gap + arm);
    ctx.stroke();

    ctx.fillStyle = overheated ? CRIMSON : overdrive ? HUD_PALETTE.boostGold : AMBER;
    ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);

    if (hitMarkerAlpha > 0.02) {
      const inner = (6 + (1 - hitMarkerAlpha) * 3) * s;
      const outer = (14 + (1 - hitMarkerAlpha) * 5) * s;
      ctx.save();
      ctx.globalAlpha = clamp(hitMarkerAlpha, 0, 1);
      ctx.strokeStyle = hitMarkerKill ? CRIMSON : hitMarkerShield ? CYAN : HUD_PALETTE.boostGold;
      ctx.lineWidth = hitMarkerKill ? 2.4 : 1.9;
      ctx.beginPath();
      ctx.moveTo(cx - outer, cy - outer);
      ctx.lineTo(cx - inner, cy - inner);
      ctx.moveTo(cx + outer, cy - outer);
      ctx.lineTo(cx + inner, cy - inner);
      ctx.moveTo(cx - outer, cy + outer);
      ctx.lineTo(cx - inner, cy + inner);
      ctx.moveTo(cx + outer, cy + outer);
      ctx.lineTo(cx + inner, cy + inner);
      ctx.stroke();
      ctx.restore();
    }

    const arcRadius = 46 * s;
    const arcSpan = 0.72;
    const leftStart = Math.PI - arcSpan;
    const leftEnd = Math.PI + arcSpan;
    const rightStart = -arcSpan;
    const rightEnd = arcSpan;

    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, leftStart, leftEnd);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, rightStart, rightEnd);
    ctx.stroke();

    const shdRatio = clamp(p.energy.shieldCharge / 100, 0, 1);
    const shdColor = overdrive
      ? HUD_PALETTE.boostGold
      : shdRatio < 0.25
        ? CRIMSON
        : 'rgba(107, 229, 255, 0.85)';
    ctx.strokeStyle = shdColor;
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, leftEnd - (leftEnd - leftStart) * shdRatio, leftEnd);
    ctx.stroke();

    const wpnRatio = clamp(p.energy.weaponCharge / 100, 0, 1);
    ctx.strokeStyle = overheated
      ? CRIMSON
      : wpnRatio < 0.25
        ? HUD_PALETTE.missileOrange
        : 'rgba(244, 180, 89, 0.85)';
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, rightEnd - (rightEnd - rightStart) * wpnRatio, rightEnd);
    ctx.stroke();

    const pipW = 8;
    const pipGap = 4;
    const totalW = p.maxMissiles * pipW + (p.maxMissiles - 1) * pipGap;
    const pipStartX = cx - totalW * 0.5;
    const pipY = cy + arcRadius + 8;
    for (let i = 0; i < p.maxMissiles; i += 1) {
      ctx.fillStyle = i < p.missilesReady ? HUD_PALETTE.missileOrange : 'rgba(255, 255, 255, 0.16)';
      ctx.fillRect(pipStartX + i * (pipW + pipGap), pipY, pipW, 3);
    }

    if (overheated) {
      ctx.font = 'bold 10px "Courier New", monospace';
      ctx.fillStyle = CRIMSON;
      ctx.textAlign = 'center';
      ctx.fillText('OVERHEAT', cx, cy - arcRadius - 8);
    } else if (overdrive) {
      ctx.font = 'bold 10px "Courier New", monospace';
      ctx.fillStyle = HUD_PALETTE.boostGold;
      ctx.textAlign = 'center';
      ctx.fillText('OVERDRIVE 120%', cx, cy - arcRadius - 8);
    } else if (shieldBreakBannerAlpha > 0.05) {
      ctx.save();
      ctx.globalAlpha = clamp(shieldBreakBannerAlpha, 0, 1);
      ctx.font = 'bold 10px "Courier New", monospace';
      ctx.fillStyle = CYAN;
      ctx.textAlign = 'center';
      ctx.fillText('SHIELD DOWN', cx, cy - arcRadius - 8);
      ctx.restore();
    }

    const bounds = canopyBounds();
    const velPoint = add(p.position, scale(p.velocity, 3));
    const projectedVel = project(velPoint, cssWidth, cssHeight);
    const inCanopy =
      projectedVel.inFront &&
      projectedVel.x >= bounds.left &&
      projectedVel.x <= bounds.right &&
      projectedVel.y >= bounds.top &&
      projectedVel.y <= bounds.bottom;

    if (inCanopy) {
      ctx.strokeStyle = overdrive ? HUD_PALETTE.boostGold : 'rgba(107, 229, 255, 0.52)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(projectedVel.x, projectedVel.y, 6, 0, Math.PI * 2);
      ctx.moveTo(projectedVel.x - 10, projectedVel.y);
      ctx.lineTo(projectedVel.x - 6, projectedVel.y);
      ctx.moveTo(projectedVel.x + 6, projectedVel.y);
      ctx.lineTo(projectedVel.x + 10, projectedVel.y);
      ctx.stroke();
    }
  }

  function drawLockCorners(x: number, y: number, half: number, color: string, lineWidth: number): void {
    const corner = 7;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x - half, y - half + corner);
    ctx.lineTo(x - half, y - half);
    ctx.lineTo(x - half + corner, y - half);

    ctx.moveTo(x + half - corner, y - half);
    ctx.lineTo(x + half, y - half);
    ctx.lineTo(x + half, y - half + corner);

    ctx.moveTo(x + half, y + half - corner);
    ctx.lineTo(x + half, y + half);
    ctx.lineTo(x + half - corner, y + half);

    ctx.moveTo(x - half + corner, y + half);
    ctx.lineTo(x - half, y + half);
    ctx.lineTo(x - half, y + half - corner);
    ctx.stroke();
  }

  function drawTargets(
    world: WorldState,
    project: (point: Vec3, width: number, height: number) => ProjectedPoint,
    reticle: { readonly x: number; readonly y: number },
  ): void {
    const contacts = listHostileContacts(world.enemies, world.hostileFrigate);
    const selectedId = world.player.selectedTargetId;
    const bounds = canopyBounds();

    for (const contact of contacts) {
      const projected = project(contact.position, cssWidth, cssHeight);
      const isSelected = contact.id === selectedId;
      const distMeters = Math.round(distance(world.player.position, contact.position));
      const inCanopy =
        projected.inFront &&
        projected.x >= bounds.left &&
        projected.x <= bounds.right &&
        projected.y >= bounds.top &&
        projected.y <= bounds.bottom;

      if (inCanopy) {
        if (!isSelected) {
          const size = 8;
          ctx.strokeStyle = 'rgba(255, 110, 96, 0.42)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(projected.x, projected.y - size);
          ctx.lineTo(projected.x + size, projected.y);
          ctx.lineTo(projected.x, projected.y + size);
          ctx.lineTo(projected.x - size, projected.y);
          ctx.closePath();
          ctx.stroke();
          continue;
        }

        const lock = world.player.lockState;
        const bracketHalf =
          lock.kind === 'acquiring' && lock.targetId === contact.id
            ? 30 - lock.progress * 9
            : lock.kind === 'locked' && lock.targetId === contact.id
              ? 19
              : 22;
        const bracketColor =
          lock.kind === 'acquiring' && lock.targetId === contact.id ? AMBER : CRIMSON;
        const bracketWidth =
          lock.kind === 'locked' && lock.targetId === contact.id ? 2.2 : 1.7;
        drawLockCorners(projected.x, projected.y, bracketHalf, bracketColor, bracketWidth);

        const labelAlign = projected.x > cssWidth * 0.55 ? 'right' : 'left';
        const labelX =
          labelAlign === 'right' ? projected.x - bracketHalf - 7 : projected.x + bracketHalf + 7;
        const lockSuffix = lock.kind === 'locked' && lock.targetId === contact.id ? ' [LOCK]' : '';
        drawPillLabel(
          `${contact.label} ${distMeters}M${lockSuffix}`,
          labelX,
          projected.y - 5,
          CRIMSON,
          labelAlign,
        );

        // Display real target entity shield + hull bars right beneath the lock bracket.
        const enemyEntity =
          contact.kind === 'enemy' ? world.enemies.find((e) => e.id === contact.id) : undefined;
        const barW = 36;
        const barX = projected.x - barW * 0.5;
        const barY = projected.y + bracketHalf + 6;
        if (enemyEntity !== undefined) {
          if (enemyEntity.maxShields > 0) {
            drawSegmentedBar(
              barX,
              barY,
              barW,
              3,
              enemyEntity.shields / enemyEntity.maxShields,
              enemyEntity.shields > 0 ? CYAN : 'rgba(107, 229, 255, 0.2)',
              false,
            );
          }
          drawSegmentedBar(
            barX,
            barY + 5,
            barW,
            3,
            enemyEntity.hull / enemyEntity.maxHull,
            enemyEntity.hull < enemyEntity.maxHull * 0.35 ? CRIMSON : EMERALD,
            false,
          );
        } else {
          const subEntity = world.hostileFrigate.subsystems.find((s) => s.id === contact.id);
          if (subEntity !== undefined) {
            drawSegmentedBar(barX, barY, barW, 4, subEntity.hull / subEntity.maxHull, CRIMSON, false);
          }
        }

        const lead = computeLeadPoint(
          world.player.position,
          world.player.velocity,
          contact.position,
          contact.velocity,
          COMBAT_TUNING.boltSpeed,
          COMBAT_TUNING.boltTtl,
        );
        if (lead === null) {
          continue;
        }
        const projLead = project(lead, cssWidth, cssHeight);
        const leadDist = Math.hypot(projLead.x - projected.x, projLead.y - projected.y);
        const leadInCanopy =
          projLead.inFront &&
          projLead.x >= bounds.left &&
          projLead.x <= bounds.right &&
          projLead.y >= bounds.top &&
          projLead.y <= bounds.bottom;

        if (leadInCanopy && leadDist > 12) {
          const onSolution = Math.hypot(projLead.x - reticle.x, projLead.y - reticle.y) < 16;
          const pipColor = onSolution ? HUD_PALETTE.boostGold : EMERALD;

          ctx.strokeStyle = 'rgba(244, 180, 89, 0.36)';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.moveTo(projected.x, projected.y);
          ctx.lineTo(projLead.x, projLead.y);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.strokeStyle = '#070812';
          ctx.lineWidth = 3.5;
          ctx.beginPath();
          ctx.arc(projLead.x, projLead.y, 7.5, 0, Math.PI * 2);
          ctx.stroke();

          ctx.strokeStyle = pipColor;
          ctx.lineWidth = onSolution ? 2.2 : 1.8;
          ctx.beginPath();
          ctx.arc(projLead.x, projLead.y, 7.5, 0, Math.PI * 2);
          ctx.stroke();

          ctx.fillStyle = pipColor;
          ctx.fillRect(projLead.x - 1.5, projLead.y - 1.5, 3, 3);
        }
      } else if (isSelected) {
        drawEdgeChevron(projected, CRIMSON, `${contact.label} ${distMeters}M`);
      }
    }

    const wingProj = project(world.wingmate.position, cssWidth, cssHeight);
    if (
      wingProj.inFront &&
      wingProj.x >= bounds.left &&
      wingProj.x <= bounds.right &&
      wingProj.y >= bounds.top &&
      wingProj.y <= bounds.bottom
    ) {
      ctx.strokeStyle = CYAN;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(wingProj.x - 7, wingProj.y - 7, 14, 14);
      drawPillLabel(world.wingmate.callsign, wingProj.x + 11, wingProj.y + 4, CYAN, 'left');
    }
  }

  function drawRadar(world: WorldState, cx: number, cy: number, radius: number): void {
    ctx.fillStyle = 'rgba(7, 10, 18, 0.68)';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(244, 180, 89, 0.45)';
    ctx.lineWidth = 1.25;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(244, 180, 89, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.52, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    const fwd = forwardOf(world.player.orientation);
    const right = rightOf(world.player.orientation);
    const up = upOf(world.player.orientation);
    const radarRange = 760;

    function drawBlip(pos: Vec3, color: string, size: number, isSquare = false, bracketed = false): void {
      const rel = sub(pos, world.player.position);
      const lx = dot(rel, right) / radarRange;
      const ly = dot(rel, up) / radarRange;
      const lz = dot(rel, fwd) / radarRange;
      const planarMag = Math.hypot(lx, lz);
      const scaleFactor = planarMag > 0.88 ? 0.88 / planarMag : 1;
      const bx = cx + lx * scaleFactor * radius;
      const by = cy - lz * scaleFactor * radius;
      const elev = clamp(ly * radius * 0.38, -14, 14);

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx, by - elev);
      ctx.stroke();

      ctx.fillStyle = color;
      if (isSquare) {
        ctx.fillRect(bx - size, by - elev - size, size * 2, size * 2);
      } else {
        ctx.beginPath();
        ctx.arc(bx, by - elev, size, 0, Math.PI * 2);
        ctx.fill();
      }
      if (bracketed) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.3;
        ctx.strokeRect(bx - 5, by - elev - 5, 10, 10);
      }
    }

    drawBlip(world.friendlyCarrier.position, AMBER, 3, true);
    drawBlip(world.hostileFrigate.position, HUD_PALETTE.frigateOrange, 3, true);
    drawBlip(world.wingmate.position, CYAN, 2.4);

    let selectedPos: Vec3 | null = null;
    for (const enemy of world.enemies) {
      if (enemy.id === world.player.selectedTargetId) {
        selectedPos = enemy.position;
      } else {
        drawBlip(enemy.position, CRIMSON, 2.2);
      }
    }
    for (const subsys of world.hostileFrigate.subsystems) {
      if (subsys.hull <= 0) {
        continue;
      }
      const pos = subsystemWorldPosition(world.hostileFrigate, subsys);
      if (subsys.id === world.player.selectedTargetId) {
        selectedPos = pos;
      } else {
        drawBlip(pos, HUD_PALETTE.subsystemMagenta, 2.2);
      }
    }
    if (selectedPos !== null) {
      drawBlip(selectedPos, '#ffffff', 2.6, false, true);
    }
  }

  function drawSegmentedBar(
    x: number,
    y: number,
    w: number,
    h: number,
    ratio: number,
    color: string,
    alignRight: boolean,
  ): void {
    const clamped = clamp(ratio, 0, 1);
    ctx.fillStyle = 'rgba(7, 10, 18, 0.65)';
    ctx.fillRect(x, y, w, h);

    const fillW = w * clamped;
    ctx.fillStyle = color;
    ctx.fillRect(alignRight ? x + (w - fillW) : x, y, fillW, h);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  function drawMinimalBottomHud(
    world: WorldState,
    audioMuted: boolean,
    musicEnabled: boolean,
  ): void {
    const s = hudScale();
    const radarRadius = Math.round(RADAR_RADIUS * s);
    const cx = cssWidth * 0.5;
    const radarY = cssHeight - radarRadius - 16;
    const p = world.player;

    drawRadar(world, cx, radarY, radarRadius);

    const barW = Math.round(108 * s);
    const leftBarX = cx - radarRadius - barW - 18;
    const rightBarX = cx + radarRadius + 18;

    const throttlePct = Math.round(p.throttle * 100);
    ctx.font = 'bold 19px "Courier New", monospace';
    ctx.fillStyle = p.energy.overdrive ? HUD_PALETTE.boostGold : HUD_PALETTE.warmWhite;
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(len(p.velocity))}`, leftBarX + barW, radarY - 4);
    ctx.font = 'bold 9px "Courier New", monospace';
    ctx.fillStyle = p.energy.overdrive ? HUD_PALETTE.boostGold : 'rgba(244, 180, 89, 0.72)';
    ctx.fillText(`M/S  ${throttlePct}%`, leftBarX + barW, radarY + 9);

    // Throttle bar spans 0..120%, with a visible 100% high-watermark detent tick.
    drawSegmentedBar(
      leftBarX,
      radarY + 18,
      barW,
      5,
      p.throttle / 1.2,
      p.energy.overdrive ? HUD_PALETTE.boostGold : AMBER,
      true,
    );
    const detentX = leftBarX + barW * (1 - 1 / 1.2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(detentX - 0.5, radarY + 16, 1.5, 9);

    drawSegmentedBar(
      rightBarX,
      radarY - 12,
      barW,
      7,
      p.energy.shieldCharge / 100,
      CYAN,
      false,
    );
    drawSegmentedBar(
      rightBarX,
      radarY + 2,
      barW,
      7,
      p.hull / p.maxHull,
      p.hull < 35 ? CRIMSON : EMERALD,
      false,
    );

    ctx.font = 'bold 9px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = CYAN;
    ctx.fillText('SHD', rightBarX + barW + 6, radarY - 5);
    ctx.fillStyle = p.hull < 35 ? CRIMSON : EMERALD;
    ctx.fillText('HUL', rightBarX + barW + 6, radarY + 9);

    const audioLabel = audioMuted ? 'MUTED' : musicEnabled ? 'SFX+BGM' : 'SFX';
    ctx.font = '10px "Courier New", monospace';
    ctx.fillStyle = 'rgba(216, 224, 245, 0.5)';
    ctx.textAlign = 'right';
    ctx.fillText(
      `[W@100%] OVERDRIVE  [ESC] PAUSE  [M] ${audioLabel}  [N] BGM`,
      cssWidth - 16,
      cssHeight - 14,
    );

    if (p.proximityWarning) {
      drawPillLabel('PROXIMITY', cx, radarY - radarRadius - 12, CRIMSON, 'center');
    }
  }

  function drawTopStrip(world: WorldState): void {
    const remainingSubsystems = world.hostileFrigate.subsystems.filter((s) => s.hull > 0).length;
    const carrierRatio = world.friendlyCarrier.hull / world.friendlyCarrier.maxHull;

    drawPillLabel(
      `RAIDERS ${world.enemies.length}  ·  CORES ${remainingSubsystems}`,
      16,
      26,
      AMBER,
      'left',
    );
    drawSegmentedBar(16, 34, 128, 4, carrierRatio, CYAN, false);
    ctx.font = 'bold 9px "Courier New", monospace';
    ctx.fillStyle = 'rgba(107, 229, 255, 0.78)';
    ctx.textAlign = 'left';
    ctx.fillText('HEARTHSTONE', 150, 39);

    if (world.radio !== null) {
      drawPillLabel(
        `${world.radio.speaker}: ${world.radio.text}`,
        cssWidth - 16,
        26,
        '#f2e6cf',
        'right',
      );
    }
  }

  function drawOverlay(world: WorldState): void {
    if (world.phase.kind === 'active') {
      return;
    }
    ctx.fillStyle = 'rgba(6, 7, 15, 0.68)';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const cardW = Math.min(540, cssWidth - 40);
    const cardH = 240;
    const cardX = (cssWidth - cardW) * 0.5;
    const cardY = (cssHeight - cardH) * 0.5;

    ctx.fillStyle = 'rgba(11, 13, 24, 0.94)';
    ctx.fillRect(cardX, cardY, cardW, cardH);
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 2;
    ctx.strokeRect(cardX + 1, cardY + 1, cardW - 2, cardH - 2);

    ctx.textAlign = 'center';
    if (world.phase.kind === 'briefing') {
      ctx.font = 'bold 26px "Courier New", monospace';
      ctx.fillStyle = AMBER;
      ctx.fillText('SPACE WAR SQUADRONS', cssWidth * 0.5, cardY + 48);

      ctx.font = '13px "Courier New", monospace';
      ctx.fillStyle = '#f6e8cf';
      ctx.fillText('Defend Hearthstone · Destroy raiders & both frigate cores', cssWidth * 0.5, cardY + 84);

      ctx.font = 'bold 12px "Courier New", monospace';
      ctx.fillStyle = '#fff0d4';
      ctx.fillText('MOUSE: Steer  |  LMB: Cannons (Manual + Overheat)  |  RMB/E: Lock-On Missile', cssWidth * 0.5, cardY + 126);

      ctx.font = '12px "Courier New", monospace';
      ctx.fillStyle = CYAN;
      ctx.fillText('W/S: Throttle (Tap W at 100%: 120% Overdrive)  |  A/D: Roll', cssWidth * 0.5, cardY + 152);
      ctx.fillStyle = 'rgba(244, 180, 89, 0.78)';
      ctx.fillText('T: Target  |  ESC/P: Pause  |  R: Restart  |  M/N: Audio', cssWidth * 0.5, cardY + 174);

      ctx.font = 'bold 15px "Courier New", monospace';
      ctx.fillStyle = EMERALD;
      ctx.fillText('PRESS [ENTER] OR CLICK TO LAUNCH', cssWidth * 0.5, cardY + 214);
    } else if (world.phase.kind === 'paused') {
      ctx.font = 'bold 26px "Courier New", monospace';
      ctx.fillStyle = AMBER;
      ctx.fillText('SORTIE PAUSED', cssWidth * 0.5, cardY + 56);

      ctx.font = '13px "Courier New", monospace';
      ctx.fillStyle = '#f6e8cf';
      ctx.fillText(
        `Flight Time: ${world.phase.elapsedSeconds.toFixed(1)}s   ·   Raiders Left: ${world.enemies.length}`,
        cssWidth * 0.5,
        cardY + 102,
      );

      ctx.font = '12px "Courier New", monospace';
      ctx.fillStyle = CYAN;
      ctx.fillText('[ESC] / [P] / [ENTER] or CLICK: Resume   |   [R]: Restart', cssWidth * 0.5, cardY + 148);
      ctx.fillStyle = 'rgba(244, 180, 89, 0.8)';
      ctx.fillText('[M]: Mute All   |   [N]: Toggle Soundtrack', cssWidth * 0.5, cardY + 172);

      ctx.font = 'bold 15px "Courier New", monospace';
      ctx.fillStyle = EMERALD;
      ctx.fillText('CLICK OR PRESS [ESC] TO RESUME', cssWidth * 0.5, cardY + 212);
    } else if (world.phase.kind === 'victory') {
      ctx.font = 'bold 26px "Courier New", monospace';
      ctx.fillStyle = EMERALD;
      ctx.fillText('SORTIE COMPLETE', cssWidth * 0.5, cardY + 62);
      ctx.font = '14px "Courier New", monospace';
      ctx.fillStyle = '#f6e8cf';
      ctx.fillText(
        `Raiders Down: ${world.phase.enemiesDestroyed}   Cores Neutralized: ${world.phase.subsystemsDestroyed}`,
        cssWidth * 0.5,
        cardY + 114,
      );
      ctx.fillText(
        `Flight Time: ${world.phase.elapsedSeconds.toFixed(1)}s`,
        cssWidth * 0.5,
        cardY + 144,
      );
      ctx.font = 'bold 15px "Courier New", monospace';
      ctx.fillStyle = AMBER;
      ctx.fillText('PRESS [R] OR [ENTER] TO FLY AGAIN', cssWidth * 0.5, cardY + 202);
    } else {
      ctx.font = 'bold 26px "Courier New", monospace';
      ctx.fillStyle = CRIMSON;
      ctx.fillText('SORTIE FAILED', cssWidth * 0.5, cardY + 62);
      ctx.font = '15px "Courier New", monospace';
      ctx.fillStyle = '#f6e8cf';
      ctx.fillText(world.phase.reason, cssWidth * 0.5, cardY + 116);
      ctx.font = 'bold 15px "Courier New", monospace';
      ctx.fillStyle = AMBER;
      ctx.fillText('PRESS [R] OR [ENTER] FOR INSTANT RETRY', cssWidth * 0.5, cardY + 196);
    }
  }

  function render(
    world: WorldState,
    project: (point: Vec3, width: number, height: number) => ProjectedPoint,
    audioMuted: boolean,
    musicEnabled: boolean,
  ): void {
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (world.tick < lastHudTick) {
      hitMarkerAlpha = 0;
      hitMarkerKill = false;
      hitMarkerShield = false;
      shieldBreakBannerAlpha = 0;
    } else if (world.tick > lastHudTick) {
      const tickDelta = Math.min(world.tick - lastHudTick, 10);
      hitMarkerAlpha = Math.max(0, hitMarkerAlpha - tickDelta * 0.09);
      shieldBreakBannerAlpha = Math.max(0, shieldBreakBannerAlpha - tickDelta * 0.025);
      for (const evt of world.events) {
        if (evt.kind === 'subsystem_destroyed') {
          hitMarkerAlpha = 1;
          hitMarkerKill = true;
          hitMarkerShield = false;
        } else if (evt.kind === 'shield_broken') {
          hitMarkerAlpha = 1;
          hitMarkerKill = false;
          hitMarkerShield = true;
          shieldBreakBannerAlpha = 1;
        } else if (evt.kind === 'hit_confirmed') {
          hitMarkerAlpha = 1;
          hitMarkerKill = evt.isKill;
          hitMarkerShield = evt.shieldHit === true;
        }
      }
    }
    lastHudTick = world.tick;

    if (world.player.hitFlash > 0.01) {
      ctx.fillStyle = `rgba(255, 65, 85, ${world.player.hitFlash * 0.28})`;
      ctx.fillRect(0, 0, cssWidth, cssHeight);
    }

    const reticle = resolveReticleScreenPos(world, project);
    drawReticleCluster(world, project, reticle);
    drawTargets(world, project, reticle);
    drawTopStrip(world);
    drawMinimalBottomHud(world, audioMuted, musicEnabled);
    drawOverlay(world);
  }

  return { resize, render };
}
