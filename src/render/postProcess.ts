import * as THREE from 'three';

export interface StylizedPostPass {
  readonly target: THREE.WebGLRenderTarget;
  readonly resize: (cssWidth: number, cssHeight: number) => void;
  readonly renderToScreen: (renderer: THREE.WebGLRenderer) => void;
  readonly destroy: () => void;
}

const TARGET_INTERNAL_HEIGHT = 480;

export function createStylizedPostPass(): StylizedPostPass {
  const target = new THREE.WebGLRenderTarget(854, TARGET_INTERNAL_HEIGHT, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
  });

  const postScene = new THREE.Scene();
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const uniforms = {
    tDiffuse: { value: target.texture },
    uResolution: { value: new THREE.Vector2(854, TARGET_INTERNAL_HEIGHT) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform vec2 uResolution;
      varying vec2 vUv;

      float bayer4(vec2 p) {
        vec2 c = mod(floor(p), 4.0);
        int x = int(c.x);
        int y = int(c.y);
        int idx = y * 4 + x;
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

      vec3 acesToneMap(vec3 x) {
        const float a = 2.51;
        const float b = 0.03;
        const float c = 2.43;
        const float d = 0.59;
        const float e = 0.14;
        return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
      }

      vec3 linearToSrgb(vec3 linearColor) {
        return pow(max(linearColor, vec3(0.0)), vec3(1.0 / 2.2));
      }

      vec3 brightOnly(vec3 c) {
        float lum = dot(c, vec3(0.299, 0.587, 0.114));
        return c * smoothstep(0.78, 1.4, lum);
      }

      void main() {
        vec2 texel = 1.0 / uResolution;
        vec3 baseLinear = texture2D(tDiffuse, vUv).rgb;

        vec3 bloomLinear = vec3(0.0);
        bloomLinear += brightOnly(texture2D(tDiffuse, vUv + vec2(texel.x * 2.0, 0.0)).rgb);
        bloomLinear += brightOnly(texture2D(tDiffuse, vUv + vec2(-texel.x * 2.0, 0.0)).rgb);
        bloomLinear += brightOnly(texture2D(tDiffuse, vUv + vec2(0.0, texel.y * 2.0)).rgb);
        bloomLinear += brightOnly(texture2D(tDiffuse, vUv + vec2(0.0, -texel.y * 2.0)).rgb);
        bloomLinear += brightOnly(texture2D(tDiffuse, vUv + vec2(texel.x * 3.0, texel.y * 3.0)).rgb) * 0.6;
        bloomLinear += brightOnly(texture2D(tDiffuse, vUv + vec2(-texel.x * 3.0, texel.y * 3.0)).rgb) * 0.6;
        bloomLinear += brightOnly(texture2D(tDiffuse, vUv + vec2(texel.x * 3.0, -texel.y * 3.0)).rgb) * 0.6;
        bloomLinear += brightOnly(texture2D(tDiffuse, vUv + vec2(-texel.x * 3.0, -texel.y * 3.0)).rgb) * 0.6;

        vec3 exposed = (baseLinear + bloomLinear * 0.12) * 1.15;
        vec3 displayColor = linearToSrgb(acesToneMap(exposed));

        vec2 pixelCoord = vUv * uResolution;
        float lum = dot(displayColor, vec3(0.299, 0.587, 0.114));
        float ditherStrength = mix(0.014, 0.032, smoothstep(0.12, 0.72, lum));
        float dither = (bayer4(pixelCoord) - 0.5) * ditherStrength;
        displayColor = floor(clamp(displayColor + dither, 0.0, 1.0) * 30.0 + 0.5) / 30.0;

        vec2 centered = vUv * 2.0 - 1.0;
        float vignette = 1.0 - dot(centered, centered) * 0.12;
        displayColor *= clamp(vignette, 0.78, 1.0);

        gl_FragColor = vec4(displayColor, 1.0);
      }
    `,
  });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  postScene.add(quad);

  function resize(cssWidth: number, cssHeight: number): void {
    const safeW = Math.max(1, cssWidth);
    const safeH = Math.max(1, cssHeight);
    const aspect = safeW / safeH;
    const internalH = TARGET_INTERNAL_HEIGHT;
    const internalW = Math.max(1, Math.round(internalH * aspect));
    target.setSize(internalW, internalH);
    uniforms.uResolution.value.set(internalW, internalH);
  }

  function renderToScreen(renderer: THREE.WebGLRenderer): void {
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);
  }

  function destroy(): void {
    target.dispose();
    quad.geometry.dispose();
    material.dispose();
  }

  return {
    target,
    resize,
    renderToScreen,
    destroy,
  };
}
