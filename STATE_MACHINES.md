# State Machines Audit — Space War Squadrons

## 1. Scope, Exclusions, and Dropped Candidates

- **Date:** 2026-11-23 (pass 3 on 2026-11-25, see section 6)
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
| 3 | Throttle Overdrive & Weapon Heat | `overdrive` × `WeaponState` (`ready`/`overheated`) × heat and shield | Traced (pass 3) | Medium (Common) | `src/sim/energy.ts`, `src/sim/flight.ts` | 1 |
| 4 | Target Selection, Pin & Missile Lock | Sum (`LockState`) × `selectedTargetId` × `targetPinned` × `missilesReady` (fresh press is the `fireMissilePressed` input edge) | Traced (pass 3) | Medium (Common) | `src/sim/combat.ts` (`resolveTargetSelection`, `stepPlayerWeapons`) | 1 |
| 6 | Enemy Maneuver | Sum (`EnemyManeuver`: `patrol`/`approach`/`break_away`) | Traced (pass 3) | Medium (Common) | `src/sim/combat.ts` (`stepEnemyAi`) | 1 |
| 7 | Planetary Stage (ground attack → air superiority) | Sum (`PlanetaryStage`) × ground-target hulls × `enemies` | Traced (pass 4) | Low (Edge) | `src/sim/planetary.ts` (`stepGroundBattle`, `remainingPlanetaryHostiles`), `src/sim/world.ts` | 1 |
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

## 6. Pass 3 (2026-11-25): Heat, Lock, Pin, Maneuver and Pause Fixes

- **Machine 3, inverted overheat.** Lockout cooling (28/s) was faster than normal recharge (18/s), so overheating out-shot disciplined bursts. Now recharge is 24/s and lockout 15/s (`ENERGY_RULES`), `weapon_ready` fires when the lockout ends, and `formal/EnergyAndLock.tla` asserts `OverheatCooldown < WeaponRecharge` and ties `OverheatTicks` to it. A heat-flush supply drop is the only other way out of the lockout, modelled as `HeatFlush`. `OverheatMutant.tla` (firing while overheated) must fail `OverheatCannotFire`, and `run-formal-check.mjs` pulls the trigger on a half-cooled overheated gun, so deleting the TS guard fails `verify:formal`.
- **Machine 3, Overdrive throttle leak.** A hostile bolt that emptied the shields cleared `overdrive` in combat, after flight had already set throttle to 1.2, leaving `overdrive=false` with `throttle=1.2` for a tick. Every damage source now goes through `damagePlayer` (`src/sim/flight.ts`), which clamps throttle in the same tick. The fuzz test asserts `!overdrive ⇒ throttle ≤ 1`.
- **Machine 4, missile hold.** `fireMissile` mixed a queued press with the held RMB level, so a held button dumped unguided missiles every cooldown. The sim now keeps `missileTriggerHeld` and launches on a fresh press, or on a held trigger only once the lock completes.
- **Machine 4, target pin.** `T` now pins its pick (`targetPinned`). Auto-focus skips a pinned target until it dies, leaves the 60° / 1400 m pin cone, or `T` is pressed on the only candidate. Auto-focus ranks by angle off the nose, and distance only breaks ties inside 0.6°, so a near off-axis contact cannot steal focus from a dead-centre one.
- **Machine 6, raider attack run.** The approach timer was clamped at 0.4 s, so the timed break-away never fired, and the tail check had its sign reversed. The timer now reaches 0, and a raider holds the run only while it is actually behind the player.
- **Machine 2, pause ordering.** On `P` during locked flight, `main.ts` released pointer lock after the sim paused, so `pointerlockchange` saw the overlay open and never recorded `lockedBeforePause`; the resume click then resumed into cursor steering. `InputChannel.releasePointerForPause()` records the lock before releasing it.

## 7. Level 2 additions (2026-11-25, megastructure trench)

- **Machine 1, briefing.** `briefing` + `selectLevel` for a different level rebuilds the world from that level's config and stays in `briefing`. Every other phase ignores `selectLevel`, and restart keeps `world.sortie`, so a restart never changes level.
- **Machine 6, `patrol`.** Trench guards start in `patrol` around a post. `patrol` → `approach` when the player is inside 520 m or the guard has lost any shield or hull. Nothing returns to `patrol`. Raiders on `patrol` hold no attack token. Saturn spawns no guards, so its machine is unchanged.

## 8. Level 3 additions (2026-11-25, planetary ground support)

- **Machine 7, one-way hand-off.** `PlanetaryStage` lives on the optional `world.planetary`, so `SortiePhase` and its formal model are untouched. `ground_attack` becomes `air_superiority` once `airWaveThreshold` ground targets are down, which spawns the air wave exactly once; nothing moves it back. Restart rebuilds it from `world.sortie.planetary`.
- **Victory gate.** Stage 1 has no air enemies and no frigate cores, so the orbital rule (`enemies === 0 && cores === 0`) would have won on the first tick. Planetary sorties count living ground targets plus the unspawned wave as remaining hostiles (`remainingPlanetaryHostiles`). `tests/planetary.test.ts` pins this, and dropping the gate fails 8 tests.

## 9. Core loop pass (2026-11-25): heat, Hot Zone, manual recharge

- **Machine 3, heat counts up.** `weaponHeat` runs 0 to 100; a shot that reaches 100 overheats, and the lockout ends when heat cools back to 0. The Hot Zone is `ready ∧ heat ≥ 80`, read before the shot and stamped on the bolt. `formal/EnergyAndLock.tla` bands heat as 0 / warm / Hot Zone / full, asserts only a lockout sits at full heat, and probes that the Hot Zone and an overheat are reachable in two and three shots.
- **Machine 3, manual recharge.** Holding `C` sets `energy.recharging` for that tick: Overdrive drops and cannot start, cannons and missiles hold fire, shields fill at 28/s past the regen delay, a ready gun's heat holds, and a lockout keeps cooling so `OverheatCompletes` still holds. `RechargeExclusive` checks it in both projections; `ShieldRechargeMutant.tla` must fail it, and `run-formal-check.mjs` measures from TS that the C key lets no shot or Overdrive through.
- **Machine 4, missile press.** The sim no longer infers a fresh press from `missileTriggerHeld`. Input sends `fireMissilePressed` for any press since the last tick, so a press and release between two ticks still launches.
- **Machine 1, debrief.** `B` from victory or failure rebuilds the world at the briefing card with the same mission selected.

## 10. Playtest polish pass (2026-11-25): automatic shields, forward-cone targeting, quiet alarms

- **Machine 3, automatic shield regen only.** Removed the manual `C` recharge mode (`recharging`) so shields simply regenerate automatically at 15/s after a 1.8 s hit delay (`ShieldRegenDelayTicks = 109`, `ShieldRecharge = 150` in `formal/EnergyAndLock.tla`).
- **Machine 4, pure forward-cone focus.** Unpinned `selectNextTarget` now returns `null` when no hostile is inside the forward focus cone instead of forcing an arbitrary off-screen target; the HUD edge chevron only appears for an explicit `T` pin.
- **Audio quietness.** `hull_critical` audio only emits when hull `≤ 35%` **and** `shieldCharge < 15` (every 3.0 s); `incoming_fire` steers directional near-miss pan without playing a radar chirp; `target_locked` debounces rapid switches (90 ticks global, 180 ticks same target).

