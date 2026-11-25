import { describe, expect, it } from 'vitest';
import { disposeObject3D, drawablesUnder } from '../src/render/dispose';
import { createPlanetaryScene } from '../src/render/planetaryScene';

describe('scene disposal', () => {
  it('frees each planetary geometry once when the scene that holds it is swept afterwards', () => {
    const scene = createPlanetaryScene().root;
    const planetary = createPlanetaryScene();
    scene.add(planetary.root, planetary.sky);
    const counts = new Map<unknown, number>();
    for (const geometry of drawablesUnder([planetary.root, planetary.sky]).geometries) {
      counts.set(geometry, 0);
      geometry.addEventListener('dispose', () => counts.set(geometry, (counts.get(geometry) ?? 0) + 1));
    }
    planetary.dispose();
    disposeObject3D([scene]);
    expect(counts.size).toBeGreaterThan(100);
    expect([...counts.values()].filter((n) => n !== 1)).toEqual([]);
  });
});
