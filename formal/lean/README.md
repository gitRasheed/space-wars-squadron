# Lean 4 proofs of the game kernels

Pure Lean 4.36.0, no Mathlib, no dependencies. A clean `lake build` takes about 5 s.

```
node scripts/verify-lean.mjs
```

The script runs every gate and exits non-zero if any of them fails:

1. `lake build` must exit 0, and its output must not contain `sorry` or `error`. A `sorry` alone still exits 0.
2. A raw-source scan of `SpaceWars.lean` and `SpaceWars/*.lean` rejects `sorry`, `sorryAx`, `admit`, `axiom`, `native_decide`, `implemented_by`, `extern`, `unsafe`, `partial`, `opaque`, `ofReduceBool`, `debug.*` options, meta commands and `import Lean`. The scan includes comments. On startup the scanner tests itself against seeded lines.
3. `audit/Axioms.lean` walks every constant defined in a `SpaceWars.*` module, including the auto-generated ones, and prints the axioms each one depends on, as `#print axioms` would. Any axiom outside `{propext, Classical.choice, Quot.sound}` fails the gate, and so do any `axiom` or `opaque` declaration, a theorem that is in the source but missing from the environment, and a theorem from the required list that is missing.
4. `lake env leanchecker <module>` replays each module through the kernel.
5. Negative control: `audit/KernelNegativeControl.lean` uses `debug.skipKernelTC` to add a forged proof of `1 = 2`. The script compiles it into a temp dir and requires leanchecker to reject it. `#print axioms` sees no axioms in that forgery, so only the replay catches it.

The `audit/` files sit outside `SpaceWars/` and nothing imports them.

## What is proved

All quantities are exact rationals or integers. The game runs the same formulas on doubles, and these proofs don't cover float rounding.

### `SweptHit.lean`: relative-motion swept sphere test

Over one tick the bolt-minus-ship offset is `rel(t) = d0 + t • dv`, `t ∈ [0, 1]` (`rel_is_relative_motion`). The kernel evaluates `|rel|²` once, at `tStar = clamp01(-(d0·dv) / |dv|²)`, with `tStar = 0` when `dv = 0`.

- `tStar_mem`: `tStar ∈ [0, 1]`.
- `closest_approach_global_min`: `|rel(tStar)|² ≤ |rel(t)|²` for every `t ∈ [0, 1]`.
- `sweptHit_complete` (no tunneling): if any instant has `|rel(t)|² ≤ r²`, the test reports a hit.
- `sweptHit_sound`: a reported hit comes with such an instant.
- `entered_hit_sphere_not_nearMiss`, `outside_hit_sphere_no_hit`, `hit_nearMiss_disjoint`, `nearMiss_sound`: a near miss (`rHit² < miss² ≤ rGraze²`) never touched the hit sphere, and a trajectory that stayed outside it never registers a hit.

### `LeadIntercept.lean`: ballistic lead

With `a = |v|² - s²`, `b = 2 d·v`, `c = |d|²`:

- `intercept_exact`: any root `t` gives `|d + t v|² = (s t)²`. `intercept_root_of_exact` is the converse.
- `quadratic_root_exact`: both quadratic-formula roots are exact, given any `D` with `D² = b² - 4ac`.
- `linear_case_exact`: when `a = 0` and `b < 0`, `t = -c / b` is strictly positive and exact.
- `zero_velocity_exact`: when `v = 0` and `s > 0`, `t = ℓ / s` is exact for any `ℓ ≥ 0` with `ℓ² = |d|²`. `Rat` has no square root, so `ℓ` stands in for `‖d‖`.

### `HeatEconomy.lean`: heat, lockout, overdrive and shield

This is an integer model at ×100, one action per 60 Hz tick. Heat is `100 - weaponCharge` from `src/sim/energy.ts`. The module header maps each constant to its source. The hot zone (80-100%) and manual shield recharge are not in `src/sim` yet, so those parts model the planned mechanic, not current code.

- `trace_inv`: the invariant holds after every finite action list from `init`, for traces of any length, by induction through `inv_step`.
- `inv_bounds`: heat and shield stay within `[0, 10000]`.
- `inv_full_heat_locks`, `unlocked_below_max`, `overheat_entered_only_by_full_shot`: 100% heat always means lockout, and only a shot that reaches 100% starts one.
- `inv_overheat_no_fire`: firing while overheated is a no-op. `fire_adds_heat` shows a shot otherwise always adds heat.
- `inv_hot_zone_disjoint` is true by definition, because `inHotZone` already requires `overheated = false`. `hot_zone_fire_stays_hot` carries the real content: a shot from the hot zone either stays in the hot zone or trips the lockout at exactly 100%.
- `inv_mutual_exclusion`: recharge and overdrive never overlap, and overdrive implies `shield > 0`.
- `overheat_terminates`: from any reachable overheated state, exactly `⌈heat / 25⌉ ≤ 400` lockout ticks unlock the gun at 0 heat, and every earlier tick is still locked.

`witness_*` theorems show that each mode is reachable, so the invariants aren't vacuous.

### `Counterexamples.lean`: broken kernels against the same specs

- `end_of_tick_tunnels`, `end_of_tick_incomplete`: an end-of-tick point test misses a bolt that crosses the centre at `t = 1/2`.
- `unclamped_unsound`: an unclamped closest approach reports a hit whose minimum lies before the tick.
- `static_ship_misclassifies_hit`, `static_ship_breaks_disjointness`: sweeping against the ship's start position calls a real hit a near miss. That is the moving-ship bug.
- `naive_aim_not_exact`: aiming at the current position ignores target motion.
- `unclamped_vent_negative_heat`, `unclamped_shield_overflow`, `unclamped_breaks_inv_bounds`: an unclamped near-miss reward reaches -2.5% heat or a 106% shield from `init`.
