import {
  COMBAT_TUNING,
  listHostileContacts,
  subsystemWorldPosition,
} from '../sim/combat';
import { add, clamp, computeLeadPoint, distance, dot, forwardOf, rightOf, scale, sub, upOf } from '../sim/math';
import type { Vec3, WorldState } from '../sim/types';
import type { ProjectedPoint } from './sceneRenderer';

export interface CockpitHud {
  readonly resize: (width: number, height: number) => void;
  readonly render: (
    world: WorldState,
    project: (point: Vec3, width: number, height: number) => ProjectedPoint,
    audioMuted: boolean,
  ) => void;
}

const AMBER = '#f4b459';
const AMBER_DIM = 'rgba(244, 180, 89, 0.38)';
const CYAN = '#6be5ff';
const CRIMSON = '#ff4d63';
const EMERALD = '#5dffb0';
const PANEL_BG = 'rgba(11, 13, 22, 0.84)';
const LABEL_BG = 'rgba(10, 11, 19, 0.78)';
const DASH_HEIGHT = 122;
const DASH_BOTTOM_MARGIN = 10;

export function createCockpitHud(canvas: HTMLCanvasElement): CockpitHud {
  const maybeCtx = canvas.getContext('2d');
  if (maybeCtx === null) {
    throw new Error('2D HUD canvas context unavailable');
  }
  const ctx: CanvasRenderingContext2D = maybeCtx;

  let cssWidth = 1280;
  let cssHeight = 720;

  function canopyBounds(): {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  } {
    return {
      left: 30,
      right: cssWidth - 30,
      top: 72,
      bottom: cssHeight - DASH_HEIGHT - DASH_BOTTOM_MARGIN - 24,
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
    ctx.strokeStyle = '#090a12';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(12, 0);
    ctx.lineTo(-7, -7);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-7, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    if (label !== null) {
      const labelAlign = edgeX > cssWidth * 0.65 ? 'right' : edgeX < cssWidth * 0.35 ? 'left' : 'center';
      const offsetX = labelAlign === 'right' ? -16 : labelAlign === 'left' ? 16 : 0;
      const offsetY = edgeY > bounds.bottom - 26 ? -12 : 4;
      drawPillLabel(label, edgeX + offsetX, edgeY + offsetY, color, labelAlign);
    }
  }

  function drawBar(
    x: number,
    y: number,
    w: number,
    h: number,
    ratio: number,
    fillColor: string,
    label: string,
    valueText: string,
  ): void {
    const clamped = clamp(ratio, 0, 1);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = fillColor;
    ctx.fillRect(x, y, w * clamped, h);
    ctx.strokeStyle = AMBER_DIM;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    ctx.font = 'bold 10px "Courier New", monospace';
    ctx.fillStyle = AMBER;
    ctx.textAlign = 'left';
    ctx.fillText(label, x, y - 4);
    ctx.textAlign = 'right';
    ctx.fillText(valueText, x + w, y - 4);
  }

  function drawReticleAndDrift(
    world: WorldState,
    project: (point: Vec3, width: number, height: number) => ProjectedPoint,
  ): void {
    const cx = cssWidth * 0.5;
    const cy = cssHeight * 0.5;
    const isDrifting = world.player.energy.boostMode.kind === 'drifting';

    ctx.strokeStyle = isDrifting ? CYAN : AMBER;
    ctx.lineWidth = 1.5;

    const gap = 10;
    const arm = 12;
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

    ctx.fillStyle = isDrifting ? CYAN : AMBER;
    ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);

    const bounds = canopyBounds();
    const velPoint = add(world.player.position, scale(world.player.velocity, 3));
    const projectedVel = project(velPoint, cssWidth, cssHeight);
    const inCanopy =
      projectedVel.inFront &&
      projectedVel.x >= bounds.left &&
      projectedVel.x <= bounds.right &&
      projectedVel.y >= bounds.top &&
      projectedVel.y <= bounds.bottom;

    if (inCanopy) {
      ctx.strokeStyle = isDrifting ? CYAN : 'rgba(107, 229, 255, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(projectedVel.x, projectedVel.y, 7, 0, Math.PI * 2);
      ctx.moveTo(projectedVel.x - 11, projectedVel.y);
      ctx.lineTo(projectedVel.x - 7, projectedVel.y);
      ctx.moveTo(projectedVel.x + 7, projectedVel.y);
      ctx.lineTo(projectedVel.x + 11, projectedVel.y);
      ctx.stroke();
    } else if (isDrifting) {
      drawEdgeChevron(projectedVel, CYAN, 'VEL');
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
        const size = isSelected ? 16 : 10;
        ctx.strokeStyle = isSelected ? CRIMSON : 'rgba(255, 110, 96, 0.58)';
        ctx.lineWidth = isSelected ? 2 : 1.2;

        ctx.beginPath();
        ctx.moveTo(projected.x, projected.y - size);
        ctx.lineTo(projected.x + size, projected.y);
        ctx.lineTo(projected.x, projected.y + size);
        ctx.lineTo(projected.x - size, projected.y);
        ctx.closePath();
        ctx.stroke();

        if (isSelected) {
          const lock = world.player.lockState;
          if (lock.kind === 'acquiring' && lock.targetId === contact.id) {
            const half = 34 - lock.progress * 13;
            drawLockCorners(projected.x, projected.y, half, AMBER, 1.8);
          } else if (lock.kind === 'locked' && lock.targetId === contact.id) {
            drawLockCorners(projected.x, projected.y, 21, CRIMSON, 2.2);
          }

          const labelAlign = projected.x > cssWidth * 0.55 ? 'right' : 'left';
          const labelX = labelAlign === 'right' ? projected.x - size - 8 : projected.x + size + 8;
          const lockSuffix = lock.kind === 'locked' && lock.targetId === contact.id ? ' [LOCK]' : '';
          drawPillLabel(`${contact.label} ${distMeters}M${lockSuffix}`, labelX, projected.y - 4, CRIMSON, labelAlign);

          const lead = computeLeadPoint(
            world.player.position,
            world.player.velocity,
            contact.position,
            contact.velocity,
            COMBAT_TUNING.boltSpeed,
          );
          const projLead = project(lead, cssWidth, cssHeight);
          const leadInCanopy =
            projLead.inFront &&
            projLead.x >= bounds.left &&
            projLead.x <= bounds.right &&
            projLead.y >= bounds.top &&
            projLead.y <= bounds.bottom;

          if (leadInCanopy) {
            ctx.strokeStyle = 'rgba(244, 180, 89, 0.45)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(projected.x, projected.y);
            ctx.lineTo(projLead.x, projLead.y);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.strokeStyle = '#090a12';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(projLead.x, projLead.y, 9, 0, Math.PI * 2);
            ctx.stroke();

            ctx.strokeStyle = EMERALD;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(projLead.x, projLead.y, 9, 0, Math.PI * 2);
            ctx.stroke();

            ctx.fillStyle = EMERALD;
            ctx.fillRect(projLead.x - 1.5, projLead.y - 1.5, 3, 3);
          }
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
      ctx.lineWidth = 1.25;
      ctx.strokeRect(wingProj.x - 9, wingProj.y - 9, 18, 18);
      drawPillLabel(world.wingmate.callsign, wingProj.x + 13, wingProj.y + 4, CYAN, 'left');
    }
  }

  function drawRadar(world: WorldState, cx: number, cy: number, radius: number): void {
    ctx.fillStyle = 'rgba(10, 14, 22, 0.9)';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = AMBER_DIM;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.55, 0, Math.PI * 2);
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
    const radarRange = 1300;

    function projectBlip(pos: Vec3): { readonly bx: number; readonly by: number; readonly elev: number } {
      const rel = sub(pos, world.player.position);
      const lx = dot(rel, right) / radarRange;
      const ly = dot(rel, up) / radarRange;
      const lz = dot(rel, fwd) / radarRange;
      const planarMag = Math.hypot(lx, lz);
      const scaleFactor = planarMag > 0.9 ? 0.9 / planarMag : 1;
      return {
        bx: cx + lx * scaleFactor * radius,
        by: cy - lz * scaleFactor * radius,
        elev: clamp(ly * radius * 0.42, -16, 16),
      };
    }

    function drawBlip(pos: Vec3, color: string, size: number, isSquare = false, bracketed = false): void {
      const p = projectBlip(pos);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.bx, p.by);
      ctx.lineTo(p.bx, p.by - p.elev);
      ctx.stroke();

      ctx.fillStyle = color;
      if (isSquare) {
        ctx.fillRect(p.bx - size, p.by - p.elev - size, size * 2, size * 2);
      } else {
        ctx.beginPath();
        ctx.arc(p.bx, p.by - p.elev, size, 0, Math.PI * 2);
        ctx.fill();
      }
      if (bracketed) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4;
        ctx.strokeRect(p.bx - 6, p.by - p.elev - 6, 12, 12);
      }
    }

    drawBlip(world.friendlyCarrier.position, AMBER, 3.2, true);
    drawBlip(world.hostileFrigate.position, '#ff8040', 3.2, true);
    drawBlip(world.wingmate.position, CYAN, 2.6);

    let selectedPos: Vec3 | null = null;
    for (const enemy of world.enemies) {
      if (enemy.id === world.player.selectedTargetId) {
        selectedPos = enemy.position;
      } else {
        drawBlip(enemy.position, CRIMSON, 2.4);
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
        drawBlip(pos, '#ff52b8', 2.4);
      }
    }
    if (selectedPos !== null) {
      drawBlip(selectedPos, '#ffffff', 2.8, false, true);
    }

    ctx.font = 'bold 9px "Courier New", monospace';
    ctx.fillStyle = AMBER;
    ctx.textAlign = 'center';
    ctx.fillText('TACTICAL', cx, cy + radius + 12);
  }

  function drawLowerDash(world: WorldState, audioMuted: boolean): void {
    const dashW = Math.min(760, cssWidth - 28);
    const dashX = (cssWidth - dashW) * 0.5;
    const dashY = cssHeight - DASH_HEIGHT - DASH_BOTTOM_MARGIN;

    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(dashX, dashY, dashW, DASH_HEIGHT);
    ctx.strokeStyle = AMBER_DIM;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(dashX + 0.5, dashY + 0.5, dashW - 1, DASH_HEIGHT - 1);

    const p = world.player;
    const leftX = dashX + 18;
    const colW = Math.min(220, dashW * 0.3);

    const boostLabel =
      p.energy.boostMode.kind === 'boosting'
        ? 'BOOST'
        : p.energy.boostMode.kind === 'drifting'
          ? 'AOA DRIFT'
          : p.energy.boostMode.kind === 'recovering'
            ? 'RECOVER'
            : 'READY';
    const boostColor =
      p.energy.boostMode.kind === 'drifting'
        ? CYAN
        : p.energy.boostMode.kind === 'boosting'
          ? '#ffd466'
          : p.energy.boostMode.kind === 'recovering'
            ? CRIMSON
            : EMERALD;

    ctx.font = 'bold 14px "Courier New", monospace';
    ctx.fillStyle = AMBER;
    ctx.textAlign = 'left';
    ctx.fillText(`SPD ${Math.round(p.speed)} M/S`, leftX, dashY + 23);
    ctx.fillStyle = boostColor;
    ctx.textAlign = 'right';
    ctx.fillText(boostLabel, leftX + colW, dashY + 23);

    drawBar(
      leftX,
      dashY + 44,
      colW,
      10,
      p.energy.engineCharge / 100,
      CYAN,
      'ENG CAP',
      `${Math.round(p.energy.engineCharge)}%`,
    );
    drawBar(
      leftX,
      dashY + 74,
      colW,
      10,
      p.energy.weaponCharge / 100,
      AMBER,
      'WPN CAP',
      `${Math.round(p.energy.weaponCharge)}%`,
    );

    ctx.font = 'bold 10px "Courier New", monospace';
    ctx.textAlign = 'left';
    const modes: readonly { key: string; mode: 'engines' | 'balanced' | 'weapons'; label: string }[] = [
      { key: '1', mode: 'engines', label: 'ENG' },
      { key: '2', mode: 'balanced', label: 'BAL' },
      { key: '3', mode: 'weapons', label: 'WPN' },
    ];
    let modeX = leftX;
    for (const item of modes) {
      const active = p.energy.powerMode === item.mode;
      ctx.fillStyle = active ? AMBER : 'rgba(244, 180, 89, 0.45)';
      ctx.fillText(`[${item.key}]${item.label}`, modeX, dashY + 105);
      modeX += 64;
    }

    drawRadar(world, cssWidth * 0.5, dashY + 56, 44);

    const rightX = dashX + dashW - colW - 18;
    drawBar(
      rightX,
      dashY + 28,
      colW,
      10,
      p.energy.shieldCharge / 100,
      CYAN,
      'SHIELDS',
      `${Math.round(p.energy.shieldCharge)}%`,
    );
    drawBar(
      rightX,
      dashY + 58,
      colW,
      10,
      p.hull / p.maxHull,
      p.hull < 35 ? CRIMSON : EMERALD,
      'HULL',
      `${Math.round(p.hull)}%`,
    );

    ctx.font = 'bold 10px "Courier New", monospace';
    ctx.fillStyle = AMBER;
    ctx.textAlign = 'left';
    ctx.fillText('MISSILES', rightX, dashY + 86);
    for (let i = 0; i < p.maxMissiles; i += 1) {
      const ready = i < p.missilesReady;
      ctx.fillStyle = ready ? '#ff8b4d' : 'rgba(255, 255, 255, 0.14)';
      ctx.fillRect(rightX + 68 + i * 24, dashY + 76, 18, 10);
    }

    ctx.fillStyle = 'rgba(244, 180, 89, 0.78)';
    ctx.textAlign = 'left';
    ctx.fillText(
      `CAM[V]:${world.cameraMode.toUpperCase()}  SFX[M]:${audioMuted ? 'OFF' : 'ON'}`,
      rightX,
      dashY + 106,
    );

    if (p.proximityWarning) {
      drawPillLabel('!! PROXIMITY — PULL UP !!', cssWidth * 0.5, dashY - 8, CRIMSON, 'center');
    }
  }

  function drawTopBar(world: WorldState): void {
    const remainingSubsystems = world.hostileFrigate.subsystems.filter((s) => s.hull > 0).length;
    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(14, 12, 332, 50);
    ctx.strokeStyle = AMBER_DIM;
    ctx.lineWidth = 1;
    ctx.strokeRect(14.5, 12.5, 331, 49);

    ctx.font = 'bold 11px "Courier New", monospace';
    ctx.fillStyle = AMBER;
    ctx.textAlign = 'left';
    ctx.fillText(
      `RAIDERS: ${world.enemies.length}   FRIGATE SUBSYS: ${remainingSubsystems}`,
      24,
      30,
    );
    ctx.fillStyle = CYAN;
    const carrierPct = Math.round((world.friendlyCarrier.hull / world.friendlyCarrier.maxHull) * 100);
    ctx.fillText(`HEARTHSTONE: ${carrierPct}%   WING: ${world.wingmate.callsign}`, 24, 49);

    if (world.radio !== null) {
      const boxW = Math.min(520, cssWidth - 380);
      const boxX = cssWidth - boxW - 14;
      ctx.fillStyle = PANEL_BG;
      ctx.fillRect(boxX, 12, boxW, 44);
      ctx.strokeStyle = 'rgba(107, 229, 255, 0.45)';
      ctx.strokeRect(boxX + 0.5, 12.5, boxW - 1, 43);

      ctx.font = 'bold 11px "Courier New", monospace';
      ctx.fillStyle = CYAN;
      ctx.textAlign = 'left';
      ctx.fillText(world.radio.speaker, boxX + 12, 29);
      ctx.fillStyle = '#f6e8cf';
      ctx.font = '11px "Courier New", monospace';
      ctx.fillText(world.radio.text, boxX + 12, 46);
    }
  }

  function drawOverlay(world: WorldState): void {
    if (world.phase.kind === 'active') {
      return;
    }
    ctx.fillStyle = 'rgba(8, 9, 18, 0.66)';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const cardW = Math.min(580, cssWidth - 40);
    const cardH = 264;
    const cardX = (cssWidth - cardW) * 0.5;
    const cardY = (cssHeight - cardH) * 0.5;

    ctx.fillStyle = 'rgba(14, 15, 26, 0.94)';
    ctx.fillRect(cardX, cardY, cardW, cardH);
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 2;
    ctx.strokeRect(cardX + 1, cardY + 1, cardW - 2, cardH - 2);

    ctx.textAlign = 'center';
    if (world.phase.kind === 'briefing') {
      ctx.font = 'bold 26px "Courier New", monospace';
      ctx.fillStyle = AMBER;
      ctx.fillText('SPACE WAR SQUADRONS', cssWidth * 0.5, cardY + 50);

      ctx.font = '13px "Courier New", monospace';
      ctx.fillStyle = '#f6e8cf';
      ctx.fillText('SORTIE 01: DEFEND HMV-09 HEARTHSTONE', cssWidth * 0.5, cardY + 84);
      ctx.fillText('Destroy enemy raiders & disable the rival frigate subsystems.', cssWidth * 0.5, cardY + 108);

      ctx.font = 'bold 12px "Courier New", monospace';
      ctx.fillStyle = '#fff0d4';
      ctx.fillText('MOUSE: Steer  |  LMB: Cannons  |  RMB/E: Missile  |  T: Cycle Target', cssWidth * 0.5, cardY + 146);

      ctx.font = '12px "Courier New", monospace';
      ctx.fillStyle = CYAN;
      ctx.fillText('W/S: Throttle  |  A/D: Roll  |  SHIFT: Boost  |  SPACE: AOA Drift', cssWidth * 0.5, cardY + 172);
      ctx.fillStyle = 'rgba(244, 180, 89, 0.85)';
      ctx.fillText('F: Order Wingmate  |  1/2/3: Power  |  V: Camera  |  R: Retry  |  M: Sound', cssWidth * 0.5, cardY + 196);

      ctx.font = 'bold 15px "Courier New", monospace';
      ctx.fillStyle = EMERALD;
      ctx.fillText('PRESS [ENTER] OR CLICK TO LAUNCH', cssWidth * 0.5, cardY + 238);
    } else if (world.phase.kind === 'victory') {
      ctx.font = 'bold 26px "Courier New", monospace';
      ctx.fillStyle = EMERALD;
      ctx.fillText('SORTIE COMPLETE', cssWidth * 0.5, cardY + 62);
      ctx.font = '14px "Courier New", monospace';
      ctx.fillStyle = '#f6e8cf';
      ctx.fillText(
        `Raiders Down: ${world.phase.enemiesDestroyed}   Subsystems Neutralized: ${world.phase.subsystemsDestroyed}`,
        cssWidth * 0.5,
        cardY + 118,
      );
      ctx.fillText(
        `Flight Time: ${world.phase.elapsedSeconds.toFixed(1)}s`,
        cssWidth * 0.5,
        cardY + 148,
      );
      ctx.font = 'bold 15px "Courier New", monospace';
      ctx.fillStyle = AMBER;
      ctx.fillText('PRESS [R] OR [ENTER] TO FLY AGAIN', cssWidth * 0.5, cardY + 216);
    } else {
      ctx.font = 'bold 26px "Courier New", monospace';
      ctx.fillStyle = CRIMSON;
      ctx.fillText('SORTIE FAILED', cssWidth * 0.5, cardY + 62);
      ctx.font = '15px "Courier New", monospace';
      ctx.fillStyle = '#f6e8cf';
      ctx.fillText(world.phase.reason, cssWidth * 0.5, cardY + 118);
      ctx.font = 'bold 15px "Courier New", monospace';
      ctx.fillStyle = AMBER;
      ctx.fillText('PRESS [R] OR [ENTER] FOR INSTANT RETRY', cssWidth * 0.5, cardY + 206);
    }
  }

  function render(
    world: WorldState,
    project: (point: Vec3, width: number, height: number) => ProjectedPoint,
    audioMuted: boolean,
  ): void {
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (world.player.hitFlash > 0.01) {
      ctx.fillStyle = `rgba(255, 65, 85, ${world.player.hitFlash * 0.28})`;
      ctx.fillRect(0, 0, cssWidth, cssHeight);
    }

    drawReticleAndDrift(world, project);
    drawTargets(world, project);
    drawTopBar(world);
    drawLowerDash(world, audioMuted);
    drawOverlay(world);
  }

  return { resize, render };
}
