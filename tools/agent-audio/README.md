# agent-audio

Render game sound effects and loops from JSON recipes, and gate any WAV with deterministic checks: BS.1770-4 loudness, true peak, clicks, cut tails, DC offset, stereo phase, loop seams, and advisory aliasing and quiet-tail warnings. It can gate a whole folder at once and check the headroom of several sounds mixed together. It is written in TypeScript with no runtime dependencies and is built for coding agents, which cannot listen to their own output.

## Status

Version 0.2.0. The package is not published to npm, so build it from source or install a packed tarball. Recipes written for 0.1.0 render byte for byte the same; every new recipe key is optional.

## Install

Requires Node 20 or later.

```bash
npm ci
npm run build
node dist/cli.js --help
```

To use it from another project:

```bash
npm pack
npm install -g ./agent-audio-0.2.0.tgz
agent-audio --help
```

## Use

```bash
agent-audio render recipes/cannon-shot.recipe.json --out out/cannon-shot.wav
agent-audio check out/cannon-shot.wav --png out/inspect

agent-audio render recipes/combat-loop.recipe.json --out out/combat-loop.wav
agent-audio check out/combat-loop.wav --loop

agent-audio batch recipes --out out/batch --summary
agent-audio mix-check --mix out/combat-loop.wav:-6,out/cannon-shot.wav:-3@1.5
```

`check` prints a JSON report and exits `0` when the file passes, `1` when a gate fails and `2` on bad input. It reads mono or stereo WAV at 44.1 or 48 kHz in PCM16, PCM24 or float32. `batch` renders every recipe and checks every WAV in a folder, and `--summary` prints one row per file:

```text
FILE                     VERDICT  DUR_S   LUFS    DBTP   CENTROID_HZ  SEAM  FINDINGS
cannon-shot.recipe.json  PASS     0.240   M-22.4  -5.9   1109         -     -
combat-loop.recipe.json  PASS     25.600  I-17.4  -2.2   803          0.01  -
```

A failing report names each defect and where it is:

```json
{
  "code": "IMPULSE_CLICK",
  "severity": "fail",
  "channel": 0,
  "frame": 12000,
  "timeS": 0.25,
  "message": "Channel 0 impulse curvature ratio 491.918 at 0.25 s (limit 25)"
}
```

`--png <dir>` writes a waveform, a log-frequency spectrogram and, for loops, a seam view of the wrap point, each with labelled time and level or frequency axes.

The synth has sine, triangle, saw, square, noise and two-operator FM voices with ADSR envelopes, biquad filters with an optional filter envelope, tanh drive, PolyBLEP band-limited saw and square, pitch sweeps on one-shots and loop notes, pattern repeats, a feedback delay send per loop track, and a master DC blocker and true-peak limiter that keep loops seamless.

[SKILL.md](SKILL.md) is the full reference: the recipe schema, every finding code, every threshold key with its default, the batch and mix-check formats, and the authoring workflow. It doubles as an agent skill file.

## Library

```ts
import { checkAudio, checkMix, mixStems, readWavFile, renderRecipe, validateRecipe } from 'agent-audio';

const report = checkAudio(readWavFile('out/cannon-shot.wav'), 'cannon-shot.wav', { loop: false });

const stems = [
  { file: 'out/combat-loop.wav', gainDb: -6, offsetS: 0, loop: true },
  { file: 'out/cannon-shot.wav', gainDb: -3, offsetS: 1.5, loop: false },
].map((s) => ({ ...s, audio: readWavFile(s.file) }));
const mix = checkMix(stems, mixStems(stems));
```

## Develop

```bash
npm test
```

The loudness tests compare against `ffmpeg` when it is installed and skip that comparison when it is not. The files in `recipes/` are examples. Tests that pin rendering or exact gate behaviour use `tests/fixtures/` or inline recipes. A few tests still read `cannon-shot`, `lock-chirp` and `combat-loop` from `recipes/` and expect them to pass the gate, and one runs `batch` over the whole folder.

## License

MIT
