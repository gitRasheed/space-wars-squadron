# State Machines Audit — Space War Squadrons

## 1. Scope, Exclusions, and Dropped Candidates

- **Date:** 2026-11-23
- **Scope:** `src/main.ts`, `src/input/keyboardMouse.ts`, `src/sim/types.ts`, `src/sim/energy.ts`, `src/sim/combat.ts`, `src/sim/world.ts`, `src/audio/synthAudio.ts`, `src/render/sceneRenderer.ts`
- **Dropped candidates (admission gate):**
  - `cameraMode` (`cockpit | chase`): single independent UI toggle with one writer in `src/sim/world.ts:154-158`.
  - `proximityWarning`, `hitFlash`, `recoilKick`: pure derived / decaying scalar visual feedback.
  - `subsystemMeshes` material swap in `src/render/sceneRenderer.ts:258-271`: pure projection of `subsys.hull <= 0`.

## 2. Summary Table

| # | Machine | Axes (Sum/Product) | Evidence | Top Risk (Likelihood) | Key Files | Fix Rung |
|---|---|---|---|---|---|---|
| 1 | Sortie Lifecycle & Launch/Restart | Sum (`SortiePhase`) + dual write sites | Traced | Medium (Common) | `src/main.ts:59-82`, `src/input/keyboardMouse.ts:62-63`, `src/sim/world.ts:153-184` | 3 |
| 2 | Input Steering & Focus / Pointer Lock | Implicit 2-flag product (`pointerLocked` × `cursorActive` × held keys) | Traced | Medium (Common) | `src/input/keyboardMouse.ts:14-40,102-129,154-164` | 2 |
| 3 | Boost / AOA-Drift Energy Lifecycle | Sum (`BoostMode`) × Product (`PowerMode`, charges) | No traced hazard in scope | Low (Edge) | `src/sim/energy.ts:39-125` | — |
| 4 | Target Selection & Missile Lock | Sum (`LockState`) × `selectedTargetId` × `missilesReady` | Traced | Low (Common) | `src/sim/combat.ts:127-160,394-403` | 1 |
| 5 | Web Audio Engine Lifecycle | Implicit (`muted` × `ctx` × `document.hidden`) | Traced | Low (Edge) | `src/audio/synthAudio.ts:13-57,125-138` | 0 |

## 3. Detailed Sections (`Traced` Only)

### Machine 1: Sortie Lifecycle & Launch/Restart

- **States:** `briefing`, `active`, `victory`, `failed` (`src/sim/types.ts:36-45`).
- **Write sites:**
  1. `src/main.ts:62-80` (`glCanvas` `mousedown` listener mutates `world` directly outside the fixed-timestep loop).
  2. `src/main.ts:118` (`frame()` fixed-timestep loop writes `world = stepWorld(world, sampled, FIXED_DT)`).
- **Transition table:**

| From | Trigger | Who | Guard | To | Side Effects | File:Line |
|---|---|---|---|---|---|---|
| `briefing` | `mousedown` on `#gl-canvas` | `main.ts` | `world.phase.kind === 'briefing'` (enforced) | `active` | Also sets `mouseLeftHeld = true` in `keyboardMouse.ts:84` | `src/main.ts:59-82` |
| `briefing` | `Enter` or `KeyR` | `stepWorld` | `input.startOrRestart` | `active` | None | `src/sim/world.ts:160-170` |
| `active` | `Enter` or `KeyR` | `stepWorld` | `input.startOrRestart` (none distinguishing `Enter` from `KeyR`) | `active` (reset!) | Destroys active sortie progress silently | `src/input/keyboardMouse.ts:62-63`, `src/sim/world.ts:179-184` |
| `victory`/`failed` | `Enter` or `KeyR` | `stepWorld` | `input.startOrRestart` | `active` (reset) | Resets world preserving `cameraMode` | `src/sim/world.ts:172-177` |

- **Traced trigger paths:**
  1. **Accidental mid-sortie wipe:** While `phase.kind === 'active'`, pressing `Enter` sets `queuedStartOrRestart = true` (`src/input/keyboardMouse.ts:62-63`), which hits `src/sim/world.ts:179-184` and unconditionally resets the sortie.
  2. **Accidental shot on launch + dual writer:** Clicking `#gl-canvas` in `briefing` transitions `world` to `active` immediately in `src/main.ts:62` while `onMouseDown` in `src/input/keyboardMouse.ts:84` sets `mouseLeftHeld = true`; the very next `frame()` tick fires twin cannons before the user releases the launch click.
- **Refactor sketch (Rung 3):** Split `FlightInput` into `launchBriefing` (`Enter` or launch-click) vs `restartSortie` (`KeyR`), remove the direct `world = stepWorld(...)` listener in `src/main.ts:59-82`, and gate `mouseLeftHeld` so the click that launches briefing does not arm primary fire until the next press.

### Machine 2: Input Steering & Focus / Pointer Lock

- **States:** Implicitly encoded by `pointerLocked` (`boolean`), `cursorActive` (`boolean`), `cursorNormX/Y`, `pointerDeltaX/Y`, `heldKeys`, `mouseLeftHeld`, `mouseRightHeld` (`src/input/keyboardMouse.ts:14-23`).
- **Transition table:**

| From | Trigger | Who | Guard | To | Side Effects | File:Line |
|---|---|---|---|---|---|---|
| `cursorActive=true, pointerLocked=false` | `mousedown(0)` → pointer lock granted | `onPointerLockChange` | `document.pointerLockElement === canvas` | `pointerLocked=true` (`cursorActive` stays `true`) | Zeros `pointerDeltaX/Y` | `src/input/keyboardMouse.ts:121-125` |
| `pointerLocked=true, cursorActive=true` | User presses `Esc` | `onPointerLockChange` | `pointerLockElement !== canvas` | `pointerLocked=false, cursorActive=true` (stale!) | `sample()` immediately applies stale `cursorNormX/Y` spin | `src/input/keyboardMouse.ts:121-125,161-164` |
| Any held key/mouse | Tab hidden (`visibilitychange`) without `blur` | Browser | None | Held keys remain active | Ship keeps firing/boosting while hidden | `src/input/keyboardMouse.ts:127-138` |

- **Traced trigger path:** Hover cursor near right edge (`cursorActive = true, cursorNormX = 0.85`), click to enter pointer lock (`pointerLocked = true`), fly normally, then press `Esc` to release pointer lock (`pointerLocked = false`). Because `cursorActive` was never cleared in `onPointerLockChange`, `sample()` (`src/input/keyboardMouse.ts:161-164`) immediately yaws hard right at `0.85` even though the user has not moved the mouse.
- **Refactor sketch (Rung 2):** Replace `pointerLocked` + `cursorActive` with a tagged union `SteeringMode = { kind: 'idle' } | { kind: 'cursor'; x: number; y: number } | { kind: 'pointer_locked'; dx: number; dy: number }`. Reset to `{ kind: 'idle' }` on pointer-lock exit and clear all held inputs on both `blur` and `document.visibilitychange` (`document.hidden`).

### Machine 4: Target Selection & Missile Lock

- **States:** `selectedTargetId: string | null` × `lockState: LockState` × `missilesReady: 0..4`.
- **Traced trigger path:** When the player destroys their currently selected target on tick `N` (`src/sim/combat.ts:304`), `src/sim/combat.ts:394-403` sets `selectedTargetId = null` and `lockState = { kind: 'none' }` at the end of tick `N`. For one rendered frame, HUD target display flashes empty before tick `N+1` calls `selectNextTarget` (`src/sim/combat.ts:192`) to pick the next enemy.
- **Refactor sketch (Rung 1):** Immediately re-select the best remaining contact inside `src/sim/combat.ts:394-403` when the selected target is destroyed so no 1-frame empty-target flicker occurs, while still resetting `lockState` to `{ kind: 'none' }`.

### Machine 5: Web Audio Engine Lifecycle

- **States:** `muted: boolean` × `ctx: AudioContext | null` × tab visibility.
- **Traced trigger path:** If the user unmutes (`M`) and switches browser tabs, `requestAnimationFrame` pauses while `engineGain` stays at `0.045`, leaving a continuous sawtooth engine hum in the background tab (`src/audio/synthAudio.ts:125-138`).
- **Refactor sketch (Rung 0):** Listen to `document.visibilitychange` in `src/audio/synthAudio.ts` and suspend/ramp `engineGain` to `0` while `document.hidden` is true.

## 4. Unranked Hypotheses

- Rapid `R` restart while a missile explosion is mid-fade leaves Three.js meshes cleanly disposed on the next `syncExplosions`, assuming explosion IDs never collide across resets (`exp-${tick}-${id}` resets `tick` to `0`, so if an explosion from tick `k` existed right before restart and another occurred at the exact same tick `k` before GC, map key reuse is theoretically possible—already prevented because `explosions` resets to `[]` on restart, triggering deletion on the first render frame).

## 5. Ranked Next Steps & Pass 2 Resolution

1. **Machine 1 (Sortie Lifecycle & Launch/Restart)** — **Fixed & Pinned:** Split `launchBriefing` vs. `restartSortie` (`src/sim/types.ts`, `src/sim/world.ts`), removed the direct `world = stepWorld(...)` side-writer in `src/main.ts`, gated launch click in `src/input/keyboardMouse.ts`, and pinned regression coverage in `tests/sim.test.ts`.
2. **Machine 2 (Input Steering & Focus / Pointer Lock)** — **Fixed:** Collapsed `pointerLocked` × `cursorActive` into `SteeringMode` tagged union (`idle | cursor | pointer_locked`), reset to `idle` on pointer-lock release, and clear held inputs on `document.visibilitychange`.
3. **Machine 4 & 5 (Target Re-Selection & Audio Tab-Hide)** — **Fixed:** Immediate target re-selection on kill in `src/sim/combat.ts` and `document.visibilitychange` audio suspend in `src/audio/synthAudio.ts`.
