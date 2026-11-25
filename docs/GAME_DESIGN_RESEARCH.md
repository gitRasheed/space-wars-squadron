# Space War Squadrons: Game Design Research (Wave 2)

Research brief for the Wave 2 implementation agents. Every recommendation names the owning module, the new `SimEvent` (if any), starting numbers, the gate to run, and a deterministic test. Numbers are starting points for tuning, derived from the current constants on `main` (`66cdef7`).

**How to read the sources.** Reception claims come from reviews I found by web search (listed at the end). Quoted lines come from search-result snippets; I didn't open every page, so check a quote against the page before reusing it publicly. Anything marked *(recall)* is from memory and unverified. We take principles from these games, never their maps, names, ships, or look.

---

## 0. Current baseline (the numbers everything below is sized against)

| Quantity | Value | Source |
|---|---|---|
| Cruise / overdrive speed | 102 / 168 u/s | `FLIGHT_TUNING` |
| Pitch / yaw rate | 2.45 / 2.15 rad/s | `FLIGHT_TUNING` |
| Turn radius at cruise / overdrive (pitch) | ≈42 u / ≈69 u (v/ω) | derived |
| 180° pitch reversal | ≈1.28 s | π / 2.45 |
| Player bolt reach | ≈515 u (560 × 0.92) | `COMBAT_TUNING` |
| Lock range / acquire | 1100 u / 0.8 s | `COMBAT_TUNING` |
| Arena radius | 2600 u | `FLIGHT_TUNING` |
| Bolt damage / interval | 18 / 0.14 s | `COMBAT_TUNING` |
| Sustained burst before overheat | ≈2.0 s, ≈14 shots (net drain ≈50/s) | `ENERGY_RULES` |
| Overheat lockout | ≈3.6 s (100 / 28) | `ENERGY_RULES` |
| Raider shields + hull | 70 + 75 = 145 → 9 bolts | `world.ts` |
| Striker shields + hull | 90 + 100 = 190 → 11 bolts | `world.ts` |
| Player / enemy hit radius | 7.5 / 9.5 u | `COMBAT_TUNING` |
| Bolt step per tick (player / enemy) | 9.33 / 6.5 u | speed / 60 |

Two facts from the code that matter for everything that follows:

1. **Hit detection is point-in-sphere at the end of each tick** (`combat.ts` ~L551: `distance(nextPos, enemy.position) <= enemyHitRadius`). A player bolt moves 9.33 u per tick against a 9.5 u radius. Any chord offset more than ≈8.3 u from centre is shorter than one step, so edge hits can tunnel. Crits and grazes both need honest geometry. **Prerequisite P1: swept segment-vs-sphere (closest point on the tick's segment) for all projectiles.**
2. **Audio consumes events every sim step** (`main.ts` calls `audio.sync` inside the fixed-step loop), **but HUD and renderer read `world.events` once per frame.** On frames that run 2+ steps, the HUD sees only the last step's events (the journal's dropped `SHIELD DOWN` banner). Every jackpot visual below will vanish on slow frames unless this is fixed. **Prerequisite P2: accumulate events across the steps of a frame (`frameEvents: SimEvent[]` in `main.ts`) and pass that to `hud.render` / `renderer.render`.**

---

## 1. Reference games: what landed, what failed, what we take

### 1.1 What players and critics loved

| Game | What landed | Evidence | Principle we take |
|---|---|---|---|
| **Star Wars: Squadrons** (2020) | Power routing (engines/weapons/shields) as the core skill; cockpit-only view with diegetic instruments | Reviews call power management "the most important system… but also the most intuitive"; some note it is less granular than the 90s sims | One resource triangle the player trades in real time, readable from instruments. **We already have it**: overdrive spends shields, firing spends heat. Don't add a third bar; deepen the trades between the two we have. |
| Squadrons maps | Each map built around a landmark such as a shipyard, a station or a gas giant *(recall)*. A fan wiki lists 7 maps, incl. Galitan, Sissubo, Nadiri Dockyards, Yavin Prime, Esseles. Fleet Battles maps run in 5 zones from your flagship to theirs. Guides say most maps include debris/asteroids/terrain you use in a dogfight. | wiki / guides | **A map is a landmark plus a lane.** Give each arena one dominant structure you can name, and a front line that moves along an axis. Our Hearthstone to Concession frigate axis (≈920 u) is already a 2-zone version of this. |
| **Project Wingman** (2020) | Bombastic kill confirmation: "flames and smoldering debris confirm your kill alongside a bassy 'boom!' that you can almost feel" (PC Gamer). Missions mixing dogfights with "large scale ground assault". Conquest mode is roguelite territory capture against aces. | PC Gamer, Steam, Wikipedia | **Kills are a 3-beat event** (impact → confirmation → debris) and should be *felt* in the bass. Ground targets give the player something to do between dogfights. A roguelite mode needs named elites (aces) as punctuation. |
| **TIE Fighter** (1994) | Briefings that framed each mission's specific challenge; craft progression from unshielded to shielded; failure felt fair, "solely down to you" (Kotaku). Repair order chosen by the player; damaged cockpit displays break. | Kotaku, PC Gamer, Wikipedia | **Fairness is the product.** Every death must be attributable to a visible cause. Damage can degrade instruments diegetically instead of adding HUD warnings. |
| **House of the Dying Sun** (2016) | "Rather colorful and yet rather minimalist" presentation; "Hit Feedback is impeccable with most Weapons" (user review); tactical pause and command layer *(recall)*. | RAWG, Game Informer (7.5) | **Minimal HUD works only when hit feedback is loud.** Strip text, but never strip confirmation. |
| **Everspace 2** (2021/23) | Combat and flying praised even by critics of its systems ("I had a good time with the combat and flying", Escapist). Hand-built zones dense with stations, wrecks, and asteroid fields *(recall)*. | Escapist, PC Gamer 85 | Space doesn't have to be empty. Every Everspace zone sits inside a structure. |

### 1.2 What players hated (avoid list)

| Complaint | Where | Evidence | Our rule |
|---|---|---|---|
| **Level-scaled sponges**: one level up and "you hardly do any damage to them"; story missions gated a level or two above you | Everspace 2 | XXLGamer, Metacritic users | **No stat-scaled enemies.** Difficulty comes from count, composition, aim behaviour, and terrain. A hit always does its listed damage. A basic raider takes 9 bolts or fewer at every wave. |
| **"Kill everything" monotony**: "gets understandably old after 20 missions" | Project Wingman | player review | Every wave has a *verb* beyond "shoot all": protect, strip a subsystem, run a gauntlet, chase a runner. |
| **Repetitive faceless enemies**: "just shooting faceless enemies tends to feel somewhat repetitive" | Everspace 2 | CGM | Named callsigns already exist (`callsign`). Elites get a radio line and a silhouette accent. |
| **Small map/mode pool** | Squadrons | TechRaptor | Three arena archetypes (Section 2), each with remixable layouts from a seed. |
| **Opaque lock-on rules** | general; our own journal: held RMB fired unguided missiles (cooldown 34 ticks < lock 48 ticks) | Astra review | Lock state must be audible *and* visible at every stage. Missiles never fire unguided by accident. |
| **Unannounced difficulty cliffs** | our own bot probes: 10 to 15 s cliff to 89% enemy accuracy | Fable probe | Threat ramps visibly (enemy aim tightens as they track you; Section 3.3) and is always counterable by evasion. |
| **Bloated, noisy HUDs** | general genre complaint *(recall; no review found)*; HotDS is praised for the opposite | | Section 4.1: three zones, one banner at a time, fade what is stable. |
| **Empty vacuum, no spatial reference** | general space-sim complaint *(recall; no review found using the phrase)* | | Section 2. |

---

## 2. Non-vacuum level design

### 2.1 Sizing rules (derive every dimension from flight tuning)

- **Corridor width ≥ 2.2 × cruise turn radius (≈90 u).** Below that the player can't jink and still hold a heading. Corridors meant for overdrive runs: ≥ 2.2 × 69 ≈ 150 u.
- **Obstacle cadence 0.5 to 0.8 s at cruise** → structural ribs, pylons, or arches every **50 to 80 u** along a run. Faster cadence reads as noise; slower reads as empty.
- **Gaps you're meant to thread ≥ 4 × player hit radius (≥ 30 u)**, plus the existing `asteroidClearanceMargin` 10. Gaps under 30 u are for experts and must be optional.
- **Engagement depth ≤ bolt reach (515 u).** Every combat pocket should fit inside a 500 u sphere so the target you see is a target you can hit.
- **Landmark visibility ≥ lock range (1100 u).** Anything used for navigation must read as a silhouette from 1100 u.
- **Collision primitives don't exist yet.** `math.ts` has no capsule, box, shell or heightfield tests, and obstacles today are sphere clearance (`resolveObstacleClearance`, asteroid spheres). Arenas need prerequisite P6 (Section 5.1) before any of them ship.
- **Geometry is one shared layout** read by sim collision and by meshes (AGENTS invariant: Visual Meshes ↔ Sim Hitboxes). Define each arena as plain data in `src/sim/arenas/<name>.ts`: arrays of capsules, boxes, and spheres. `src/render/` builds meshes from the same arrays. Never hand-place a mesh that has no collider, or a collider with no mesh.

### 2.2 Archetype A: megastructure trench (fly-through)

A broken orbital ring or dry-dock spine, ≈2000 u long.

```
 top view                                    side section
  ┌──╥──╥──╥──╥──╥──╥──┐                     ▓▓▓   ▓▓▓  ← broken roof spans (cover)
  │  ║  ║  ║  ║  ║  ║  │ ← ribs every 60 u   ▓ |       | ▓
  │  ║  ║ ⊕║  ║  ║ ⊕║  │ ⊕ turret pods      ▓ |  ✈    | ▓  depth 80 u
  └──╨──╨──╨──╨──╨──╨──┘                     ▓▓▓▓▓▓▓▓▓▓▓
     width 110 u, 3 lanes                      width 110 u
```

- **Dimensions:** width 110 u, depth 80 u, rib spacing 60 u (0.6 s at cruise). Roof spans over ≈40% of the length for cover from fighters above.
- **Three lanes:** inside the trench (safe from fighters, exposed to turrets), on the rim (both), above (fighters only). The player picks risk by altitude.
- **Targets:** 4 to 6 turret pods on the walls (reuse `SubsystemState`), one power conduit at the end that drops a shield gate.
- **Exits:** a breach every ≈400 u, so a pursued player can always leave.
- **Readability:** wall panels carry a running chevron stripe pointing toward the objective (leading lines). Ribs alternate two palette values so speed reads from flicker rate.

### 2.3 Archetype B: hollow fractured super-asteroid

A ≈900 u-diameter shell split open, with a glowing core and internal ribs.

- **Exterior:** 3 to 4 fracture openings, each 120 to 180 u wide. They are the only ways in, so they act as chokepoints.
- **Interior:** core light (emissive, warm, single hue) at the centre gives a permanent "down/in" reference. Radial **sightline ribs**, 25 to 40 u thick, cross the cavity, spaced so any two points ≤ 500 u apart have a clear line about half the time. That makes peek-and-hide fights.
- **Orientation:** the core glow is visible from everywhere inside. Shell interior uses cool slate; ribs carry a warm ochre edge line, so near vs far reads by temperature.
- **Gameplay:** enemy carriers dock inside; the player strips them by diving through ribs. Destructible rib segments (existing asteroid `hull`) open new lanes mid-fight.
- **Collision:** ribs are capsules, shell is a sphere-shell with opening cut-outs (sphere test plus angular-cone exclusion). All cheap and deterministic, but all new (P6). This is still the cheapest archetype: no heightfield, and the cavity reuses sphere math.

### 2.4 Archetype C: planetary close-air-support valley

A canyon on a moon of the gas giant, the sky filled by the planet. This is the one archetype that brings gravity-like reference (ground) into the game.

**Phase structure (one sortie, ≈6 to 8 min):**

| Phase | Verb | Targets | Ends when |
|---|---|---|---|
| 1. Ingress | Fly low under the shield umbrella | 3 shield relays on ridgelines (subsystems) | relays down → umbrella drops |
| 2. Strike | Ground attack | AA batteries (fixed, telegraphed fire), a 5 to 7 vehicle convoy moving along the valley floor at 30 to 40 u/s | convoy destroyed or escapes (partial credit) |
| 3. Air superiority | Dogfight | raider wave scrambles from a forward base, then a striker pair | wave cleared |
| 4. Egress (optional) | Run the canyon out | AA plus pursuers | reach exit marker |

- **Valley dimensions:** floor width 150 to 300 u, wall height 120 to 200 u, meanders with bends every ≈600 u (≈6 s at cruise) so the next segment is always hidden until you commit.
- **Terrain collision:** a heightfield sampled deterministically from the arena seed. Keep it as a coarse grid (e.g. 64 × 256 cells, 20 u each) with bilinear height, the same grid the mesh is built from.
- **AA batteries telegraph:** 0.6 s muzzle charge glow plus a rising tone before each burst, so CAS is about timing, not attrition.
- **Altitude band:** below 40 u above the floor, AA can't depress to hit you; fighters can. That is the risk choice.
- **Shared ground target type:** convoy vehicles and batteries are entities with hull and no shields, so ground attack is fast, juicy TTK (2 to 4 bolts) and a deliberate contrast with dogfight TTK.

### 2.5 Spatial orientation toolkit (apply in every arena)

1. **One sky anchor.** The gas giant is already the best orientation cue in the game; keep it fixed per arena and never move it. The player reads "up" from it.
2. **Two-tone landmark coding.** Friendly structures warm ivory + amber, hostile structures dark hull + crimson accent, objectives cyan. Never reuse objective cyan on scenery.
3. **Silhouette contrast.** Fighters must read against both sky and structure. Hostile fighters get a crimson rim term in the toon shader that brightens with distance (to stay readable at 500+ u) and a dark ink outline against bright planet backdrops.
4. **Scale ladder.** Every view should contain three scales: something huge (planet/megastructure), something mid (frigate/carrier/rib), something small (fighters, debris). Space dust and streaks in the near field (already present as drift streaks) give speed; the mid scale gives distance.
5. **Leading lines.** Rib rows, chevron stripes, convoy roads, and trench walls all point toward the current objective.
6. **Local fog by depth.** A subtle per-arena depth tint (not distance fog that hides threats; ≤ 15% blend at 1500 u) separates near from far without hiding targets inside bolt reach.
7. **Out-of-bounds is visible.** Replace an invisible 2600 u wall with a physical boundary (gravity shear, debris belt density increasing past 2200 u) plus one radio line.

---

## 3. Variable-rate reinforcement, done ethically

### 3.1 Framing (from the two drafts, with corrections)

What we take from the drafts:
- **Prediction error drives learning.** Dopamine neurons respond to reward that is *better than expected*, not to reward itself (Schultz, Dayan & Montague 1997). A fully predictable reward stops teaching anything.
- **Uncertainty itself is salient.** The finding that sustained dopamine activity peaks when reward probability is 0.5 is **Fiorillo, Tobler & Schultz 2003**, not Schultz 1997 as the Claude draft has it. Activity is weaker at 0.25/0.75 and absent at 0 or 1. (Niv et al. 2005 argued the ramp is an averaging artefact; contested.)
- **Near-misses recruit win circuitry** (striatum, insula), and invigorate play **only when the player had personal control** (Clark et al. 2009, *Neuron*). This is the key ethical lever: in a skill game a near-miss is *real information about real control*. In a slot machine it's a lie.
- **Variable-ratio schedules resist extinction** (Ferster & Skinner 1957).

What we drop: the drafts' specific figures ("30% near-miss sweet spot", "+300% play duration", LDW 19.6%, platform addiction-rate table) are unsourced or unverifiable as written. **Do not turn any of them into a tuning constant.**

### 3.2 Guardrails (hard rules, enforceable in review)

1. **Only real skill events pay out.** Every reward traces to a measurable player action (aim, aspect, evasion, timing). No reward is a pure dice roll on a passive action.
2. **No fake near-misses.** A graze is only emitted for a bolt that actually passed within the graze shell. Never spawn shots to "almost hit".
3. **No losses disguised as wins.** No celebratory feedback on a net-negative outcome (e.g. no fanfare when the player dies with a high combo; the combo ends quietly).
4. **Randomness modulates magnitude, never eligibility.** Spray-and-pray at front aspect from max range has a crit chance of exactly 0.
5. **Natural stopping points.** The wave mode has a clear end-of-run summary, no auto-launch of the next run, no streak decay across sessions, no login rewards.
6. **TTK variance is bounded.** At most 2 crits per target life, so a crit saves at most 2 bolts on any kill. Fights stay readable.
7. **No meta-currency pressure tied to time away.** Persistent unlocks, if any, are earned per run and never expire.

### 3.3 Mechanics (ranked; implement in order, cut from the bottom)

Cut order if scope tightens: **M6 → M5 → M4 → M3** (M4's gold orb has a fallback if M6 goes). M1 and M2 are the core; M0 is a prerequisite.

#### M0. Make enemy fire dodgeable (prerequisite for M2)

Graze only works if evasion matters; the bot probe showed 89% enemy accuracy against an AFK player. The current aim code (`combat.ts` ~L1156 to 1170) explains why:
- Enemies fire at a **perfect quadratic lead point** (`computeLeadPoint`) whenever the player is 130 to 560 u away inside a ≈28° nose cone.
- Spread is `(roll − 0.5) × 0.032` rad on x plus half that on y, at most ≈0.018 rad (≈1°). At 300 u that is at most ≈5.4 u of miss, inside the 7.5 u player hit radius, so against a constant-velocity target nearly every shot hits.
- The spread is added in **world x/y**, not perpendicular to the aim direction, so when an enemy aims along world x the x component does nothing.
- **One roll drives both cooldown and spread**, so long-cooldown shots always miss to the same side.

Change:
- Spread perpendicular to `aimDir` (build a basis from `aimDir`), with two separate rolls (direction, magnitude) and a third for cooldown.
- Error cone: **4.0°** when an enemy first gets the player in its firing cone, tightening linearly to **1.2°** over **3.0 s** of continuous tracking. Reset to 4.0° when the player's angular rate exceeds **1.2 rad/s** for ≥ 0.25 s (jinking). Line-of-sight resets wait for P6.
- Lead uses the player's velocity *at fire time*, which already rewards jinking: a player who changes velocity after the shot leaves the lead point.
- Owner: `src/sim/combat.ts`. RNG: the existing `rngState` stream (this is AI behaviour, so churn in existing seeded tests is expected; update their snapshots in the same commit).
- Test (vitest, seeded): over 20 seeds × 180 s, AFK hit rate ≥ 70% (threat stays real); a scripted jinking bot's hit rate ≤ 35%.

#### M1. Precision critical hits (skill-weighted variable ratio)

Hull hits only (shield hits never crit, so reading the shield stays meaningful).

```
p = rearAspect + postBreak + chain + closeRange, capped at 0.50
rearAspect  = 0.15 if dot(enemyForward, boltDir) > 0.70 (bolt travelling with the enemy, ~45° tail cone)
postBreak   = 0.20 if within 1.5 s after this enemy's shield_broken
chain       = 0.04 × max(0, consecutiveHitsOnTarget - 3), capped at 0.20 (any miss resets)
closeRange  = 0.05 if range < 200 u
crit damage = 2 × boltDamage (36)
```

- Why this shape: the cap of 0.5 puts skilled play right where Fiorillo-style uncertainty is maximal, while sloppy play sits at p = 0 (certainty, no salience). Best play = most exciting play.
- Bounded variance: **at most 2 crits per target life**, so a crit kill saves at most 2 bolts on any hull size. Raider hull 75: 5 bolts normally, 3 minimum. Striker hull 100: 6 normally, 4 minimum. An ace at 150 hull: 9 normally, 7 minimum.
- **Separate RNG stream:** add `rewardRngState` to `WorldState`. Drawing crits from the main `rngState` would shift every enemy AI roll downstream and churn every seeded test and bot probe.
- Event: extend `hit_confirmed` with `crit: boolean` and `chain: number` rather than adding a new kind. The kill path (explosion cue keyed on `hit_confirmed.isKill`, the `subsystem_destroyed` look-ahead in `synthAudio.ts`) stays one path, and audio picks the crit cue from the flag. Add `position: Vec3` so render can place the burst.
- Owner: `src/sim/combat.ts` (roll + damage), `src/render/` (impact flash), `src/audio/` (cue).
- Tests: (a) 10 000 seeded hull hits per condition, observed crit rate within ±1.5 pp of p; (b) front-aspect, >200 u, no chain, no break window: crit count exactly 0; (c) same seed twice gives an identical crit sequence; (d) changing only crit code leaves `rngState` sequences identical (stream isolation).

#### M2. Near-miss graze

- Graze shell: closest approach **7.5 < d ≤ 14 u** to the player (≈1.9× hit radius), measured on the swept segment (P1).
- Emit once per bolt (`grazed: boolean` on `ProjectileState`) at the tick the bolt passes its closest approach (sign change of `dot(relPos, relVel)`).
- Reward: **+6 weapon charge** per graze (heat relief, which is the resource that matters mid-fight), max **3 grazes rewarded per rolling 2 s** to stop camping in fire. Grazes inside 2 s escalate the cue pitch (Section 4.3).
- Not rewarded while overheated *(design choice: prevents grazing as a lockout bypass; revisit after playtest)*.
- Event: `{ kind: 'graze'; position: Vec3; count: number }`.
- Formal: graze adds charge to `EnergyState`, so update `formal/EnergyAndLock.tla` with a `Graze` action (bounded +6, blocked while overheated) and run `npm run verify:formal`.
- Tests: scripted bolt passing at 10 u emits exactly one `graze`; at 7 u emits a hit and no graze; at 15 u emits nothing; 10 grazes in 1 s award charge for only 3.

#### M3. Streak multiplier (wave mode)

- Streak increments on kills and subsystem kills; window **6 s** between kills, extended by **+1.5 s** per graze/crit (rewards staying engaged, capped at 8 s).
- **The timer freezes** during `intermission` and while no hostile is alive (spawn gaps such as wave 5's second flight). A streak can only be lost by being slow while there is something to shoot, so it carries across waves.
- Multiplier steps at 3 / 6 / 10 / 15 kills: ×1.5 / ×2 / ×3 / ×4 on wave score only (never on damage; combat math stays honest). With the freeze, tier 4 needs about two and a half clean waves, which is the intended "great run" bar.
- Breaking the streak is quiet (no buzzer, no loss animation). It just fades.
- Event: `{ kind: 'streak_changed'; count: number; tier: 0|1|2|3|4 }` on tier change only.
- Owner: new `src/sim/waves.ts`. Test: seeded kill timeline gives the exact expected tier sequence.

#### M4. Rare tactical drops (variable ratio with bad-luck protection)

Dropped by destroyed enemies; collected by flying within 25 u (no aim needed, but you must leave your line to get it, which is the risk).

| Drop | Effect | Base weight |
|---|---|---|
| Heat flush | weapon charge → 100, cancels overheat | 40 |
| Shield surge | +40 shield, clears regen delay | 30 |
| Super-missile | next missile 2× damage, 1.5× turn rate | 20 |
| Gold orb | +50 run XP (Section M6) | 10 |

- Drop chance per kill: **base 12%**, **+6% per kill without a drop** (bad-luck protection), reset on drop. That guarantees a drop by the 16th kill; expected interval ≈4 kills (computed).
- Elite (ace) kills always drop.
- Drops live 12 s, blink the last 3 s.
- Rolls use `rewardRngState`.
- **Heat flush caution:** the journal found overheat refill (28/s) gives +41% DPS over normal recharge (18/s). Fix that first (make lockout refill ≤ 18/s or add a post-lockout penalty), otherwise heat flush stacks onto an exploit.
- Formal: heat flush and shield surge mutate `EnergyState`; add `HeatFlush` and `ShieldSurge` actions to the TLA+ model. `verify:formal` must pass, and the mutant gate must still kill.
- Events: `{ kind: 'drop_spawned'; dropKind; position }`, `{ kind: 'drop_collected'; dropKind }`.
- Tests: 100 000 seeded kills give drop rate and kind distribution within ±1 pp; no run of >15 kills without a drop.

#### M5. Ace elites in wave mode

Every 3rd wave includes one named ace (callsign + radio line + crimson stripe silhouette). Aces are skill punctuation, not sponges: shield/hull at most 1.5× striker, but tighter aim (cone floor 0.8°) and real evasive breaks. They always drop. This is the Project Wingman / roguelite "boss and ace squadrons" beat.

#### M6. Run XP, levels and upgrade picks

- Run XP: kill 10, subsystem 25, ace 60, graze 1, crit 2, gold orb 50. XP is per run and resets on run end (no persistent grind).
- Level thresholds: 100, 220, 360, 520, then +180 per level. On level-up the pick waits for the next `intermission` (never interrupts a fight): pick 1 of 3 small flat changes (e.g. +10% heat capacity, missile rearm −0.5 s, graze shell +2 u). No rarity tiers, no currency rerolls.
- Events: `{ kind: 'xp_gained'; amount: number }` (HUD only, aggregated per frame), `{ kind: 'level_up'; level: number }`. The level-up fanfare plays at the moment of `level_up` (Section 4.3); the pick screen plays the wave-clear cadence.
- **If M6 is cut**, the gold orb becomes "+1 missile now and full shield" (an immediate effect) and XP/levels don't exist.
- Test: seeded event timeline gives exact XP totals and level-up ticks; level-up never changes `phase` during `active`.

### 3.4 Wave mode structure (pacing)

Wave mode must enter the single exhaustive `SortiePhase` union (AGENTS invariant). Suggest adding a `mode: 'campaign' | 'waves'` to `SortieConfig` and a phase `{ kind: 'intermission'; wave: number; elapsedSeconds: number }` between waves. Pause rules apply to it like `active`, but `paused` today carries only `elapsedSeconds` and always resumes to `active`. It needs a resume target, e.g. `{ kind: 'paused'; resumeTo: ActivePhase | IntermissionPhase }`, so focus loss during intermission resumes to intermission. Update `STATE_MACHINES.md` and the pause tests (idempotent, never unpauses) with it.

Avoid single-wave monotony with a sawtooth intensity curve:

| Wave | Shape | Intensity |
|---|---|---|
| 1 | 3 raiders, open space near a landmark | low |
| 2 | 4 raiders + 1 striker | rising |
| 3 | Ace + escort | peak |
| 4 | **Breather objective**: strip 2 turret pods / escort a damaged friendly; 2 raiders | dip |
| 5 | 5 raiders arrive in two flights 20 s apart | rising |
| 6 | Striker pair + ace | peak |
| … | repeat with composition remixes and arena changes every 3 waves | |

- Intermission: 8 s, shields refill, upgrade pick, music drops to the pad layer.
- Ending: on death or on choosing "bank and end" in intermission. Summary screen shows waves, crits, grazes, best streak. No auto-restart.
- Tests: wave composition is a pure function of `(seed, waveIndex)`; a snapshot test pins waves 1 to 9.

---

## 4. Minimal-clutter cockpit UI and audio psychology

### 4.1 HUD principles

1. **Three zones, nothing else.** (a) Reticle cluster at centre: aim, lead pip, heat arc, lock state. (b) Target bracket on the target itself: shield/hull pips. (c) Bottom strip: speed, throttle, own shield/hull, radar. Everything else is diegetic (cockpit dials, barrel glow, smoke) or audio.
2. **Information lives where the eye already is.** Heat belongs on the reticle arc (it does). Shield state belongs on the target bracket. Never ask the player to look at a corner mid-fight.
3. **One text banner at a time, ≤ 2 words, ≤ 1.2 s.** `SHIELD DOWN`, `OVERHEAT`, `LOCKED`. Priority queue: overheat > shield down > lock > streak. Lower priority waits or drops.
4. **Shape before colour, colour before text.** Lock acquiring = 4 corner ticks closing in; locked = ticks snap and fill. Readable in grayscale and for colour-blind players.
5. **Fade what is stable.** Bars at 100% fade to 30% opacity after 2 s. They return to full on change. A calm screen makes changes pop.
6. **Off-screen threats use edge chevrons only** (already present); never a full-screen damage vignette over 20% opacity.
7. **Rewards render in world space.** Crit sparks at the impact point, graze flare along the bolt's path, drop icons on the object. Floating numbers: off by default.
8. **Every reward visual ≤ 250 ms on screen** except kills (debris persists, which is fine; it's world, not HUD).
9. **Camera shake is applied to the camera used by `projectWorldPoint`**, never as a separate canvas transform, so the reticle and lead pip can't drift from ballistics (Camera ↔ HUD ↔ Ballistics invariant). Max 0.3°, 90 ms, kills and player damage only. No FOV kicks (they move the lead pip).
10. **Damage degrades instruments, not adds warnings** (the TIE Fighter lesson): below 30% hull, the radar flickers and one cockpit dial needle jitters.

### 4.2 Event-to-feedback map (the juice table)

| Event | Visual (≤ frame) | Audio | Duration |
|---|---|---|---|
| `hit_confirmed` (shield) | blue hex ripple on enemy shield | glassy tick, pitch by chain | 80 ms |
| `hit_confirmed` (hull) | orange sparks + 1-frame white flash on mesh | dry metallic tick, pitch by chain | 60 ms |
| `hit_confirmed` (crit) | white-gold star burst, reticle inner ring pulse | crit cue (below) | 180 ms |
| `shield_broken` | shield shell shatters into 12 shards | shield-break (exists) + 1.5 s high shimmer telling the player the crit window is open | 1.5 s |
| kill | flash → fireball → debris tumble 3 s | kill cue: sub punch + ring + debris rattle | 3 beats over 400 ms |
| `graze` | short cyan streak along the passing bolt | air-rip whoosh, pitch by graze count | 120 ms |
| `drop_spawned` | rotating icon, vertical light pillar 40 u | soft 2-note chime | until collected (12 s) |
| `drop_collected` | icon implodes to reticle | ascending 3-note arpeggio | 300 ms |
| `streak_changed` | reticle outer ring gains one notch per tier | tier stinger, quantised to the beat | one beat (0.4 s) |

### 4.3 Audio psychology: concrete recipes

**Pitch-escalating hit ticks.** `playCue` already sets `source.detune` for barrel side, so escalation needs no new recipe variants: pass a detune of **+100 cents per consecutive hit on the same target (one semitone), capped at +700 (a fifth)**, reset on miss or target change. Better: step through the D natural minor scale (D E F G A B♭ C) so the chain plays a melody in key with the 150 BPM D-minor loop. Detune changes duration slightly; fine for ticks under 80 ms.

**Crit cue** (new `agent-audio` recipe `critical-hit`, ≈300 ms):
- Sub punch: sine 55 Hz (A1, the dominant of D) with a pitch drop from 110 Hz over 40 ms, attack 1 ms, decay 120 ms.
- Metallic ring: FM, carrier 1760 Hz (A6), ratio 3.5 (inharmonic = metallic), index 3 → 0.5 over 200 ms, decay 250 ms.
- Transient: 3 ms highpassed noise click at 6 kHz.
- Sidechain: duck music bus by −4 dB for 120 ms (release back with 0.08 s time constant) so the crit reads over the score.

**Kill cue** (rebuild `kill-confirm` as 3 beats): beat 1 impact (noise + 60 Hz punch), beat 2 at +90 ms: a ring on D (1175 Hz) and A (1760 Hz) together, an open fifth that resolves; beat 3 at +180 ms: lowpassed debris rattle 400 ms. That is the "you felt it" Project Wingman bass plus a tonal resolution.

**Lock-on anticipation → resolution.** During `acquiring`, play a tick each time `progress` crosses 0.25/0.5/0.75 on **A → B♭ → C♯** (rising, ending on the leading tone C♯ for tension), then `target_locked` resolves to **D** with a sustained tone. Tension on the leading tone, release on the tonic. Lost lock: a falling minor second, quiet. Needs a new `lock_progress` event `{ kind: 'lock_progress'; step: 1|2|3 }` from the lock state machine (already TLA+-modelled; adding an event doesn't change state, but confirm the model is unaffected).

**Streak tier stingers / wave-clear fanfare.** Quantise to the next eighth note of the 150 BPM loop (0.2 s grid) so they land musically. Use the loop's A–D–E–F motif, one note higher per tier. Wave clear: motif plus a held D major chord (picardy third) for 1.2 s. In a D-minor score a major tonic is a rare colour, so it reads as earned; check the loop recipe doesn't already use F♯ over D before relying on that.

**Level-up fanfare** (`level-up` recipe, ≈900 ms): anticipation then resolution. A 250 ms rising filtered-noise swell plus an A–C♯ pickup on the beat grid, then a D major triad stab (D5 F♯5 A5, square + saw, short release) with the sub punch from the crit cue under it. Quantise the stab to the next beat (0.4 s at 150 BPM) so the wait is part of the reward.

**Graze whoosh.** Bandpassed noise, centre 1.2 kHz sweeping to 3 kHz over 120 ms, panned to the side the bolt passed. Escalate centre frequency by +20% per graze in the 2 s window.

**Rules:**
- All new cues route through `effects` → master bus (AGENTS audio rule). New cues are `agent-audio` recipes in `combat-cues.json`, verified with `npm --prefix tools/agent-audio test`.
- **Do not edit the pinned soundtrack recipe** (`combat-loop.recipe.json`); parity tests pin it. Ducking is a gain change on the music bus, not a recipe change.
- Voice-limit reward cues to **4 concurrent**; drop the oldest. Stacked crits must not clip.
- Rare cues stay rare: target no more than one crit cue per ≈1.5 s in expert play (a target, not yet measured). If a seeded expert-bot probe shows more, lower `chain`, not the cue's loudness.

---

## 5. Engineering contract for Wave 2

### 5.1 Prerequisites (do first)

| ID | Change | Module | Gate |
|---|---|---|---|
| P1 | Swept segment-vs-sphere hits for all projectiles | `src/sim/combat.ts`, `src/sim/math.ts` | `npm run check`; test: bolt at 9 u offset from centre registers a hit (currently can tunnel) |
| P2 | Accumulate events across steps in a frame for HUD/render | `src/main.ts`, `src/render/cockpitHud.ts` | `npm run verify:browser`; test: 3-step frame with `shield_broken` in step 1 shows the banner |
| P3 | Fix overheat refill DPS exploit (lockout refill ≤ normal recharge, or post-lockout penalty) | `src/sim/energy.ts`, `formal/` | `npm run verify:formal` |
| P4 | Enemy aim error cone (M0) | `src/sim/combat.ts` | seeded bot-probe test (M0) |
| P5 | `rewardRngState` separate stream | `src/sim/types.ts`, `world.ts` | test: existing seeded tests unchanged |
| P6 | Collision primitives (capsule, box, sphere-shell with cut-outs, heightfield), projectile occlusion by geometry, enemy/wingmate obstacle avoidance and line of sight | `src/sim/math.ts`, `combat.ts`, `flight.ts`, new `src/sim/arenas/` | `npm run check`; seeded bot probe: 0 AI ship-in-wall ticks over 20 seeds × 180 s; bolts stop at walls |

### 5.2 New `SimEvent` kinds

```ts
| { readonly kind: 'graze'; readonly position: Vec3; readonly count: number }
| { readonly kind: 'lock_progress'; readonly step: 1 | 2 | 3 }
| { readonly kind: 'streak_changed'; readonly count: number; readonly tier: 0 | 1 | 2 | 3 | 4 }
| { readonly kind: 'drop_spawned'; readonly dropKind: DropKind; readonly position: Vec3 }
| { readonly kind: 'drop_collected'; readonly dropKind: DropKind }
| { readonly kind: 'wave_started'; readonly wave: number }
| { readonly kind: 'wave_cleared'; readonly wave: number }
| { readonly kind: 'xp_gained'; readonly amount: number }
| { readonly kind: 'level_up'; readonly level: number }
// extended, not new:
| { readonly kind: 'hit_confirmed'; readonly isKill: boolean; readonly shieldHit?: boolean; readonly crit: boolean; readonly chain: number; readonly position: Vec3 }
```

`chain` on `hit_confirmed` lets audio escalate pitch without tracking state in the audio layer, so audio stays a pure reaction to sim events.

### 5.3 Gates per area

| Area | Gate |
|---|---|
| Any `src/` change | `npm run check` |
| `energy.ts`, lock, graze, drops touching `EnergyState` | `npm run verify:formal` (model + mutant gate) |
| HUD, renderer, arenas | `npm run verify:browser` with `VERIFY_OUT_DIR=artifacts/verify-<worker>`; inspect screenshots |
| New arena meshes / structures | `agent-3d` turntable, 0 degenerate triangles, inspect contact sheet |
| New cues | `npm --prefix tools/agent-audio test`; audio parity tests stay green |

### 5.4 Suggested agent split

- **Sim agent (Opus):** P1, P3, P4, P5, P6, M1, M2, M3, M4, M6 sim side, wave state machine, TLA+ updates.
- **Render/HUD agent (Opus):** P2, juice table visuals, HUD fade/priority rules, arena mesh builders from shared layouts.
- **Audio agent:** crit, kill, lock-progress, graze, stinger recipes; detune escalation; music-bus ducking.
- **Fable:** art direction for arenas (palette coding, silhouette contrast, landmark readability), playtest judgment on reward frequency.

Order: P1 to P5 → M1 + M2 with their cues → P6 plus one arena archetype (recommend B, the hollow asteroid: no heightfield, mostly sphere math) → wave mode (M3 to M6) → archetypes A and C.

---

## Sources

- PC Gamer, *Star Wars: Squadrons* review: https://www.pcgamer.com/star-wars-squadrons-review/
- TechRaptor, *Star Wars: Squadrons* review: https://Techraptor.net/gaming/reviews/star-wars-squadrons-review
- Squadrons map list (fan wiki, via Windows Central): https://www.windowscentral.com/star-wars-squadrons-list-all-locations-and-maps
- StrategyWiki, Squadrons Fleet Battles zones: https://www.strategywiki.org/wiki/Star_Wars:_Squadrons/Fleet_Battles
- Game Rant, Fleet Battles tips: https://gamerant.com/star-wars-squadrons-fleet-battles-tips/
- PC Gamer, *Project Wingman* review: https://pcgamer.com/project-wingman-review
- Project Wingman on Steam / Wikipedia: https://store.steampowered.com/app/895870/Project_Wingman/ , https://www.wikipedia.org/wiki/Project_Wingman
- Project Wingman player feedback (itch.io): https://rb-d2.itch.io/wingman/comments?after=339
- Kotaku, *TIE Fighter* review: https://kotaku.com/tie-fighter-the-kotaku-review-1652538943
- PC Gamer, Squadrons vs TIE Fighter briefings: https://www.pcgamer.com/star-wars-squadrons-has-a-fun-campaign-but-its-missing-the-brilliance-of-tie-fighters-military-flavor-text
- Wikipedia, *TIE Fighter*: https://en.wikipedia.org/wiki/Star_Wars:_TIE_Fighter
- Game Informer, *House of the Dying Sun*: https://gameinformer.com/games/house_of_the_dying_sun/b/pc/archive/2016/11/11/short-sweet-and-somewhat-sentimental.aspx
- RAWG user review, *House of the Dying Sun*: https://rawg.io/reviews/1635
- *Everspace 2* reviews: PC Gamer https://pcgamer.com/everspace-2-review , XXLGamer https://www.xxlgamer.com/reviews/exit/179/ , Escapist https://www.escapistmagazine.com/?p=141353 , CGM https://www.cgmagonline.com/?p=1022462 , Metacritic users https://legacy.prod.metacritic.com/game/pc/everspace-2/user-reviews
- Fiorillo, Tobler & Schultz 2003, *Science* 299:1898: https://pubmed.ncbi.nlm.nih.gov/12649484/
- Clark et al. 2009, *Neuron* 61:481: https://pmc.ncbi.nlm.nih.gov/articles/PMC2658737
- Schultz, Dayan & Montague 1997, *Science* 275:1593 (cited in the Claude draft)
- Jonasson & Purho, "Juice It or Lose It" (GDC Vault): https://gdcvault.com/play/1016789/Juice-It-or-Lose ; Nijman, "The Art of Screenshake" (Vlambeer)
