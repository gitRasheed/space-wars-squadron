# agent-3d

Headless checks for 3D game assets, built for coding agents. Point it at a binary glTF (`.glb`) or a Three.js factory module and it measures the mesh, checks it against a style card, and renders a labeled nine-view contact sheet in headless Chromium. Every command prints a JSON report and exits 0 (pass), 1 (gate failed) or 2 (bad input, timeout, renderer error or unsupported gate).

MIT licensed. Needs Node.js 20 or later.

## Install

```bash
npm ci
npx playwright install chromium
npm run build
```

From another directory, pack once with `npm pack` and run the tarball:

```bash
npx --package=/absolute/path/to/agent-3d-0.1.0.tgz -- agent-3d check ./model.glb
```

## Commands

```bash
agent-3d check <asset> [--card card.json] [--out report.json]
agent-3d turntable <asset> --out <dir> [--card card.json] [capture options]
agent-3d batch <dir> --out <dir> [--card card.json] [capture options]
agent-3d gpu-probe [--out <dir>] [--browser chrome|chromium] [--headed]
```

`<asset>` is a `.glb` or a factory module (`.ts`, `.mts`, `.js`, `.mjs`). All commands accept `--timeout <ms>` (default 30000), which also bounds factory loading.

**check** measures geometry and authored colors without rendering. It reports triangle, material and texture counts, degenerate triangles, world bounds, shape (length, width, height, mirror symmetry, ground offset and footprint) and every sampled color with its nearest palette role.

**turntable** runs the same checks, then renders nine views (`persp-front`, `persp-three-quarter`, `persp-right`, `persp-back`, `persp-left`, `persp-hero-low`, `ortho-front`, `ortho-right`, `ortho-top`) into `<dir>/contact-sheet.png` and writes `<dir>/report.json`. Each view is gated: the subject must be visible, must not touch the tile edge, must not be a single flat color, and backface culling must not hide more than half of the nearest `FrontSide` surface (a sign of inverted winding).

Capture options for `turntable` and `batch`:

| Flag | Default | Effect |
| --- | --- | --- |
| `--tile-size <WxH>` | `420x315` | Pixel size of each view, 64 to 2048 per side. Use `840x630` to inspect seams and glints. |
| `--zoom <factor>` | `1` | Camera zoom, 0.25 to 8. Above 1, edge clipping is reported as info, and so is a flat tile the subject fills completely. |
| `--lighting <preset>` | `studio` | `studio`: soft key, rim and sky fill with ACES tone mapping. `cel`: hard warm key, cool rim and a violet sky fill with no tone mapping, close to how stylized toon games light their models. `dramatic`: low raking key, faint rim, deep shadows. Presets change lights and tone mapping only. |
| `--save-views` | off | Also write `<view-id>.png` for each view next to the contact sheet. |
| `--no-fail-on-console-error` | off | Report browser console errors as a warning instead of failing. |

**Console errors.** Both `check` and `turntable` capture `console.error` output from the page, including Three.js shader compile and link errors. Any console error fails the run with a `CONSOLE_ERROR` finding that quotes the first message; all messages (up to 20, truncated) are in `consoleErrors`. `--fail-on-console-error` states the default explicitly. Shader errors only show up in `turntable`, because `check` never renders.

**batch** runs `turntable` on every `.glb`, `.ts`, `.mts`, `.js` and `.mjs` file in a directory (not recursive, `.d.ts` skipped, sorted by name) with one card and one set of capture options. Each asset gets `<out>/<name>/contact-sheet.png` and `report.json`. A crash or timeout on one asset becomes an error row and the batch continues. It prints one compact JSON summary to stdout, a table to stderr, and writes both to `<out>/summary.json` and `<out>/summary.txt`:

```text
asset    tris  degen  palette           samples  maxΔE76  result
-------  ----  -----  ----------------  -------  -------  ------
crate    12    0      assessed          1        0.00     PASS
lantern  944   0      partial_textured  42       14.20    FAIL
lantern: PALETTE_DELTA_E_EXCEEDED
1/2 passed against card 'props'
```

The exit code is the worst per-asset code: 1 if any gate failed, 2 if any asset errored.

**gpu-probe** checks whether headless Chrome can render through WebGPU on this machine. It renders the same lit scene with `WebGPURenderer` and `WebGLRenderer`, flushes the GPU queue and waits two frames before reading pixels, and writes `probe.json`, `REPORT.md`, `webgpu.png` and `webgl.png` to `--out`. It launches the installed Google Chrome by default (`--browser chromium` uses Playwright's build) with the SwiftShader flag set:

```text
--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --enable-unsafe-webgpu
--enable-features=Vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --ignore-gpu-blocklist
```

Do not add `--disable-vulkan-surface`; it blanks compositor screenshots. Exit codes: 0 WebGPU rendered at least 50 unique colors, 1 WebGPU backend but a blank capture, 2 launch error, 3 three.js silently fell back to WebGL, 4 WebGL failed too. The turntable itself always uses WebGL; treat the probe as a separate smoke job.

## Style card

```json
{
  "id": "lowpoly-starships",
  "frontAxis": "-Z",
  "topUpAxis": "-Z",
  "pivot": "center",
  "pivotToleranceFraction": 0.1,
  "palette": { "hull": "#dfd9cc", "accent": "#e88332", "ink": "#070712" },
  "paletteDeltaE76Max": 8,
  "requirePaletteOnTextured": false,
  "separationMinDeltaE76": 12,
  "separationRoles": [["hull", "accent"]],
  "budgets": {
    "trisMax": 2000,
    "materialsMax": 12,
    "texturesMax": 4,
    "bytesMax": 200000,
    "degenerateTrianglesMax": 0,
    "requireTriangleLists": true
  },
  "geometry": {
    "groundContact": true,
    "groundToleranceFraction": 0.01,
    "groundFootprintMin": 0.25,
    "mirrorSymmetryMin": 0.95,
    "symmetryToleranceFraction": 0.01,
    "lengthToWidth": [1, 4],
    "heightToLength": [0.1, 0.6]
  }
}
```

Every key except `id` is optional, and unknown keys are rejected.

- **Axes.** `frontAxis` is the direction the asset faces; it sets the front view and the length axis. `topUpAxis` is screen-up in the top view and cannot be ±Y.
- **Palette.** For each untextured material the checker adds emissive color times intensity to the linear base color (after vertex and instance tinting), clamps to the sRGB gamut, and takes the CIE76 distance to the nearest role. The worst sample must stay within `paletteDeltaE76Max`. Meshes colored by a texture, or by a `ShaderMaterial` with no `color`, cannot be scored this way and are listed as info for visual review. `requirePaletteOnTextured: true` turns the textured case into an unsupported-gate exit 2. The report's `palette.colors` lists the 48 most-sampled colors with their nearest role, which is the quickest way to build or tune a palette.
- **Geometry.** All shape values are always reported; these keys turn them into gates. Ground contact needs the lowest point on y=0. The footprint is the x/z box of vertices within tolerance of the lowest point, divided by the full x/z box; a small value means the asset balances on a point or edge. Mirror symmetry is the share of vertices whose reflection across the width-axis mid-plane lands within tolerance of another vertex. Aspect ranges are inclusive `[min, max]`, with length measured along `frontAxis`.
- **Budgets.** `bytesMax` and `requireTriangleLists` apply only to GLB input and are listed as skipped for factories. Degenerate triangles fail at any count above `degenerateTrianglesMax` (default 0), with or without a card.

Bounds come from the vertices Three.js actually draws, after node transforms and accessor dequantization, so quantized GLBs (`KHR_mesh_quantization`, normalized integer positions) report real-world bounds. A test pins this against `getBounds()` from `@gltf-transform/core`.

## Factory modules

A factory is a browser-compatible module that exports `buildAsset(THREE)` (or a default function) returning a `THREE.Object3D` or a promise of one. The CLI bundles it with esbuild against one shared copy of `three`, so a factory may import project code that imports `three`. Its `console.error` calls count as console errors.

```js
export function buildAsset(THREE) {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 2), new THREE.MeshStandardMaterial({ color: 0xe88332 }));
}
```

## Library use

```ts
import { runAssetSession, evaluateAssetGates } from 'agent-3d';

const session = await runAssetSession({ assetPath: 'ship.glb', card: null, renderSheet: false });
const { ok, findings } = evaluateAssetGates(session.metrics, null, undefined, { consoleErrors: session.consoleErrors });
```

## Development

```bash
npm test        # type-checks, then runs the CLI and Chromium regression suite (about a minute)
```

[SKILL.md](SKILL.md) is the agent-facing guide: the iteration loop and the blind visual critic prompt.
