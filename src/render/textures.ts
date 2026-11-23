import * as THREE from 'three';
import { TEXTURE_PALETTE } from './palette';

function createPixelCanvas(
  size: number,
  paint: (ctx: CanvasRenderingContext2D, size: number) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    ctx.imageSmoothingEnabled = false;
    paint(ctx, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
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

function paintPanelGrid(
  ctx: CanvasRenderingContext2D,
  size: number,
  base: string,
  panelAlt: string,
  seam: string,
  rivet: string,
  accentLights: string | null,
): void {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  const step = size / 4;
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      if ((row + col) % 2 === 0) {
        ctx.fillStyle = panelAlt;
        ctx.fillRect(col * step + 1, row * step + 1, step - 2, step - 2);
      }
      ctx.strokeStyle = seam;
      ctx.lineWidth = 1;
      ctx.strokeRect(col * step + 0.5, row * step + 0.5, step - 1, step - 1);

      ctx.fillStyle = rivet;
      ctx.fillRect(col * step + 3, row * step + 3, 1, 1);
      ctx.fillRect((col + 1) * step - 4, (row + 1) * step - 4, 1, 1);
    }
  }

  if (accentLights !== null) {
    ctx.fillStyle = accentLights;
    for (let i = 0; i < 6; i += 1) {
      const lx = ((i * 19 + 5) % (size - 8)) + 3;
      const ly = ((i * 29 + 11) % (size - 8)) + 3;
      ctx.fillRect(lx, ly, 3, 1);
    }
  }
}

function paintAsteroidSurface(
  ctx: CanvasRenderingContext2D,
  size: number,
  base: string,
  mid: string,
  dark: string,
  highlight: string,
): void {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  let seed = 0x51a7c0de;
  for (let i = 0; i < 95; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const x = ((seed >>> 0) % size);
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const y = ((seed >>> 0) % size);
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const w = 2 + ((seed >>> 0) % 7);
    const h = 2 + (((seed >>> 4) >>> 0) % 6);
    ctx.fillStyle = i % 5 === 0 ? highlight : i % 3 === 0 ? dark : mid;
    ctx.fillRect(x, y, w, h);
  }

  for (let c = 0; c < 6; c += 1) {
    const cx = (c * 17 + 9) % size;
    const cy = (c * 23 + 13) % size;
    ctx.fillStyle = dark;
    ctx.fillRect(cx - 2, cy - 2, 5, 5);
    ctx.fillStyle = highlight;
    ctx.fillRect(cx + 2, cy - 2, 1, 4);
  }
}

export function createHullTextureSet(): HullTextureSet {
  const f = TEXTURE_PALETTE.fighter;
  const fighterHull = createPixelCanvas(64, (ctx, size) => {
    paintPanelGrid(ctx, size, f.base, f.alt, f.seam, f.rivet, null);
    ctx.fillStyle = f.band;
    ctx.fillRect(0, 28, size, 6);
    ctx.fillStyle = f.trim;
    ctx.fillRect(0, 34, size, 2);
  });

  const c = TEXTURE_PALETTE.carrier;
  const carrierHull = createPixelCanvas(64, (ctx, size) => {
    paintPanelGrid(ctx, size, c.base, c.alt, c.seam, c.rivet, c.light);
    ctx.fillStyle = c.band;
    ctx.fillRect(0, 20, size, 4);
    ctx.fillRect(0, 48, size, 3);
  });

  const fr = TEXTURE_PALETTE.frigate;
  const frigateHull = createPixelCanvas(64, (ctx, size) => {
    paintPanelGrid(ctx, size, fr.base, fr.alt, fr.seam, fr.rivet, fr.light);
    ctx.fillStyle = fr.band;
    ctx.fillRect(0, 30, size, 4);
  });

  const sv = TEXTURE_PALETTE.solarVane;
  const solarVane = createPixelCanvas(64, (ctx, size) => {
    ctx.fillStyle = sv.bg;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = sv.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i < size; i += 8) {
      ctx.beginPath();
      ctx.moveTo(i + 0.5, 0);
      ctx.lineTo(i + 0.5, size);
      ctx.moveTo(0, i + 0.5);
      ctx.lineTo(size, i + 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = sv.cell;
    for (let y = 2; y < size; y += 8) {
      for (let x = 2; x < size; x += 8) {
        ctx.fillRect(x, y, 4, 4);
      }
    }
    ctx.strokeStyle = sv.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, size - 2, size - 2);
  });

  const ice = TEXTURE_PALETTE.asteroidIce;
  const asteroidIce = createPixelCanvas(64, (ctx, size) => {
    paintAsteroidSurface(ctx, size, ice.base, ice.mid, ice.dark, ice.highlight);
  });

  const ochre = TEXTURE_PALETTE.asteroidOchre;
  const asteroidOchre = createPixelCanvas(64, (ctx, size) => {
    paintAsteroidSurface(ctx, size, ochre.base, ochre.mid, ochre.dark, ochre.highlight);
  });

  const slate = TEXTURE_PALETTE.asteroidSlate;
  const asteroidSlate = createPixelCanvas(64, (ctx, size) => {
    paintAsteroidSurface(ctx, size, slate.base, slate.mid, slate.dark, slate.highlight);
  });

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
