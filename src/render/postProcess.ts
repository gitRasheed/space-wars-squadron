import * as THREE from 'three';

export interface StylizedPostPass {
  readonly target: THREE.WebGLRenderTarget;
  readonly resize: (cssWidth: number, cssHeight: number) => void;
  readonly renderToScreen: (renderer: THREE.WebGLRenderer) => void;
  readonly destroy: () => void;
}

const MAX_INTERNAL_HEIGHT = 900;

export function createStylizedPostPass(): StylizedPostPass {
  const target = new THREE.WebGLRenderTarget(1280, 720, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    samples: 4,
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

  // Pass 3: Neutral highlight rolloff, HDR bloom composite, vignette before dither+quantize.
  const compositeUniforms = {
    tDiffuse: { value: target.texture },
    tBloom: { value: bloomTargetB.texture },
    uResolution: { value: new THREE.Vector2(1280, 720) },
  };
  const compositeMat = new THREE.ShaderMaterial({
    uniforms: compositeUniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: vertShader,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform sampler2D tBloom;
      uniform vec2 uResolution;
      varying vec2 vUv;

      float bayer4(vec2 p) {
        vec2 c = mod(floor(p), 4.0);
        int idx = int(c.y) * 4 + int(c.x);
        if (idx == 0) return 0.0 / 16.0;
        if (idx == 1) return 8.0 / 16.0;
        if (idx == 2) return 2.0 / 16.0;
        if (idx == 3) return 10.0 / 16.0;
        if (idx == 4) return 12.0 / 16.0;
        if (idx == 5) return 4.0 / 16.0;
        if (idx == 6) return 14.0 / 16.0;
        if (idx == 7) return 6.0 / 16.0;
        if (idx == 8) return 3.0 / 16.0;
        if (idx == 9) return 11.0 / 16.0;
        if (idx == 10) return 1.0 / 16.0;
        if (idx == 11) return 9.0 / 16.0;
        if (idx == 12) return 15.0 / 16.0;
        if (idx == 13) return 7.0 / 16.0;
        if (idx == 14) return 13.0 / 16.0;
        return 5.0 / 16.0;
      }

      // Khronos PBR Neutral-inspired highlight rolloff preserves cel palette hues while rolling HDR glows cleanly to white.
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
        vec3 combined = baseLinear + bloomLinear * 0.42;

        vec2 centered = vUv * 2.0 - 1.0;
        float vignette = clamp(1.0 - dot(centered, centered) * 0.14, 0.78, 1.0);
        combined *= vignette;

        vec3 displayColor = linearToSrgb(neutralToneMap(combined));

        vec2 pixelCoord = vUv * uResolution;
        float dither = (bayer4(pixelCoord) - 0.5) * (0.85 / 48.0);
        displayColor = floor(clamp(displayColor + dither, 0.0, 1.0) * 48.0 + 0.5) / 48.0;

        gl_FragColor = vec4(displayColor, 1.0);
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
    const scale = safeH > MAX_INTERNAL_HEIGHT ? MAX_INTERNAL_HEIGHT / safeH : 1;
    const internalW = Math.max(1, Math.round(safeW * scale));
    const internalH = Math.max(1, Math.round(safeH * scale));
    const halfW = Math.max(1, Math.round(internalW * 0.5));
    const halfH = Math.max(1, Math.round(internalH * 0.5));

    target.setSize(internalW, internalH);
    bloomTargetA.setSize(halfW, halfH);
    bloomTargetB.setSize(halfW, halfH);

    extractUniforms.uTexel.value.set(1 / halfW, 1 / halfH);
    blurVUniforms.uTexel.value.set(1 / halfW, 1 / halfH);
    compositeUniforms.uResolution.value.set(internalW, internalH);
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
