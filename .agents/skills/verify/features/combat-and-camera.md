# Combat, Wingmate Orders, and Camera Toggle

## Sub-features
- Primary twin cannons (`LMB` or `KeyJ`) draining weapon capacitor
- Concussion missiles (`RMB` or `KeyE`) with auto-rearm and target lock ring
- One-button wingmate attack order (`KeyF`) with radio banner acknowledgement
- First-person cockpit / chase camera toggle (`KeyV`)

## How to get to it (user POV)
Press `F` to send `VALKYRIE-2` after your selected target, fire cannons with `LMB`/`J`, launch missiles with `RMB`/`E`, and tap `V` to switch between first-person cockpit and chase camera.

## Driving it with Playwright
Send `KeyF`, hold `KeyJ` for 320ms, verify `wingmateAssignedTargetId !== null` and weapon capacitor spent or bolts spawned, capture `02-cockpit-combat.png`. Press `KeyE` to verify `missilesReady < 4`. Press `KeyV` to verify `cameraMode === 'chase'` and capture `04-chase-boost.png`.

## Gotchas
- `KeyJ` is bound alongside left mouse click so automated Playwright runs can fire without triggering pointer-lock dialogs.
