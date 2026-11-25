#!/usr/bin/env bash
# Renders, gates and bakes the three level scores. Run from tools/agent-daw after `npm run build`.
#   scores/bake.sh [showcase-dir] [game-audio-dir]
# Writes lossless showcases (1x, the 2x wrap, stems, MIDI, gate PNGs) to the first folder and the
# game's Opus files to the second. Each Opus file is the loop with half a second of wrapped audio
# on both sides, so the codec's start-up and tail sit outside the loop points the game plays.
set -euo pipefail

out="${1:-../../artifacts/daw-soundtracks}"
game="${2:-../../public/audio}"
daw="node dist/cli.js"
pad_s=0.5
loop_s=32
mkdir -p "$out" "$game"

for id in saturn-orbit megastructure-trench sunset-ground-support; do
  score="scores/$id.daw.json"
  $daw critique "$score" --min 0.85 > "$out/$id.critique.json"
  # --repeats writes the single pass to --out and the wrap to <name>_x2.wav beside it.
  $daw render "$score" --out "$out/$id.wav" --repeats 2 --stems-dir "$out/$id-stems" > "$out/$id.render.json"
  mv "$out/${id}_x2.wav" "$out/$id-x2.wav"
  $daw gate "$out/$id.wav" --project "$score" --png-dir "$out/$id-gate" > "$out/$id.gate.json"
  $daw gate "$out/$id-x2.wav" --project "$score" --png-dir "$out/$id-x2-gate" > "$out/$id-x2.gate.json"
  $daw export-midi "$score" --out "$out/$id.mid" > /dev/null

  work="$(mktemp -d)"
  # The last half second, the whole loop, then the first half second again.
  ffmpeg -y -loglevel error -i "$out/$id-x2.wav" -filter_complex \
    "[0]atrim=start=$((loop_s - 1)).5:end=$((2 * loop_s)),asetpts=N/SR/TB[a];[0]atrim=start=0:end=$pad_s,asetpts=N/SR/TB[b];[a][b]concat=n=2:v=0:a=1" \
    -c:a pcm_s24le "$work/padded.wav"
  ffmpeg -y -loglevel error -i "$work/padded.wav" -c:a libopus -b:a 96k -vbr on -application audio "$game/$id.ogg"

  # Prove the round trip: the decoded loop region must still gate as a clean loop under -1 dBTP.
  ffmpeg -y -loglevel error -i "$game/$id.ogg" -ar 48000 -c:a pcm_s24le "$work/decoded.wav"
  ffmpeg -y -loglevel error -ss "$pad_s" -t "$loop_s" -i "$work/decoded.wav" -c:a pcm_s24le "$out/$id.opus-loop.wav"
  $daw gate "$out/$id.opus-loop.wav" --project "$score" > "$out/$id.opus-loop.gate.json"
  rm -rf "${work:?}"
  echo "$id: baked $(stat -c %s "$game/$id.ogg") bytes"
done
