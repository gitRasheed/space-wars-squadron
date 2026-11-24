import fs from 'node:fs';
import type { GlbSourceInfo } from './types.js';

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_TYPE_JSON = 0x4e4f534a; // "JSON"
const GLTF_TRIANGLES_MODE = 4;

interface RawGltfJson {
  readonly scenes?: readonly unknown[];
  readonly materials?: readonly unknown[];
  readonly textures?: readonly unknown[];
  readonly meshes?: readonly { readonly primitives?: readonly { readonly mode?: number }[] }[];
}

export function inspectGlbSource(filePath: string): GlbSourceInfo {
  const bytes = fs.readFileSync(filePath);
  if (bytes.byteLength < 20) {
    throw new Error(`GLB file too small (${bytes.byteLength} bytes): ${filePath}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const declaredLen = view.getUint32(8, true);
  if (magic !== GLB_MAGIC || version !== 2) {
    throw new Error(`Invalid GLB header (magic=0x${magic.toString(16)}, version=${version})`);
  }
  if (declaredLen > bytes.byteLength || declaredLen < 20) {
    throw new Error(`Truncated GLB container (declared=${declaredLen}, actual=${bytes.byteLength})`);
  }

  const chunkLen = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  if (chunkType !== CHUNK_TYPE_JSON || 20 + chunkLen > declaredLen) {
    throw new Error('GLB missing valid JSON chunk');
  }

  const jsonText = new TextDecoder('utf-8').decode(bytes.subarray(20, 20 + chunkLen));
  const gltf = JSON.parse(jsonText) as RawGltfJson;

  let nonTrianglePrimitives = 0;
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const mode = prim.mode ?? GLTF_TRIANGLES_MODE;
      if (mode !== GLTF_TRIANGLES_MODE) {
        nonTrianglePrimitives += 1;
      }
    }
  }

  return {
    bytes: bytes.byteLength,
    scenes: (gltf.scenes ?? []).length,
    declaredMaterials: (gltf.materials ?? []).length,
    declaredTextures: (gltf.textures ?? []).length,
    nonTrianglePrimitives,
  };
}
