import * as THREE from 'three';

interface Drawables {
  readonly geometries: ReadonlySet<THREE.BufferGeometry>;
  readonly materials: ReadonlySet<THREE.Material>;
}

export function drawablesUnder(roots: readonly THREE.Object3D[]): Drawables {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  for (const root of roots) {
    root.traverse((node) => {
      if (node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.Points) {
        geometries.add(node.geometry as THREE.BufferGeometry);
        const mat = node.material as THREE.Material | THREE.Material[];
        for (const item of Array.isArray(mat) ? mat : [mat]) materials.add(item);
      }
    });
  }
  return { geometries, materials };
}

/** Frees every geometry and material under `roots`, plus `extraMaterials`, each exactly once. */
export function disposeObject3D(roots: readonly THREE.Object3D[], extraMaterials: readonly THREE.Material[] = []): void {
  const { geometries, materials } = drawablesUnder(roots);
  for (const geo of geometries) geo.dispose();
  for (const mat of new Set([...materials, ...extraMaterials])) mat.dispose();
}
