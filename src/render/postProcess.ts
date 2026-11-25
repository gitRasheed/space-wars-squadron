import * as THREE from 'three';
import { INK_PALETTE, SATURN_BIOME, type BiomeCard } from './palette';

export interface StylizedPostPass {
  /** Pixel size of the internal targets; the canvas backing store should match it. */
  readonly size: () => { readonly width: number; readonly height: number };
  readonly resize: (cssWidth: number, cssHeight: number) => void;
  readonly render: (renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) => void;
  readonly setBiome: (card: BiomeCard) => void;
  readonly destroy: () => void;
}

/** Meshes on this layer are drawn into the ink buffer, so they get outlines and crease lines. */
export const INK_LAYER = 1;

export const CAMERA_CLIP = { near: 0.25, far: 12000 } as const;

const MAX_INTERNAL_HEIGHT = 1440;

const QUAD_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

function halfFloatTarget(samples: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(1280, 720, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    samples,
    depthBuffer: samples > 0,
    stencilBuffer: false,
  });
}

function quadMaterial(uniforms: Record<string, THREE.IUniform>, fragmentShader: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: QUAD_VERTEX,
    fragmentShader,
  });
}

/** One axis of a separable 7-tap Gaussian over the prelude's `tap(uv)`, which may use the `tSource` sampler. */
function blurShader(axis: 'x' | 'y', prelude: string): string {
  const stride = axis === 'x' ? 'vec2(uTexel.x, 0.0)' : 'vec2(0.0, uTexel.y)';
  return `
    uniform sampler2D tSource;
    uniform vec2 uTexel;
    varying vec2 vUv;
    ${prelude}
    void main() {
      vec2 stride = ${stride};
      vec3 sum = tap(vUv) * 0.227027;
      sum += (tap(vUv + stride * 1.5) + tap(vUv - stride * 1.5)) * 0.1945946;
      sum += (tap(vUv + stride * 3.5) + tap(vUv - stride * 3.5)) * 0.1216216;
      sum += (tap(vUv + stride * 5.5) + tap(vUv - stride * 5.5)) * 0.0702703;
      gl_FragColor = vec4(sum, 1.0);
    }
  `;
}

export function createStylizedPostPass(): StylizedPostPass {
  const colorTarget = halfFloatTarget(4);
  // View normal in rgb, 1/depth in alpha. Multisampled so edge pixels blend, which is what antialiases the ink.
  const inkTarget = halfFloatTarget(4);
  const bloomTargetA = halfFloatTarget(0);
  const bloomTargetB = halfFloatTarget(0);

  const inkGeometryMat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalMatrix * normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vNormal;
      void main() {
        gl_FragColor = vec4(normalize(vNormal), gl_FragCoord.w);
      }
    `,
  });

  // Bloom: keep only HDR emissives while blurring across at half-res, then blur down.
  const extractUniforms = {
    tSource: { value: colorTarget.texture },
    uTexel: { value: new THREE.Vector2(1 / 640, 1 / 360) },
  };
  const extractMat = quadMaterial(
    extractUniforms,
    blurShader('x', `
      vec3 tap(vec2 uv) {
        vec3 c = texture2D(tSource, uv).rgb;
        float peak = max(c.r, max(c.g, c.b));
        return max(c - vec3(0.85), vec3(0.0)) * smoothstep(0.95, 1.85, peak);
      }
    `),
  );
  const blurVUniforms = {
    tSource: { value: bloomTargetA.texture },
    uTexel: { value: new THREE.Vector2(1 / 640, 1 / 360) },
  };
  const blurVMat = quadMaterial(
    blurVUniforms,
    blurShader('y', 'vec3 tap(vec2 uv) { return texture2D(tSource, uv).rgb; }'),
  );

  const compositeUniforms = {
    tDiffuse: { value: colorTarget.texture },
    tBloom: { value: bloomTargetB.texture },
    tInk: { value: inkTarget.texture },
    uInkStep: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uInkTint: { value: new THREE.Vector3() },
    uVignetteTint: { value: new THREE.Vector3() },
    uGradeShadows: { value: new THREE.Vector3() },
    uGradeHighlights: { value: new THREE.Vector3() },
  };
  function setBiome(card: BiomeCard): void {
    compositeUniforms.uInkTint.value.fromArray(card.inkTint);
    compositeUniforms.uVignetteTint.value.fromArray(card.vignetteTint);
    compositeUniforms.uGradeShadows.value.fromArray(card.gradeShadows);
    compositeUniforms.uGradeHighlights.value.fromArray(card.gradeHighlights);
  }
  setBiome(SATURN_BIOME);
  const compositeMat = quadMaterial(
    compositeUniforms,
    `
      uniform sampler2D tDiffuse;
      uniform sampler2D tBloom;
      uniform sampler2D tInk;
      uniform vec2 uInkStep;
      uniform vec3 uInkTint;
      uniform vec3 uVignetteTint;
      uniform vec3 uGradeShadows;
      uniform vec3 uGradeHighlights;
      varying vec2 vUv;

      // 1/depth is linear across the screen on any flat face, so its second difference is zero there at every
      // viewing angle and jumps only where a nearer surface ends. Positive means this pixel is the near side.
      float outline(float here, float a, float b) {
        float bulge = (2.0 * here - a - b) / here;
        float edge = smoothstep(0.012, 0.03, bulge);
        // Slivers with background on both sides would otherwise turn solid ink.
        return edge * (1.0 - 0.55 * smoothstep(1.2, 1.8, bulge));
      }

      // A fold between two faces at about the same depth. Blunt folds stay clean so rocks do not turn into wireframes.
      float crease(vec4 here, vec4 next) {
        float sameSurface = 1.0 - smoothstep(0.02, 0.05, abs(here.a - next.a) / max(here.a, next.a));
        float bend = 1.0 - dot(normalize(here.rgb), normalize(next.rgb + vec3(0.0, 0.0, 1e-5)));
        return smoothstep(0.2, 0.5, bend) * sameSurface;
      }

      // Emissives are HDR-boosted well past 1.0, so only they escape the ink; sunlit hull keeps it.
      float inkCoverage(float peak) {
        vec4 here = texture2D(tInk, vUv);
        if (here.a <= 0.0 || peak >= 1.5) return 0.0;
        float dist = 1.0 / here.a;
        if (dist > 2600.0) return 0.0;

        // Bold lines on the cockpit, hairlines on distant hulls.
        float width = mix(1.3, 0.55, smoothstep(4.0, 420.0, dist));
        vec2 dx = vec2(uInkStep.x * width, 0.0);
        vec2 dy = vec2(0.0, uInkStep.y * width);
        vec4 right = texture2D(tInk, vUv + dx);
        vec4 up = texture2D(tInk, vUv + dy);
        float silhouette = max(
          outline(here.a, texture2D(tInk, vUv - dx).a, right.a),
          outline(here.a, texture2D(tInk, vUv - dy).a, up.a)
        );
        float fold = max(crease(here, right), crease(here, up)) * (1.0 - smoothstep(260.0, 900.0, dist));
        return max(silhouette, fold * 0.85)
             * mix(1.0, 0.45, smoothstep(160.0, 700.0, dist))
             * (1.0 - smoothstep(1500.0, 2600.0, dist))
             * (1.0 - smoothstep(1.05, 1.5, peak));
      }

      vec3 neutralToneMap(vec3 color) {
        const float startCompression = 0.8 - 0.04;
        const float desaturation = 0.15;
        float x = min(color.r, min(color.g, color.b));
        float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
        color -= offset;
        float peak = max(color.r, max(color.g, color.b));
        if (peak < startCompression) return max(color, vec3(0.0));
        float d = 1.0 - startCompression;
        float newPeak = 1.0 - d * d / (peak + d - startCompression);
        color *= newPeak / peak;
        float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
        return mix(color, vec3(newPeak), g);
      }

      vec3 linearToSrgb(vec3 linearColor) {
        return pow(max(linearColor, vec3(0.0)), vec3(1.0 / 2.2));
      }

      void main() {
        vec3 baseLinear = texture2D(tDiffuse, vUv).rgb;
        vec3 bloomLinear = texture2D(tBloom, vUv).rgb;
        float ink = inkCoverage(max(baseLinear.r, max(baseLinear.g, baseLinear.b)));
        vec3 inkColor = min(baseLinear, baseLinear * ${INK_PALETTE.keep.toFixed(3)} + uInkTint);
        vec3 combined = mix(baseLinear, inkColor, ink * 0.92) + bloomLinear * 0.5;

        vec2 centered = vUv * 2.0 - 1.0;
        float vignette = clamp(1.0 - dot(centered, centered) * 0.16, 0.74, 1.0);
        combined *= mix(uVignetteTint, vec3(1.0), vignette) * vignette;

        vec3 displayColor = linearToSrgb(neutralToneMap(combined));

        // Print-style grade: indigo in the shadows, warmth in the highlights, a touch more chroma and contrast.
        float luma = dot(displayColor, vec3(0.299, 0.587, 0.114));
        float shadows = 1.0 - smoothstep(0.0, 0.42, luma);
        displayColor = mix(displayColor, displayColor * uGradeShadows + vec3(0.008, 0.004, 0.024), shadows * 0.6);
        displayColor = mix(displayColor, displayColor * uGradeHighlights, smoothstep(0.55, 1.0, luma) * 0.5);
        displayColor = mix(vec3(luma), displayColor, 1.12);
        displayColor = mix(displayColor, displayColor * displayColor * (3.0 - 2.0 * displayColor), 0.22);

        float grain = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        gl_FragColor = vec4(displayColor + (grain - 0.5) / 255.0, 1.0);
      }
    `,
  );

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), extractMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const savedClear = new THREE.Color();

  function drawQuad(
    renderer: THREE.WebGLRenderer,
    material: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget | null,
  ): void {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCamera);
  }

  function resize(cssWidth: number, cssHeight: number): void {
    const safeW = Math.max(1, Math.round(cssWidth));
    const safeH = Math.max(1, Math.round(cssHeight));
    const scale = Math.min(globalThis.devicePixelRatio || 1, MAX_INTERNAL_HEIGHT / safeH);
    const internalW = Math.max(1, Math.round(safeW * scale));
    const internalH = Math.max(1, Math.round(safeH * scale));
    const halfW = Math.max(1, Math.round(internalW * 0.5));
    const halfH = Math.max(1, Math.round(internalH * 0.5));

    colorTarget.setSize(internalW, internalH);
    inkTarget.setSize(internalW, internalH);
    bloomTargetA.setSize(halfW, halfH);
    bloomTargetB.setSize(halfW, halfH);

    extractUniforms.uTexel.value.set(1 / halfW, 1 / halfH);
    blurVUniforms.uTexel.value.set(1 / halfW, 1 / halfH);
    const inkWidth = Math.max(1, internalH / 560);
    compositeUniforms.uInkStep.value.set(inkWidth / internalW, inkWidth / internalH);
  }

  function render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    // Alpha 0 is "nothing here": the ink shader reads it as infinitely far away.
    renderer.getClearColor(savedClear);
    const savedAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    scene.overrideMaterial = inkGeometryMat;
    camera.layers.set(INK_LAYER);
    renderer.setRenderTarget(inkTarget);
    renderer.render(scene, camera);
    camera.layers.set(0);
    scene.overrideMaterial = null;
    renderer.setClearColor(savedClear, savedAlpha);

    renderer.setRenderTarget(colorTarget);
    renderer.render(scene, camera);

    drawQuad(renderer, extractMat, bloomTargetA);
    drawQuad(renderer, blurVMat, bloomTargetB);
    drawQuad(renderer, compositeMat, null);
  }

  function destroy(): void {
    colorTarget.dispose();
    inkTarget.dispose();
    bloomTargetA.dispose();
    bloomTargetB.dispose();
    quad.geometry.dispose();
    inkGeometryMat.dispose();
    extractMat.dispose();
    blurVMat.dispose();
    compositeMat.dispose();
  }

  return {
    size: () => ({ width: colorTarget.width, height: colorTarget.height }),
    resize,
    render,
    setBiome,
    destroy,
  };
}
