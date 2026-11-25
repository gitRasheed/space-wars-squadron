# agent-daw

A headless DAW for coding agents. An agent writes a JSON project, renders it to a 48 kHz stereo WAV, and checks the result two ways: a symbolic critic that reads the score and an objective listening gate that measures the audio. Everything runs in Node with no runtime dependencies. MIT licensed.

It picks up where `agent-audio` stops. That tool is good at chip-synth loops and UI sounds; this one is for orchestral and hybrid cues: brass, strings, piano, guitars, timpani, hall reverb and a mastered bus.

## Quick start

```sh
npm ci && npm run build
node dist/cli.js render examples/star-wars-overture.daw.json --out out/overture.wav --repeats 2 --stems-dir out/stems
node dist/cli.js critique examples/star-wars-overture.daw.json --min 0.85
node dist/cli.js gate out/overture.wav --project examples/star-wars-overture.daw.json --png-dir out/gate
node dist/cli.js export-midi examples/star-wars-overture.daw.json --out out/overture.mid
```

Exit codes: 0 pass, 1 a check failed (invalid project, gate findings, critic below `--min`), 2 usage or runtime error.

## Project format (`agent-daw/v1`)

```json
{
  "format": "agent-daw/v1",
  "id": "overture", "kind": "loop", "loop": true,
  "tempo": { "bpm": 120, "beatsPerBar": 4 },
  "key": { "tonic": "D", "mode": "minor" },
  "bars": 16,
  "master": { "targetLufs": -16, "ceilingDbtp": -1.5, "hpfHz": 30, "compressor": { "thresholdDb": -16, "ratio": 2 } },
  "sections": [{ "id": "fanfare", "startBar": 0, "bars": 4, "layer": "base" }],
  "patterns": { "riff": { "lengthBeats": 4, "notes": [] } },
  "tracks": [{
    "id": "horns", "role": "lead", "layer": "base", "gainDb": -2, "pan": -0.15,
    "instrument": { "type": "brass-horn", "params": { "players": 4 } },
    "fx": [{ "type": "reverb", "preset": "hall", "mix": 0.3 }],
    "automation": [{ "param": "volume", "points": [{ "beat": 0, "value": 0 }, { "beat": 64, "value": 0 }] }],
    "clips": [{ "id": "a", "startBeat": 0, "notes": [
      { "midi": 62, "startBeat": 0, "durationBeats": 0.75, "velocity": 104, "articulation": "accent" }
    ] }]
  }]
}
```

- Notes take `midi` (or `pitch`), `startBeat` relative to the clip, `durationBeats`, `velocity` 1-127, `articulation` (`normal`, `legato`, `staccato`, `accent`, `sforzando`), and optional `pan` and `pitchBend` (semitones, a glide across the note; guitars and drums ignore it).
- Clips either carry notes or point at a `pattern` with `repeat`, `transpose` and `velocityScale`.
- `role` (`lead`, `counter`, `harmony`, `bass`, `percussion`, `pad`, `fx`) tells the critic what each track does. Each instrument has a default.
- `layer` (`base`, `tension`, `combat`, `climax`) groups tracks into adaptive stems. Keep the hook in `base`.
- Validation reports errors by JSON path. It warns when a loop is not a whole number of frames (110 BPM x 16 bars is not; 120 BPM always is), when notes start after the end, and when automation does not return to its start value before the wrap.
- `notes/v1` scores (`{format, bpm, key, parts: [{id, instrument, notes: [{pitch, start, dur, vel, art}]}]}`) import with `import-notes`. This schema is defined here; it has not been checked against the research kit's `notes/v1`.

## Instruments

All synthesis is procedural TypeScript, seeded per note, so renders are bit-identical across runs.

| type | model |
| --- | --- |
| `piano` | Up to 32 stiff-string partials at `n·f0·√(1+Bn²)` with B rising toward the treble, 1-3 detuned strings per key, velocity-dependent hammer hardness and strike-position comb, two-stage decay, felt knock, damper release, pedal resonance, pitch-spread stereo |
| `brass-horn`, `brass-trumpet` | Ensemble of 3-4 detuned band-limited saws with an onset scoop, delayed vibrato and loose onsets; a dynamic low-pass and a wave-steepening term make forte notes brassier; breath noise; bell formant filters (horn dark, trumpet bright) |
| `strings-ensemble`, `strings-cello`, `strings-bass` | 3-6 detuned PolyBLEP saws per note with per-player vibrato, rosin onset noise, violin, cello or bass body resonances, articulation-shaped envelopes; seated violins left, cellos right, basses centre-right |
| `guitar-electric`, `guitar-acoustic` | Karplus-Strong with fractional-delay tuning (within 5 cents over three octaves), pick-position comb, damping filter, palm mute on staccato. Electric: double-tracked takes, then a biased tube stage and 4x12 cabinet on the summed track. Acoustic: wooden body resonances |
| `timpani` | Tuned kettle-drum modes with a strike pitch glide and mallet noise |
| `orchestral-perc` | GM-style map: 35/36 taiko, 41-50 toms, 38/40 snare, 39 hybrid trailer hit, 42/46 hats, 49/57 crash, 51 ride, 52/55 suspended-cymbal swell (swells over the note length) |
| `synth-pad`, `synth-bass` | 7-voice supersaw pad with slow filter drift; saw-plus-sub bass with a filter envelope |
| `cinematic-sfx` | `params.preset`: `doppler` fly-by, `bell-impact` FM hit, `glass`, `shield-shatter`, `chime`, `riser`, `sub-drop` |

## Effects and mastering

Track inserts: `eq3`, `chorus`, `delay` (tempo-synced, ping-pong), `reverb` (Freeverb with `hall`, `plate`, `room` presets, early reflections and a band-limited wet path), `overdrive`, `cab`, `compressor`. Automation lanes: `volume` (dB) and `cutoff` (Hz, swept in log frequency).

Loops are rendered so the wrap is inaudible:

- Note tails past the end fold back onto the start.
- Each track's effect chain runs over two loop periods and keeps the second, so reverb and delay tails wrap.
- Chorus rates snap to whole cycles per loop.
- The master bus (30 Hz DC-blocking high-pass, RMS bus compressor, constant gain to the LUFS target, lookahead limiter) runs on the loop padded with 2 s of wrapped audio at each end, then crops the exact loop frames back out. The limiter threshold steps down until the 4x-oversampled true peak sits under the ceiling.

`render --stems-dir` writes one WAV per layer with the master's high-pass and gain but none of its non-linear stages, so the stems sum to the pre-limiter mix.

## Symbolic critic (`critique`, MCP `analyse` with `project`)

Scores the score itself, 0 to 1, with fixed weights:

| subscore | weight | what it measures |
| --- | --- | --- |
| `motifRecall` | 0.25 | transposition-invariant 3-interval figures in the lead skyline that recur across sections; penalises both one-figure repetition and all-new material |
| `harmonicFlow` | 0.25 | per-bar chord detection: cadence into the loop wrap (or final cadence), chord diversity, change rate, chord-tone fit, key fit |
| `rhythmicVariety` | 0.15 | off-beat onsets, density contrast between sections, note-length variety in the lead |
| `registerSeparation` | 0.15 | lead/harmony/bass spacing, close intervals below E3, lead notes buried under the harmony, overall span |
| `dynamicContrast` | 0.20 | section energy range, where the peak falls, lead velocity shaping, articulation variety |

Every weak subscore comes with advice the composing agent can act on, for example "End the loop on a V (major, with the leading tone) or bVII so the wrap resolves to the tonic." Percussion and SFX tracks are excluded from melody and harmony. Raise the score by revising the music; the weights are fixed.

## Listening gate (`gate`)

Measures the written file (after PCM quantisation and dither), not the float buffer:

- BS.1770-4 integrated, momentary and short-term loudness; 4x-oversampled true peak
- loop seam: the wrap's sample prediction step and level jump against the roughest bar line in the file
- DC offset, full-scale samples, impulse clicks (onsets that repeat at a pitch period are not clicks)
- 50/60 Hz hum: a 16 s Hann window resolves 0.25 Hz, so a G1 or B1 bass note does not trip it. A tempo-locked drum pattern puts spectral lines on every multiple of the beat rate (50 Hz is the 25th at 120 BPM), so when the tempo is known the line is judged against its neighbours on that comb
- silent channel, stereo correlation and balance, spectral centroid and 85%/95% rolloff
- labelled waveform (bar lines, clipping in red) and log-frequency spectrogram PNGs

Categories `music` (default; -16 ± 2 LUFS or the project's target), `sfx`, `ui` and `ambience` set the thresholds.

## Edit (`edit`)

`trim-silence`, `fade`, `normalize` (LUFS, category or peak; constant gain, limiter only if the ceiling would break, `--loop true` for the loop-safe path), `pitch` (semitones; Lanczos resample plus WSOLA, or `--backend rubberband|sox`), `stretch` (`--ratio` = output/input duration), `layer` (several `--in`, `--gains-db`, `--offsets-s`), `export` (WAV natively; `--backend ffmpeg|sox` for other formats). The binaries are optional and only run when asked for.

## MCP server

`node dist/cli.js mcp` speaks newline-delimited JSON-RPC 2.0 on stdio with 15 tools: `project_init`, `project_validate`, `project_dump`, `add_track`, `remove_track`, `add_clip`, `add_notes`, `set_instrument`, `add_fx`, `add_automation`, `render`, `edit`, `analyse`, `gate`, `export_midi`. Every edit re-validates the whole project before it is saved.

```json
{ "mcpServers": { "agent-daw": { "command": "node", "args": ["<repo>/tools/agent-daw/dist/cli.js", "mcp"] } } }
```

## MIDI

`export-midi` writes SMF type 1 at 480 PPQ: a conductor track (tempo, meter, key signature, section markers), then one track per instrument with GM program, volume, pan, notes and pitch-wheel sweeps (bend range set to 12 semitones). Orchestral percussion goes on channel 10.

## Limits

- Only 48 kHz projects.
- Synthesis is modelled, not sampled. The instruments read as orchestral and expressive but will not pass for a recorded section.
- The critic is a heuristic for catching structural weaknesses. A high score does not mean the music is good; listen to it.
- A full 16-bar, 13-track render takes about 20-30 s of CPU.
