# First-Person Cockpit Flight, Boost, and AOA Drift

## Sub-features
- Mouse steering (both pointer-locked and non-pointer-locked cursor steering)
- Throttle (`W`/`S`) and roll (`A`/`D`)
- Boost (`Shift`) with FOV expansion and recovery cooldown
- AOA Drift (`Space`) decoupling velocity vector from nose orientation

## How to get to it (user POV)
Once launched, move the mouse to pitch/yaw, hold `Shift` to boost, and hold `Space` while turning to whip the nose sideways while maintaining drift momentum.

## Driving it with Playwright
Hold `Space` and move the mouse off-center (`page.mouse.move(940, 290, { steps: 8 })`), verify `boostMode` enters `drifting` or `recovering`, and capture `03-aoa-drift.png`. Wait >1s for recovery, then hold `ShiftLeft` + `KeyD` and verify `boostMode === 'boosting'`.

## Gotchas
- Attempting to engage `Shift` immediately after releasing `Space` stays in `recovering` by design (anti-boost-gasp invariant); wait >1.0s before testing `Shift` boost.
