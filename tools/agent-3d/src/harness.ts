import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { chromium, type Page } from 'playwright';

export const DEFAULT_TIMEOUT_MS = 30000;

const requireFromHere = createRequire(import.meta.url);
// Works on Node 20.0.0+ without relying on import.meta.resolve (added in 20.6).
const THREE_BUILD_DIR = path.dirname(requireFromHere.resolve('three'));
const THREE_DIR = path.resolve(THREE_BUILD_DIR, '..');

export const WEBGL_SWIFTSHADER_FLAGS: readonly string[] = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

// Never add --disable-vulkan-surface: it blanks compositor screenshots under the WebGPU adapter.
export const WEBGPU_SWIFTSHADER_FLAGS: readonly string[] = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  '--ignore-gpu-blocklist',
];

const MAX_CONSOLE_ERRORS = 20;
const MAX_CONSOLE_ERROR_CHARS = 600;

export function validateTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new Error('--timeout must be a positive integer in milliseconds (at most 2147483647)');
  }
  return timeoutMs;
}

export async function bundleBrowserEntry(source: string, resolveDir: string): Promise<string> {
  const result = await esbuild.build({
    stdin: { contents: source, resolveDir, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    // Longest keys first so 'three/webgpu' never resolves as a path under three.module.js.
    alias: {
      'three/webgpu': path.resolve(THREE_BUILD_DIR, 'three.webgpu.js'),
      'three/examples': path.resolve(THREE_DIR, 'examples'),
      three: path.resolve(THREE_BUILD_DIR, 'three.module.js'),
    },
    logOverride: { 'import-is-undefined': 'silent' },
  });
  const text = result.outputFiles[0]?.text;
  if (text === undefined) {
    throw new Error('Failed to bundle browser harness');
  }
  return text;
}

export async function withTimeout<T>(execution: Promise<T>, ms: number, what = 'Asset execution'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    });
    return await Promise.race([execution, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export interface HarnessPage {
  readonly page: Page;
  readonly baseUrl: string;
  /** console.error output and WebGL/WebGPU diagnostics, in arrival order, truncated. */
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
}

export interface HarnessOptions {
  readonly jsBundle: string;
  readonly files?: ReadonlyMap<string, { readonly type: string; readonly body: Buffer }>;
  readonly args: readonly string[];
  readonly channel?: 'chrome';
  readonly headless?: boolean;
  readonly timeoutMs: number;
}

// Serves the bundle from an ephemeral loopback port, opens one page, and always tears both down.
export async function withHarnessPage<T>(options: HarnessOptions, fn: (h: HarnessPage) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><link rel="icon" href="data:,"></head><body></body></html>');
      return;
    }
    if (url === '/harness.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(options.jsBundle);
      return;
    }
    const file = options.files?.get(url);
    if (file !== undefined) {
      res.writeHead(200, { 'Content-Type': file.type });
      res.end(file.body);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind ephemeral HTTP port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let browser;
  try {
    browser = await chromium.launch({
      headless: options.headless ?? true,
      args: [...options.args],
      ...(options.channel !== undefined ? { channel: options.channel } : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const push = (list: string[], text: string): void => {
      if (list.length < MAX_CONSOLE_ERRORS) {
        list.push(text.length > MAX_CONSOLE_ERROR_CHARS ? `${text.slice(0, MAX_CONSOLE_ERROR_CHARS)}…` : text);
      }
    };
    page.on('console', (msg) => {
      if (msg.type() === 'error') push(consoleErrors, msg.text());
    });
    page.on('pageerror', (err) => push(pageErrors, err.message));
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    return await fn({ page, baseUrl, consoleErrors, pageErrors });
  } finally {
    if (browser !== undefined) {
      await browser.close();
    }
    server.close();
  }
}
