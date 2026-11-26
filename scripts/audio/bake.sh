#!/usr/bin/env bash
# Usage from the repository root: scripts/audio/bake.sh [showcase-dir] [game-audio-dir]
# Writes lossless showcases (1x, the 2x wrap, stems, MIDI, gate PNGs) to the first folder and the
# game's Opus files to the second. Each Opus file is the loop with half a second of wrapped audio
# on both sides, so the codec's start-up and tail sit outside the loop points the game plays.
set -euo pipefail

out="${1:-artifacts/daw-soundtracks}"
game="${2:-public/audio}"
work="$(mktemp -d)"
trap 'rm -rf "${work:?}"' EXIT
pad_s=0.5
loop_s=32
mkdir -p "$out" "$game"

for id in saturn-orbit megastructure-trench sunset-ground-support; do
  score="scripts/audio/$id.daw.json"
  npx kleos validate "$score" > "$out/$id.validate.json"
  # --repeats writes the single pass to --out and the wrap to <name>_x2.wav beside it.
  npx kleos render "$score" --out "$out/$id.wav" --repeats 2 --stems-dir "$out/$id-stems" > "$out/$id.render.json"
  mv "$out/${id}_x2.wav" "$out/$id-x2.wav"
  npx kleos check "$out/$id.wav" --project "$score" --png "$out/$id-gate" > "$out/$id.gate.json"
  npx kleos check "$out/$id-x2.wav" --project "$score" --png "$out/$id-x2-gate" > "$out/$id-x2.gate.json"
  npx kleos export-midi "$score" --out "$out/$id.mid" > /dev/null

  # The last half second, the whole loop, then the first half second again.
  ffmpeg -y -loglevel error -i "$out/$id-x2.wav" -filter_complex \
    "[0]atrim=start=$((loop_s - 1)).5:end=$((2 * loop_s)),asetpts=N/SR/TB[a];[0]atrim=start=0:end=$pad_s,asetpts=N/SR/TB[b];[a][b]concat=n=2:v=0:a=1" \
    -c:a pcm_s24le "$work/padded.wav"
  npx kleos edit export --in "$work/padded.wav" --out "$game/$id.ogg" --codec opus --bitrate 96k > /dev/null

  # Prove the round trip: the decoded loop region must still gate as a clean loop under -1 dBTP.
  ffmpeg -y -loglevel error -i "$game/$id.ogg" -ar 48000 -c:a pcm_s24le "$work/decoded.wav"
  ffmpeg -y -loglevel error -ss "$pad_s" -t "$loop_s" -i "$work/decoded.wav" -c:a pcm_s24le "$out/$id.opus-loop.wav"
  npx kleos check "$out/$id.opus-loop.wav" --project "$score" > "$out/$id.opus-loop.gate.json"
  echo "$id: baked $(stat -c %s "$game/$id.ogg") bytes"
done
