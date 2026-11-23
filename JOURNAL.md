# Implementation & Skill Experiment Journal

Candid notes from **Gemini 4 Neon** and **GPT-6.2 Astra** on applying `/metis`, `$state-audit`, `$formal-proof`, and `$create-verification-skill` (plus a visual Playwright screenshot critique loop) to a 3D Three.js space combat game.

---

## 1. `/metis` (Plain Data, Pure Core, Zero Narrating Comments)

### What genuinely helped
- **Pure simulation vs. Three.js boundary:** Keeping `src/sim/` 100% free of `three` and DOM imports—enforced by an ESLint `no-restricted-imports` rule—made the entire flight physics, AOA drift, targeting, wingmate AI, and 3,600-tick randomized fuzz test execute in **~150ms** in Vitest without WebGL.
- **Tagged unions killed bugs before they existed:** Encoding `BoostMode` (`ready | boosting | drifting | recovering`), `LockState` (`none | acquiring | locked`), and `SortiePhase` (`briefing | active | victory | failed`) as discriminated unions made invalid combinations unrepresentable and mapped almost 1:1 to our TLA+ model.
- **No-comment discipline:** Writing self-explaining functions (`sweetSpotTurnFactor`, `resolveCapitalClearance`, `absorbShieldDamage`) left only **two** single-line comments across `src/sim/` (Mulberry32 deterministic PRNG and the 5° gimbal convergence cone). Code reads cleaner without narrating comments cluttering diffs.

### Friction / Watch-outs
- **Allocation vs. purity in 60fps 3D loops:** `src/sim/` returns fresh plain objects each tick cleanly (zero GC issues at 4–10 ships), while `src/render/sceneRenderer.ts` uses pre-allocated `THREE.Vector3` scratch objects and in-place `BufferAttribute` updates inside `updateDustField` / `updateSpeedStreaks`. Metis explicitly permits internal mutation for performance (`Design #7`), and that escape hatch was essential in the render loop.
- **Closure narrowing in strict TypeScript:** `strictTypeChecked` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` caught real defects early, with minor boilerplate around 2D canvas `ctx` narrowing inside nested helper closures.

### Suggested skill tweaks
- Keep the default-to-no-comment rule exactly as-is; consider adding a quick ESLint-friendly rule suggestion or checklist item for enforcing architectural boundaries (`no-restricted-imports`) so Metis's core/edge split stays mechanically enforced in CI.

---

## 2. `$state-audit` (Explicit & Implicit State Machine Hunt)

### What genuinely helped
- **Caught 4 real bugs in our own fresh v1 code immediately:**
  1. **Dual `world` writer + accidental launch shot + `Enter` wiping active sorties** (`src/main.ts` + `src/input/keyboardMouse.ts` + `src/sim/world.ts`): Pressing `Enter` mid-dogfight reset the sortie, and clicking Launch fired cannons on tick 1. Fixed by splitting `launchBriefing` vs. `restartSortie` and funneling all writes through `frame()`.
  2. **Stale cursor spin on `Esc` pointer-lock exit** (`src/input/keyboardMouse.ts`): Leaving pointer lock kept `cursorActive = true` from pre-lock hovering, causing immediate involuntary yaw. Fixed by collapsing `pointerLocked` × `cursorActive` into one `SteeringMode` tagged union (`idle | cursor | pointer_locked`) and clearing held keys on `document.visibilitychange`.
  3. **1-frame empty target HUD flicker on kill** (`src/sim/combat.ts`): Fixed by immediately re-selecting the next contact in the same step while resetting `lockState`.
  4. **Background-tab engine hum** (`src/audio/synthAudio.ts`): Fixed with a `visibilitychange` suspend guard.

### Friction / Watch-outs
- None on Pass 1/Pass 2—Wait until v1 actually runs before auditing. Auditing real `file:line` sites prevented speculative theater and uncovered real player-facing bugs in minutes.

---

## 3. `$formal-proof` (TLA+ / Exhaustive TLC on Energy & Lock Kernels)

### What genuinely helped (Astra + Neon)
- **Exhaustive TLC checked 2,053,943 generated / 64,190 distinct states with `0` states left on queue** and verified every safety & liveness invariant on `EnergyAndLock.tla`:
  - `RecoveryCannotBeSkipped` (mathematically rules out *Star Wars: Squadrons*-style boost-gasping/pinballing)
  - `LockHasLiveTarget` & `LockRequiresMissile` (no ghost locks on destroyed targets or empty tubes)
  - `RecoveryCompletes` (liveness under weak fairness: recovery can never soft-lock)
- **Anti-cheating gates paid off immediately:** Four reachability probes (`NeverRecovering`, `NeverLocked`, `NeverFiredLastMissile`, `NeverAtDriftLimit`) proved TLC wasn't vacuously green, and our seeded ghost-lock mutant (`EnergyAndLockMutant.tla`) failed with exact invariant `LockHasLiveTarget` (exit 12) on a 2-state counterexample where a target dies on the exact frame lock acquisition starts.
- **Concrete TypeScript-to-TLA+ alignment:** Replaying timer boundaries in TypeScript at 60 Hz before choosing discrete constants (drift exit on update 133, lock complete on update 55, first reload on update 271) and preserving exact same-frame ordering (reload → fire → impact cleanup) kept the model honest instead of a detached toy.

### Friction / Watch-outs
- Continuous 3D flight physics, quaternion damping, and Three.js rendering sit outside TLC's scope; keeping formal verification strictly scoped to the discrete energy & lock state kernels avoided fake proofs.
- Downloading `tla2tools.jar` on first run requires network access in CI/local setup (cached cleanly in `formal/tla2tools.jar` and gitignored).

### Suggested skill tweaks (from Astra)
- **Add a fairness-removal negative control to `formal-proof`'s liveness guidance:** Temporarily removing weak fairness from `RecoveryCompletes` produced a concrete stuttering trace where recovery never finishes—proving the liveness property actually relies on the fairness assumption rather than holding vacuously.

---

## 4. `$create-verification-skill` + Visual Screenshot Critique Loop

### What genuinely helped
- **Make-or-break discovery:** Every single test (`tsc`, `eslint`, `vitest`, `vite build`, TLC) passed on v1—yet inspecting the 5 real Playwright PNGs with both Neon and Astra immediately exposed **5 major visual/UX defects**:
  1. Velocity vector & target labels overlapping the lower instrument dash during AOA Drift (`03-aoa-drift.png`).
  2. Giant square WebGL `PointsMaterial` dust motes competing with enemy contacts (`04-chase-boost.png`).
  3. Blocky black cockpit barrels + solid yellow diamond muzzle flashes cluttering the windshield (`02-cockpit-combat.png`, `05-cockpit-turn.png`).
  4. Unreadable red target text over bright magenta frigate dome & salmon sky, plus overlapping radar blips (`02-cockpit-combat.png`).
  5. Hostile frigate spawning nearly end-on so its two destructible subsystems overlapped visually (`02-cockpit-combat.png`).
- **Second visual pass confirmed every fix** cleanly: clipped canopy markers + named off-screen chevrons (`TOW CLAMP 844M`, `VEL`), soft radial dust + boost speed-streaks, Cassini-gap shaded gas-giant rings, cool-lit Hearthstone hangar bays, broadside frigate subsystems, high-contrast lead pip, and sleek beveled canopy framing.

### Friction / Watch-outs
- Headless Chromium on Linux requires explicit SwiftShader ANGLE flags (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`) and `KeyJ` fallback alongside `LMB` so automated runs don't stall on Pointer Lock prompts. Recording these in `.agents/skills/verify/features/*.md` under `Gotchas` directly solves this for future agents.

### Suggested skill tweaks
- Consider adding an explicit **"Visual / Multimodal Inspection"** sub-step to `create-verification-skill`'s `Evidence` section for GUI/WebGL/3D apps so agents don't stop at exit code `0` without opening the captured screenshots.

---

## 5. Round 2 Post-Mortem: What Slipped Past CI & Our 4 Skills (and Why)

Playtesting v1 exposed two distinct failure classes that all green checks (`tsc`, ESLint, Vitest, `$state-audit`, 663k-state TLC, and headless Playwright) missed:

1. **Gameplay Feel Failure (last enemy gluing behind the player in an endless turn stalemate + control bloat):**
   - *Why it slipped through:* Our v1 enemy AI had no explicit maneuver state machine (`approach` vs. `break_away`)—it was a single continuous pursuit vector, so `$state-audit` and `$formal-proof` never flagged it, and the 60-second fuzz test only checked `Number.isFinite` rather than a gameplay separation contract.
   - *Fix & lesson:* Modeled enemy passes as an explicit `EnemyManeuver` union (`approach | break_away`) with a real behavioral regression test in `tests/sim.test.ts` proving close passes trigger break-away separation. **Gap to close in future games:** write *playability invariants* (time-to-180° turn, minimum AI break-off distance, kill time-to-target) alongside crash/NaN tests.

2. **Visual & Shader Failures (blocky primitives, linear-to-sRGB dark frigate, floating muzzle flashes, HUD label collision, wrong camera on `05-chase-combat.png`):**
   - *Why it slipped through:* `/metis`, `$state-audit`, and `$formal-proof` verify architecture and discrete state correctness—not visual craft, gamma pipelines, or HUD collisions. Meanwhile `$create-verification-skill` verified functional execution + zero WebGL errors, and our script originally missed an explicit `cameraMode === 'chase'` assertion before saving `05-chase-combat.png`.
   - *Fix & lesson:* Added ACES tone-mapping + `linearToSrgb` conversion in `src/render/postProcess.ts`, rebuilt ships with beveled `ExtrudeGeometry` + cel-shading + ink outlines, anchored cockpit barrels, unified target brackets, and added the missing `cameraMode` assertion + stale PNG cleanup in `scripts/verify-browser.mjs`. **Skill gap identified:** visual/3D repos need (a) an explicit multimodal critique step in `verify`, and (b) an isolated multi-angle `3d-asset-studio` contact-sheet harness so models are judged up close before entering gameplay.
