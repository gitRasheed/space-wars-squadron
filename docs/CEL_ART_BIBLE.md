# Space War Squadrons: visual and game-feel bible for Wave 2

Read-only pass, nothing in the repo changed. I read `palette.ts`, `postProcess.ts`, the toon shader in `models.ts`, `cockpitHud.ts`, the five `fable-visual` shots and three turntables. Hex values for B and C are starting points to tune by screenshot. The caps and rules are the contract.

## 0. Fix these before fanning out

1. **Saturn's violet is hard-coded in five places**, so B and C will inherit its cast: band tints baked into the shader string (`models.ts:28-30`), default rim `0x7c96d8` (`models.ts:115`), ink tint (`postProcess.ts:179`), vignette tint (`:184`), shadow and highlight grade (`:191-192`). Move them into one `BiomeCard` in `palette.ts`, read as uniforms. One builder should land this before the level builders start.
2. **Ink is depth-only.** It draws occlusion silhouettes and never draws creases, so a concave trench and continuous terrain get almost no lines for free (see 1.3).
3. **Defect:** a translucent crimson slab covers about 38% of `03-overheat.png`, and a wedge of it shows in `04-overdrive.png`. My guess is an enemy shield bubble at point-blank (`sceneRenderer.ts:512`, opacity `flash * 0.42`), but I did not diagnose it. Rule 5 in section 3 exists because of it.

## 1. Cel grammar

### 1.1 Global rules (same in every biome)

- **Four flat light steps** at N·L = -0.42, 0.04, 0.52, with luma multipliers 0.07 / 0.32 / 0.73 / 1.0 (today's values). A biome changes the hue of each step and nothing else.
- **No gradient wider than 2 px** on a lit surface. Step edges are anti-aliased by `fwidth` only.
- **Rim light is periwinkle `0x6b88ff` everywhere**, as a hard band. It is the house signature and puts a cold edge on every ship over warm backdrops.
- **One stepped glint**, no soft specular. `toonMat` and `glowMat` are the only materials.
- **Lift shadows with hemi light**, never by flattening the bands.
- **Value roles.** Friendly ivory hull (`0xede6d5`, luma 0.90) is the lightest non-emissive surface in the game. Hostile hull (`0x67647c` to `0x3b314d`) is the darkest saturated one. Environments sit between: lit environment tones cap at 0.72 display luma. Only emissives exceed 1.0 linear.
- **Depth comes in three tiers, not fog.** Near (under 450 m): full palette and ink. Mid (450 to 1600 m): ink fading, 3 tones. Far (over 1600 m): no ink, 2 flat tones, shape read by value alone.
- **Reserved hues.** No environment may use crimson, emerald, cyan or magenta above 55% saturation. Those belong to section 2.

### 1.2 Ink weight hierarchy

| Tier | Range | Line sources | Weight |
|---|---|---|---|
| Cockpit | 0 to 40 m | back-face shell, depth ink, crease lines (`0x111222` at 0.48) | 1.5x base (target; today it shares 1x with near ships) |
| Mid-range ships | 40 to 520 m | shell and depth ink | 1x at 40 m, tapering to 0.5x at 520 m |
| Distant ships | 450 to 1600 m | depth ink only | 0.5x, fading to zero |
| Landmarks | over 1600 m | none | 2 flat tones against the sky |

Base weight is `H/560` px (1.3 px at 720p, 2.6 px at 1440p). Ink is never pure black: it is 10% of the colour under it plus the biome's ink tint. Emissives (linear peak 1.5 or more) never take ink.

### 1.3 Where B and C get their lines

Depth ink starts when a surface stands proud of what is behind it by 3.5% of its distance and is solid at 12%. Build for that:

- **Trench:** walls are flat tone. Lines come from ribs, gantries and pipes that stand at least 8 m proud of the wall (solid ink to about 65 m, some ink to about 230 m).
- **Terrain:** stepped mesas and terraces 20 to 60 m tall. Each ledge is a real depth edge and a flat strata band. No rolling hills and no noise textures.
- **Panel lines:** modelled trim strips in the shadow tone, or `EdgesGeometry` crease lines on near geometry. Never a texture.

Unverified risk: assuming a vertical FOV near 60° at 720p, any plane passing within about 40 m of the eye takes ink in the last 1.5° (about 18 px) before its vanishing line. In a trench all four walls converge there, exactly where the player aims. No such geometry exists yet, so this is arithmetic, not a measurement. If the first trench screenshot shows a dark knot at the vanishing point, compute `depthJump` from the second difference of reciprocal depth, which is exactly zero on a plane, and retune the thresholds.

### 1.4 Biome cards

| Slot | A. Saturn Dusk Orbit | B. Megastructure Trench | C. Sunset Ground Support |
|---|---|---|---|
| Key light | `0xffdfbd` | sodium `0xffc070` | low sun `0xffc48a`, about 12° elevation |
| Shadow / core / terminator | (.06,.065,.13) / (.30,.31,.45) / (.82,.70,.64) | (.05,.07,.12) / (.40,.30,.24) / (.86,.70,.52) | (.07,.06,.13) / (.34,.29,.42) / (.90,.68,.56) |
| Hemi sky / ground | `0x7c88b8` / `0x1b172c` at 0.78 | `0x8a5a3c` / `0x0c1220` at 0.6 | `0x8a7fc0` / `0x7a4a3a` at 1.1 |
| Environment tones | sky in 4 flat tiers, luma 0.22 or less behind the fight | walls `0x33262a`, `0x6e4a3c`, `0x8a6650` (cap 0.45 luma, 45% saturation); void `0x05070f` | sky tiers `0x2b2f5e`, `0x7a4f7c`, `0xe8866a`, `0xe9ab78`; cloud `0xe0a58c` / `0x6a4a78`; mesa `0xb88a68`, `0x7d5560`, `0x3d2f52` |
| Grade: shadows / highlights | indigo / warm (today) | teal-black / sodium | violet / peach |
| Hero landmark (one only) | Saturn and rings | the cold gap at the trench's end | the sun disc on the horizon |
| How hostiles read | dark on dark, so by rim and crimson emissive. Hostile rim strength 0.3 or more (default is 0.18). | cold navy on warm rust: hue contrast | dark on light: value contrast |
| How friendlies read | brightest thing in frame | brightest thing in frame | ink, navy trim and cyan trail over cloud (only 0.2 luma headroom) |

Biome-specific rules:

- **B. Sodium is a light colour, never an emitter colour.** You see it on lit walls. Glowing sodium bulbs would collide with friendly bolts (`0xffe07d`), missiles and HUD amber.
- **B. Guide ribs are cold periwinkle-white `0xaab8ff`**, the one cold light inside, pointing at the cold exit. Evenly spaced, hard-edged strips, no flicker.
- **C. Every ground target sits on a flat pad in the lightest terrain tone**, with at least 0.35 luma between body and pad. Figure-ground is built into the level, not rescued by the HUD.
- **C. Sky and cloud stay under 0.95 linear** so they never bloom. Only the sun disc may.
- **C. Choose canyon mesas over archipelago.** Water invites reflections and soft speculars that break the style.

### 1.5 Rulings on the non-cel elements

| Element | Ruling |
|---|---|
| Bloom | Keep, emissives only, strength 0.5. Never on lit hull, sky or cloud. |
| Nebula and sky | Posterise into 4 flat tiers with edges 2 px soft at most. Today's soft gradients go. |
| Procedural plating | Keep at today's contrast (about 4% tone), near range only. Not on terrain or trench walls. |
| Rivet and hull textures | Capital ships only. Fighters are flat colour. |
| Additive glow | Bolts, engines and explosions only: white core plus one hue. |
| Smoke and debris | Faceted 2-tone puffs and shards, opacity 0.85 or more. No soft sprites. |
| Vignette, grain | Keep. Vignette tint comes from the biome card. |

## 2. HUD and telemetry

### 2.1 Budget

`02-cockpit-combat.png` carries about 15 canvas elements. Heat shows five ways (arc, dial, barrel glow, smoke, text) and throttle four (number, percent, bar, dial). Target: one fact gets at most one glass readout and one diegetic readout.

| Layer | Holds | Cap |
|---|---|---|
| Glass, always | reticle with shield and heat arcs, missile pips, selected-target bracket with one label and bars, lead pip, hostile markers | 6 nearest markers, 3 text strings, 2 live numbers (speed, target range) |
| Dash and cockpit | speed number, radar, SHD and HUL bars, throttle dial, heat dial, barrel glow and smoke, strut LEDs | 4 dash readouts |
| Hidden until triggered | objective counter (3 s on change), carrier health (when hit or under 50%), radio (one line, 4 s), key hints (first 20 s and pause card), state word, wingmate label (when within 10° of the reticle or calling) | 1 state word, 1 radio line and 1 banner at a time, queued danger > objective > reward > chatter |

Cut now: the throttle bar and percent text, and the permanent key-hint line.

- **Centre keep-out.** Within 150 px of the reticle at 720p, only the reticle, lead pip, target bracket, hit marker and one state word may draw.
- **No floating damage numbers and no score popups.**
- **Every glass mark gets the `#070812` ink underlay** at stroke width plus 2 px. Today only the lead pip has it (`cockpitHud.ts:481`). The 1 px, 0.42 alpha diamonds will vanish over C's sky.
- **Three stroke weights:** 2.2, 1.7, 1.2. No 1 px strokes. Text is 11 px minimum at 720p and scales with height (today's 9 px labels are too small).

### 2.2 Colour semantics: one hue, one meaning

Crimson currently means hostile, OVERHEAT, own hull low, SORTIE FAILED and kill marker. Emerald means hostile bolts, healthy hull, lead pip and prompts. Reassign:

| Meaning | Colour | Shape |
|---|---|---|
| Hostile (bracket, label, blip, incoming-damage flash, incoming missile) | crimson `#ff4d63` | diamond in the air, down-caret on the ground |
| Hostile fire | emerald `0x5dffb3` | scene only. Remove emerald from the HUD. |
| Your systems and aim (reticle, lead pip, chrome, speed) | amber `#f4b459` | |
| Peak and reward (overdrive, on-solution, crit, kill marker, XP, wave clear) | gold `#ffd966` | |
| Shields (anyone's) and friendlies | cyan `#6be5ff` | square |
| Your missiles | orange `#ff8e4d` | pips |
| Objectives, subsystems, weak points | magenta `#ff52b8` | hexagon |
| Neutral text (radio, counters, wave info, hull bars, prompts) | cream `#f6e8cf` | |

Own-system warnings (OVERHEAT, hull low) are an inverted amber pill with dark text, blinking at 2 Hz for 1 s and then steady. They never use crimson. Retire `frigateOrange`: a frigate is a large crimson blip.

### 2.3 New signals, each in an existing slot

- **Crit.** "VRR" is not defined anywhere in the repo or journal, so I assume a weak-point or timed bonus hit. The hit marker turns gold at 1.4x size for 120 ms, the impact gets one flat 6-point gold burst for 6 frames, and the sound is the hit-confirm cue pitched up a fifth. No text and no number. If VRR is a timing window, show the window as a gold notch on the existing heat arc.
- **Near-miss.** The bolt's streak brightens as it passes, a 3-frame emerald glint lands on the canopy strut on that side (2% of screen at most), and a whoosh pans to that side. No text. If it awards XP, one strut LED ticks.
- **Ground targets.** A crimson down-caret 14 px above the target with a thin stem to the ground beyond 600 m, for the 6 nearest only. The selected one takes the same corner bracket as air targets. On radar they are hollow triangles.
- **XP.** The eight strut LEDs fill gold as the level bar. On level-up they chase once and the state word reads `UPGRADE READY`. No XP number in combat.
- **Wave.** Reuse the objective slot: `WAVE 3 · 5 LEFT` for 3 s at wave start and on each kill, then hidden.
- **Upgrade pick.** One card in the existing pause-card style with the sim paused. Three choices at most, each with a name of 3 words or fewer, a line of 8 words or fewer, and one number. Owned upgrades are listed on the pause card only.

## 3. Guardrails for Wave 2 builders

1. **One palette, one material path.** DO take every colour from `palette.ts` and every surface from `toonMat` or `glowMat`. DON'T add hex literals elsewhere, PBR or Lambert materials, or image textures. Check: grep the diff.
2. **Silhouette first.** DO give each ship 5 major masses at most and make it pass the black-fill test: filled black in `ortho-top` and `ortho-front` on the contact sheet, it cannot be mistaken for any other ship, and its faction still reads at 12 px. DON'T fix a weak shape with greebles or decals.
3. **Own shape language.** Friendlies are long ivory wedges with one stripe. Hostiles are dark faceted plates with spikes and crimson light. DO invent from those two families. DON'T borrow from film or game ships. The current fighter, raider and a trench level already sit close to one famous franchise, so the megastructure needs its own structure and objective (hollow-asteroid ribs, the cold gap) and must not be a surface trench run to a port.
4. **Colour and detail budget.** DO keep each ship to 3 hull tones, 1 accent and 1 emissive at roughly 60/30/10, with emissive under 3% of the surface and always semantic. DO give each ship or level exactly one handcrafted charm detail, as the lucky crystal does for the cockpit. DON'T add a second.
5. **Quiet levels.** DO keep at least 40% of a typical frame in one or two flat tones, with one hero landmark per level. DO cap VFX: no single translucent primitive over 8% of the screen, 20% in total, and anything within 6 m of the camera fades out. DON'T scatter props inside the central 40° where targets live.
6. **One event, one response.** DO give each event one visual, one sound and one cockpit reaction, starting within one frame of the input, and keep feel effects in `src/render` so the sim stays deterministic. Hit feedback lasts 80 to 120 ms, kills 250 to 400 ms, and camera shake stays under 0.6° and 150 ms. DON'T stack flashes, shake and text on the same event.
7. **Upgrades you can see.** DO make each upgrade change something visible or audible in the cockpit or world (a barrel fin, a bolt shape, a dial mark), with an effect of 15% or more or a new behaviour, inside the verified energy and heat state machine. DON'T ship "+3%" stat cards or add a HUD widget per upgrade.

**Proof for every builder:** a turntable contact sheet (0 degenerate triangles, black-fill test), plus a `verify:browser` shot in each biome the asset appears in. Convert that shot to greyscale: a hostile at 500 m must be findable in a second, and every HUD mark must be readable over the brightest part of the backdrop.
