import * as THREE from 'three';
import { BIOME_CARDS, type BiomeCard } from './palette';

function vec3Uniform(): THREE.IUniform<THREE.Vector3> {
  return { value: new THREE.Vector3() };
}

/**
 * The active biome as shader uniforms, shared by reference: every cel material holds `surface` and the
 * composite pass holds `post`, so one write restyles the whole frame.
 */
export const BIOME_UNIFORMS = {
  surface: {
    uSunDirection: vec3Uniform(),
    uBounceDirection: vec3Uniform(),
    uBandHighlight: vec3Uniform(),
    uBandBase: vec3Uniform(),
    uBandShadow: vec3Uniform(),
    uBandBounce: vec3Uniform(),
    uGlint: vec3Uniform(),
  },
  rim: { value: new THREE.Color() } as THREE.IUniform<THREE.Color>,
  post: {
    uInkTint: vec3Uniform(),
    uVignetteTint: vec3Uniform(),
    uGradeShadowGain: vec3Uniform(),
    uGradeShadowLift: vec3Uniform(),
    uGradeHighlightGain: vec3Uniform(),
  },
} as const;

export function setActiveBiome(card: BiomeCard): void {
  const { surface, post } = BIOME_UNIFORMS;
  const sun = card.sunDirection;
  surface.uSunDirection.value.set(sun.x, sun.y, sun.z).normalize();
  // Skylight arrives from above on the side away from the sun.
  surface.uBounceDirection.value.set(-sun.x, 0.6, -sun.z).normalize();
  surface.uBandHighlight.value.fromArray(card.bands.highlight);
  surface.uBandBase.value.fromArray(card.bands.base);
  surface.uBandShadow.value.fromArray(card.bands.shadow);
  surface.uBandBounce.value.fromArray(card.bands.bounce);
  surface.uGlint.value.fromArray(card.glint);
  BIOME_UNIFORMS.rim.value.set(card.rim);
  post.uInkTint.value.fromArray(card.inkTint);
  post.uVignetteTint.value.fromArray(card.vignetteTint);
  post.uGradeShadowGain.value.fromArray(card.grade.shadowGain);
  post.uGradeShadowLift.value.fromArray(card.grade.shadowLift);
  post.uGradeHighlightGain.value.fromArray(card.grade.highlightGain);
}

setActiveBiome(BIOME_CARDS.saturnOrbit);
