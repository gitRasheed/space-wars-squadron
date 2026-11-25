# Agent Audio and DAW Research

Date: 2026-11-25. Machine: `sisyphus` (Ryzen 9 9950X, 32 threads, no GPU).

Every number carries a provenance tag:

- **[measured]**: run on sisyphus for this report. Scripts and outputs are in the session scratchpad (`probe/probe.py`, `probe/out/`).
- **[grok]**: claimed by the Grok v4 report and not reproduced here. Its kit lives under `/workspace/...`, which does not exist on this machine, so the "cue 2/4, SFX 3/7" baseline, the 15-tool MCP and every `/workspace` artefact are unverified.
- **[web]**: read from a primary page on 2026-11-25 (URL in Sources).
- **[search]**: taken from web search summaries that cite the source, without opening the primary page myself. **[3rd-party]** marks aggregator claims I could not confirm at the source.
- **[judgement]**: my opinion with no gate behind it. Loudness and click gates cannot tell whether a patch sounds like brass, and nobody has auditioned the probe files yet.

## 0. Summary

1. **Bake orchestral music and keep synthesis live only where it reacts to play.** The game renders music in the browser through `src/audio/renderVoice.ts`, a hand-kept twin of `tools/agent-audio/src/synth.ts`. Tests pin the twin with PCM16 frame values and per-bar RMS. That twin pattern works for a 6-waveform chip synth. It does not scale to sample playback, convolution reverb or physical models, because every DSP change would have to land twice and be pinned twice. Music and large cues should move to baked stems, delivered with a manifest and pinned by a PCM hash. Engine turbines, cannon pitch/pan variation and other parametric cues stay live.
2. **Build `agent-daw` in TypeScript as a thin project format plus render orchestrator** that matches the existing tools' TypeScript and MIT shape. Grok's agent-daw is a Python package, which I would not adopt. Realistic instruments come from samples (SF2/SFZ) on CC0 or MIT banks. In-repo DSP covers plucked strings, modal percussion and reverb, where cheap models are the standard technique. External engines (sfizz, FluidSynth, Csound) run as subprocesses and are never linked or bundled.
3. **Generative cloud audio is a sketch and texture source, never a dependency.** ElevenLabs SFX v3 and TTS are cheap, and ElevenLabs says paid plans carry a commercial licence. ElevenLabs Music excludes "Studio Games" on every tier below Enterprise Music, unless the game qualifies as an Indie Game. Suno has no official API that I could find. Every generated asset goes through the same post-process and gate, with a licence sidecar.
4. **The split is low-risk** because ESLint already enforces the boundary between `tools/` and `src/`. A `git grep` for `tools/` outside the tools finds four couplings: `tests/audio.test.ts` reads `tools/agent-audio/recipes/*.json` by path, `.github/workflows/ci.yml` builds and tests both tools, `AGENTS.md` names tool paths in its gates, and `eslint.config.js` holds the boundary rule. On npm, the unscoped names `agent-audio`, `agent-3d`, `agent-daw` and `agentdaw` all return 404 today [measured, `npm view`].

## 1. What we have today

| Piece | Facts [measured] |
| --- | --- |
| `tools/agent-audio` 0.1.0 | MIT, zero runtime deps, about 2,450 lines of TS. Recipes: `one-shot` (timed voices) and `loop` (bpm, beats, tracks of `NoteEvent {startBeat, durationBeats, midi, velocity}`). Voice: one of `sine/triangle/saw/square/noise/fm`, ADSR, one optional biquad (LP/HP/BP), drive, pan. `check` covers BS.1770-4 LUFS, true peak, clicks, cut tails, DC, phase and loop seam. Exit codes are 0/1/2. |
| `src/audio/` | `renderVoice.ts` (134 lines) re-implements the voice mixer. `combatScore.ts` renders the 64-beat, 150 BPM loop (25.6 s, 1,228,800 frames at 48 kHz) a few ms per frame inside the game loop. `combatCues.ts` renders 12 cues, which are pre-rendered in the quiet syncs after the score finishes. One `AudioContext`, with master, music, engine and effects buses. There is no `fetch` or `decodeAudioData`, and there is no `public/` dir. |
| Parity pin | `tests/audio.test.ts` deep-equals each game recipe JSON against `tools/agent-audio/recipes/<id>.recipe.json`, pins 3 or 4 PCM16 frame values per cue and pins the per-bar RMS of all 16 bars to 5 decimals. |
| Determinism | Two `agent-audio render` runs of the combat loop gave identical WAV MD5s (`e226f532…`). Render took 1.49 s wall. |
| Game bundle | `dist/` is 732 KB in total. |
| Installed | node 26.12, SoX_ng 14.8, ffmpeg 9.0.2 (`afir`, `loudnorm`, `ebur128`, `alimiter`, `rubberband`, libopus, libvorbis), rubberband 4.0, Python 3.14 with numpy 2.5.5 and scipy 1.18.1 (no `soundfile`), Blender 5.2.2. |
| Not installed, one `pacman -S` away | `fluidsynth` 2.6.1 (LGPL-2.1+), `soundfont-fluid` 3.1 (FluidR3_GM, MIT, 144.6 MiB), `sfizz` 1.2.3 (BSD-2; the `sfizz` package is a 1.33 KiB meta package, so check which split package ships `sfizz_render` before scripting it), `csound` 6.18.1 (LGPL-2.1+, 11.8 MiB), `faust` 2.88.0 (85.7 MiB). Glicol, SuperCollider, ChucK, LilyPond and MuseScore are absent. |
| On npm | `spessasynth_core` 4.4.12 (Apache-2.0, pure JS SF2/SF3/DLS + MIDI synth, offline render in Node), `@modelcontextprotocol/sdk` 1.32.2 (MIT), `@elevenlabs/elevenlabs-js` 2.80.0. |

## 2. What breaks past chip loops

The list below is what has to change in `agent-audio`'s model before it can carry a Star Wars or Project Wingman style score. Each item is a schema or pipeline gap in the current code, not a taste call.

1. **The note model has no performance data.** `NoteEvent` holds pitch, start, length and velocity. Orchestral writing also needs articulation (legato, staccato, spiccato, marcato, sfz, swells), continuous controllers (CC1 dynamics crossfade, CC11 expression, pitch bend, sustain pedal), a tempo map, time signatures and keyswitches. Brass swells and string crescendos are CC curves, and velocity cannot express them.
2. **One oscillator per track cannot be an instrument.** Real instruments need velocity layers, round robins, release triggers, legato transitions, a polyphony and voice-steal policy, and section ensembles (detuned players with independent vibrato). The probe's 6-player-per-part string pad cost 4.28 s of numpy for 4 s of audio [measured]. That is fine offline. Numpy is only a proxy for TS cost, which I did not measure, but a 30-voice additive pad is far heavier than anything the frame-budgeted renderer in `combatScore.ts` does today.
3. **There is no mix graph.** Today a voice goes to pan and then to the master. A score needs buses, sends, an orchestral seating plan, reverb (required for strings and brass), bus compression and a loop-safe master limiter. Grok separately reports that a direct limiter made the loop wrap 7.02x the loudest bar line, and that its combat layer needed a bus compressor [grok].
4. **Loop seams get harder.** Reverb tails cross the loop point. The standard fix is to render two passes and fold the tail of pass 1 into the head of the loop. The current `loopWrap` flag only wraps note releases.
5. **The loudness targets are one-shot targets.** Orchestral cues have real dynamic range. An integrated -16 LUFS target pushes a quiet intro and a tutti climax to the same level unless the gate also checks loudness range (LRA) and per-section momentary loudness.
6. **The browser twin stops being viable.** Sample banks are megabytes, and convolution and physical models are hot loops. Mirroring them in `src/audio/` and pinning them with PCM frames would double every DSP change. See section 4.
7. **The gates cannot judge timbre.** `check` catches mechanical defects. It cannot tell a convincing horn section from a buzzy saw [judgement]. A realistic score needs three more checks: a spectral-envelope comparison against a reference recording, a symbolic critic on the score (Grok's went 0.479 to 0.976 over 3 iterations [grok]), and a human listen at milestones.
8. **Samples bring provenance and attribution.** The licence of the shipped audio follows the samples more than the engine (section 3.3).
9. **Adaptive music becomes a requirement.** Dogfight music needs vertical layers (intensity stems), horizontal re-sequencing on bar lines, and stingers quantised to the beat. None of these exist in the recipe format.

## 3. Synthesis paths compared

### 3.1 Probe results [measured]

`probe.py` (Appendix A) renders each instrument with plain numpy/scipy, normalises it to -3 dBFS and runs `agent-audio check` on it. Times are single-threaded wall times. The realism column is what I expect from each method; nobody has listened to the files.

| Instrument | Method | Render time | `agent-audio check` | Realism [judgement] |
| --- | --- | ---: | --- | --- |
| Guitar strum, 6 strings, 4 s | Extended Karplus-Strong (pick-position comb, 2-tap loss loop, plain Python inner loop) plus 3 body resonances | 382 ms | pass | Extended KS is the standard method for plucked strings, so expect a credible acoustic guitar. Electric needs an amp model (waveshaper, cab IR). |
| Timpani roll, 23 hits, 3 s | Modal: 6 membrane modes (ratios 1, 1.5, 1.98, 2.44, 2.9, 3.36), decaying sines, band-passed strike noise | 152 ms | **fail: `IMPULSE_CLICK` at 1.26 s, ratio 55.6 vs limit 25** | A probe bug: each partial started at a random phase, so every hit began with a step. With a 1.5 ms attack ramp the roll passes. With zero phase and no ramp it fails `DC_OFFSET` instead, because decaying sines that all start at phase 0 have a net positive area. The gate caught both real defects. |
| Piano chord, 4 notes, 4 s | Modal: 15 inharmonic partials (B = 0.0004), 3 detuned strings per note | 1,059 ms | pass | Expect an electric or toy piano character. A grand needs a hammer model, a soundboard, sympathetic resonance and pedal, so samples win here. |
| Brass swell, 3 s | Additive saw, brightness tracks loudness (block-wise moving low-pass), 2 fixed formants, delayed vibrato | 167 ms | pass | Expect synth brass. Brightness tracking loudness is the key cue, but real lip-reed attacks and section blend need samples or a waveguide lip model. |
| String section pad, 5 parts x 6 players, 4 s | Additive saws, per-player detune and vibrato, 3 body resonances | 4,282 ms | pass | Expect a pad. Bow noise, attack scrub and legato are missing. |
| Reverb on the string pad | 2.8 s RT60 stereo noise IR, 6 kHz air absorption, 20 ms pre-delay, `scipy.signal.fftconvolve` | 129 ms | pass | Fine as an algorithmic hall. `ffmpeg afir` with the same IR took 0.59 s wall including process start. |

The whole probe took 9.96 s wall with 146 MB RSS. Offline cost is not the constraint on this box. Quality is.

### 3.2 The options

| Path | Licence | Runs here today | Strengths | Weaknesses |
| --- | --- | --- | --- | --- |
| **In-repo TS DSP** (extend `agent-audio/synth.ts`: KS, modal, waveguide, FDN or convolution reverb) | MIT, ours | yes | Deterministic, zero deps, testable down to the sample, no licence questions. | Brass, bowed strings and grand piano stay "synth-like" unless months go into modelling [judgement]. |
| **SF2/SF3 via `spessasynth_core`** (pure JS, Node and browser) | Apache-2.0 (NOTICE file, MIT-compatible) | `npm i`, not yet tried | Same JS engine offline and in-browser, full GM plus CC, pitch bend and modulators, no native build. | SF2 is a dated format with weak round-robin and legato. Quality is capped by the bank. |
| **SFZ via `sfizz_render`** | BSD-2 | one `pacman -S` | Best free sampler format for VSCO-2 CE and VCSL (which ship as SFZ). Has a MIDI to WAV CLI. | Native subprocess. Needs MIDI export from our score. |
| **FluidSynth CLI** | LGPL-2.1+ (fine as a subprocess) | one `pacman -S` | Mature, fast, `-F out.wav` offline render. | Grok reports a 0.019 DC offset from its soundfont path [grok]. Add a DC-blocking high-pass regardless. |
| **Csound** | LGPL-2.1+ | one `pacman -S` | Huge opcode library (waveguides, `wgbow`, `wgbrass`, `pluck`, `reverbsc`), the only engine Grok saw pass on first bounce [grok]. | Its own language for agents to learn. Grok also saw a 0.056 wrap step [grok]. |
| **Faust** | The compiler's `COPYING.txt` says LGPL-2.1 [web]. The Arch package lists GPL-2.0+, GPL-3.0+ and LGPL-2.1+ [measured]. The `faustlibraries` licence dir holds only an STK note, and my recollection is that each library function carries its own `declare license` line; check every function used. The fetched pages did not show the compiler-output exception Grok cites, so treat that exception as unverified. | one `pacman -S` (85.7 MiB) | Best-in-class physical models (`pm.lib`: brass, bowed and plucked strings), compiles to C++, WASM or JS, so the same DSP can run offline and in the browser. | Toolchain weight and licence review per function. |
| **Glicol, Strudel, SuperCollider, ChucK** | MIT / AGPL / GPL / mixed | not installed | Live coding. | Wrong abstraction for orchestral realism. Strudel is AGPL. |

### 3.3 Sample banks (licence of the shipped audio)

| Bank | Licence [search] | Use |
| --- | --- | --- |
| VSCO-2 Community Edition (Versilian) | CC0 (Freesound upload, about 3,000 samples in about 70 packs; Versilian lists 1,952 samples, SFZ and WAV) | Strings, brass, woodwinds, timpani. Default orchestral source. |
| VCSL / VCSL Keys | CC0 | Pianos, percussion, keys. |
| FluidR3_GM | MIT (keep the copyright notice) | GM fallback, guitars, quick sketches. Arch packages it. |
| Salamander Grand Piano | CC-BY-3.0 (Yamaha C5, Alexander Holm), requires attribution | Best free grand. Fine with a credits line. |
| GeneralUser GS | Permissive, but the author cannot vouch for every sample's origin | Avoid for shipped audio. |
| Sonatina Symphonic Orchestra | No formal licence text found, only a forum post by the author | Do not use until a licence file is confirmed. |

### 3.4 Recommended architecture for `tools/agent-daw`

```
song.daw.json  (agent-owned source: tempo map, tracks, clips, notes + CC lanes, buses, layers)
   │  agent-daw validate / render / stems / check
   ├─ engine "dsp"      in-repo TS: chip voices (agent-audio), KS guitar, modal perc, reverb
   ├─ engine "sf2"      spessasynth_core (in-process, Apache-2.0)
   ├─ engine "sfz"      sfizz_render subprocess (optional)
   ├─ engine "csound"   subprocess (optional)
   └─ engine "faust"    precompiled JS or WASM DSP modules checked in with licence headers (optional)
   ▼
mix graph in TS: per-track gain/pan, sends, convolution or FDN reverb, bus compressor,
                 loop-safe master limiter (pad wrap, limit, crop), DC-block HP
   ▼
agent-audio check on every stem and the full mix (LUFS, TP, seam, clicks), plus new LRA and spectral-reference checks
   ▼
out/<cue>/<layer>.wav (PCM master), <layer>.ogg/.m4a (delivery), cue.manifest.json, cue.licence.json
```

Decisions behind this design:

- **TypeScript, not Python.** Both existing tools are TS and MIT. A Python core would bring pedalboard (GPL-3), pydub and librosa into a package meant to be MIT. agent-daw cannot stay zero-dependency like agent-audio: it depends on agent-audio for gates and types and on `spessasynth_core` (Apache-2.0) for the `sf2` engine. Everything else stays optional.
- **One score format.** `song.daw.json` should grow out of `agent-audio/recipe/v1` instead of being a fresh schema. Keep `NoteEvent` and add `cc` lanes, `articulation`, a tempo map and `layer` tags. MIDI (SMF) is an export for the sfizz, FluidSynth and Csound adapters and is never the source.
- **External engines are adapters behind one interface** (`render(track, notes, sr) -> Float32Array[]`). The core ships only `dsp` and `sf2`. Each adapter pins the engine version and fails loudly when the binary is missing.
- **Fewer MCP tools than Grok's 15.** Agents edit JSON well. The MCP surface should be `validate`, `render`, `stems`, `check`, `inspect` (spectrogram PNG) and `export-midi`. Notes and tracks are edited as JSON patches against the file, which keeps the CLI the primary interface.
- **Effort [judgement]:** about 1 week for the score format, mix graph, `dsp` + `sf2` engines and stems with a manifest. About 1 more week for the sfz adapter, LRA and spectral checks, two-pass reverb loop folding and a CC0 orchestral starter kit. Grok's own estimate was 3-5 days to harden plus 3-7 days of authoring [grok].

## 4. Bridging baked stems into the game

The current contract (recipe JSON deep-equal plus PCM frames) is replaced by a manifest contract. `src/` still never imports `tools/`, so files are the only interface.

**Manifest** (`src/audio/stems/<cue>.manifest.json`, written by agent-daw and committed):

```json
{
  "schemaVersion": "agent-daw/manifest/v1",
  "id": "dogfight", "bpm": 150, "beatsPerBar": 4, "bars": 16,
  "sampleRate": 48000, "frames": 1228800, "loopStartFrame": 0, "loopEndFrame": 1228800,
  "layers": [
    { "id": "base", "file": "dogfight.base.ogg", "pcmSha256": "…", "integratedLufs": -16.0, "truePeakDbtp": -1.5 },
    { "id": "brass", "file": "dogfight.brass.ogg", "pcmSha256": "…", "intensity": 0.5 }
  ],
  "licence": "dogfight.licence.json"
}
```

**Game side:** import the encoded files through Vite (`new URL('./stems/x.ogg', import.meta.url)`), `fetch` and `decodeAudioData` them after the first user gesture, start every layer on one `AudioContext` time, and drive layer gains from sim intensity. Set `AudioBufferSourceNode.loopStart` and `loopEnd` (in seconds, so frames divided by the context rate) from the manifest instead of trusting the decoded length. That absorbs trailing padding. Leading encoder priming shifts the loop start, so measure it per codec in the browser and store the offset in the manifest if it is non-zero. The existing master/music/engine/effects bus graph stays as it is, so the "every node behind master" test still applies.

**Tests:**

- In `tools/agent-daw`: the manifest validates, each `pcmSha256` matches its PCM master, every stem passes `check --loop`, and the layers sum to the gated mix.
- In `tests/` (game): the manifest parses, each referenced file exists, layer start alignment is scheduled on one context time, and the gain law per intensity holds. Pin the hash of **decoded PCM**, never encoded bytes:

| Determinism check [measured] | Result |
| --- | --- |
| Same Opus encode twice, default ffmpeg | different file MD5s (Ogg stream serial is random) |
| Same encode with `-fflags +bitexact -flags:a +bitexact -map_metadata -1` | identical MD5s |
| ffmpeg decode of the two differing files to s16le | identical MD5s |

**Codec round trip of the current 25.6 s combat loop [measured].** I encoded it with ffmpeg 9.0.2, decoded it back to 48 kHz PCM16 and ran `agent-audio check --loop`:

| Format | Bytes | Decoded frames | `check --loop` |
| --- | ---: | ---: | --- |
| WAV PCM16 (master) | 4,915,244 | 1,228,800 | pass |
| Opus 128k (Ogg) | 497,291 | 1,228,800 | pass |
| Opus 96k (Ogg) | 377,732 | 1,228,800 | pass |
| Vorbis q5 (Ogg) | 490,401 | 1,228,800 | pass |
| AAC 160k (M4A) | 552,850 | 1,228,800 | pass |
| MP3 192k | 615,788 | 1,228,800 | pass |
| Resampled to 44.1 kHz (WAV) | n/a | n/a | pass, no non-info findings |

Budget: four intensity layers at Opus 96k come to about 1.5 MB, twice today's whole `dist/` (732 KB). Lazy-load them after unlock.

**Not tested, so verify in the browser before choosing a codec:**

- Whether Safari's `decodeAudioData` accepts Ogg Opus and Ogg Vorbis. If it does not, ship AAC/M4A as a fallback.
- Whether browsers trim encoder priming and padding the way the ffmpeg CLI does. MP3 and AAC are the usual offenders. `loopEnd` guards the tail; a measured start offset guards the head.
- Seam behaviour when the `AudioContext` runs at 44.1 kHz and the browser resamples a 48 kHz buffer. The offline resample passed, but the browser's resampler is a different one.

`npm run verify:browser` can host a test that decodes each stem in Chromium and checks the decoded frame count against the manifest.

**What stays live:** turbine oscillators, cannon shots with per-faction pitch and pan variation, lock chirps and other short parametric cues. Their current twin-renderer parity pin is cheap and worth keeping. Once music moves to stems, `combatScore.ts`'s frame-sliced renderer and its RMS pin can retire. The **Audio Parity** invariant in `AGENTS.md` ("Keep the in-game combat soundtrack in voice and note parity with its game-owned recipe") then has to be rewritten to pin the manifest and decoded-PCM hashes instead.

## 5. Generative and cloud audio (checked 2026-11-25)

| Service | What it offers | Price | Game licence | Fit |
| --- | --- | --- | --- | --- |
| **ElevenLabs Sound Effects** [web] | `POST /v1/sound-generation`, models `eleven_text_to_sound_v3` and `eleven_text_to_sound_v2` (v2 deprecated and removed on 2027-03-01). `loop` boolean, `duration_seconds` 0.5 to 30 (API ref; the capabilities page says 0.1 to 30), `prompt_influence` 0 to 1, output formats include `opus_48000_*`, `pcm_*` and `wav_*` (44.1 kHz PCM/WAV needs Pro). | $0.12 per minute, so about $0.06 per 30 s loop; 40 credits per second when a duration is set | Commercial on paid plans and not on Free [search: ElevenLabs help centre, which adds "provided you're not using Beta Services"; the page returned 403 to my fetch]. | Good for textures: engine beds, hull creaks, explosion tails, then post-process and gate. Grok's "$0.04 per sound" and "loop since 2 Nov 2026" are not on the docs page I read; the `loop` parameter exists but carries no date. |
| **Eleven Music** [web] | Prompt or composition-plan to song, 5 minute limit per generation | $0.15 per minute, $1.50 per finetune | Terms updated 2026-10-09. Exhibit A's Media Rights cell for Free, Starter, Creator, Pro, Scale, Business and Enterprise Music Lite reads "All online and offline commercial use permitted, except film, TV, radio, and Studio Games". Only Enterprise Music reads "All online and offline commercial use permitted" (cells matched by position in flattened page text). An **Indie Game** (under $500,000 revenue since release, from a developer with under $1,000,000 game revenue last financial year) is not a Studio Game. Free to Pro are "individual use only", Free cannot download, WAV downloads need Pro+. | Allowed for this project while it qualifies as indie, with 60 days "to obtain a plan that permits use of Output in a Studio Game" once it stops qualifying. This matches Grok's "Indie only; studios need Enterprise". Scale and Business are also limited to organisations under 10 and under 50 employees. Model output still has to be cut to bars and pass the loop gate. |
| **ElevenLabs TTS** for wingmate radio [web] | `eleven_v4`, `eleven_v4_turbo`, `eleven_v3`, `eleven_v3_conversational`, `eleven_multilingual_v2`, `eleven_flash_v2_5`. Audio tags (v4 Turbo, v3 Conversational) and multi-speaker dialogue (v4, v3, plus a Text to Dialogue API). | $0.04 to $0.08 per 1K characters | Commercial on paid plans [search, as above] | Cheapest win. 200 radio lines at about 60 characters each is about 12K characters, roughly $0.96 on v3. Bake the lines, then run a deterministic radio chain locally (300 to 3,400 Hz band-pass, soft clip, squelch tail, SoX or ffmpeg) so the effect stays ours and repeatable. |
| **ElevenLabs MCP** [web] | The local `elevenlabs/elevenlabs-mcp` (MIT) was archived on 2026-08-20 and deprecated in favour of a hosted server at `https://api.elevenlabs.io/v1/mcp`. Its docs page says it "also has creative tools for generating speech, images and video" but lists no tool names or limits. | n/a | n/a | A "5 s duration cap" on the MCP sound-effects tool appears only in third-party listings of the archived server [3rd-party]. Call the REST API from a small script instead, so the request and the cost are explicit. |
| **Suno** [web] | No official public API found (`suno.com/api` returns 404, `docs.suno.com` does not resolve). The site links an "MCP" product that I did not inspect. Pro and Premier assign output rights "subject to … commercial use restrictions" within permitted downloads. | plan-based | Allowed on Pro/Premier for permitted downloads. UMG and Sony litigation reportedly continues [3rd-party]. | Skip. Without an official API, automation would go through unofficial wrappers, and the litigation adds risk. |
| **ACE-Step 1.5** | Open music model; AMD's write-up says the project claims training on royalty-free data [search] | free | Model card: "License: mit" and "You can strictly use the generated music for commercial purposes" [web] | Best open-weight option. GPU recommended, and this box has none, so run it on Colab via the `colab` CLI if needed. Not run here. |
| **Stable Audio Open Small / 3.0** [search] | Open-weight text to audio | free | Stability Community Licence, under $1M annual revenue | Acceptable fallback for SFX textures. |
| **MOSS-SoundEffect v2.0** | Text to SFX, CPU | free | Apache-2.0 [grok] | Grok measured 0/5 raw and 3/5 after post-processing [grok]. |

Grok's other MCP entries (lmms-mcp, sp-mc, mcp-music-studio, opendaw-mcp, Audacity-MCP, ableton-mcp) were not checked for this report and remain [grok].

**Placement rule.** Use deterministic local synthesis and samples first. Generative output is for one-off textures, voice lines and reference sketches that an agent then re-scores. Generated audio never ships unprocessed and never runs at runtime. Each generated asset gets the post chain (40 Hz high-pass, fades, category LUFS, -1.5 dBTP, or constant gain plus the loop-safe limiter for loops), `agent-audio check`, and a `licence.json` sidecar (service, model id, plan, date, prompt, terms URL and version). Any paid call names its cost first.

## 6. Splitting the tools into standalone repos

### 6.1 Order and mechanics

1. **agent-audio first.** It is the smallest and already has zero dependencies, an MIT licence and `files` set in `package.json`.
2. **agent-3d second.** It depends on esbuild and Playwright and needs a browser in CI.
3. **agent-daw last**, as a new repo that depends on agent-audio for its gates and recipe types.

Per repo:

- `git filter-repo --subdirectory-filter tools/<tool>` keeps the history.
- Add CI (Node 20 and 22 matrix, `npm test`, `npm pack --dry-run`).
- Publish under one npm scope. The unscoped names are free today but squattable, and a scope avoids the problem.
- Mark `0.x` until the recipe schema settles.

The game repo then consumes each tool as a pinned devDependency (`npm i -D <scope>/agent-audio@0.2.0`), or a git tag before the first publish. Four places change:

- `tests/audio.test.ts:297` reads `../tools/agent-audio/recipes/<id>.recipe.json`. Point it at `node_modules/<scope>/agent-audio/recipes/` (already in `files`), or keep game-owned copies and pin only the PCM frames. A file read is not an import, so the ESLint boundary still holds.
- `.github/workflows/ci.yml` lines 85-113 build and test both tools, including the Playwright install for agent-3d. That job moves to each tool's own repo.
- `AGENTS.md` gate commands (`npm --prefix tools/<tool> test`, and `node tools/agent-3d/dist/cli.js turntable scripts/ship-adapters/<ship>.ts ...`) switch to `npx <scope>/agent-3d turntable ...`. The ship adapters stay in this repo.
- `eslint.config.js` lines 33 and 49 can keep their `tools/*` patterns, extended to ban imports of the scoped packages from `src/`.

### 6.2 Licensing hygiene

- **Core packages stay MIT** with no GPL or AGPL in `dependencies`. `spessasynth_core` is Apache-2.0: keep its NOTICE and declare it.
- **External engines run only as subprocesses**: the LGPL and GPL ones (fluidsynth, csound, faust, ffmpeg, sox, rubberband) and BSD-2 sfizz alike. They are never bundled or linked, and their versions are recorded in render metadata. Document them as optional system dependencies.
- **Sample banks are fetched and never vendored.** A `fetch-kit` command downloads VSCO-2 CE, VCSL and FluidR3 with SHA-256 checks and writes their licences beside them. The README states that rendered output carries the samples' terms. CC0 needs nothing, and Salamander needs a credit line.
- **Every rendered asset gets a `licence.json`**: engine and version, sample banks and licences, generative service and terms version if any, and the attribution string.
- **Faust:** check `declare license` on every library function used, and keep the generated code's header.
- **Tool docs and README** must not reference this game's code paths. ESLint enforces that for code, but READMEs and recipes need a manual check.

### 6.3 CLI and MCP ergonomics

- Keep the current conventions: JSON reports on stdout, exit 0 for pass, 1 for gate failure and 2 for bad input, a `SKILL.md` that doubles as the agent skill, and `--png` for visual inspection.
- Add `--summary` to `check`, printing one line per non-info finding. Extracting failures from the full report needed a Python one-liner in every probe step [measured, see Tooling Feedback].
- The MCP server is an optional bin (`agent-daw mcp`) on `@modelcontextprotocol/sdk` (MIT), with tools that mirror the CLI one to one. It is stdio, needs no Python path setup, and prints the cost line before any network call.

### 6.4 Demos worth shipping (each runs offline on a CPU)

1. **"The agent can't hear, the gate can."** Plant a click in an SFX. `check` reports `IMPULSE_CLICK` with its time, the agent edits the recipe, and the gate passes. The probe produced a real case: random-phase timpani partials clicked at 1.26 s, the zero-phase fix tripped `DC_OFFSET`, and a 1.5 ms attack ramp passed.
2. **"Four codecs, one seam."** Render the combat loop, encode it five ways (Opus 128k and 96k, Vorbis, AAC, MP3), and show every round trip passing `check --loop`, with sizes. Section 4 already has the numbers.
3. **"A cinematic cue from CC0 samples."** A 16-bar 150 BPM dogfight cue in `song.daw.json`: VSCO-2 brass and strings, modal timpani, KS guitar ostinato, a hall reverb. Bounce 4 intensity stems with a manifest, and play them in a 50-line web page with an intensity slider.
4. **"Wingmate radio."** Script lines, TTS once (paid, cost printed), then the deterministic radio chain plus gate, with a licence sidecar per line.
5. **agent-3d:** a turntable contact sheet with the 0-degenerate-triangle gate on a procedural ship.

## Appendix A: `probe.py`

```python
"""Timed render probe: KS guitar, modal timpani, modal piano, formant brass, bowed-ish strings, noise-IR reverb."""
import sys, time, json
import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
OUT = sys.argv[1]
rng = np.random.default_rng(7)
timings = {}

def timed(name):
    def deco(fn):
        def run(*a, **k):
            t = time.perf_counter(); y = fn(*a, **k); timings[name] = round((time.perf_counter() - t) * 1000, 2)
            return y
        return run
    return deco

def write(name, y):
    y = np.atleast_2d(y)
    if y.shape[0] == 1: y = np.vstack([y, y])
    peak = np.max(np.abs(y)); y = y / peak * 10 ** (-3 / 20)  # -3 dBFS peak, leave headroom for the gate
    wavfile.write(f"{OUT}/{name}.wav", SR, (y.T * 32767).astype(np.int16))

def fade(y, ms=5):
    n = int(SR * ms / 1000); y[-n:] *= np.linspace(1, 0, n); return y

@timed("karplus_strong_guitar_4s")
def ks_guitar(freqs=(82.41, 110, 146.83, 196, 246.94, 329.63), dur=4.0, strum=0.025):
    out = np.zeros(int(SR * dur))
    for i, f in enumerate(freqs):
        # extended KS: fractional-delay-free, two-point lowpass loop, pick-position comb on the excitation
        n = int(round(SR / f)); buf = rng.uniform(-1, 1, n)
        buf -= np.roll(buf, n // 7)                       # pick position ~1/7 string length
        total = int(SR * (dur - i * strum)); y = np.empty(total)
        b = buf.copy(); idx = 0; loss = 0.996
        for t in range(total):                            # deliberately plain Python: worst case cost
            nxt = (idx + 1) % n
            y[t] = b[idx]; b[idx] = loss * 0.5 * (b[idx] + b[nxt]); idx = nxt
        out[int(SR * i * strum):int(SR * i * strum) + total] += y
    # body: a few fixed resonances standing in for a guitar top-plate
    for fc, q in ((98, 8), (204, 10), (400, 6)):
        bb, aa = signal.iirpeak(fc, q, SR); out += 0.4 * signal.lfilter(bb, aa, out)
    return fade(out)

def modal(f0, ratios, decays, amps, dur, strike_noise=0.0):
    t = np.arange(int(SR * dur)) / SR
    y = sum(a * np.exp(-t / d) * np.sin(2 * np.pi * f0 * r * t + rng.uniform(0, 6.28)) for r, d, a in zip(ratios, decays, amps))
    if strike_noise:
        burst = rng.standard_normal(int(SR * 0.015)) * np.linspace(1, 0, int(SR * 0.015))
        bb, aa = signal.butter(2, [200, 3000], "band", fs=SR); y[:burst.size] += strike_noise * signal.lfilter(bb, aa, burst)
    return y

@timed("modal_timpani_roll_3s")
def timpani():
    # membrane modes of a kettledrum (Rossing): ratios near 1, 1.5, 2, 2.44, 2.9 relative to the (1,1) mode
    out = np.zeros(int(SR * 3.0))
    for k, start in enumerate(np.arange(0, 1.6, 0.07)):
        hit = modal(98, (1, 1.5, 1.98, 2.44, 2.9, 3.36), (1.2, 0.8, 0.6, 0.4, 0.3, 0.2), (1, .6, .4, .25, .15, .1), 1.4, 0.3)
        s = int(SR * start); out[s:s + hit.size] += hit[: out.size - s] * (0.4 + 0.6 * k / 22)
    return fade(out)

@timed("modal_piano_chord_4s")
def piano(notes=(57, 60, 64, 69)):
    out = np.zeros(int(SR * 4.0))
    for m in notes:
        f = 440 * 2 ** ((m - 69) / 12); B = 0.0004       # inharmonicity coefficient
        parts = np.arange(1, 16)
        ratios = parts * np.sqrt(1 + B * parts ** 2)
        for detune in (0.9997, 1.0, 1.0004):            # three detuned strings -> beating, two-stage decay
            out += modal(f * detune, ratios, 3.0 / parts ** 0.7, 1 / parts ** 1.1, 4.0, 0.05)[: out.size]
    return fade(out)

@timed("formant_brass_swell_3s")
def brass(f0=146.83, dur=3.0):
    t = np.arange(int(SR * dur)) / SR
    env = np.minimum(1, t / 0.6) * np.minimum(1, (dur - t) / 0.3)
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.2 * t) * np.minimum(1, t / 1.0)
    phase = np.cumsum(2 * np.pi * f0 * vib / SR)
    saw = sum(np.sin(k * phase) / k for k in range(1, 40))
    # brightness tracks loudness, the defining brass behaviour; approximate with a moving lowpass in blocks
    y = np.zeros_like(saw); blk = 512; zi = None
    for i in range(0, saw.size, blk):
        fc = 400 + 3600 * env[i] ** 2
        bb, aa = signal.butter(2, fc, fs=SR)
        if zi is None or zi.shape[0] != 2: zi = np.zeros(2)
        y[i:i + blk], zi = signal.lfilter(bb, aa, saw[i:i + blk], zi=zi)
    for fc, q, g in ((1200, 4, 0.5), (2500, 6, 0.3)):  # fixed bell formants
        bb, aa = signal.iirpeak(fc, q, SR); y += g * signal.lfilter(bb, aa, y)
    return y * env

@timed("string_section_pad_4s")
def strings(chord=(50, 57, 62, 65, 69), dur=4.0):
    t = np.arange(int(SR * dur)) / SR
    env = np.minimum(1, t / 0.8) * np.minimum(1, (dur - t) / 0.8)
    L = np.zeros_like(t); R = np.zeros_like(t)
    for m in chord:
        for p in np.linspace(-0.8, 0.8, 6):              # six players per part, independent vibrato and detune
            f = 440 * 2 ** ((m - 69) / 12) * (1 + rng.normal(0, 0.0025))
            ph = np.cumsum(2 * np.pi * f * (1 + 0.003 * np.sin(2 * np.pi * rng.uniform(4.5, 6) * t + rng.uniform(0, 6))) / SR)
            v = sum(np.sin(k * ph) / k for k in range(1, 25))
            L += v * (1 - p) / 2; R += v * (1 + p) / 2
    bb, aa = signal.butter(2, 3500, fs=SR)
    for fc, q in ((280, 3), (450, 4), (2900, 3)):       # violin-body-like resonances
        pb, pa = signal.iirpeak(fc, q, SR); L += 0.3 * signal.lfilter(pb, pa, L); R += 0.3 * signal.lfilter(pb, pa, R)
    return np.vstack([signal.lfilter(bb, aa, L) * env, signal.lfilter(bb, aa, R) * env])

@timed("noise_ir_reverb_2.8s_rt60_fftconvolve")
def reverb(dry):
    rt60 = 2.8; n = int(SR * rt60)
    tt = np.arange(n) / SR; decay = np.exp(-6.91 * tt / rt60)
    ir = rng.standard_normal((2, n)) * decay
    bb, aa = signal.butter(1, 6000, fs=SR); ir = signal.lfilter(bb, aa, ir)   # air absorption
    ir[:, : int(SR * 0.02)] *= np.linspace(0, 1, int(SR * 0.02))              # 20 ms pre-delay ramp
    ir /= np.sqrt(np.sum(ir ** 2, axis=1, keepdims=True))
    wet = np.vstack([signal.fftconvolve(dry[c], ir[c]) for c in range(2)])[:, : dry.shape[1] + n]
    out = np.zeros_like(wet); out[:, : dry.shape[1]] += dry; return out + 0.35 * wet, ir

g = ks_guitar(); write("guitar_ks", g)
tp = timpani(); write("timpani_modal", tp)
pn = piano(); write("piano_modal", pn)
br = brass(); write("brass_formant", br)
st = strings(); write("strings_pad", st)
wet, ir = reverb(st); write("strings_pad_reverb", wet)
wavfile.write(f"{OUT}/ir_stereo.wav", SR, (ir.T / np.max(np.abs(ir)) * 32767 * 0.5).astype(np.int16))
print(json.dumps(timings, indent=1))
```

## Appendix B: commands behind the measured numbers

```bash
A=tools/agent-audio
python3 -I probe.py out/                                  # section 3.1 timings
for f in out/*.wav; do node $A/dist/cli.js check $f; done # section 3.1 gate column
ffmpeg -i out/strings_pad.wav -i out/ir_stereo.wav -filter_complex "[0][1]afir=dry=10:wet=4" afir_out.wav
node $A/dist/cli.js render $A/recipes/combat-loop.recipe.json --out loop.wav
ffmpeg -i loop.wav -c:a libopus -b:a 128k loop.opus.ogg   # likewise 96k, libvorbis -q:a 5, aac 160k, libmp3lame 192k
ffmpeg -i loop.opus.ogg -ar 48000 -c:a pcm_s16le dec.wav && node $A/dist/cli.js check dec.wav --loop
ffmpeg -i loop.wav -map_metadata -1 -fflags +bitexact -flags:a +bitexact -c:a libopus -b:a 128k b.ogg  # byte-stable
ffmpeg -i loop.opus.ogg -f s16le - | md5sum               # decoded-PCM hash
```

The timpani re-run used the same `modal()` with zero phase, or random phase plus a 1.5 ms linear attack ramp per hit.

## Tooling Feedback

- `agent-audio check` worked as documented and gave stable verdicts across five codec round trips. To list failures I had to parse the full JSON with Python each time, so a `--summary` flag would save agent tokens.
- `IMPULSE_CLICK` and `DC_OFFSET` both fired on real probe bugs (random-phase onsets, then zero-phase DC) and cleared once fixed. I saw no false positives.
- The Grok kit's paths (`/workspace/...`) do not exist on this machine, so none of its gate numbers could be re-run here.

## Sources

Primary pages read on 2026-11-25:

- [ElevenLabs Sound Effects API reference](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)
- [ElevenLabs Sound Effects capabilities](https://elevenlabs.io/docs/capabilities/sound-effects)
- [ElevenLabs API pricing](https://elevenlabs.io/pricing/api)
- [Eleven Music model-specific terms](https://elevenlabs.io/eleven-music-model-specific-terms)
- [ElevenLabs models](https://elevenlabs.io/docs/models)
- [elevenlabs-mcp (archived)](https://github.com/elevenlabs/elevenlabs-mcp)
- [ElevenLabs hosted MCP](https://elevenlabs.io/docs/eleven-agents/operate/hosted-mcp)
- [ACE-Step 1.5 base model card](https://huggingface.co/ACE-Step/acestep-v15-base)
- [Suno terms](https://suno.com/terms)
- [Faust COPYING.txt](https://github.com/grame-cncm/faust/blob/master-dev/COPYING.txt)
- [faustlibraries licences](https://github.com/grame-cncm/faustlibraries/tree/master/licenses)

Search results and secondary sources:

- [ElevenLabs help: publishing generated content (403 on fetch)](https://help.elevenlabs.io/hc/en-us/articles/13313564601361-Can-I-publish-the-content-I-generate-on-the-platform)
- [ACE-Step 1.5 paper](https://arxiv.org/abs/2602.00744)
- [AMD on ACE-Step 1.5](https://www.amd.com/en/blogs/2026/commercial-grade-ai-music-generation-on-amd-ryzen-ai-and-radeon-ace-step-1-5.html)
- [Stability AI and Arm: Stable Audio Open Small](https://stability.ai/news/stability-ai-and-arm-release-stable-audio-open-small-enabling-real-world-deployment-for-on-device-audio-control)
- [TechCrunch on Stable Audio Open Small](https://techcrunch.com/2025/05/14/stability-ai-releases-an-audio-generating-model-that-can-run-on-smartphones)
- [spessasynth_core](https://github.com/spessasus/spessasynth_core)
- [sfizz_render man page](https://man.archlinux.org/man/sfizz_render.1.en.raw)
- [SFZ players list](https://sfzformat.com/software/players)
- [VSCO-2 Community Edition](https://versilian-studios.com/vsco-community/)
- [VCSL](https://github.com/sgossner/VCSL)
- [SFZ Instruments: pianos (Salamander CC-BY-3.0)](https://sfzinstruments.github.io/pianos)
- [GeneralUser GS licence](https://scancode-licensedb.aboutcode.org/generaluser-gs-2.0.LICENSE)
- [FluidR3Mono licence](https://grok.dragonflybsd.org/xref/dports/audio/musescore/MuseScore-3.6.1/share/sound/FluidR3Mono_License.md)
- [Sonatina forum thread](https://musescore.org/node/20378)
- [Rolling Stone on the Warner and Suno settlement](https://au.rollingstone.com/music/music-news/suno-warner-music-group-ai-music-settlement-lawsuit-87464)
- [Third-party: Suno commercial use guide](https://techjacksolutions.com/ai-tools/suno/suno-commercial-use/)
- [Third-party: ElevenLabs SFX v3 reseller listing](https://wiro.ai/models/elevenlabs/sound-effects-v3)
- [Third-party: ElevenLabs Music for game loops](https://github.com/chengchao/hopon/issues/124)
