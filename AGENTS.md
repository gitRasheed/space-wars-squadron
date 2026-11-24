# Space War Squadrons — Agent Working Rules

## Module Boundaries
- `src/sim/` is pure TypeScript simulation (zero Three.js, zero DOM, deterministic at 60 Hz).
- `src/render/` owns Three.js, cameras, shaders, and HUD drawing.
- `src/audio/` owns Web Audio synthesis and soundtrack scheduling; every node must route behind `masterGain`.
- `tools/agent-audio/` and `tools/agent-3d/` are standalone MIT packages with **zero imports from `src/`**.

## Single-Source-of-Truth Invariants (Derive, Do Not Copy)
- **Camera ↔ HUD ↔ Ballistics:** Never hardcode screen center as the gun reticle. Derive camera pose from `src/render/cameraPose.ts` (`computeCameraPose`), lead intercept from `src/sim/math.ts` (`computeLeadPoint`), and gun reticle projection from `computeGunBoresightPoint`.
- **Visual Meshes ↔ Sim Hitboxes:** Targetable subsystem positions live once in `FRIGATE_SUBSYSTEM_LAYOUT` (`src/sim/world.ts`) and are read by both `world.ts` and `src/render/models.ts`.
- **Lifecycle Phases:** All game modes (`briefing`, `active`, `paused`, `victory`, `failed`) live in the exhaustive `SortiePhase` union (`src/sim/types.ts`). Browser pointer-lock exit and focus loss during active flight pause cleanly.
- **Audio Recipes ↔ In-Game BGM:** `src/audio/combatScore.ts` stays in parity with `tools/agent-audio/recipes/combat-loop.recipe.json` (enforced by `tests/audio.test.ts`), keeping `src/` and `tools/` decoupled at runtime.
- **Palette:** Colors belong in `src/render/palette.ts`.

## Verification Gates
Run the relevant checks before claiming done or committing:
- **Core code / sim / UI:** `npm run check` (`tsc`, `eslint`, `vitest`, `vite build`)
- **Energy / lock / timing changes:** `npm run verify:formal` (TLA+ TLC + `tests/formalAgreement.test.ts`)
- **Gameplay / rendering / HUD changes:** `npm run verify:browser` (headless Playwright WebGL check; visually inspect `artifacts/verify/*.png`)
- **3D ship model edits:** Build once on a clean checkout (`npm --prefix tools/agent-3d ci && npm --prefix tools/agent-3d run build`), then run `node tools/agent-3d/dist/cli.js turntable scripts/ship-adapters/<ship>.ts --card scripts/ship-adapters/space-wars-card.json --out artifacts/turntable/<ship>` (0 degenerate triangles; inspect `contact-sheet.png`)
- **Audio recipe edits:** Build once on a clean checkout (`npm --prefix tools/agent-audio ci && npm --prefix tools/agent-audio run build`), then run `node tools/agent-audio/dist/cli.js check <file.wav> [--loop] --png <dir>`
