---
name: agent-audio
description: Render deterministic game SFX and loops from plain JSON recipes, run objective BS.1770-4 / integrity / loop-seam gates on any supported WAV, and inspect waveform/spectrogram PNGs before shipping audio.
---

# agent-audio

A zero-dependency TypeScript CLI giving coding agents deterministic ears and a repeatable sound-design workflow.

## Install & Run

```bash
npm install -g agent-audio   # or run via npx agent-audio (Node >= 20, zero native deps)
```

## Supported WAV Matrix

`agent-audio check` accepts any independently authored WAV matching:
- Little-endian RIFF (`RIFF`/`WAVE`), bounded by declared RIFF container size, skipping arbitrary metadata chunks including odd-length padded chunks
- Mono (`1` ch) or stereo (`2` ch)
- `PCM16`, `PCM24` (including `WAVE_FORMAT_EXTENSIBLE` PCM/float), or `IEEE float32`
- `44100 Hz` or `48000 Hz`

Unsupported formats, truncated chunks, or non-finite floats exit `2` with a stable error code.

## Minimal Recipe Example

```json
{
  "schemaVersion": "agent-audio/recipe/v1",
  "kind": "one-shot",
  "id": "ui-ping",
  "sampleRate": 48000,
  "channels": 2,
  "encoding": "pcm16",
  "durationS": 0.11,
  "masterGainDb": -6,
  "voices": [
    {
      "id": "ping",
      "waveform": "sine",
      "gainDb": -2,
      "freqStartHz": 1320,
      "freqEndHz": 1760,
      "envelope": { "attackS": 0.003, "decayS": 0.04, "sustainLevel": 0.3, "releaseS": 0.02 }
    }
  ]
}
```

## Commands

```bash
# 1. Render a recipe to WAV
agent-audio render recipes/lock-chirp.recipe.json --out out/lock-chirp.wav

# 2. Run deterministic checks (+ optional inspection PNGs)
agent-audio check out/lock-chirp.wav --png out/inspect --out out/lock-chirp.report.json

# 3. Check a seamless loop (with seam_wrap.png)
agent-audio render recipes/combat-loop.recipe.json --out out/combat-loop.wav
agent-audio check out/combat-loop.wav --loop --png out/inspect
```

Exit codes: `0` pass, `1` gate violation, `2` invalid input or tool error.

## Authoring & Revision Workflow

1. **Author or edit** a plain JSON recipe (`schemaVersion: "agent-audio/recipe/v1"`) with explicit `gainDb`, envelopes, and seeded noise.
2. **Render** to WAV and immediately run `check` with `--png`.
3. **Fix all numeric `fail` findings first** (`TRUE_PEAK_EXCEEDED`, `FULL_SCALE_SAMPLES`, `DC_OFFSET`, `LEADING_SILENCE`, `CUT_TAIL`, `IMPULSE_CLICK`, `LOOP_SEAM_DISCONTINUITY`).
4. **Inspect PNGs** only after numeric gates pass (or to locate a named defect):
   - `*_waveform.png`: red bars mark near-full-scale clipping; empty left gap is leading silence; abrupt wall at right edge is a cut tail.
   - `*_spectrogram.png`: thin vertical full-band line = click; horizontal bars = pitched tones; textured smear = filtered noise.
   - `*_seam_wrap.png` (`--loop`): last 80 ms joined to first 80 ms; a vertical line down the center indicates a loop seam click.
5. **Audition in context:** for gameplay cues (like a target-lock chirp over engine + cannon fire), audition at explicit game gains and offsets rather than relying on isolated loudness numbers alone.

## Sound-Design Rules of Thumb

- **Short one-shots (< 400 ms):** `integratedLufs` is `null` (`duration_below_400ms`); judge level using `momentaryMaxLufs` (`momentaryPadded: true`) and keep `truePeakDbtp <= -1.0`.
- **Loops:** choose tempos/lengths that yield exact integer frame counts (e.g. `120 BPM`, `8 beats` = `4.000 s`) and keep `loopWrap: true` so note releases wrap smoothly across bar 1.
- **Avoid muddying foreground cues:** separate transient weapons (low-mid sweep + noise click) from status alerts (clean upper-mid `1.2–2.2 kHz` tonal chirp).
