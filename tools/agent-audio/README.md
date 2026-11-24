# agent-audio

Render game sound effects and loops from JSON recipes, and gate any WAV with deterministic checks: BS.1770-4 loudness, true peak, clicks, cut tails, DC offset, stereo phase and loop seams. It is written in TypeScript with no runtime dependencies and is built for coding agents, which cannot listen to their own output.

## Status

Version 0.1.0. The package is not published to npm, so build it from source or install a packed tarball.

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
npm install -g ./agent-audio-0.1.0.tgz
agent-audio --help
```

## Use

```bash
agent-audio render recipes/cannon-shot.recipe.json --out out/cannon-shot.wav
agent-audio check out/cannon-shot.wav --png out/inspect

agent-audio render recipes/combat-loop.recipe.json --out out/combat-loop.wav
agent-audio check out/combat-loop.wav --loop
```

`check` prints a JSON report and exits `0` when the file passes, `1` when a gate fails and `2` on bad input. It reads mono or stereo WAV at 44.1 or 48 kHz in PCM16, PCM24 or float32.

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

[SKILL.md](SKILL.md) is the full reference: the recipe schema for one-shots and loops, every finding code, every threshold key with its default, and the authoring workflow. It doubles as an agent skill file.

## Library

```ts
import { checkAudio, readWavFile, renderRecipe, validateRecipe } from 'agent-audio';

const report = checkAudio(readWavFile('out/cannon-shot.wav'), 'cannon-shot.wav', { loop: false });
```

## Develop

```bash
npm test
```

The loudness tests compare against `ffmpeg` when it is installed and skip that comparison when it is not.

## License

MIT
