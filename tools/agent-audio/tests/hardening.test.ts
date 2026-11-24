import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkAudio,
  decodeWav,
  encodeWav,
  FINDING_CODES,
  renderRecipe,
  THRESHOLD_KEYS,
  validateRecipe,
  type AudioBufferData,
  type CheckReport,
  type FindingCode,
  type WaveformType,
} from '../src/index.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PKG_ROOT, 'dist', 'cli.js');
const RECIPES_DIR = path.join(PKG_ROOT, 'recipes');
const SR = 48000;

function mono(buf: Float64Array): AudioBufferData {
  return { sampleRate: SR, channels: [buf], format: 'float32' };
}

function stereo(left: Float64Array, right: Float64Array): AudioBufferData {
  return { sampleRate: SR, channels: [left, right], format: 'float32' };
}

function has(report: CheckReport, code: FindingCode): boolean {
  return report.findings.some((f) => f.code === code);
}

// Sine with a 10 ms fade-in and, unless hardCut, a 50 ms fade-out.
function tone(freqHz: number, durationS: number, amp: number, hardCut = false): Float64Array {
  const n = Math.round(durationS * SR);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const fadeOut = hardCut ? 1 : Math.min(1, (n - 1 - i) / 2400);
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / SR) * amp * Math.min(1, i / 480) * fadeOut;
  }
  return out;
}

function renderRawWave(
  waveform: WaveformType,
  freqHz: number,
  gainDb: number,
  onset: { readonly startS: number; readonly attackS: number } = { startS: 0, attackS: 0.005 },
): AudioBufferData {
  return renderRecipe(
    validateRecipe({
      schemaVersion: 'agent-audio/recipe/v1',
      kind: 'one-shot',
      id: 'raw-wave',
      channels: 1,
      encoding: 'float32',
      durationS: 0.5,
      voices: [
        {
          id: 'raw',
          waveform,
          gainDb,
          freqStartHz: freqHz,
          startS: onset.startS,
          envelope: { attackS: onset.attackS, decayS: 0.05, sustainLevel: 0.7, releaseS: 0.05 },
        },
      ],
    }),
  );
}

function loadRecipe(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, file), 'utf8')) as Record<string, unknown>;
}

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('click and cut-tail gates are relative to signal level', () => {
  for (const waveform of ['saw', 'square'] as const) {
    for (const freqHz of [55, 220, 880]) {
      it(`raw ${waveform} at ${freqHz} Hz gets the same click and tail verdict from 0 to -40 dB`, () => {
        const loud = checkAudio(renderRawWave(waveform, freqHz, 0), 'loud.wav');
        const loudRatio = loud.channels[0]?.clickRatio ?? Number.NaN;
        assert.equal(has(loud, 'IMPULSE_CLICK'), false);
        assert.equal(has(loud, 'CUT_TAIL'), false);
        for (const gainDb of [-6, -20, -40]) {
          const quiet = checkAudio(renderRawWave(waveform, freqHz, gainDb), 'quiet.wav');
          assert.equal(has(quiet, 'IMPULSE_CLICK'), false, `${gainDb} dB`);
          assert.equal(has(quiet, 'CUT_TAIL'), false, `${gainDb} dB`);
          const ratio = quiet.channels[0]?.clickRatio ?? Number.NaN;
          assert.ok(Math.abs(ratio - loudRatio) <= 0.01 * Math.max(1, loudRatio), `${gainDb} dB: ${ratio} vs ${loudRatio}`);
        }
      });
    }
  }

  it('passes a raw saw at 31 Hz, whose resets are 32 ms apart', () => {
    const report = checkAudio(renderRawWave('saw', 31, -6), 'low-saw.wav');
    assert.equal(has(report, 'IMPULSE_CLICK'), false);
  });

  it('fails a triangle that starts mid-file at full level with no attack, at -6 and -30 dB alike', () => {
    const hardStart = { startS: 0.1, attackS: 0 };
    const loud = checkAudio(renderRawWave('triangle', 220, -6, hardStart), 'loud.wav');
    const quiet = checkAudio(renderRawWave('triangle', 220, -30, hardStart), 'quiet.wav');
    assert.equal(loud.findings.find((f) => f.code === 'IMPULSE_CLICK')?.frame, 4800);
    assert.equal(quiet.findings.find((f) => f.code === 'IMPULSE_CLICK')?.frame, 4800);
  });

  it('fails CUT_TAIL on a -30 dBFS hard cut', () => {
    const report = checkAudio(mono(tone(440, 0.5, 0.0316, true)), 'quiet-cut.wav');
    assert.ok(has(report, 'CUT_TAIL'));
  });

  it('fails both gates on a -30 dBFS hard cut carrying a 4x click, without the click hiding the tail', () => {
    const buf = tone(440, 0.5, 0.0316, true);
    buf[12000] = 0.1264;
    const report = checkAudio(mono(buf), 'quiet-cut-click.wav');
    assert.ok(has(report, 'CUT_TAIL'));
    assert.ok(has(report, 'IMPULSE_CLICK'));
    assert.ok(Math.abs((report.referenceLevelDbfs ?? 0) - -30) < 1, `reference ${report.referenceLevelDbfs}`);
  });

  it('fails IMPULSE_CLICK on a 5 ms dropout in a -30 dBFS tone', () => {
    const buf = tone(1000, 0.5, 0.0316);
    buf.fill(0, 12012, 12252);
    const report = checkAudio(mono(buf), 'quiet-dropout.wav');
    assert.ok(has(report, 'IMPULSE_CLICK'));
  });

  it('fails IMPULSE_CLICK on a click three times larger than the resets of a raw saw', () => {
    const audio = renderRawWave('saw', 220, -20);
    const buf = audio.channels[0] ?? new Float64Array(0);
    buf[12100] = (buf[12100] ?? 0) + 0.21;
    const report = checkAudio(audio, 'saw-click.wav');
    const click = report.findings.find((f) => f.code === 'IMPULSE_CLICK');
    assert.equal(click?.frame, 12100);
  });

  it('fails IMPULSE_CLICK on two clicks 20 ms apart', () => {
    const buf = tone(440, 0.5, 0.3);
    buf[12000] = (buf[12000] ?? 0) + 0.3;
    buf[12960] = (buf[12960] ?? 0) + 0.3;
    assert.ok(has(checkAudio(mono(buf), 'two-clicks.wav'), 'IMPULSE_CLICK'));
  });

  it('fails IMPULSE_CLICK on three unevenly spaced clicks inside 40 ms', () => {
    const buf = tone(440, 0.5, 0.3);
    for (const frame of [12000, 12300, 13700]) {
      buf[frame] = (buf[frame] ?? 0) + 0.3;
    }
    assert.ok(has(checkAudio(mono(buf), 'three-clicks.wav'), 'IMPULSE_CLICK'));
  });

  it('scores one click the same at 0, -20 and -40 dB', () => {
    const buf = tone(440, 0.5, 0.5);
    buf[12000] = (buf[12000] ?? 0) + 0.4;
    const ratioAt = (gain: number): number =>
      checkAudio(mono(Float64Array.from(buf, (v) => v * gain)), 'scaled.wav').channels[0]?.clickRatio ?? Number.NaN;
    const loud = ratioAt(1);
    assert.ok(loud > 25, `ratio ${loud}`);
    assert.ok(Math.abs(ratioAt(0.1) - loud) < 0.01 * loud);
    assert.ok(Math.abs(ratioAt(0.01) - loud) < 0.01 * loud);
  });

  it('passes a 1 ms-attack tone burst', () => {
    const n = SR / 4;
    const buf = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      buf[i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.5 * Math.min(1, i / 48) * Math.exp(-i / 2400);
    }
    const report = checkAudio(mono(buf), 'burst.wav');
    assert.equal(has(report, 'IMPULSE_CLICK'), false);
    assert.equal(has(report, 'CUT_TAIL'), false);
  });

  it('keeps cannon-shot at under half the click limit and a silent tail', () => {
    const report = checkAudio(renderRecipe(validateRecipe(loadRecipe('cannon-shot.recipe.json'))), 'cannon.wav');
    assert.equal(report.ok, true);
    for (const ch of report.channels) {
      assert.ok(ch.clickRatio < 12.5, `clickRatio ${ch.clickRatio}`);
      assert.ok(ch.endEdgePeak < 0.01, `endEdgePeak ${ch.endEdgePeak}`);
    }
  });

  for (const amp of [1e-3, 1e-4]) {
    it(`does not read PCM16 quantisation of a clean ${amp} peak tone as a click or cut tail`, () => {
      const decoded = decodeWav(encodeWav([tone(220, 0.5, amp)], SR, 'pcm16'));
      const report = checkAudio(decoded, 'quiet-pcm16.wav');
      assert.equal(has(report, 'IMPULSE_CLICK'), false);
      assert.equal(has(report, 'CUT_TAIL'), false);
    });
  }
});

describe('loop seam reference ignores silence', () => {
  function loopRecipe(loopWrap: boolean, midi: number, startBeat: number, durationBeats: number): AudioBufferData {
    return renderRecipe(
      validateRecipe({
        schemaVersion: 'agent-audio/recipe/v1',
        kind: 'loop',
        id: 'seam',
        encoding: 'float32',
        bpm: 120,
        beats: 8,
        loopWrap,
        tracks: [
          {
            id: 'voice',
            voice: {
              waveform: 'sine',
              gainDb: -6,
              envelope: { attackS: 0.003, decayS: 0.03, sustainLevel: 0.4, releaseS: 0.04 },
            },
            notes: [{ startBeat, durationBeats, midi, velocity: 1 }],
          },
        ],
      }),
    );
  }

  it('passes a 4 s loop holding one 80 ms ping at beat 0', () => {
    const report = checkAudio(loopRecipe(true, 84, 0, 0.08), 'sparse.wav', { loop: true });
    assert.equal(report.ok, true);
    for (const ch of report.channels) {
      assert.ok((ch.loopSeam?.discontinuityRatio ?? 99) < 3, `ratio ${ch.loopSeam?.discontinuityRatio}`);
    }
  });

  it('passes a bass note that wraps across the boundary and fails the same note cut at it', () => {
    const wrapped = checkAudio(loopRecipe(true, 46, 7, 2), 'wrapped.wav', { loop: true });
    assert.equal(has(wrapped, 'LOOP_SEAM_DISCONTINUITY'), false);

    const cut = checkAudio(loopRecipe(false, 46, 7, 2), 'cut.wav', { loop: true });
    assert.ok(cut.findings.some((f) => f.code === 'LOOP_SEAM_DISCONTINUITY' && f.channel === 0));
    assert.ok(cut.findings.some((f) => f.code === 'LOOP_SEAM_DISCONTINUITY' && f.channel === 1));
  });
});

describe('recipe schema rejects unknown keys', () => {
  const oneShot = loadRecipe('lock-chirp.recipe.json');
  const loop = loadRecipe('combat-loop.recipe.json');
  const voice = (oneShot['voices'] as Record<string, unknown>[])[0] ?? {};
  const track = (loop['tracks'] as Record<string, unknown>[])[0] ?? {};
  const note = (track['notes'] as Record<string, unknown>[])[0] ?? {};

  const withVoice = (patch: Record<string, unknown>): unknown => ({ ...oneShot, voices: [{ ...voice, ...patch }] });
  const withTrack = (patch: Record<string, unknown>): unknown => ({ ...loop, tracks: [{ ...track, ...patch }] });

  const cases: readonly (readonly [key: string, where: string, recipe: unknown])[] = [
    ['freqEndHZ', 'voices[0]', withVoice({ freqEndHZ: 900 })],
    ['lfo', 'voices[0]', withVoice({ lfo: { rateHz: 5 } })],
    ['holdS', 'voices[0].envelope', withVoice({ envelope: { ...(voice['envelope'] as object), holdS: 0.1 } })],
    ['gainDb', 'voices[0].filter', withVoice({ filter: { type: 'lowpass', freqHz: 900, gainDb: 3 } })],
    ['mastergainDb', 'recipe', { ...oneShot, mastergainDb: -3 }],
    ['reverb', 'recipe', { ...oneShot, reverb: { mix: 0.3 } }],
    ['bpm', 'recipe', { ...oneShot, bpm: 120 }],
    ['durationS', 'recipe', { ...loop, durationS: 4 }],
    ['freqStartHz', 'tracks[0].voice', withTrack({ voice: { ...(track['voice'] as object), freqStartHz: 440 } })],
    ['pitch', 'tracks[0].notes[0]', withTrack({ notes: [{ ...note, pitch: 60 }] })],
    ['swing', 'tracks[0]', withTrack({ swing: 0.2 })],
  ];

  for (const [key, where, recipe] of cases) {
    it(`exits 2 naming "${key}" at ${where}`, () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audio-schema-'));
      try {
        const recipePath = path.join(tmpDir, 'bad.recipe.json');
        const wavPath = path.join(tmpDir, 'bad.wav');
        fs.writeFileSync(recipePath, JSON.stringify(recipe));
        const res = runCli(['render', recipePath, '--out', wavPath]);
        assert.equal(res.status, 2);
        assert.equal(res.stdout, '');
        const err = JSON.parse(res.stderr) as { code: string; message: string };
        assert.equal(err.code, 'INVALID_RECIPE');
        assert.ok(err.message.includes(`"${key}"`), err.message);
        assert.ok(err.message.includes(where), err.message);
        assert.equal(fs.existsSync(wavPath), false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }
});

describe('CLI help', () => {
  for (const args of [['--help'], ['-h'], ['check', '-h'], ['render', '--help']]) {
    it(`prints usage to stdout and exits 0 for "${args.join(' ')}"`, () => {
      const res = runCli(args);
      assert.equal(res.status, 0);
      assert.equal(res.stderr, '');
      assert.ok(res.stdout.startsWith('Usage:'));
      for (const key of THRESHOLD_KEYS) {
        assert.ok(res.stdout.includes(key), `usage should list ${key}`);
      }
    });
  }

  it('prints usage to stderr and exits 2 with no command', () => {
    const res = runCli([]);
    assert.equal(res.status, 2);
    assert.equal(res.stdout, '');
    assert.ok(res.stderr.startsWith('Usage:'));
  });
});

describe('stereo phase', () => {
  const left = tone(440, 0.5, 0.3);
  const inverted = Float64Array.from(left, (v) => -v);

  it('fails STEREO_PHASE_INVERTED when the right channel is the inverted left', () => {
    const report = checkAudio(stereo(left, inverted), 'antiphase.wav');
    assert.equal(report.stereo?.correlation, -1);
    assert.equal(report.ok, false);
    assert.ok(has(report, 'STEREO_PHASE_INVERTED'));
  });

  it('passes unrelated left and right content', () => {
    const report = checkAudio(stereo(left, tone(554, 0.5, 0.3)), 'wide.wav');
    assert.equal(has(report, 'STEREO_PHASE_INVERTED'), false);
  });

  it('stays quiet on inverted channels below the -70 dBFS judging floor', () => {
    const faint = tone(440, 0.5, 1e-4);
    const report = checkAudio(stereo(faint, Float64Array.from(faint, (v) => -v)), 'faint.wav');
    assert.equal(has(report, 'STEREO_PHASE_INVERTED'), false);
  });

  it('honours a minStereoCorrelation override through the CLI', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audio-phase-'));
    try {
      const wavPath = path.join(tmpDir, 'antiphase.wav');
      fs.writeFileSync(wavPath, encodeWav([left, inverted], SR, 'float32'));
      assert.equal(runCli(['check', wavPath]).status, 1);
      assert.equal(runCli(['check', wavPath, '--thresholds', '{"minStereoCorrelation":-1}']).status, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('spectral metrics cover the whole file', () => {
  it('weights 4 s of 6 kHz after 2 s of 200 Hz', () => {
    const low = tone(200, 2, 0.3);
    const high = tone(6000, 4, 0.3);
    const buf = new Float64Array(low.length + high.length);
    buf.set(low, 0);
    buf.set(high, low.length);
    const { spectral } = checkAudio(mono(buf), 'two-part.wav');
    assert.ok(spectral.centroidHz > 3800 && spectral.centroidHz < 4300, `centroid ${spectral.centroidHz}`);
    assert.ok(spectral.rolloff95Hz > 5900 && spectral.rolloff95Hz < 6100, `rolloff95 ${spectral.rolloff95Hz}`);
  });

  it('measures anti-phase stereo instead of its cancelled mono sum', () => {
    const left = tone(1000, 0.5, 0.3);
    const { spectral } = checkAudio(stereo(left, Float64Array.from(left, (v) => -v)), 'antiphase.wav');
    assert.ok(Math.abs(spectral.centroidHz - 1000) < 30, `centroid ${spectral.centroidHz}`);
  });

  it('measures a file shorter than one analysis frame', () => {
    const { spectral } = checkAudio(mono(tone(1000, 2000 / SR, 0.3)), 'short.wav');
    assert.ok(Math.abs(spectral.centroidHz - 1000) < 60, `centroid ${spectral.centroidHz}`);
  });
});

describe('SKILL.md', () => {
  const skill = fs.readFileSync(path.join(PKG_ROOT, 'SKILL.md'), 'utf8');

  it('documents every threshold key', () => {
    assert.deepEqual(THRESHOLD_KEYS.filter((key) => !skill.includes(key)), []);
  });

  it('documents every finding code', () => {
    assert.deepEqual(FINDING_CODES.filter((code) => !skill.includes(code)), []);
  });

  for (const [index, block] of [...skill.matchAll(/```json\n([\s\S]*?)```/g)].entries()) {
    it(`recipe example ${index + 1} renders and passes its gate`, () => {
      const recipe = validateRecipe(JSON.parse(block[1] ?? ''));
      const report = checkAudio(renderRecipe(recipe), `${recipe.id}.wav`, { loop: recipe.kind === 'loop' });
      assert.deepEqual(report.findings, []);
    });
  }
});
