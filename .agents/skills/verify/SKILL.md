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
Run the end-to-end browser verification script, which launches its own isolated Vite server, clears stale PNGs, drives real keyboard and mouse inputs (`Enter`, `KeyJ`, `KeyE`, `Space`, `ShiftLeft`, `KeyD`, `KeyV`, `KeyR`, mouse steering), asserts zero console/page errors and real simulation telemetry transitions, and shuts down the server cleanly:
```bash
npm run verify:browser
```

## Evidence
Proof artifacts survive server teardown in `artifacts/verify/`:
- `artifacts/verify/01-briefing.png` — Briefing card over live 3D orbital backdrop
- `artifacts/verify/02-cockpit-combat.png` — First-person cockpit firing cannons against raiders & frigate
- `artifacts/verify/03-snap-turn.png` — Mid-turn Snap-Turn Flip (`Space`) + missile launch
- `artifacts/verify/04-chase-boost.png` — Chase camera (`V`) with active afterburner plumes & speed streaks
- `artifacts/verify/05-chase-combat.png` — Exterior chase combat view firing on opening approach
- `artifacts/verify/report.json` — Read-only telemetry snapshots across every step

Always inspect the saved PNGs directly (never rely solely on exit code `0`) to verify 3D models, cockpit framing, lighting/gamma, HUD legibility, and zero WebGL blank screens.

## Cleanup
`scripts/verify-browser.mjs` terminates only the child Vite process it spawned (`server.kill('SIGTERM')`) in its `finally` block and leaves `artifacts/verify/` intact.

## Feature Map
See `.agents/skills/verify/features/README.md` for per-feature user journeys and gotchas.
