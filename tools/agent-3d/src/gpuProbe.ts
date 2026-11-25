import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleBrowserEntry, validateTimeout, WEBGPU_SWIFTSHADER_FLAGS, withHarnessPage, withTimeout } from './harness.js';

export const GPU_PROBE_MIN_COLORS = 50;
const PROBE_SIZE = 256;

export interface GpuProbeOptions {
  /** 'chrome' drives the installed Google Chrome (Playwright channel), 'chromium' the bundled build. */
  readonly browser: 'chrome' | 'chromium';
  readonly headed: boolean;
  readonly timeoutMs: number;
  readonly outDir?: string;
}

export interface GpuProbeBackendResult {
  readonly backend: string | null;
  readonly uniqueColors: number;
  readonly error: string | null;
}

export interface GpuProbeResult {
  readonly schemaVersion: 'agent-3d/gpu-probe/v1';
  readonly ok: boolean;
  readonly exitCode: 0 | 1 | 3 | 4;
  readonly verdict: 'webgpu-ok' | 'webgpu-blank' | 'webgl-fallback' | 'webgl-failed';
  readonly browser: string;
  readonly browserVersion: string | null;
  readonly flags: readonly string[];
  readonly navigatorGpu: boolean;
  readonly adapter: Readonly<Record<string, string>> | null;
  readonly webgpu: GpuProbeBackendResult;
  readonly webgl: GpuProbeBackendResult;
  readonly consoleErrors: readonly string[];
  readonly files: readonly string[];
}

const PROBE_SOURCE = `
import * as THREE_GPU from 'three/webgpu';
import * as THREE from 'three';

const SIZE = ${PROBE_SIZE};
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function buildScene(NS) {
  const scene = new NS.Scene();
  scene.background = new NS.Color(0x141826);
  const camera = new NS.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0.6, 4.2);
  camera.lookAt(0, 0, 0);
  const knot = new NS.Mesh(
    new NS.TorusKnotGeometry(0.9, 0.3, 160, 24),
    new NS.MeshStandardMaterial({ color: 0xe88332, roughness: 0.45, metalness: 0.1 }),
  );
  knot.rotation.set(0.4, 0.6, 0);
  scene.add(knot);
  const key = new NS.DirectionalLight(0xfff1dc, 2.4);
  key.position.set(3, 4, 2);
  scene.add(key);
  const rim = new NS.DirectionalLight(0x6b88ff, 1.4);
  rim.position.set(-3, 1, -3);
  scene.add(rim);
  scene.add(new NS.HemisphereLight(0xaab8e0, 0x242038, 0.6));
  return { scene, camera };
}

async function countColors(dataUrl) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const seen = new Set();
  for (let i = 0; i < px.length; i += 4) seen.add((px[i] << 24) | (px[i + 1] << 16) | (px[i + 2] << 8) | px[i + 3]);
  return seen.size;
}

function newCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  document.body.appendChild(canvas);
  return canvas;
}

export async function probe() {
  const out = { navigatorGpu: Boolean(navigator.gpu), adapter: null, webgpu: null, webgl: null };

  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const info = adapter.info || {};
        out.adapter = {
          vendor: String(info.vendor || ''),
          architecture: String(info.architecture || ''),
          device: String(info.device || ''),
          description: String(info.description || ''),
        };
      }
    } catch (err) {
      out.adapter = { error: String(err && err.message || err) };
    }
  }

  try {
    const canvas = newCanvas();
    const renderer = new THREE_GPU.WebGPURenderer({ canvas, antialias: false });
    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE, false);
    await renderer.init();
    const backend = renderer.backend.isWebGPUBackend ? 'WebGPUBackend'
      : renderer.backend.isWebGLBackend ? 'WebGLBackend' : String(renderer.backend.constructor.name);
    const { scene, camera } = buildScene(THREE_GPU);
    // Default framebuffer, then wait for the GPU queue and two frames before reading pixels back.
    renderer.render(scene, camera);
    if (renderer.backend.device) await renderer.backend.device.queue.onSubmittedWorkDone();
    await nextFrame();
    await nextFrame();
    const dataUrl = canvas.toDataURL('image/png');
    out.webgpu = { backend, uniqueColors: await countColors(dataUrl), error: null, dataUrl };
    renderer.dispose();
  } catch (err) {
    out.webgpu = { backend: null, uniqueColors: 0, error: String(err && err.message || err), dataUrl: null };
  }

  try {
    const canvas = newCanvas();
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE, false);
    const { scene, camera } = buildScene(THREE);
    renderer.render(scene, camera);
    const dataUrl = canvas.toDataURL('image/png');
    out.webgl = { backend: 'WebGLRenderer', uniqueColors: await countColors(dataUrl), error: null, dataUrl };
    renderer.dispose();
  } catch (err) {
    out.webgl = { backend: null, uniqueColors: 0, error: String(err && err.message || err), dataUrl: null };
  }
  return out;
}
`;

interface RawBackend extends GpuProbeBackendResult {
  readonly dataUrl: string | null;
}

interface RawProbe {
  readonly navigatorGpu: boolean;
  readonly adapter: Record<string, string> | null;
  readonly webgpu: RawBackend;
  readonly webgl: RawBackend;
}

export function classifyGpuProbe(
  webgpu: GpuProbeBackendResult,
  webgl: GpuProbeBackendResult,
): Pick<GpuProbeResult, 'exitCode' | 'verdict'> {
  if (webgpu.backend === 'WebGPUBackend') {
    return webgpu.uniqueColors >= GPU_PROBE_MIN_COLORS
      ? { exitCode: 0, verdict: 'webgpu-ok' }
      : { exitCode: 1, verdict: 'webgpu-blank' };
  }
  // A WebGL2 fallback canvas reads back transparent, so it is never graded as a WebGPU pass.
  return webgl.error === null && webgl.uniqueColors >= GPU_PROBE_MIN_COLORS
    ? { exitCode: 3, verdict: 'webgl-fallback' }
    : { exitCode: 4, verdict: 'webgl-failed' };
}

function stripImage({ backend, uniqueColors, error }: RawBackend): GpuProbeBackendResult {
  return { backend, uniqueColors, error };
}

function reportMarkdown(r: GpuProbeResult): string {
  const row = (name: string, b: GpuProbeBackendResult): string =>
    `| ${name} | ${b.backend ?? '-'} | ${b.uniqueColors} | ${b.error ?? ''} |`;
  return [
    '# agent-3d gpu-probe',
    '',
    `Verdict: **${r.verdict}** (exit ${r.exitCode}). Browser: ${r.browser} ${r.browserVersion ?? ''}.`,
    '',
    `navigator.gpu: ${r.navigatorGpu}. Adapter: ${r.adapter === null ? 'none' : JSON.stringify(r.adapter)}.`,
    '',
    '| Renderer | Backend | Unique colours | Error |',
    '| --- | --- | ---: | --- |',
    row('WebGPURenderer', r.webgpu),
    row('WebGLRenderer', r.webgl),
    '',
    `Pass needs the WebGPU backend and at least ${GPU_PROBE_MIN_COLORS} unique colours.`,
    '',
    `Flags: \`${r.flags.join(' ')}\``,
    '',
    ...(r.consoleErrors.length > 0 ? ['Console errors:', '', ...r.consoleErrors.map((e) => `- ${e}`), ''] : []),
  ].join('\n');
}

export async function runGpuProbe(options: GpuProbeOptions): Promise<GpuProbeResult> {
  const timeoutMs = validateTimeout(options.timeoutMs);
  const jsBundle = await bundleBrowserEntry(PROBE_SOURCE, path.dirname(fileURLToPath(import.meta.url)));
  const flags = WEBGPU_SWIFTSHADER_FLAGS;
  return withHarnessPage(
    {
      jsBundle,
      args: flags,
      headless: !options.headed,
      timeoutMs,
      ...(options.browser === 'chrome' ? { channel: 'chrome' as const } : {}),
    },
    async (h) => {
      const raw = await withTimeout(
        h.page.evaluate(async (url) => {
          const { probe } = await import(url);
          return probe() as Promise<RawProbe>;
        }, `${h.baseUrl}/harness.js`),
        timeoutMs,
        'GPU probe',
      );
      const webgpu = stripImage(raw.webgpu);
      const webgl = stripImage(raw.webgl);
      const files: string[] = [];
      if (options.outDir !== undefined) {
        const dir = path.resolve(options.outDir);
        fs.mkdirSync(dir, { recursive: true });
        for (const [name, b] of [['webgpu.png', raw.webgpu], ['webgl.png', raw.webgl]] as const) {
          if (b.dataUrl?.startsWith('data:image/png;base64,') === true) {
            const file = path.join(dir, name);
            fs.writeFileSync(file, Buffer.from(b.dataUrl.slice('data:image/png;base64,'.length), 'base64'));
            files.push(file);
          }
        }
        files.push(path.join(dir, 'probe.json'), path.join(dir, 'REPORT.md'));
      }
      const verdict = classifyGpuProbe(webgpu, webgl);
      const final: GpuProbeResult = {
        schemaVersion: 'agent-3d/gpu-probe/v1',
        ok: verdict.exitCode === 0,
        ...verdict,
        browser: options.browser,
        browserVersion: h.page.context().browser()?.version() ?? null,
        flags,
        navigatorGpu: raw.navigatorGpu,
        adapter: raw.adapter,
        webgpu,
        webgl,
        consoleErrors: [...h.consoleErrors, ...h.pageErrors],
        files,
      };
      if (options.outDir !== undefined) {
        const dir = path.resolve(options.outDir);
        fs.writeFileSync(path.join(dir, 'probe.json'), `${JSON.stringify(final, null, 2)}\n`);
        fs.writeFileSync(path.join(dir, 'REPORT.md'), reportMarkdown(final));
      }
      return final;
    },
  );
}
