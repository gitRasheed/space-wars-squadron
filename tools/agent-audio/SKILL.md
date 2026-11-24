---
name: agent-audio
description: Render deterministic game SFX and loops from plain JSON recipes, run objective BS.1770-4 / integrity / loop-seam gates on any supported WAV, and inspect waveform/spectrogram PNGs before shipping audio.
---

# agent-audio

A zero-dependency TypeScript CLI that renders sound from JSON recipes and gates any WAV with deterministic checks.

## Run

The package is not on npm yet. Build it from this folder (Node >= 20), then call the built CLI:

```bash
npm ci
npm run build
node dist/cli.js --help
```

To use it outside the folder, pack a tarball and run or install that:

```bash
npm pack
npx --yes --package ./agent-audio-0.1.0.tgz agent-audio --help
npm install -g ./agent-audio-0.1.0.tgz
```

The examples below write `agent-audio` for whichever form you use.

## Commands

```bash
# Render a recipe to WAV
agent-audio render recipes/lock-chirp.recipe.json --out out/lock-chirp.wav

# Gate a one-shot, write the report and inspection PNGs
agent-audio check out/lock-chirp.wav --png out/inspect --out out/lock-chirp.report.json

# Gate a loop: adds the seam checks and a seam PNG, skips the leading-silence and cut-tail checks
agent-audio render recipes/combat-loop.recipe.json --out out/combat-loop.wav
agent-audio check out/combat-loop.wav --loop --png out/inspect

# Override thresholds with inline JSON or a JSON file
agent-audio check out/lock-chirp.wav --thresholds '{"maxTruePeakDbtp":-3,"minMomentaryLufs":-30}'
```

Exit codes: `0` pass, `1` gate failure, `2` invalid input or tool error. `check` prints the JSON report on stdout. Errors print one JSON line on stderr with a stable `code`. `--help` or `-h` prints usage and the threshold keys.

## Supported WAV input

`check` accepts any WAV that is:

- Little-endian RIFF/WAVE, including files with extra metadata chunks
- Mono or stereo
- PCM16, PCM24 or IEEE float32, plain or `WAVE_FORMAT_EXTENSIBLE`
- 44100 Hz or 48000 Hz

## Recipes

A recipe is one JSON object. Unknown keys are rejected anywhere in it: the error names the key, its path (for example `voices[0]`) and the keys allowed there, and `render` exits `2`.

Keys shared by both kinds:

| Key | Values |
| --- | --- |
| `schemaVersion` | `"agent-audio/recipe/v1"` |
| `kind` | `"one-shot"` or `"loop"` |
| `id` | non-empty string |
| `sampleRate` | `44100` or `48000` (default `48000`) |
| `channels` | `1` or `2` (default `2`) |
| `encoding` | `"pcm16"` or `"float32"` (default `"pcm16"`) |
| `seed` | number, seeds the noise generator |
| `masterGainDb` | number (default `0`) |

A voice, used by both kinds:

| Key | Values |
| --- | --- |
| `waveform` | `sine`, `triangle`, `saw`, `square`, `noise`, `fm` |
| `gainDb` | -120 to 24 |
| `pan` | -1 (left) to 1 (right), default 0 |
| `envelope` | `{ attackS, decayS, sustainLevel, releaseS }`, all required |
| `filter` | `{ type, freqHz, q }`, `type` is `lowpass`, `highpass` or `bandpass` |
| `drive` | 0 to 20, tanh saturation after the filter |
| `fmRatio`, `fmIndex` | modulator ratio and depth for `fm` |

### One-shot

Adds `durationS` (up to 30) and `voices`. A one-shot voice also takes `id`, `freqStartHz`, `freqEndHz`, `freqCurve` (`exp` or `linear`), `startS` and `durationS`.

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

### Loop

Adds `bpm` (30 to 300), `beats`, `loopWrap` (default `true`) and `tracks`. The loop lasts `beats * 60 / bpm` seconds. A track has `id`, `voice` and `notes`. Pitch comes from each note, so a track voice takes no `id`, frequency, `startS` or `durationS` keys. A note is `{ startBeat, durationBeats, midi, velocity }` with `midi` from 0 to 127 and `velocity` above 0 up to 1.

With `loopWrap: true` a note that rings past the last beat continues at the start of the file, so the loop point is seamless. With `false` the note is cut at the end of the file.

```json
{
  "schemaVersion": "agent-audio/recipe/v1",
  "kind": "loop",
  "id": "pulse-loop",
  "bpm": 120,
  "beats": 4,
  "masterGainDb": -6,
  "loopWrap": true,
  "tracks": [
    {
      "id": "bass",
      "voice": {
        "waveform": "triangle",
        "gainDb": -4,
        "envelope": { "attackS": 0.005, "decayS": 0.1, "sustainLevel": 0.4, "releaseS": 0.08 },
        "filter": { "type": "lowpass", "freqHz": 900, "q": 0.9 }
      },
      "notes": [
        { "startBeat": 0, "durationBeats": 0.5, "midi": 45, "velocity": 0.9 },
        { "startBeat": 1, "durationBeats": 0.5, "midi": 45, "velocity": 0.7 },
        { "startBeat": 2, "durationBeats": 0.5, "midi": 48, "velocity": 0.9 },
        { "startBeat": 3.5, "durationBeats": 0.5, "midi": 43, "velocity": 0.8 }
      ]
    }
  ]
}
```

Always gate a loop with `check --loop`.

## Findings and thresholds

Every finding has `severity: "fail"` and fails the gate. Pass any threshold key through `--thresholds` to change its limit.

| Finding | Threshold key (default) | Fires when |
| --- | --- | --- |
| `SILENT_AUDIO` | none | The file is empty or peaks below -120 dBFS. |
| `TRUE_PEAK_EXCEEDED` | `maxTruePeakDbtp` (-1) | The 4x oversampled true peak is above the limit. |
| `FULL_SCALE_SAMPLES` | `maxFullScaleSamples` (7) | More samples than the limit sit at or above 0.999. |
| `DC_OFFSET` | `maxDcOffset` (0.005) | A channel's mean is further from zero than the limit. |
| `LEADING_SILENCE` | `maxLeadingSilenceS` (0.02) | The sound starts later than the limit. Skipped with `--loop`. |
| `CUT_TAIL` | `maxEndEdgeRatio` (0.4) | The last 0.5 ms still peaks at this fraction of the reference level. Skipped with `--loop`. |
| `IMPULSE_CLICK` | `maxClickRatio` (25) | An isolated discontinuity stands this many times above the curvature around it. |
| `STEREO_IMBALANCE` | `maxStereoBalanceDb` (12) | Left and right RMS differ by more than the limit. |
| `STEREO_PHASE_INVERTED` | `minStereoCorrelation` (-0.5) | Left/right correlation is below the limit, so the channels cancel in mono. |
| `LOOP_SEAM_DISCONTINUITY` | `maxLoopDiscontinuityRatio` (12, `--loop` only) | The jump from the last sample to the first is this many times larger than the sample-to-sample error inside the loop. |
| `LOOP_WRAP_DELTA` | `maxLoopWrapDelta` (off) | The last and first samples differ by more than the limit. |
| `LOUDNESS_MOMENTARY_LOW` | `minMomentaryLufs` (off) | The loudest 400 ms block is below the limit. |
| `LOUDNESS_MOMENTARY_HIGH` | `maxMomentaryLufs` (off) | The loudest 400 ms block is above the limit. |
| `LOUDNESS_INTEGRATED_LOW` | `minIntegratedLufs` (off) | Gated integrated loudness is below the limit or cannot be measured. |
| `LOUDNESS_INTEGRATED_HIGH` | `maxIntegratedLufs` (off) | Gated integrated loudness is above the limit. |

How the level-relative gates work:

- `referenceLevelDbfs` in the report is √2 times the loudest 10 ms RMS in the file. It equals the peak of a steady tone and barely moves for a single-sample click. `IMPULSE_CLICK`, `CUT_TAIL` and the loop seam floor scale with it, so a file gets the same verdict at any gain.
- A discontinuity that repeats at a steady rate faster than 20 times a second is treated as pitch. A raw `saw` from about 22 Hz up and a raw `square` from about 11 Hz up pass, and a lone click, a dropout, a voice that starts mid-file at full level, or an uneven burst of clicks fails. A click smaller than about twice the wave's own steps is masked by them and passes.
- Below a reference level of -70 dBFS the click, cut-tail and phase checks are skipped, because PCM16 quantisation steps are that large.
- The loop seam is compared with the non-silent part of the loop, so a loop that is mostly silence is judged against its notes.

## Reading the report

- `loudness`: `integratedLufs`, `momentaryMaxLufs` and `truePeakDbtp` per BS.1770-4. Files under 400 ms report `integratedLufs: null` with `integratedReason: "duration_below_400ms"`; use `momentaryMaxLufs` for those.
- `spectral`: power-weighted `centroidHz` and the 85% and 95% rolloff of the average spectrum over the whole file (4096-point Hann frames, 50% overlap, all channels).
- `stereo`: `balanceDb` and `correlation`, or `null` for mono.
- `channels[]`: per-channel peak, RMS, DC, edge peaks, `clickRatio` with its frame, and `loopSeam` with `--loop`.

## Workflow

1. Write or edit the recipe, render it, and run `check` with `--png`.
2. Fix every finding before looking at the PNGs.
3. Use the PNGs to locate a named defect:
   - `*_waveform.png`: red bars mark near-full-scale samples, an empty left gap is leading silence, and a wall at the right edge is a cut tail.
   - `*_spectrogram.png`: a thin full-height vertical line is a click, horizontal bars are pitched tones, and a textured smear is filtered noise.
   - `*_seam_wrap.png` (`--loop`): the last 80 ms joined to the first 80 ms. A vertical line at the centre is a seam click.
4. Audition gameplay cues in context, at the gains and offsets the game uses.

## Sound-design rules of thumb

- Keep `truePeakDbtp` at or below -1.0.
- For loops, pick a tempo and length that give a whole number of frames (120 BPM and 8 beats is 4.000 s) and keep `loopWrap: true`.
- Keep foreground cues apart in frequency: a weapon as a low-mid sweep with a noise transient, a status alert as a clean tone around 1.2 to 2.2 kHz.
