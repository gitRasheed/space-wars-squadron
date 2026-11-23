import * as THREE from 'three';

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
  const fighterHull = createPixelCanvas(64, (ctx, size) => {
    paintPanelGrid(ctx, size, '#dfd9cc', '#d2cab9', '#8a857c', '#f7f3e8', null);
    ctx.fillStyle = '#c4baa8';
    ctx.fillRect(0, 28, size, 6);
    ctx.fillStyle = '#6c6f7d';
    ctx.fillRect(0, 34, size, 2);
  });

  const carrierHull = createPixelCanvas(64, (ctx, size) => {
    paintPanelGrid(ctx, size, '#7e889b', '#6d778a', '#3c4354', '#a4b0c4', '#ffd88a');
    ctx.fillStyle = '#586276';
    ctx.fillRect(0, 20, size, 4);
    ctx.fillRect(0, 48, size, 3);
  });

  const frigateHull = createPixelCanvas(64, (ctx, size) => {
    paintPanelGrid(ctx, size, '#5a5070', '#4d4363', '#272036', '#8577a3', '#ff6478');
    ctx.fillStyle = '#3b314d';
    ctx.fillRect(0, 30, size, 4);
  });

  const solarVane = createPixelCanvas(64, (ctx, size) => {
    ctx.fillStyle = '#1d2230';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#394359';
    ctx.lineWidth = 1;
    for (let i = 0; i < size; i += 8) {
      ctx.beginPath();
      ctx.moveTo(i + 0.5, 0);
      ctx.lineTo(i + 0.5, size);
      ctx.moveTo(0, i + 0.5);
      ctx.lineTo(size, i + 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = '#2a3347';
    for (let y = 2; y < size; y += 8) {
      for (let x = 2; x < size; x += 8) {
        ctx.fillRect(x, y, 4, 4);
      }
    }
    ctx.strokeStyle = '#9ea8bd';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, size - 2, size - 2);
  });

  const asteroidIce = createPixelCanvas(64, (ctx, size) => {
    paintAsteroidSurface(ctx, size, '#8f84ab', '#776c94', '#4d4466', '#bfb7d9');
  });

  const asteroidOchre = createPixelCanvas(64, (ctx, size) => {
    paintAsteroidSurface(ctx, size, '#8f5f4e', '#754b3d', '#4c2e26', '#bd866d');
  });

  const asteroidSlate = createPixelCanvas(64, (ctx, size) => {
    paintAsteroidSurface(ctx, size, '#555c73', '#444a5e', '#2b2f3d', '#828ca8');
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
