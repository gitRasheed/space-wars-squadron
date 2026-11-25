---
name: verify
description: Launch Space War Squadrons in Vite and drive real gameplay through headless Playwright Chromium to verify rendering, controls, HUD, combat state, and capture visual proof screenshots. Use whenever verifying visual or interactive changes to the browser game.
---

# Verify Space War Squadrons

## Launch
Start an isolated Vite dev server on port `4179` (or set `VERIFY_PORT` for parallel runs):
```bash
npx vite --host 127.0.0.1 --port 4179 --strictPort
```
Ready when `GET http://127.0.0.1:4179/` returns HTTP `200`.

## Doctor
Confirm build, types, lint, and simulation contracts pass before browser verification:
```bash
npm run check
```

## Drive
Run the end-to-end browser verification script. It starts its own isolated Vite server, clears stale PNGs, drives real keyboard input (`Enter`, `KeyJ`, `KeyW`, `KeyR`, `KeyE`), asserts zero console/page errors and real telemetry transitions (cannon fire, overheat lockout, 120% Overdrive, a completed missile lock, and a missile homing on the locked target id), then shuts the server down:
```bash
VERIFY_OUT_DIR=artifacts/verify-<worker> npm run verify:browser
```

## Evidence
Proof artifacts survive server teardown in `$VERIFY_OUT_DIR` (default `artifacts/verify/`):
- `01-briefing.png` — Briefing card over the live 3D orbital backdrop
- `02-cockpit-combat.png` — First-person cockpit firing the twin cannons
- `03-overheat.png` — Cannons in overheat lockout
- `04-overdrive.png` — 120% throttle Overdrive burning shields
- `05-missile-combat.png` — Locked missile and cannon combat after a restart
- `report.json` — Read-only telemetry snapshots for every step (`window.__SWS_TELEMETRY__`, including `lockState`, `lockTargetId`, `playerMissileTargets`, `targetPinned`)

Always inspect the saved PNGs directly (never rely solely on exit code `0`) to verify 3D models, cockpit framing, lighting, HUD legibility, and zero WebGL blank screens.

## Profiling
Open the game with `?profile=1` to get `window.__SW_PROFILE__.snapshot()` (rolling frame/sim/render ms with p50/p95/p99 over 600 frames) and a corner readout toggled with `` ` ``. Without the flag the frame loop never touches the profiler.

## Cleanup
`scripts/verify-browser.mjs` closes the browser and its in-process Vite server in its `finally` block and leaves the output directory intact.

## Feature Map
See `.agents/skills/verify/features/README.md` for per-feature user journeys and gotchas.
