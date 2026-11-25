#!/usr/bin/env bash
# Stitches the five reward and warning cues into one listening file, plus the hit-confirm chain climb.
# Run from tools/agent-daw with both tools built: scores/sfx-showcase.sh [out-dir]
set -euo pipefail

out="${1:-../../artifacts/daw-soundtracks}"
daw="node dist/cli.js"
audio="node ../agent-audio/dist/cli.js"
recipes="../agent-audio/recipes"
work="$(mktemp -d)"
mkdir -p "$out"

for cue in crit-hit near-miss supply-drop weapon-ready incoming-fire hit-confirm; do
  $audio render "$recipes/$cue.recipe.json" --out "$work/$cue.wav" > /dev/null
  $daw gate "$work/$cue.wav" --category sfx > "$work/$cue.gate.json"
done

$daw edit layer --in "$work/crit-hit.wav" --in "$work/near-miss.wav" --in "$work/supply-drop.wav" --in "$work/weapon-ready.wav" --in "$work/incoming-fire.wav" \
  --out "$work/sequence.wav" --gains-db '[0,0,0,0,0]' --offsets-s '[0.2,1.2,2.1,3.2,4.2]' > /dev/null
# One constant gain, so the cues keep the balance they have in the game.
$daw edit normalize --in "$work/sequence.wav" --out "$out/vrr-sfx-showcase.wav" --peak-db -3 > /dev/null
$daw gate "$out/vrr-sfx-showcase.wav" --category sfx --png-dir "$out/vrr-sfx-showcase-gate" > "$out/vrr-sfx-showcase.gate.json"

# The game climbs D E G A C D by raising playback rate; a pitch shift is the nearest offline stand-in.
inputs=()
for semitones in 0 2 5 7 10 12; do
  $daw edit pitch --in "$work/hit-confirm.wav" --out "$work/hit-$semitones.wav" --semitones "$semitones" > /dev/null
  inputs+=(--in "$work/hit-$semitones.wav")
done
$daw edit layer "${inputs[@]}" --in "$work/crit-hit.wav" --out "$work/chain.wav" \
  --gains-db '[0,0,0,0,0,0,0]' --offsets-s '[0.2,0.33,0.46,0.59,0.72,0.85,1.05]' > /dev/null
$daw edit normalize --in "$work/chain.wav" --out "$out/vrr-hit-chain-showcase.wav" --peak-db -3 > /dev/null
$daw gate "$out/vrr-hit-chain-showcase.wav" --category sfx > "$out/vrr-hit-chain-showcase.gate.json"
rm -rf "${work:?}"
echo "wrote $out/vrr-sfx-showcase.wav and $out/vrr-hit-chain-showcase.wav"
