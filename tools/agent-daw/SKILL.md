---
name: agent-daw
description: Compose, render, critique and gate orchestral or hybrid game music and cinematic SFX headlessly from a JSON project. Use when a cue needs brass, strings, piano, guitars, timpani, reverb and a mastered loop, or when you must prove a music file is loop-safe, on loudness and free of defects.
---

# agent-daw

Run from `tools/agent-daw` after `npm ci && npm run build`. `DAW="node dist/cli.js"`.

## Compose loop

1. **Brief.** Write down the mood, length, key, tempo and which layers the game needs (`base`, `tension`, `combat`, `climax`). The base layer must carry the hook.
2. **Project.** `$DAW init cue.json --id cue --bpm 120 --bars 16 --tonic D --mode minor`. For a loop, choose a tempo where `bars x beatsPerBar x 60 x 48000 / bpm` is an integer; 120 BPM always works, and `validate` warns otherwise.
3. **Write the score.** Either edit the JSON directly (patterns plus clips keep it short) or generate it with a script, as `examples/compose-overture.mjs` does. Give every track a `role`. Shape a phrase with velocity and articulation, not just notes.
4. **Critique.** `$DAW critique cue.json --min 0.85`. Read `advice` and fix the music. Never touch the weights. The usual fixes:
   - restate the hook (transposed) in every section;
   - end the loop on V or bVII;
   - voice low chords open (root and fifth below E3, third above);
   - keep harmony below the lead;
   - make one section clearly quieter than the climax.
5. **Render.** `$DAW render cue.json --out out/cue.wav --repeats 2 --stems-dir out/stems`. The x2 file lets you hear the wrap.
6. **Gate.** `$DAW gate out/cue.wav --project cue.json --png-dir out/gate`. Exit 0 means no findings. Open `gate_spectrogram.png` and `gate_waveform.png` and look:
   - a yellow band only below 150 Hz means a bottom-heavy mix (the `rolloff` and `dull` findings);
   - red waveform columns mean clipping;
   - a step at the right edge means a bad seam.
7. **Revise** until critic ≥ 0.85 and the gate is clean, then get a human listen. Passing both gates is not the same as sounding good.

## Mixing rules that keep the gate green

- Set levels with track `gainDb`. The master applies one constant gain to reach the LUFS target, and the limiter only shaves peaks.
- Timpani, taiko and contrabass pile up energy under 150 Hz quickly. Start them around -8 dB and the sub bass around -15 dB.
- Put a hall `reverb` (mix 0.25-0.35) on orchestral tracks, a `plate` on piano and a `room` on guitars.
- Electric guitar: `drive` 8-12, keep `double: true`, sit it about -12 dB under the orchestra, and play palm-muted staccato gallops on root plus fifth.
- Automation in a loop must end on its start value.

## Edits (the sfx_edit role)

```sh
$DAW edit trim-silence --in raw.wav --out t.wav
$DAW edit fade --in t.wav --out f.wav --in-s 0.002 --out-s 0.03
$DAW edit pitch --in f.wav --out p.wav --semitones 3 [--backend rubberband]
$DAW edit stretch --in p.wav --out s.wav --ratio 1.25
$DAW edit normalize --in s.wav --out n.wav --category sfx   # or --lufs -18, --peak-db -1
$DAW edit layer --in a.wav --in b.wav --out l.wav --gains-db '[0,-6]' --offsets-s '[0,0.05]'
$DAW gate n.wav --category sfx
```

## MCP

`node dist/cli.js mcp` exposes the same operations as 15 tools (`project_init` ... `export_midi`). `analyse` takes `project` for the critic or `wav` for raw audio metrics. Tool errors come back as `isError: true` with the JSON path of the problem.

## Reference

`README.md` documents the schema, instrument models, critic subscores and gate checks. `examples/star-wars-overture.daw.json` is a 16-bar, 13-track worked example.
