import { buildPlayerFighterMesh } from '../../src/render/models';
import { SCENE_PALETTE } from '../../src/render/palette';
import { createHullTextureSet } from '../../src/render/textures';

export function buildAsset() {
  const textures = createHullTextureSet();
  const rig = buildPlayerFighterMesh(SCENE_PALETTE.playerStripe, textures);
  return rig.root;
}
