# Space War Squadrons

First-person stylized low-poly 3D space dogfighter built with Three.js, TypeScript, Vite, Web Audio, Playwright verification, and TLA+ formal state verification.

## Controls (Mouse & Keyboard)

| Action | Input |
|---|---|
| Steer pitch / yaw | Mouse (click canvas for pointer lock, or move cursor freely) |
| Speed | `W` / `S` |
| Roll | `A` / `D` |
| Primary Twin Cannons | `Left Click` or `J` |
| Homing Missiles (4 tubes, auto-rearm) | `Right Click` or `E` |
| Afterburner (Boost) | `Shift` |
| Snap-Turn Flip (AOA Drift) | `Space` |
| Cycle Hostile Target | `T` or `Tab` |
| Toggle Cockpit / Chase Camera | `V` |
| Mute / Unmute Synth Audio | `M` |
| Launch / Retry Sortie | `Enter` / `R` |

## Development & Verification

```bash
npm install
npm run dev            # Start local dev server
npm run check          # Typecheck, strict ESLint, Vitest sim suite, Vite build
npm run verify:formal  # Exhaustive TLA+ (TLC) energy & lock proof + mutant kill gate
npm run verify:browser # Headless Playwright WebGL gameplay run + screenshots
```

## Architecture & Engineering Notes

- `src/sim/` — Pure, deterministic TypeScript simulation (zero Three.js or DOM imports, enforced by ESLint).
- `src/input/` — Normalized input boundary (`FlightInput`), ready for DualShock Gamepad integration.
- `src/render/` — Cel-shaded ink-outlined Three.js 3D scene (`models.ts`, `sceneRenderer.ts`), 480p ACES + Bayer-dithered + bloom post-pass (`postProcess.ts`), and retro-vector Canvas 2D cockpit HUD (`cockpitHud.ts`).
- `src/audio/` — Procedural Web Audio synthesizer (`synthAudio.ts`).
- `formal/` — Exhaustive TLA+ model (`EnergyAndLock.tla`) and seeded-bug mutant (`EnergyAndLockMutant.tla`).
- `STATE_MACHINES.md` — State-machine audit log and resolved lifecycle hazards.
- `JOURNAL.md` — Candid implementation journal from Gemini 4 Neon and GPT-6.2 Astra evaluating `/metis`, `$state-audit`, `$formal-proof`, and `$create-verification-skill`.
- `.agents/skills/verify/` — Project-local Playwright browser verification skill and feature map.
