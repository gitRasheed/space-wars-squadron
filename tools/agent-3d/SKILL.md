---
name: agent-3d
description: Inspect 3D assets (.glb or Three.js factory modules) with deterministic mesh/style-lock gates, 9-view labeled contact sheets, and a blind visual critic rubric.
---

# agent-3d

Headless 3D verification and visual iteration for coding agents (Three.js + Playwright Chromium WebGL).

## Install & Commands

```bash
npm install -g agent-3d   # or npx agent-3d (Node >= 20)

# Mechanical geometry, budget, bounds, and authored flat-color check
agent-3d check path/to/model.glb --card style-card.json --out report.json

# 9-view labeled contact sheet + internal silhouette framing mask + mechanical gate
agent-3d turntable path/to/factory.ts --card style-card.json --out out/turntable
```

Exit codes: `0` pass, `1` measured violation, `2` invalid input, unavailable renderer, or unsupported required gate (e.g., `requirePaletteOnTextured: true` on a textured mesh).

## Minimal `style-card.json`

```json
{
  "id": "lowpoly-starships",
  "frontAxis": "-Z",
  "topUpAxis": "-Z",
  "pivot": "center",
  "pivotToleranceFraction": 0.1,
  "palette": {
    "hull": "#dfd9cc",
    "accent": "#e88332",
    "ink": "#070712"
  },
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
  }
}
```

## Factory Module Contract

A browser-compatible `.ts` / `.mjs` / `.js` adapter exports `buildAsset(THREE)` (or default export) returning `THREE.Object3D | Promise<THREE.Object3D>`. The CLI bundles it against one shared copy of `three`, awaits readiness, measures world-transformed bounds before camera centering, and renders all 9 views from the same root.

## Blind Visual Critic Workflow

Mechanical gates (`report.json`) decide budgets, bounds, degeneracy, and framing; a **blind visual critic** judges silhouette, proportions, symmetry, and readability.

**Strict rule:** Give the critic **only** `contact-sheet.png` and the short design brief. Never include builder source code, commit messages, or prior scores.

### Blind Critic Prompt

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

Apply at most **one issue class per iteration**, re-run `turntable` with the same card, and re-check with a fresh critic context.
