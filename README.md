# Space War Squadrons

First-person stylized low-poly 3D space dogfighter built with Three.js, TypeScript, Vite, Web Audio, Playwright verification, and TLA+ formal state verification.

## Controls (Mouse & Keyboard)

| Action | Input |
|---|---|
| Steer pitch / yaw | Mouse (click the canvas for pointer lock, or steer with the free cursor), or arrow keys |
| Roll | `A` / `D` |
| Throttle | Hold `W` / `S`; `W` stops at the 100% detent |
| Overdrive (120%, burns shields) | Tap `W` again at 100%; `S` or empty shields drop back to 100% |
| Twin cannons | `Left Click` or `J` |
| Manual shield recharge | Hold `C`: shields fill at 28/s, cannons, missiles and Overdrive stay offline |
| Missile | `Right Click` or `E`: a press fires now (guided if locked); holding fires the next one only when its lock completes |
| Pin target | `T` / `Tab` cycles forward contacts and pins the pick until it dies, leaves the forward cone, or you press `T` on the only one |
| Pause | `P` / `Esc` (also on pointer-lock loss or focus loss) |
| Mute SFX + music / music only | `M` / `N` |
| Pick mission on the briefing card | `1` / `2` / `3` or click a mission |
| Launch / retry, restart, back to briefing | `Enter`, `R`, `B` (from the debrief) |
| Profiler readout (with `?profile=1`) | `` ` `` |

## Combat Rules

- **Heat.** The gauge fills from 0 (cold). Each shot adds 9.5 heat, which cools at 24/s. Reaching 100 overheats the cannons into a lockout that cools at only 15/s and ends back at 0 (`weapon_ready`), so bursting beats riding the lockout.
- **Hot Zone.** A shot from a ready gun at 80 heat or more doubles the crit bonus: 2.5x instead of 1.75x. The bolt carries the bonus from the moment it is fired.
- **Shields.** Passive regen starts 2.2 s after the last hit. Holding `C` recharges at 28/s with no delay; a ready gun holds its heat meanwhile, a lockout keeps cooling.
- **Low hull.** At 35% hull or less the cockpit warns (`HULL CRITICAL`, a red edge pulse) and a two-beep alarm repeats every 1.5 s.
- **Hitboxes.** Spheres sized to each ship's solid core (`SHIP_STATS` in `src/sim/ships.ts`: player 5.5 m, raider 5.8 m, striker 6.8 m). Shots are swept in each moving ship's frame, so fast bolts cannot tunnel and a hit or near miss is judged against where the ship really was. Player bolts fly at 390 m/s for about 520 m, so crossing targets need the lead pip. The frigate hull blocks shots with stepped boxes that follow its tapered mesh (`src/sim/frigateLayout.ts`), so empty air beside the prow does not.
- **Variable-ratio rewards.** Cannon hits roll a crit (14% base, more for dead-centre hits, plus a capped pity ramp) for 1.75x damage. A kill rolls a supply drop (35%, rising after each dry kill): heat flush, shield surge, or missile resupply. Skimming an enemy bolt or buzzing a rock, ship or fighter at speed vents 12 heat (or restores 6 shield).
- **Missiles.** 4 per sortie, one rearm every 12 s; one missile breaks a fresh raider or striker shield.
- **Enemy fire.** Nobody fires for the first 4.5 s, at most two raiders attack the player at once, and their aim error grows with your speed, crossing rate, turn rate and Overdrive. Strikers only shoot at Hearthstone.

## Development & Verification

```bash
npm install
npm run dev            # Start local dev server (append ?profile=1 for the frame profiler)
npm run check          # Typecheck, strict ESLint, Vitest sim suite (incl. bot balance harness), Vite build
npm run verify:formal  # Exhaustive TLA+ (TLC) energy & lock model, simulation agreement, mutant kill gates
npm run verify:browser # Headless Playwright WebGL gameplay run + screenshots
```

With `?profile=1`, `window.__SW_PROFILE__.snapshot()` returns rolling frame, sim (fixed steps plus input and audio sync) and render times (mean, p50, p95, p99) over the last 600 frames, and a corner readout shows the same. `reset()` clears the window, for example after loading.

## Architecture & Engineering Notes

- `src/sim/` — Pure, deterministic TypeScript simulation (no Three.js imports or browser globals, enforced by ESLint).
- `src/input/` — Normalized input boundary (`FlightInput`), ready for DualShock Gamepad integration.
- `src/render/` — Cel-shaded ink-outlined Three.js 3D scene (`models.ts`, `sceneRenderer.ts`), 480p ACES + Bayer-dithered + bloom post-pass (`postProcess.ts`), and retro-vector Canvas 2D cockpit HUD (`cockpitHud.ts`).
- `src/audio/` — Procedural Web Audio synthesizer (`synthAudio.ts`).
- `formal/` — Exhaustive TLA+ model (`EnergyAndLock.tla`) and seeded-bug mutants (`EnergyAndLockMutant.tla` keeps a lock on a dead target, `OverheatMutant.tla` fires while overheated, `ShieldRechargeMutant.tla` leaves the guns and Overdrive live while recharging).
- `tests/support/pilots.ts` — Headless AFK and cannon-only bot pilots used by the balance harness.
- `STATE_MACHINES.md` — State-machine audit log and resolved lifecycle hazards.
- `JOURNAL.md` — Candid implementation journal from Gemini 4 Neon and GPT-6.2 Astra evaluating `/metis`, `$state-audit`, `$formal-proof`, and `$create-verification-skill`.
- `.agents/skills/verify/` — Project-local Playwright browser verification skill and feature map.
