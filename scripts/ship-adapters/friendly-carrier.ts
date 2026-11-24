import { buildFriendlyCarrierMesh } from '../../src/render/models';
import { createHullTextureSet } from '../../src/render/textures';

export function buildAsset() {
  const textures = createHullTextureSet();
  return buildFriendlyCarrierMesh(textures);
}
