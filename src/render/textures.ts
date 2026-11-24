import * as THREE from 'three';
import { TEXTURE_PALETTE } from './palette';

function paintTile(paint: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) paint(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export interface HullTextureSet {
  readonly fighterHull: THREE.CanvasTexture;
  readonly carrierHull: THREE.CanvasTexture;
  readonly frigateHull: THREE.CanvasTexture;
  readonly solarVane: THREE.CanvasTexture;
  readonly asteroidIce: THREE.CanvasTexture;
  readonly asteroidOchre: THREE.CanvasTexture;
  readonly asteroidSlate: THREE.CanvasTexture;
  readonly dispose: () => void;
}

type HullPaint = typeof TEXTURE_PALETTE['fighter' | 'carrier' | 'frigate'];
type MineralPaint = typeof TEXTURE_PALETTE['asteroidIce' | 'asteroidSlate' | 'asteroidOchre'];

function hullTile(colors: HullPaint): THREE.CanvasTexture {
  return paintTile((ctx) => {
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, 256, 256);

    const plate = new Path2D();
    plate.moveTo(0, 19);
    plate.lineTo(147, 19);
    plate.lineTo(166, 38);
    plate.lineTo(225, 38);
    plate.lineTo(244, 19);
    plate.lineTo(256, 19);
    plate.lineTo(256, 202);
    plate.lineTo(230, 202);
    plate.lineTo(212, 184);
    plate.lineTo(105, 184);
    plate.lineTo(87, 202);
    plate.lineTo(0, 202);
    plate.closePath();
    ctx.fillStyle = colors.alt;
    ctx.fill(plate);

    const seams = new Path2D(plate);
    seams.moveTo(166, 38);
    seams.lineTo(166, 105);
    seams.lineTo(181, 120);
    seams.lineTo(181, 184);
    seams.moveTo(71, 202);
    seams.lineTo(71, 256);
    seams.moveTo(71, 0);
    seams.lineTo(71, 19);
    ctx.save();
    ctx.translate(1.5, 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = colors.rivet;
    ctx.stroke(seams);
    ctx.restore();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = colors.seam;
    ctx.stroke(seams);

    // Bolted access hatch and a worn scuff give each tile a hand-serviced look.
    ctx.lineWidth = 2;
    ctx.strokeStyle = colors.seam;
    ctx.strokeRect(100, 66, 44, 60);
    ctx.fillStyle = colors.band;
    ctx.fillRect(104, 70, 36, 52);
    ctx.fillStyle = colors.rivet;
    for (const [x, y] of [[106, 72], [134, 72], [106, 116], [134, 116], [20, 150], [50, 150], [20, 180], [230, 60], [230, 130]] as const) {
      ctx.fillRect(x, y, 4, 4);
    }
    ctx.fillStyle = colors.seam;
    ctx.fillRect(112, 92, 20, 3);
    ctx.fillRect(22, 222, 40, 3);
    ctx.fillRect(30, 230, 22, 2);

    ctx.fillStyle = colors.band;
    ctx.fillRect(12, 31, 57, 4);
    ctx.fillRect(12, 38, 30, 2);
    ctx.fillStyle = 'light' in colors ? colors.light : colors.trim;
    for (const x of [195, 205, 215]) {
      ctx.beginPath();
      ctx.moveTo(x, 158);
      ctx.lineTo(x + 4, 158);
      ctx.lineTo(x, 169);
      ctx.lineTo(x - 4, 169);
      ctx.fill();
    }
  });
}

function mineralTile(colors: MineralPaint): THREE.CanvasTexture {
  return paintTile((ctx) => {
    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = colors.mid;
    ctx.beginPath();
    ctx.moveTo(0, 88);
    ctx.lineTo(66, 102);
    ctx.lineTo(155, 61);
    ctx.lineTo(204, 76);
    ctx.lineTo(256, 88);
    ctx.lineTo(256, 116);
    ctx.lineTo(206, 104);
    ctx.lineTo(159, 87);
    ctx.lineTo(69, 125);
    ctx.lineTo(0, 116);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(58, 186);
    ctx.lineTo(121, 163);
    ctx.lineTo(98, 184);
    ctx.lineTo(68, 195);
    ctx.fillStyle = colors.dark;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(58, 186);
    ctx.lineTo(121, 163);
    ctx.lineTo(102, 173);
    ctx.fillStyle = colors.highlight;
    ctx.fill();
  });
}

export function createHullTextureSet(): HullTextureSet {
  const fighterHull = hullTile(TEXTURE_PALETTE.fighter);
  const carrierHull = hullTile(TEXTURE_PALETTE.carrier);
  const frigateHull = hullTile(TEXTURE_PALETTE.frigate);
  const solarVane = paintTile((ctx) => {
    const sv = TEXTURE_PALETTE.solarVane;
    ctx.fillStyle = sv.bg;
    ctx.fillRect(0, 0, 256, 256);
    for (let y = 4; y < 256; y += 64) {
      for (let x = 3; x < 256; x += 32) {
        ctx.fillStyle = sv.cell;
        ctx.fillRect(x, y, 28, 57);
        ctx.fillStyle = sv.grid;
        ctx.fillRect(x, y, 2, 57);
      }
    }
    ctx.fillStyle = sv.border;
    ctx.fillRect(0, 126, 256, 3);
  });
  const asteroidIce = mineralTile(TEXTURE_PALETTE.asteroidIce);
  const asteroidOchre = mineralTile(TEXTURE_PALETTE.asteroidOchre);
  const asteroidSlate = mineralTile(TEXTURE_PALETTE.asteroidSlate);

  function dispose(): void {
    fighterHull.dispose();
    carrierHull.dispose();
    frigateHull.dispose();
    solarVane.dispose();
    asteroidIce.dispose();
    asteroidOchre.dispose();
    asteroidSlate.dispose();
  }

  return {
    fighterHull,
    carrierHull,
    frigateHull,
    solarVane,
    asteroidIce,
    asteroidOchre,
    asteroidSlate,
    dispose,
  };
}
