import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkAudio,
  decodeWav,
  encodeWav,
  measureTruePeak,
  renderRecipe,
  validateRecipe,
  type AudioBufferData,
  type CheckReport,
  type FindingCode,
  type LoopRecipe,
  type MusicTrackSpec,
  type OneShotRecipe,
  type VoiceSpec,
} from '../src/index.js';
import {
  columnAtTime,
  COLORS,
  MARGIN,
  pixelAt,
  renderSeamImage,
  renderSpectrogramImage,
  renderWaveformImage,
  rowAtFreq,
  spectrogramFreqAxis,
  timeTicks,
} from '../src/plot.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PKG_ROOT, 'dist', 'cli.js');
const FIXTURES = path.join(PKG_ROOT, 'tests', 'fixtures');
const SR = 48000;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audio-upgrade-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function has(report: CheckReport, code: FindingCode): boolean {
  return report.findings.some((f) => f.code === code);
}

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function render(recipe: unknown): AudioBufferData {
  return renderRecipe(validateRecipe(recipe));
}

function wavBytes(audio: AudioBufferData): Uint8Array {
  return encodeWav(audio.channels, audio.sampleRate, audio.format === 'float32' ? 'float32' : 'pcm16');
}

function writeTmp(name: string, content: string | Uint8Array): string {
  const file = path.join(TMP, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const ENV = { attackS: 0.005, decayS: 0.05, sustainLevel: 0.7, releaseS: 0.05 };

function oneShot(voice: Partial<VoiceSpec>, extra: Partial<OneShotRecipe> = {}): OneShotRecipe {
  return {
    schemaVersion: 'agent-audio/recipe/v1',
    kind: 'one-shot',
    id: 'fixture',
    channels: 1,
    encoding: 'float32',
    durationS: 0.5,
    voices: [{ id: 'v', waveform: 'sine', gainDb: -6, freqStartHz: 440, envelope: ENV, ...voice }],
    ...extra,
  };
}

function loop(tracks: readonly MusicTrackSpec[], extra: Partial<LoopRecipe> = {}): LoopRecipe {
  return {
    schemaVersion: 'agent-audio/recipe/v1',
    kind: 'loop',
    id: 'fixture-loop',
    encoding: 'float32',
    bpm: 120,
    beats: 4,
    tracks,
    ...extra,
  };
}

// A wrapped loop must equal one middle pass of the same loop played `passes` times in a row without wrapping.
function maxSteadyStateError(recipe: LoopRecipe, passes: number): number {
  const unrolled: LoopRecipe = {
    ...recipe,
    beats: recipe.beats * passes,
    loopWrap: false,
    tracks: recipe.tracks.map((t) => ({ ...t, repeat: { times: passes, strideBeats: recipe.beats } })),
  };
  const wrapped = render(recipe).channels;
  const long = render(unrolled).channels;
  const n = wrapped[0]?.length ?? 0;
  const start = (passes - 2) * n;
  let worst = 0;
  for (const [c, buf] of wrapped.entries()) {
    for (let i = 0; i < n; i += 1) {
      worst = Math.max(worst, Math.abs((buf[i] ?? 0) - (long[c]?.[start + i] ?? 0)));
    }
  }
  return worst;
}

function zeroCrossings(buf: Float64Array, from: number, to: number): number {
  let count = 0;
  for (let i = from + 1; i < to; i += 1) {
    if (((buf[i - 1] ?? 0) < 0) !== ((buf[i] ?? 0) < 0)) {
      count += 1;
    }
  }
  return count;
}

function peakIn(buf: Float64Array, from: number, to: number): number {
  let peak = 0;
  for (let i = from; i < to; i += 1) {
    peak = Math.max(peak, Math.abs(buf[i] ?? 0));
  }
  return peak;
}

describe('default renders stay byte-identical to v0.1.0', () => {
  // Hashes of the v0.1.0 renders of these fixtures; every new recipe key is optional and off by default.
  const pinned: Record<string, string> = {
    'determinism-loop.recipe.json': '807bc3878715b007e8d86d6aa0b8534ad135d54132be7719a788a8bb2b80b259',
    'determinism-one-shot.recipe.json': '852ea33fd9b503d4340f38acbf890b0a1f4f20b3cee86c46a61b5071fa9ca1f6',
  };
  for (const [file, hash] of Object.entries(pinned)) {
    it(`renders ${file} to its pinned hash`, () => {
      const recipe = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8')) as unknown;
      assert.equal(sha256(wavBytes(render(recipe))), hash);
    });
  }
});

describe('PolyBLEP saw and square with the aliasing indicator', () => {
  // 2109.375 Hz sits exactly on bin 90 of the 2048-point analysis frame at 48 kHz.
  const highNote = 2109.375;

  it('warns ALIASING_SUSPECTED on a raw high saw without failing the gate', () => {
    const report = checkAudio(render(oneShot({ waveform: 'saw', freqStartHz: highNote })), 'raw-saw.wav');
    assert.ok((report.spectral.aliasingRatio ?? 0) > 0.02, `ratio ${report.spectral.aliasingRatio}`);
    assert.equal(report.findings.find((f) => f.code === 'ALIASING_SUSPECTED')?.severity, 'warn');
    assert.equal(report.ok, true);
  });

  it('fails the same saw under --strict', () => {
    const report = checkAudio(render(oneShot({ waveform: 'saw', freqStartHz: highNote })), 'raw-saw.wav', {
      strict: true,
    });
    assert.equal(report.ok, false);
  });

  it('clears the saw with bandLimited: true, cutting the alias energy at least tenfold', () => {
    const raw = checkAudio(render(oneShot({ waveform: 'saw', freqStartHz: highNote })), 'raw.wav');
    const blep = checkAudio(render(oneShot({ waveform: 'saw', freqStartHz: highNote, bandLimited: true })), 'blep.wav');
    assert.equal(has(blep, 'ALIASING_SUSPECTED'), false);
    assert.ok((blep.spectral.aliasingRatio ?? 1) * 10 < (raw.spectral.aliasingRatio ?? 0));
  });

  it('clears a high square with bandLimited: true', () => {
    const raw = checkAudio(render(oneShot({ waveform: 'square', freqStartHz: highNote })), 'raw.wav');
    const blep = checkAudio(render(oneShot({ waveform: 'square', freqStartHz: highNote, bandLimited: true })), 'b.wav');
    assert.ok(has(raw, 'ALIASING_SUSPECTED'));
    assert.equal(has(blep, 'ALIASING_SUSPECTED'), false);
  });

  it('keeps a band-limited saw at the same level and pitch as the raw one', () => {
    const raw = render(oneShot({ waveform: 'saw', freqStartHz: 220 })).channels[0] ?? new Float64Array(0);
    const blep = render(oneShot({ waveform: 'saw', freqStartHz: 220, bandLimited: true })).channels[0] ?? raw;
    assert.equal(zeroCrossings(blep, 0, blep.length), zeroCrossings(raw, 0, raw.length));
    const rms = (b: Float64Array): number => Math.sqrt(b.reduce((a, v) => a + v * v, 0) / b.length);
    assert.ok(Math.abs(20 * Math.log10(rms(blep) / rms(raw))) < 0.1);
  });

  it('reports no aliasing ratio for noise', () => {
    const report = checkAudio(render(oneShot({ waveform: 'noise' })), 'noise.wav');
    assert.equal(report.spectral.aliasingRatio, null);
  });
});

describe('loop note pitch sweeps', () => {
  const kick = (note: Record<string, number>): Float64Array =>
    render(
      loop(
        [
          {
            id: 'kick',
            voice: { waveform: 'sine', gainDb: -3, envelope: { attackS: 0.001, decayS: 0.2, sustainLevel: 0, releaseS: 0.05 } },
            notes: [{ startBeat: 0, durationBeats: 0.5, midi: 36, velocity: 1, ...note }],
          },
        ],
        { channels: 1 },
      ),
    ).channels[0] ?? new Float64Array(0);

  it('drops two octaves to the note pitch within pitchSweepS', () => {
    const buf = kick({ pitchStartSemitones: 24, pitchSweepS: 0.04 });
    const early = zeroCrossings(buf, 0, 480);
    const late = zeroCrossings(buf, 4800, 9600);
    // 65.4 Hz gives about 13 crossings in 100 ms; the 261.6 Hz start gives about 5 in its first 10 ms.
    assert.ok(early >= 4, `early ${early}`);
    assert.ok(late >= 12 && late <= 14, `late ${late}`);
  });

  it('sweeps between absolute freqStartHz and freqEndHz', () => {
    const buf = kick({ freqStartHz: 400, freqEndHz: 100, pitchSweepS: 0.05 });
    assert.ok(zeroCrossings(buf, 0, 1200) > zeroCrossings(buf, 9600, 10800));
  });

  it('rejects a note that sets both pitchStartSemitones and freqStartHz', () => {
    assert.throws(() => kick({ pitchStartSemitones: 12, freqStartHz: 200 }), /both pitchStartSemitones and freqStartHz/);
  });
});

describe('filter envelope', () => {
  const pluck = (filterEnv?: { depthHz: number; attackS: number; decayS: number }): Float64Array =>
    render(
      oneShot({
        waveform: 'saw',
        freqStartHz: 110,
        bandLimited: true,
        filter: { type: 'lowpass', freqHz: 300, q: 0.8 },
        ...(filterEnv !== undefined ? { filterEnv } : {}),
      }),
    ).channels[0] ?? new Float64Array(0);

  it('opens the lowpass at the start and closes it after decayS', () => {
    const centroid = (buf: Float64Array, from: number, to: number): number =>
      checkAudio({ sampleRate: SR, channels: [buf.slice(from, to)], format: 'float32' }, 'x.wav').spectral.centroidHz;
    const swept = pluck({ depthHz: 6000, attackS: 0, decayS: 0.1 });
    const fixed = pluck();
    assert.ok(centroid(swept, 480, 2880) > 1.5 * centroid(swept, 9600, 14400));
    assert.ok(centroid(swept, 480, 2880) > 1.5 * centroid(fixed, 480, 2880));
    assert.ok(Math.abs(centroid(swept, 9600, 14400) - centroid(fixed, 9600, 14400)) < 20);
  });

  it('rejects filterEnv without a filter', () => {
    assert.throws(
      () => render(oneShot({ filterEnv: { depthHz: 100, attackS: 0, decayS: 0.1 } })),
      /filterEnv needs a filter/,
    );
  });
});

describe('track delay send', () => {
  const ping: MusicTrackSpec['voice'] = {
    waveform: 'sine',
    gainDb: -6,
    envelope: { attackS: 0.002, decayS: 0.02, sustainLevel: 0, releaseS: 0.01 },
  };
  const echoLoop = (delay: NonNullable<MusicTrackSpec['delay']>, beats = 4): LoopRecipe =>
    loop([{ id: 'ping', voice: ping, delay, notes: [{ startBeat: 0, durationBeats: 0.05, midi: 81, velocity: 1 }] }], {
      beats,
    });

  it('repeats the dry hit at timeS, scaled by mix and then by feedback', () => {
    const left = render(echoLoop({ timeS: 0.5, feedback: 0.5, mix: 0.6 })).channels[0] ?? new Float64Array(0);
    const dry = peakIn(left, 0, 2400);
    assert.ok(Math.abs(peakIn(left, 24000, 26400) / dry - 0.6) < 0.01);
    assert.ok(Math.abs(peakIn(left, 48000, 50400) / dry - 0.3) < 0.01);
  });

  it('alternates taps left and right with pingPong', () => {
    const [left, right] = render(echoLoop({ timeS: 0.5, feedback: 0.5, mix: 0.6, pingPong: true })).channels;
    const l = left ?? new Float64Array(0);
    const r = right ?? new Float64Array(0);
    assert.ok(peakIn(l, 24000, 26400) > 0.05 && peakIn(r, 24000, 26400) < 1e-9);
    assert.ok(peakIn(r, 48000, 50400) > 0.02 && peakIn(l, 48000, 50400) < 1e-9);
  });

  it('wraps a feedback tail longer than the loop without a seam', () => {
    const report = checkAudio(render(echoLoop({ timeS: 0.3, feedback: 0.85, mix: 0.5 }, 1)), 'echo.wav', { loop: true });
    assert.deepEqual(report.findings, []);
  });

  it('starts the wrapped loop with the echoes an endless repeat would carry in', () => {
    // 0.5 s loop, 0.3 s echoes: 24 passes leave the long render's missing pre-history below 1e-8.
    const recipe = echoLoop({ timeS: 0.3, feedback: 0.6, mix: 0.5, pingPong: true }, 1);
    assert.ok(maxSteadyStateError(recipe, 24) < 1e-6);
  });

  it('rejects feedback above 0.95', () => {
    assert.throws(() => render(echoLoop({ timeS: 0.3, feedback: 1, mix: 0.5 })), /feedback must be in \[0, 0.95\]/);
  });
});

describe('pattern repeats', () => {
  const hatVoice: MusicTrackSpec['voice'] = {
    waveform: 'noise',
    gainDb: -12,
    envelope: { attackS: 0.001, decayS: 0.02, sustainLevel: 0, releaseS: 0.01 },
  };
  const pattern = [
    { startBeat: 0, durationBeats: 0.1, midi: 60, velocity: 0.9 },
    { startBeat: 0.5, durationBeats: 0.1, midi: 60, velocity: 0.5 },
  ];

  it('renders byte-identical to the hand-unrolled notes, noise draws included', () => {
    const repeated = loop([{ id: 'hat', voice: hatVoice, notes: pattern, repeat: { times: 4, strideBeats: 1 } }]);
    const unrolled = loop([
      {
        id: 'hat',
        voice: hatVoice,
        notes: [0, 1, 2, 3].flatMap((pass) => pattern.map((n) => ({ ...n, startBeat: n.startBeat + pass }))),
      },
    ]);
    assert.equal(sha256(wavBytes(render(repeated))), sha256(wavBytes(render(unrolled))));
  });

  it('rejects a repeat that runs past the loop', () => {
    const recipe = loop([{ id: 'hat', voice: hatVoice, notes: pattern, repeat: { times: 5, strideBeats: 1 } }]);
    assert.throws(() => render(recipe), /note 0 repeats to startBeat 4, past the loop's 4 beats/);
  });
});

describe('master DC blocker and true-peak limiter', () => {
  // Half a cycle of 10 Hz: a one-sided bump that puts about 0.015 of DC on a one-second loop.
  const bump: MusicTrackSpec = {
    id: 'bump',
    voice: { waveform: 'sine', gainDb: -6, envelope: { attackS: 0.005, decayS: 0, sustainLevel: 1, releaseS: 0.01 } },
    notes: [{ startBeat: 0.2, durationBeats: 0.04, midi: 0, velocity: 1 }],
  };
  const tone: MusicTrackSpec = {
    id: 'tone',
    voice: { waveform: 'sine', gainDb: -20, envelope: { attackS: 0.01, decayS: 0, sustainLevel: 1, releaseS: 0.05 } },
    notes: [{ startBeat: 0, durationBeats: 1, midi: 69, velocity: 1 }],
  };

  it('runs dcBlock and the limiter on a wrapped loop as on an endless repeat', () => {
    assert.ok(maxSteadyStateError(loop([bump, tone], { bpm: 60, beats: 1, dcBlock: true }), 4) < 1e-6);
    assert.ok(maxSteadyStateError(loop([loud], { masterLimiterDb: -1 }), 4) < 1e-6);
  });

  it('removes DC offset with dcBlock while the loop stays seamless', () => {
    const plain = checkAudio(render(loop([bump, tone], { bpm: 60, beats: 1 })), 'dc.wav', { loop: true });
    const blocked = checkAudio(render(loop([bump, tone], { bpm: 60, beats: 1, dcBlock: true })), 'dc.wav', {
      loop: true,
    });
    assert.ok(has(plain, 'DC_OFFSET'));
    assert.deepEqual(blocked.findings, []);
  });

  // Sines, because the seam gate cannot tell a saw reset that lands on the last frame from a seam click.
  const loud: MusicTrackSpec = {
    id: 'chord',
    voice: { waveform: 'sine', gainDb: 0, envelope: { attackS: 0.002, decayS: 0.1, sustainLevel: 0.8, releaseS: 0.3 } },
    notes: [45, 52, 57, 61].map((midi, i) => ({ startBeat: i * 0.25, durationBeats: 3.9, midi, velocity: 1 })),
  };

  it('holds the PCM16 file under masterLimiterDb and keeps the loop seamless', () => {
    const unlimited = render(loop([loud], { encoding: 'pcm16' }));
    assert.ok((measureTruePeak(unlimited.channels).truePeakDbtp ?? -99) > 0);
    const limited = render(loop([loud], { encoding: 'pcm16', masterLimiterDb: -1 }));
    const decoded = decodeWav(wavBytes(limited));
    assert.ok((measureTruePeak(decoded.channels).truePeakDbtp ?? 99) <= -0.99);
    assert.deepEqual(checkAudio(decoded, 'limited.wav', { loop: true }).findings, []);
  });

  it('limits a one-shot without touching audio far below the ceiling', () => {
    const quietThenLoud: OneShotRecipe = {
      ...oneShot({ waveform: 'sine', gainDb: -30, freqStartHz: 220, durationS: 0.1 }),
      voices: [
        { id: 'quiet', waveform: 'sine', gainDb: -30, freqStartHz: 220, durationS: 0.1, envelope: ENV },
        { id: 'loud', waveform: 'saw', gainDb: 6, freqStartHz: 110, startS: 0.3, envelope: ENV },
      ],
      durationS: 0.6,
    };
    const plain = render(quietThenLoud).channels[0] ?? new Float64Array(0);
    const limited = render({ ...quietThenLoud, masterLimiterDb: -3 }).channels[0] ?? new Float64Array(0);
    assert.deepEqual(limited.subarray(0, 4800), plain.subarray(0, 4800));
    assert.ok((measureTruePeak([limited]).truePeakDbtp ?? 99) <= -2.99);
  });
});

describe('quiet tail warning', () => {
  const blip = oneShot({ durationS: 0.2, envelope: { attackS: 0.005, decayS: 0.05, sustainLevel: 0.5, releaseS: 0.02 } }, {
    durationS: 1,
  });

  it('warns QUIET_TAIL when the last 70% of a one-shot sits 24 dB below its peak', () => {
    const report = checkAudio(render(blip), 'blip.wav');
    const finding = report.findings.find((f) => f.code === 'QUIET_TAIL');
    assert.equal(finding?.severity, 'warn');
    assert.ok(report.tail.quietTailFraction > 0.7, `${report.tail.quietTailFraction}`);
    assert.equal(report.ok, true);
  });

  it('skips the warning under --loop and honours a looser limit', () => {
    assert.equal(has(checkAudio(render(blip), 'blip.wav', { loop: true }), 'QUIET_TAIL'), false);
    const loose = checkAudio(render(blip), 'blip.wav', { thresholds: { maxQuietTailFraction: 0.9 } });
    assert.equal(has(loose, 'QUIET_TAIL'), false);
  });
});

describe('check --summary and batch', () => {
  const goodRecipe = oneShot({ envelope: { attackS: 0.005, decayS: 0.05, sustainLevel: 0.7, releaseS: 0.05 } });

  it('prints a header and one row for check --summary', () => {
    const wav = writeTmp('summary/tone.wav', wavBytes(render(goodRecipe)));
    const res = runCli(['check', wav, '--summary']);
    assert.equal(res.status, 0);
    const lines = res.stdout.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? '', /^FILE\s+VERDICT\s+DUR_S\s+LUFS\s+DBTP\s+CENTROID_HZ\s+SEAM\s+FINDINGS$/);
    assert.match(lines[1] ?? '', /tone\.wav\s+PASS\s+0\.500\s+I-\d/);
  });

  it('renders recipes, checks WAVs, continues past a broken file and exits with the worst code', () => {
    const dir = path.join(TMP, 'batch-in');
    const out = path.join(TMP, 'batch-out');
    writeTmp('batch-in/good.recipe.json', JSON.stringify(goodRecipe));
    writeTmp('batch-in/good.wav', 'stale render of good.recipe.json, skipped');
    writeTmp('batch-in/broken.recipe.json', JSON.stringify({ ...goodRecipe, bogus: 1 }));
    const clipped = Float64Array.from({ length: SR / 2 }, (_, i) => Math.max(-1, Math.min(1, 3 * Math.sin(i / 10))));
    writeTmp('batch-in/clipped.wav', encodeWav([clipped], SR, 'pcm16'));

    const res = runCli(['batch', dir, '--out', out, '--summary']);
    assert.equal(res.status, 2);
    const rows = res.stdout.trim().split('\n').slice(1);
    assert.deepEqual(
      rows.map((r) => r.split(/\s+/).slice(0, 2)),
      [
        ['broken.recipe.json', 'ERROR'],
        ['clipped.wav', 'FAIL'],
        ['good.recipe.json', 'PASS'],
      ],
    );
    assert.match(rows[0] ?? '', /INVALID_RECIPE$/);
    assert.ok(fs.existsSync(path.join(out, 'good.wav')));
    const report = JSON.parse(fs.readFileSync(path.join(out, 'clipped.report.json'), 'utf8')) as CheckReport;
    assert.ok(has(report, 'FULL_SCALE_SAMPLES'));
  });

  it('exits 1 on a gate failure alone and prints JSON without --summary', () => {
    const dir = path.join(TMP, 'batch-fail');
    const clipped = Float64Array.from({ length: SR / 2 }, (_, i) => Math.max(-1, Math.min(1, 3 * Math.sin(i / 10))));
    writeTmp('batch-fail/clipped.wav', encodeWav([clipped], SR, 'pcm16'));
    const res = runCli(['batch', dir, '--out', path.join(TMP, 'batch-fail-out')]);
    assert.equal(res.status, 1);
    const parsed = JSON.parse(res.stdout) as { ok: boolean; results: { verdict: string }[] };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.results[0]?.verdict, 'FAIL');
  });

  it('gates every shipped recipe without a failure', () => {
    const res = runCli(['batch', path.join(PKG_ROOT, 'recipes'), '--out', path.join(TMP, 'shipped'), '--summary']);
    assert.equal(res.status, 0, res.stdout);
  });

  it('writes the same report for a recipe as check gives on the WAV batch wrote', () => {
    const dir = path.join(TMP, 'batch-same');
    const out = path.join(TMP, 'batch-same-out');
    writeTmp('batch-same/quiet.recipe.json', JSON.stringify({ ...goodRecipe, encoding: 'pcm16', masterGainDb: -60 }));
    assert.equal(runCli(['batch', dir, '--out', out]).status, 0);
    const wav = path.join(out, 'quiet.wav');
    const viaCheck = JSON.parse(runCli(['check', wav]).stdout) as CheckReport;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'quiet.report.json'), 'utf8')), viaCheck);
  });

  it('shows advisory findings as WARN and fails them under --strict', () => {
    const dir = path.join(TMP, 'batch-warn');
    writeTmp('batch-warn/blip.recipe.json', JSON.stringify(oneShot({ durationS: 0.1 }, { durationS: 1 })));
    const res = runCli(['batch', dir, '--out', path.join(TMP, 'batch-warn-out'), '--summary']);
    assert.equal(res.status, 0);
    assert.match(res.stdout.trim().split('\n')[1] ?? '', /^blip\.recipe\.json\s+WARN\s.*QUIET_TAIL$/);
    const strict = runCli(['batch', dir, '--out', path.join(TMP, 'batch-warn-out'), '--summary', '--strict']);
    assert.equal(strict.status, 1);
    assert.match(strict.stdout, /\sFAIL\s/);
    const wav = path.join(TMP, 'batch-warn-out', 'blip.wav');
    assert.equal(runCli(['check', wav]).status, 0);
    assert.equal(runCli(['check', wav, '--strict']).status, 1);
  });
});

describe('mix-check', () => {
  // Two in-phase tones at -3 dBTP each: fine alone, about +3 dBTP summed.
  const tone = (hz: number): Uint8Array => {
    const buf = Float64Array.from({ length: SR }, (_, i) => {
      const fade = Math.min(1, i / 480, (SR - 1 - i) / 2400);
      return 0.708 * Math.sin((2 * Math.PI * hz * i) / SR) * fade;
    });
    return encodeWav([buf, buf], SR, 'float32');
  };
  const a = writeTmp('mix/a.wav', tone(220));
  const b = writeTmp('mix/b.wav', tone(220));

  it('passes each stem alone', () => {
    assert.equal(runCli(['check', a]).status, 0);
    assert.equal(runCli(['mix-check', '--mix', `${a}:0`]).status, 0);
  });

  it('fails TRUE_PEAK_EXCEEDED and FULL_SCALE_SAMPLES when the stems sum at unity', () => {
    const manifest = writeTmp(
      'mix/hot.mix.json',
      JSON.stringify({ schemaVersion: 'agent-audio/mix/v1', stems: [{ file: 'a.wav' }, { file: 'b.wav', gainDb: 0 }] }),
    );
    const res = runCli(['mix-check', manifest]);
    assert.equal(res.status, 1);
    const report = JSON.parse(res.stdout) as { findings: { code: string }[]; loudness: { truePeakDbtp: number } };
    assert.ok(report.loudness.truePeakDbtp > 2.9, `${report.loudness.truePeakDbtp}`);
    assert.deepEqual([...new Set(report.findings.map((f) => f.code))], ['TRUE_PEAK_EXCEEDED', 'FULL_SCALE_SAMPLES']);
  });

  it('passes again with both stems 6 dB down, and writes the composite', () => {
    const mixWav = path.join(TMP, 'mix/out.wav');
    const res = runCli(['mix-check', '--mix', `${a}:-6,${b}:-6`, '--wav', mixWav]);
    assert.equal(res.status, 0, res.stdout);
    assert.ok(fs.existsSync(mixWav));
  });

  it('places an offset stem and tiles a looped one', () => {
    const report = JSON.parse(
      runCli(['mix-check', writeTmp('mix/offset.mix.json', JSON.stringify({
        schemaVersion: 'agent-audio/mix/v1',
        durationS: 3,
        stems: [{ file: 'a.wav', gainDb: -6, loop: true }, { file: 'b.wav', gainDb: -6, offsetS: 1.5 }],
      }))]).stdout,
    ) as { format: { durationS: number }; ok: boolean };
    assert.equal(report.format.durationS, 3);
    assert.equal(report.ok, true);
  });

  it('exits 2 on mismatched sample rates', () => {
    const slow = writeTmp('mix/slow.wav', encodeWav([new Float64Array(44100)], 44100, 'pcm16'));
    const res = runCli(['mix-check', '--mix', `${a}:0,${slow}:0`]);
    assert.equal(res.status, 2);
    assert.equal((JSON.parse(res.stderr) as { code: string }).code, 'MIX_SAMPLE_RATE_MISMATCH');
  });

  it('rejects a threshold that does not apply to a mix', () => {
    const res = runCli(['mix-check', '--mix', `${a}:0`, '--thresholds', '{"maxClickRatio":10}']);
    assert.equal(res.status, 2);
  });
});

describe('labelled inspection PNGs', () => {
  const sine1k = Float64Array.from({ length: SR / 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR));

  it('puts the 1 kHz tick on the row where a 1 kHz tone is brightest', () => {
    const img = renderSpectrogramImage(sine1k, SR);
    const axis = spectrogramFreqAxis(SR, 240);
    const col = MARGIN.left + 320;
    let brightest = 0;
    let brightestRow = -1;
    for (let row = 0; row < 240; row += 1) {
      const [r, g, b] = pixelAt(img, col, MARGIN.top + row);
      if (r + g + b > brightest) {
        brightest = r + g + b;
        brightestRow = row;
      }
    }
    assert.ok(Math.abs(brightestRow - rowAtFreq(axis, 1000)) <= 1, `${brightestRow} vs ${rowAtFreq(axis, 1000)}`);
    assert.deepEqual(pixelAt(img, MARGIN.left - 2, MARGIN.top + rowAtFreq(axis, 1000)), COLORS.frame);
  });

  it('ticks the waveform time axis where those times are drawn', () => {
    const img = renderWaveformImage(sine1k, SR);
    const axis = { frames: sine1k.length, sampleRate: SR, originS: 0, columns: 640 };
    const { times, unit } = timeTicks(axis);
    assert.equal(unit, 'MS');
    assert.deepEqual(times, [0, 0.1, 0.2, 0.3, 0.4, 0.5]);
    assert.equal(columnAtTime(axis, 0.3), 384);
    assert.deepEqual(pixelAt(img, MARGIN.left + 384, MARGIN.top + 180 + 2), COLORS.frame);
    assert.deepEqual(pixelAt(img, MARGIN.left + 385, MARGIN.top + 180 + 2), COLORS.background);
  });

  it('marks the wrap at the centre of the seam image', () => {
    const stitched = new Float64Array(2 * 3840);
    stitched.fill(0.3, 3840);
    const img = renderSeamImage(stitched, SR);
    const x = MARGIN.left + 240;
    assert.deepEqual(pixelAt(img, x, MARGIN.top - 3), COLORS.wrap);
    assert.deepEqual(pixelAt(img, x + 1, MARGIN.top + 40), COLORS.wave);
  });
});
