---
name: agent-audio
description: Render deterministic game SFX and loops from plain JSON recipes, run objective BS.1770-4 / integrity / loop-seam gates on any supported WAV or on a whole folder, check the headroom of several cues mixed together, and inspect labelled waveform/spectrogram PNGs before shipping audio.
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
npx --yes --package ./agent-audio-0.2.0.tgz agent-audio --help
npm install -g ./agent-audio-0.2.0.tgz
```

The examples below write `agent-audio` for whichever form you use.

## Commands

```bash
# Render a recipe to WAV
agent-audio render recipes/lock-chirp.recipe.json --out out/lock-chirp.wav

# Gate a one-shot, write the report and inspection PNGs
agent-audio check out/lock-chirp.wav --png out/inspect --out out/lock-chirp.report.json

# Gate a loop: adds the seam checks and a seam PNG, skips the leading-silence, cut-tail and quiet-tail checks
agent-audio render recipes/combat-loop.recipe.json --out out/combat-loop.wav
agent-audio check out/combat-loop.wav --loop --png out/inspect

# Override thresholds with inline JSON or a JSON file
agent-audio check out/lock-chirp.wav --thresholds '{"maxTruePeakDbtp":-3,"minMomentaryLufs":-30}'

# One table row instead of the JSON report
agent-audio check out/lock-chirp.wav --summary

# Render and gate a whole folder
agent-audio batch recipes --out out/batch --summary

# Sum several WAVs at their bus gains and gate the mix
agent-audio mix-check --mix out/combat-loop.wav:-6,out/cannon-shot.wav:-3@1.5
agent-audio mix-check combat.mix.json --wav out/combat-mix.wav --png out/inspect
```

Exit codes: `0` pass, `1` gate failure, `2` invalid input or tool error. `check` and `mix-check` print the JSON report on stdout. Errors print one JSON line on stderr with a stable `code`. `--help` or `-h` prints usage and the threshold keys.

`--strict` on `check` and `batch` turns the advisory warnings into failures.

### Batch

`batch <dir> --out <dir>` handles every `*.recipe.json` and `*.wav` in the folder, in name order:

- A recipe is rendered to `<out>/<name>.wav` and gated, with `--loop` applied when its `kind` is `loop`.
- A WAV is gated as it is, as a loop only when you pass `--loop`. A WAV with the same base name as a recipe is skipped, since it is an earlier render of that recipe.
- Each file gets `<out>/<name>.report.json`. `--png <dir>` and `--thresholds` apply to every file.
- A broken file gets an `ERROR` row and the run moves on. The exit code is the worst seen: `2` if any file errored, else `1` if any failed, else `0`.

Without `--summary`, `batch` prints `{ schemaVersion: "agent-audio/batch/v1", ok, results }` with each file's source, WAV, report path, verdict and finding codes.

### Summary table

`--summary` on `check` or `batch` prints a header and one row per file:

```text
FILE                     VERDICT  DUR_S   LUFS    DBTP   CENTROID_HZ  SEAM  FINDINGS
cannon-shot.recipe.json  PASS     0.240   M-22.4  -5.9   1109         -     -
combat-loop.recipe.json  PASS     25.600  I-17.4  -2.2   803          0.01  -
```

- `VERDICT` is `PASS`, `WARN` (advisory findings only), `FAIL` or `ERROR`.
- `LUFS` is integrated loudness (`I`) when the file is at least 400 ms long, else the loudest momentary block (`M`).
- `SEAM` is the largest per-channel loop discontinuity ratio, or `-` without `--loop`.
- `FINDINGS` lists the distinct finding codes, or the error code for an `ERROR` row.

### Mix headroom

`mix-check` sums WAVs at bus gains and runs BS.1770-4 loudness, 4x true peak and full-scale sample counts on the composite. Give the stems as a manifest file or as `--mix file:gainDb[@offsetS],...`; the gain follows the last colon in each entry.

```json
{
  "schemaVersion": "agent-audio/mix/v1",
  "durationS": 4,
  "stems": [
    { "file": "out/combat-loop.wav", "gainDb": -6, "loop": true },
    { "file": "out/cannon-shot.wav", "gainDb": -3, "offsetS": 0.5 },
    { "file": "out/explosion.wav", "gainDb": -4, "offsetS": 1.25 }
  ]
}
```

- Manifest paths resolve against the manifest's folder.
- The sum is never clamped, so a peak over 0 dBFS reads as it is.
- Every stem must share one sample rate, or the command exits `2` with `MIX_SAMPLE_RATE_MISMATCH`.
- A mono stem feeds both channels of a stereo mix at full level.
- The mix lasts `durationS`, else until the last non-looped stem ends, else one pass of the longest looped stem. A `loop: true` stem repeats from its offset to the end of the mix.
- Defaults are `maxTruePeakDbtp` -1 and `maxFullScaleSamples` 7 per channel. `--thresholds` also takes the four loudness keys; any other key exits `2`.
- `--wav <file>` writes the float32 composite and `--png <dir>` its inspection PNGs.

The report has `loudness`, `samplePeakDbfs`, `headroomDb` (minus the true peak), `fullScaleSamples` per channel, `stems`, `format` and `findings`.

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
| `dcBlock` | `true` adds a 10 Hz one-pole DC-blocking high-pass after `masterGainDb` |
| `masterLimiterDb` | -30 to 0: a true-peak limiter holds the 4x oversampled peak at or below this many dBTP |

On a wrapped loop both master stages run as if the loop repeated forever: the DC blocker warms up over earlier passes and the limiter works on three back-to-back copies and keeps the middle one, so the seam stays clean. The limiter looks 1.5 ms ahead, releases over 60 ms and leaves audio far below the ceiling untouched.

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
| `bandLimited` | `true` adds PolyBLEP correction to `saw` and `square`, which removes most aliasing on high notes. Off by default, so existing recipes render byte for byte as before. |
| `filterEnv` | `{ depthHz, attackS, decayS }`, needs `filter`. The cutoff moves from `freqHz` to `freqHz + depthHz` over `attackS`, then back to `freqHz` over `decayS`, linearly. |

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

Adds `bpm` (30 to 300), `beats`, `loopWrap` (default `true`) and `tracks`. The loop lasts `beats * 60 / bpm` seconds. A track has `id`, `voice` and `notes`, and optionally `repeat` and `delay`. Pitch comes from each note, so a track voice takes no `id`, frequency, `startS` or `durationS` keys. A note is `{ startBeat, durationBeats, midi, velocity }` with `midi` from 0 to 127 and `velocity` above 0 up to 1.

With `loopWrap: true` a note that rings past the last beat continues at the start of the file, so the loop point is seamless. With `false` the note is cut at the end of the file.

Optional note keys sweep the pitch, which is how kicks and toms are made:

| Key | Values |
| --- | --- |
| `pitchStartSemitones` | -96 to 96. The note starts this far from `midi` and sweeps to it. |
| `freqStartHz`, `freqEndHz` | absolute sweep in Hz; each defaults to the `midi` pitch. A note cannot set both `pitchStartSemitones` and `freqStartHz`. |
| `pitchSweepS` | sweep time in seconds (default: the note's held length). The sweep is exponential, that is linear in semitones. |

Optional track keys:

| Key | Values |
| --- | --- |
| `repeat` | `{ times, strideBeats }`. The notes play `times` times (1 to 1024), each pass `strideBeats` later. Copies run pass by pass, so noise voices draw from the generator in the same order as the hand-written notes would. Every copy must start before `beats`. |
| `delay` | `{ timeS, feedback, mix, pingPong }`: a feedback delay send added on top of the dry track. `timeS` 0 to 2, `feedback` 0 to 0.95, `mix` 0 to 1 scales the first echo, and each later echo is `feedback` times the one before. `pingPong: true` sends the first echo of a stereo track left, the second right, and so on. On a wrapped loop the echoes wrap too, even when the tail outlasts the loop. |

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

This loop uses the new keys: a pitch-swept kick, a band-limited arpeggio with a filter envelope and a ping-pong echo, and a repeated hi-hat, behind a DC blocker and a limiter.

```json
{
  "schemaVersion": "agent-audio/recipe/v1",
  "kind": "loop",
  "id": "drive-loop",
  "bpm": 120,
  "beats": 4,
  "masterGainDb": -4,
  "dcBlock": true,
  "masterLimiterDb": -1.5,
  "tracks": [
    {
      "id": "kick",
      "voice": {
        "waveform": "sine",
        "gainDb": -3,
        "envelope": { "attackS": 0.001, "decayS": 0.18, "sustainLevel": 0, "releaseS": 0.05 }
      },
      "repeat": { "times": 4, "strideBeats": 1 },
      "notes": [{ "startBeat": 0, "durationBeats": 0.4, "midi": 36, "velocity": 1, "pitchStartSemitones": 24, "pitchSweepS": 0.04 }]
    },
    {
      "id": "arp",
      "voice": {
        "waveform": "saw",
        "bandLimited": true,
        "gainDb": -16,
        "envelope": { "attackS": 0.003, "decayS": 0.12, "sustainLevel": 0.2, "releaseS": 0.08 },
        "filter": { "type": "lowpass", "freqHz": 700, "q": 1.2 },
        "filterEnv": { "depthHz": 2500, "attackS": 0.002, "decayS": 0.12 }
      },
      "delay": { "timeS": 0.375, "feedback": 0.4, "mix": 0.35, "pingPong": true },
      "repeat": { "times": 2, "strideBeats": 2 },
      "notes": [
        { "startBeat": 0.5, "durationBeats": 0.25, "midi": 69, "velocity": 0.8 },
        { "startBeat": 1, "durationBeats": 0.25, "midi": 72, "velocity": 0.7 },
        { "startBeat": 1.5, "durationBeats": 0.25, "midi": 76, "velocity": 0.8 }
      ]
    },
    {
      "id": "hat",
      "voice": {
        "waveform": "noise",
        "gainDb": -22,
        "pan": 0.3,
        "envelope": { "attackS": 0.001, "decayS": 0.03, "sustainLevel": 0, "releaseS": 0.02 },
        "filter": { "type": "highpass", "freqHz": 7000 }
      },
      "repeat": { "times": 8, "strideBeats": 0.5 },
      "notes": [{ "startBeat": 0.25, "durationBeats": 0.1, "midi": 60, "velocity": 0.6 }]
    }
  ]
}
```

Always gate a loop with `check --loop`.

## Findings and thresholds

Most findings have `severity: "fail"` and fail the gate. `ALIASING_SUSPECTED` and `QUIET_TAIL` are advisory: they have `severity: "warn"`, leave `ok` true and show as `WARN` in the summary, unless `--strict` (or `strict: true` in the library) makes them failures. Pass any threshold key through `--thresholds` to change its limit.

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
| `ALIASING_SUSPECTED` (warn) | `maxAliasingRatio` (0.006) | `spectral.aliasingRatio` is above the limit. |
| `QUIET_TAIL` (warn) | `maxQuietTailFraction` (0.4), `quietTailDb` (24) | The end of a one-shot sits more than `quietTailDb` below its loudest 10 ms for more than this fraction of the file. Skipped with `--loop`. |

How the level-relative gates work:

- `referenceLevelDbfs` in the report is √2 times the loudest 10 ms RMS in the file. It equals the peak of a steady tone and barely moves for a single-sample click. `IMPULSE_CLICK`, `CUT_TAIL` and the loop seam floor scale with it, so a file gets the same verdict at any gain.
- A discontinuity that repeats at a steady rate faster than 20 times a second is treated as pitch. A raw `saw` from about 22 Hz up and a raw `square` from about 11 Hz up pass, and a lone click, a dropout, a voice that starts mid-file at full level, or an uneven burst of clicks fails. A click smaller than about twice the wave's own steps is masked by them and passes.
- Below a reference level of -70 dBFS the click, cut-tail and phase checks are skipped, because PCM16 quantisation steps are that large.
- The loop seam is compared with the non-silent part of the loop, so a loop that is mostly silence is judged against its notes.
- The seam check compares the jump across the wrap with ordinary sample-to-sample motion, so a raw `saw` or `square` step that happens to land on the last frame reads as a seam click.

How the advisory checks work:

- `aliasingRatio` is a heuristic. It looks at 2048-point frames with a steady pitch of 300 Hz or more where at least 90% of the energy sits on that pitch's harmonics or on the frequencies its folded-back partials would land on. It reports the share of that energy on the fold-back grid, above what chance would put there. Noise, pitch sweeps, chords and inharmonic FM fail the steady-pitch test, and when such frames hold under 20% of the file's energy the ratio is `null` and nothing is flagged. From MIDI 81 to 108 (880 Hz to 4.2 kHz), at 44.1 and 48 kHz, every raw `saw` and `square` crosses the default limit and every `bandLimited: true` one stays under it (worst 0.0049). A pitch that divides the sample rate, such as 2 kHz at 48 kHz, folds onto its own harmonics and reads near 0.
- `tail.quietTailS` and `tail.quietTailFraction` measure the time after the last 10 ms window within `quietTailDb` of the loudest window. Trailing silence counts as quiet. Shorten `durationS` or the release to fix it.

## Reading the report

- `loudness`: `integratedLufs`, `momentaryMaxLufs` and `truePeakDbtp` per BS.1770-4. Files under 400 ms report `integratedLufs: null` with `integratedReason: "duration_below_400ms"`; use `momentaryMaxLufs` for those.
- `spectral`: power-weighted `centroidHz` and the 85% and 95% rolloff of the average spectrum over the whole file (4096-point Hann frames, 50% overlap, all channels), and `aliasingRatio`.
- `tail`: `quietTailS` and `quietTailFraction`.
- `stereo`: `balanceDb` and `correlation`, or `null` for mono.
- `channels[]`: per-channel peak, RMS, DC, edge peaks, `clickRatio` with its frame, and `loopSeam` with `--loop`.

## Workflow

1. Write or edit the recipe, render it, and run `check` with `--png`. For a set of cues, run `batch --summary` over the folder.
2. Fix every failure before looking at the PNGs, and read every warning.
3. Use the PNGs to locate a named defect. Every PNG has a time axis along the bottom (ms under 2 s, else s) and a title naming its vertical axis.
   - `*_waveform.png`: dotted gridlines and labels at 0, -6, -12 and -20 dBFS. Red bars mark near-full-scale samples, an empty left gap is leading silence, and a wall at the right edge is a cut tail.
   - `*_spectrogram.png`: log frequency with ticks at 100 Hz, 500 Hz, 1 kHz, 4 kHz and 12 kHz. A thin full-height vertical line is a click, horizontal bars are pitched tones, and a textured smear is filtered noise.
   - `*_seam_wrap.png` (`--loop`): the last 80 ms joined to the first 80 ms, as a waveform strip over a spectrogram, with ms ticks relative to the wrap. Yellow marks in the margins and a dashed line behind the waveform show the wrap. A step in the waveform or a vertical line in the spectrogram at the wrap is a seam click.
4. Run `mix-check` with the cues and the music at the gains and offsets the game uses, and keep the true peak of the busiest moment under the ceiling.
5. Audition gameplay cues in context.

## Sound-design rules of thumb

- Keep `truePeakDbtp` at or below -1.0. `masterLimiterDb: -1` does this for you, but a limiter working hard flattens transients, so fix the gain first.
- Use `bandLimited: true` on any `saw` or `square` above about 600 Hz.
- For loops, pick a tempo and length that give a whole number of frames (120 BPM and 8 beats is 4.000 s) and keep `loopWrap: true`.
- Keep foreground cues apart in frequency: a weapon as a low-mid sweep with a noise transient, a status alert as a clean tone around 1.2 to 2.2 kHz.
