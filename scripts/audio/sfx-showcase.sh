#!/usr/bin/env bash
# Stitches the five reward and warning cues into one listening file, plus the hit-confirm chain climb.
# Usage from the repository root: scripts/audio/sfx-showcase.sh [out-dir]
set -euo pipefail

out="${1:-artifacts/daw-soundtracks}"
work="$(mktemp -d)"
trap 'rm -rf "${work:?}"' EXIT
mkdir -p "$out"
# Both listening sequences start at 0.2 s, followed by the first cue's attack.
showcase_limits='{"maxLeadingSilenceS":0.21}'

for cue in crit-hit near-miss supply-drop weapon-ready incoming-fire hit-confirm; do
  node -p 'JSON.stringify(require("./src/audio/combat-cues.json")[process.argv[1]])' "$cue" > "$work/$cue.json"
  npx kleos render "$work/$cue.json" --out "$work/$cue.wav" > /dev/null
  npx kleos check "$work/$cue.wav" --profile sfx > "$work/$cue.gate.json"
done

npx kleos edit layer --in "$work/crit-hit.wav" --in "$work/near-miss.wav" --in "$work/supply-drop.wav" --in "$work/weapon-ready.wav" --in "$work/incoming-fire.wav" \
  --out "$work/sequence.wav" --gains-db '[0,0,0,0,0]' --offsets-s '[0.2,1.2,2.1,3.2,4.2]' > /dev/null
# One constant gain, so the cues keep the balance they have in the game.
npx kleos edit normalize --in "$work/sequence.wav" --out "$out/vrr-sfx-showcase.wav" --peak-db -3 > /dev/null
npx kleos check "$out/vrr-sfx-showcase.wav" --profile sfx --thresholds "$showcase_limits" --png "$out/vrr-sfx-showcase-gate" > "$out/vrr-sfx-showcase.gate.json"

# The game climbs D E G A C D by raising playback rate; a pitch shift is the nearest offline stand-in.
inputs=()
for semitones in 0 2 5 7 10 12; do
  npx kleos edit pitch --in "$work/hit-confirm.wav" --out "$work/hit-$semitones.wav" --semitones "$semitones" > /dev/null
  inputs+=(--in "$work/hit-$semitones.wav")
done
npx kleos edit layer "${inputs[@]}" --in "$work/crit-hit.wav" --out "$work/chain.wav" \
  --gains-db '[0,0,0,0,0,0,0]' --offsets-s '[0.2,0.33,0.46,0.59,0.72,0.85,1.05]' > /dev/null
npx kleos edit normalize --in "$work/chain.wav" --out "$out/vrr-hit-chain-showcase.wav" --peak-db -3 > /dev/null
npx kleos check "$out/vrr-hit-chain-showcase.wav" --profile sfx --thresholds "$showcase_limits" > "$out/vrr-hit-chain-showcase.gate.json"
echo "wrote $out/vrr-sfx-showcase.wav and $out/vrr-hit-chain-showcase.wav"
