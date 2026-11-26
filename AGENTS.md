# Space War Squadrons — Agent Working Rules

## Module Boundaries
- `src/sim/` is pure TypeScript simulation (zero Three.js, zero DOM, deterministic at 60 Hz).
- `src/render/` owns Three.js, cameras, shaders, palette, and HUD drawing.
- `src/audio/` owns Web Audio synthesis and soundtrack scheduling; every audio node must route behind the master bus.
- Level scores and composers live in `scripts/audio/` and use `kleos`. Ship adapters use `agent-threejs-turntable` from `scripts/asset-qa/`, which has its own Three.js version. ESLint keeps both tools out of `src/` and `tests/`.

## Invariants (Derive, Do Not Copy)
- **Camera ↔ HUD ↔ Ballistics:** Derive gun convergence, muzzle offsets, lead intercept, and HUD reticle projection from one shared source so projectiles and reticle cannot drift across camera modes or FOV changes.
- **Visual Meshes ↔ Sim Hitboxes:** Targetable ship subsystems and weapon mounts read one shared layout rather than hardcoding coordinates in both simulation and meshes.
- **Lifecycle & Pause:** Keep all sortie modes in one exhaustive discriminated union; pointer-lock exit and window focus loss during active flight must pause idempotently without ever unpausing.
- **Audio Parity:** Keep the in-game combat soundtrack in voice and note parity with its game-owned recipe (pinned by audio tests).

## Verification Gates
Run the gates matching what you changed before claiming done or committing:
- **Core code (`src/`, `tests/`):** `npm run check` (`tsc`, `eslint`, `vitest`, `vite build`)
- **Sim state machines (`src/sim/`, `formal/`):** `npm run verify:formal`
- **Gameplay / rendering / HUD (`src/render/`, `src/input/`):** `npm run verify:browser` (set `VERIFY_OUT_DIR=artifacts/verify-<worker>` for concurrent runs; inspect screenshots)
- For 3D ship models, install the turntable with `npm --prefix scripts/asset-qa ci` and its Chromium build with `npm --prefix scripts/asset-qa exec -- playwright install --only-shell chromium`. Run `npm run turntable -- turntable scripts/ship-adapters/<ship>.ts --card scripts/ship-adapters/space-wars-card.json --out artifacts/turntable/<ship>`. Inspect `contact-sheet.png` and check for zero degenerate triangles.
- For combat audio, run `npm run verify:audio` to render and check the game recipes with Kleos. For level scores, run `scripts/audio/bake.sh` from the repo root.

## Tooling Feedback
- If any local tool or verification gate (`verify:audio`, `turntable`, `verify:browser`, `verify:formal`, or `npm run check`) gets in your way, produces confusing output, or has false positives/negatives, include a brief **Tooling Feedback** section in your report describing what happened.

## Implementation Journal
- Keep a local, git-ignored, append-only `IMPLEMENTATION_JOURNAL.md` at the repo root for design principles, live playtest reactions, and milestone retrospectives. Always append new dated entries; never rewrite or delete earlier entries.
