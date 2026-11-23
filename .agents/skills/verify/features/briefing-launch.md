# Briefing and Sortie Launch

## Sub-features
- Orbital backdrop and carrier visible behind briefing card
- Launching active flight via `Enter` or clicking `#gl-canvas`
- Instant retry via `R` or `Enter`

## How to get to it (user POV)
Open `http://127.0.0.1:4179/` in a WebGL2-capable browser. The briefing overlay appears centered over the live 3D scene. Press `Enter` or click the viewport to begin flying.

## Driving it with Playwright
Navigate to the app URL, capture `01-briefing.png`, verify `window.__SWS_TELEMETRY__.getSnapshot().phase === 'briefing'`, send `page.keyboard.press('Enter')`, wait 300ms, and confirm `phase === 'active'` and `tick > 5`.

## Gotchas
- Headless Chromium requires SwiftShader WebGL flags (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`) on machines without exposed headless GPU acceleration.
- Clicking `#gl-canvas` attempts Pointer Lock; `keyboardMouse.ts` catches promise rejection cleanly in headless environments.
