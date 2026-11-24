import * as THREE from 'three';

export interface StylizedPostPass {
  readonly target: THREE.WebGLRenderTarget;
  readonly resize: (cssWidth: number, cssHeight: number) => void;
  readonly renderToScreen: (renderer: THREE.WebGLRenderer) => void;
  readonly destroy: () => void;
}

export const CAMERA_CLIP = { near: 0.25, far: 12000 } as const;

const MAX_INTERNAL_HEIGHT = 1440;

export function createStylizedPostPass(): StylizedPostPass {
  const target = new THREE.WebGLRenderTarget(1280, 720, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    samples: 4,
    depthTexture: new THREE.DepthTexture(1280, 720, THREE.UnsignedIntType),
    depthBuffer: true,
    stencilBuffer: false,
  });

  const bloomTargetA = new THREE.WebGLRenderTarget(640, 360, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  });

  const bloomTargetB = new THREE.WebGLRenderTarget(640, 360, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  });

  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const vertShader = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;

  // Pass 1: Extract HDR emissives (> 0.95) and blur horizontally at half-res.
  const extractUniforms = {
    tDiffuse: { value: target.texture },
    uTexel: { value: new THREE.Vector2(1 / 640, 1 / 360) },
  };
  const extractMat = new THREE.ShaderMaterial({
    uniforms: extractUniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: vertShader,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform vec2 uTexel;
      varying vec2 vUv;

      vec3 extractHdr(vec3 c) {
        float peak = max(c.r, max(c.g, c.b));
        float weight = smoothstep(0.95, 1.85, peak);
        return max(c - vec3(0.85), vec3(0.0)) * weight;
      }

      void main() {
        vec3 sum = extractHdr(texture2D(tDiffuse, vUv).rgb) * 0.227027;
        sum += extractHdr(texture2D(tDiffuse, vUv + vec2(uTexel.x * 1.5, 0.0)).rgb) * 0.1945946;
        sum += extractHdr(texture2D(tDiffuse, vUv - vec2(uTexel.x * 1.5, 0.0)).rgb) * 0.1945946;
        sum += extractHdr(texture2D(tDiffuse, vUv + vec2(uTexel.x * 3.5, 0.0)).rgb) * 0.1216216;
        sum += extractHdr(texture2D(tDiffuse, vUv - vec2(uTexel.x * 3.5, 0.0)).rgb) * 0.1216216;
        sum += extractHdr(texture2D(tDiffuse, vUv + vec2(uTexel.x * 5.5, 0.0)).rgb) * 0.0702703;
        sum += extractHdr(texture2D(tDiffuse, vUv - vec2(uTexel.x * 5.5, 0.0)).rgb) * 0.0702703;
        gl_FragColor = vec4(sum, 1.0);
      }
    `,
  });

  // Pass 2: Separable vertical Gaussian blur at half-res.
  const blurVUniforms = {
    tBloom: { value: bloomTargetA.texture },
    uTexel: { value: new THREE.Vector2(1 / 640, 1 / 360) },
  };
  const blurVMat = new THREE.ShaderMaterial({
    uniforms: blurVUniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: vertShader,
    fragmentShader: `
      uniform sampler2D tBloom;
      uniform vec2 uTexel;
      varying vec2 vUv;

      void main() {
        vec3 sum = texture2D(tBloom, vUv).rgb * 0.227027;
        sum += texture2D(tBloom, vUv + vec2(0.0, uTexel.y * 1.5)).rgb * 0.1945946;
        sum += texture2D(tBloom, vUv - vec2(0.0, uTexel.y * 1.5)).rgb * 0.1945946;
        sum += texture2D(tBloom, vUv + vec2(0.0, uTexel.y * 3.5)).rgb * 0.1216216;
        sum += texture2D(tBloom, vUv - vec2(0.0, uTexel.y * 3.5)).rgb * 0.1216216;
        sum += texture2D(tBloom, vUv + vec2(0.0, uTexel.y * 5.5)).rgb * 0.0702703;
        sum += texture2D(tBloom, vUv - vec2(0.0, uTexel.y * 5.5)).rgb * 0.0702703;
        gl_FragColor = vec4(sum, 1.0);
      }
    `,
  });

  const compositeUniforms = {
    tDiffuse: { value: target.texture },
    tBloom: { value: bloomTargetB.texture },
    tDepth: { value: target.depthTexture },
    uInkStep: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
  };
  const compositeMat = new THREE.ShaderMaterial({
    uniforms: compositeUniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: vertShader,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform sampler2D tBloom;
      uniform sampler2D tDepth;
      uniform vec2 uInkStep;
      varying vec2 vUv;

      float viewDistance(vec2 uv) {
        float depth = texture2D(tDepth, uv).r;
        return ${CAMERA_CLIP.near} / mix(1.0, ${CAMERA_CLIP.near / CAMERA_CLIP.far}, depth);
      }

      float inkCoverage(float peak) {
        float center = viewDistance(vUv);
        if (center > 1600.0 || peak >= 0.95) return 0.0;

        vec2 dx = vec2(uInkStep.x, 0.0);
        vec2 dy = vec2(0.0, uInkStep.y);
        float acrossX = max(viewDistance(vUv - dx), viewDistance(vUv + dx));
        float acrossY = max(viewDistance(vUv - dy), viewDistance(vUv + dy));
        float depthJump = (max(acrossX, acrossY) - center) / center;
        return smoothstep(0.035, 0.12, depthJump)
             * (1.0 - smoothstep(450.0, 1600.0, center))
             * (1.0 - smoothstep(0.68, 0.95, peak));
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
        vec3 inkColor = min(baseLinear, vec3(0.009, 0.011, 0.022));
        vec3 combined = mix(baseLinear, inkColor, ink * 0.88) + bloomLinear * 0.42;

        vec2 centered = vUv * 2.0 - 1.0;
        float vignette = clamp(1.0 - dot(centered, centered) * 0.14, 0.78, 1.0);
        combined *= vignette;

        vec3 displayColor = linearToSrgb(neutralToneMap(combined));

        float grain = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        gl_FragColor = vec4(displayColor + (grain - 0.5) / 255.0, 1.0);
      }
    `,
  });

  const sceneExtract = new THREE.Scene();
  sceneExtract.add(new THREE.Mesh(quadGeo, extractMat));

  const sceneBlurV = new THREE.Scene();
  sceneBlurV.add(new THREE.Mesh(quadGeo, blurVMat));

  const sceneComposite = new THREE.Scene();
  sceneComposite.add(new THREE.Mesh(quadGeo, compositeMat));

  function resize(cssWidth: number, cssHeight: number): void {
    const safeW = Math.max(1, Math.round(cssWidth));
    const safeH = Math.max(1, Math.round(cssHeight));
    const scale = Math.min(globalThis.devicePixelRatio || 1, MAX_INTERNAL_HEIGHT / safeH);
    const internalW = Math.max(1, Math.round(safeW * scale));
    const internalH = Math.max(1, Math.round(safeH * scale));
    const halfW = Math.max(1, Math.round(internalW * 0.5));
    const halfH = Math.max(1, Math.round(internalH * 0.5));

    target.setSize(internalW, internalH);
    bloomTargetA.setSize(halfW, halfH);
    bloomTargetB.setSize(halfW, halfH);

    extractUniforms.uTexel.value.set(1 / halfW, 1 / halfH);
    blurVUniforms.uTexel.value.set(1 / halfW, 1 / halfH);
    const inkWidth = Math.max(1, internalH / 800);
    compositeUniforms.uInkStep.value.set(inkWidth / internalW, inkWidth / internalH);
  }

  function renderToScreen(renderer: THREE.WebGLRenderer): void {
    renderer.setRenderTarget(bloomTargetA);
    renderer.render(sceneExtract, postCamera);

    renderer.setRenderTarget(bloomTargetB);
    renderer.render(sceneBlurV, postCamera);

    renderer.setRenderTarget(null);
    renderer.render(sceneComposite, postCamera);
  }

  function destroy(): void {
    target.dispose();
    bloomTargetA.dispose();
    bloomTargetB.dispose();
    quadGeo.dispose();
    extractMat.dispose();
    blurVMat.dispose();
    compositeMat.dispose();
  }

  return {
    target,
    resize,
    renderToScreen,
    destroy,
  };
}
