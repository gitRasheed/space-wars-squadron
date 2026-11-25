---
name: agent-3d
description: Check 3D assets (.glb or Three.js factory modules) with deterministic mesh, palette and shape gates, render labeled 9-view contact sheets (single asset or a whole directory), probe headless WebGPU, and run a blind visual critic.
---

# agent-3d

Headless 3D verification for coding agents: Three.js in Playwright Chromium over SwiftShader WebGL. [README.md](README.md) has every flag, the style card reference and exit codes. This file covers how to use it while iterating on an asset.

## Setup

From the package directory, with Node.js 20 or later:

```bash
npm ci && npx playwright install chromium && npm run build
```

## Loop

1. **Gate the asset.** `node dist/cli.js turntable <asset> --card card.json --out out/<asset>`. Exit 0 passes, 1 is a gate failure (read `findings` in the JSON), 2 is bad input or a renderer problem (read stderr).
2. **Gate the whole set** after a shared change such as a material, palette or lighting tweak: `node dist/cli.js batch <dir> --card card.json --out out/batch`. Read the table on stderr; open `out/batch/<name>/report.json` for any FAIL or ERROR row.
3. **Look closer** when the critic or a finding points at a detail: `--tile-size 840x630 --zoom 1.4 --save-views` writes full-size single views such as `persp-three-quarter.png`. `--zoom` only crops the perspective views; the ortho views stay whole unless you add `--zoom-ortho`. Add `--black-fill` for `silhouette-sheet.png` (batch: `black-fill-masks.png`), the top and front views as black on white, to judge whether the silhouette reads without color or lighting. Use `--lighting cel` to see the asset under stylized game-style lighting, and `--lighting dramatic` to check that forms still read with deep shadows.
4. **Run the blind critic** on `contact-sheet.png` (below).
5. Fix **one issue class per iteration**, re-run with the same card, and re-check with a fresh critic context.

Things that commonly trip agents:

- `CONSOLE_ERROR` usually means a shader failed to compile or a factory logged an error. The finding quotes the first message and `consoleErrors` has the rest. Fix the cause; use `--no-fail-on-console-error` only for a known, harmless third-party message.
- `PALETTE_DELTA_E_EXCEEDED` names the mesh, the sampled color and the nearest role. `metrics.palette.colors` lists every sampled color, so check whether the color is a mistake or the card is missing a role. A `ShaderMaterial` is scored from its `uAlbedo` / `uColor` / `color` uniform plus `uEmissive` × `uEmissiveIntensity` (rename them with the card's `shaderColorUniforms` and `shaderEmissiveUniforms`). Textured surfaces and shaders with none of those uniforms are not scored; review them on the sheet.
- `VIEW_EDGE_CLIPPED` as a fail (an unzoomed view) means the bounds include something far from the body, often a stray or hidden-by-material mesh.
- `INVERTED_WINDING` means triangle order is reversed; flip the index order or the scale sign rather than switching the material to `DoubleSide`.
- Shape values (`metrics.shape`) are always reported. Only gate on them (card `geometry`) after confirming every asset in the set meets the rule; a deliberately asymmetric design is not a defect.

## Factory contract

A browser-compatible `.ts`, `.mts`, `.js` or `.mjs` module exports `buildAsset(THREE)` (or a default function) returning `THREE.Object3D` or a promise of one. It may import project code; the CLI bundles everything against one shared copy of `three`.

## WebGPU smoke job

`node dist/cli.js gpu-probe --out out/gpu` answers whether WebGPU actually renders on this machine. Exit 0 means it does; exit 3 means three.js silently fell back to WebGL, so a WebGPU-only bug would go unnoticed. Keep the turntable on WebGL as the pixel gate and run the probe separately.

## Blind visual critic

Mechanical gates decide budgets, bounds, palette, degeneracy and framing. A blind visual critic judges silhouette, proportions, symmetry and readability.

Give the critic **only** `contact-sheet.png` (or saved views) and a short design brief. Never include builder source code, commit messages or earlier scores.

```text
You are a visual critic for a game-ready 3D asset. You are looking at a labeled 9-view contact sheet:
persp-front, persp-three-quarter, persp-right, persp-back, persp-left, persp-hero-low,
ortho-front, ortho-right, ortho-top.

Do not invent views not on the sheet. Score each axis 1–5 and cite at least one view ID and concrete visual fact for every score:
1. Silhouette & readability (distinctive outline from front, back, side, and ortho-top?)
2. Proportions & symmetry (do wings, engines, hulls, and turrets agree across views?)
3. Completeness & intersections (missing parts, floating geometry, unintended clipping?)
4. Material & form readability (clear separation between hull, trim, accents, and cockpit/canopy?)

Target: every axis >= 4. If any axis is < 4, list at most 3 concrete fixes (most severe first), naming the exact view ID and magnitude.
Finish with one line: PASS, PARTIAL, or FAIL.
```
