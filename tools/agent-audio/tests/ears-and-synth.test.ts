import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import {
  checkAudio,
  decodeWav,
  encodeWav,
  renderRecipe,
  validateRecipe,
  type LoopRecipe,
  type OneShotRecipe,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RECIPES_DIR = path.join(REPO_ROOT, 'recipes');

describe('listening gate planted defects and loop-seam contracts', () => {
  it('catches DC offset, impulse clicks, cut tails, full-scale clipping, and stereo imbalance', () => {
    const sr = 48000;
    const n = sr / 2;
    const clean = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const env = i < 480 ? i / 480 : i > n - 2400 ? (n - i) / 2400 : 1;
      clean[i] = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.3 * env;
    }
    const cleanReport = checkAudio({ sampleRate: sr, channels: [clean, clean], format: 'pcm16' }, 'clean.wav');
    assert.equal(cleanReport.ok, true);

    const dcBuf = Float64Array.from(clean, (v) => v + 0.04);
    const dcReport = checkAudio({ sampleRate: sr, channels: [dcBuf], format: 'pcm16' }, 'dc.wav');
    assert.ok(dcReport.findings.some((f) => f.code === 'DC_OFFSET'));

    const clickBuf = Float64Array.from(clean);
    clickBuf[12000] = 0.85;
    const clickReport = checkAudio({ sampleRate: sr, channels: [clickBuf], format: 'pcm16' }, 'click.wav');
    assert.ok(clickReport.findings.some((f) => f.code === 'IMPULSE_CLICK'));

    const cutBuf = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      cutBuf[i] = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.35;
    }
    const cutReport = checkAudio({ sampleRate: sr, channels: [cutBuf], format: 'pcm16' }, 'cut.wav');
    assert.ok(cutReport.findings.some((f) => f.code === 'CUT_TAIL'));

    const clipBuf = Float64Array.from(clean, (v) => Math.max(-1, Math.min(1, v * 5)));
    const clipReport = checkAudio({ sampleRate: sr, channels: [clipBuf], format: 'pcm16' }, 'clip.wav');
    assert.ok(clipReport.findings.some((f) => f.code === 'FULL_SCALE_SAMPLES'));

    const silentRight = new Float64Array(n);
    const stereoReport = checkAudio(
      { sampleRate: sr, channels: [clean, silentRight], format: 'pcm16' },
      'imbalance.wav',
    );
    assert.ok(stereoReport.findings.some((f) => f.code === 'STEREO_IMBALANCE'));
  });

  it('accepts an exact periodic 4 kHz sine at 48 kHz and catches opposing +-0.5 stereo clicks', () => {
    const sr = 48000;
    // 4 kHz at 48 kHz = exact period of 12 samples -> 48000 samples is 4000 exact cycles.
    const periodic = new Float64Array(sr);
    for (let i = 0; i < sr; i += 1) {
      periodic[i] = Math.sin((2 * Math.PI * 4000 * i) / sr) * 0.5;
    }
    const periodicReport = checkAudio(
      { sampleRate: sr, channels: [periodic, periodic], format: 'float32' },
      'periodic4k.wav',
      { loop: true, thresholds: { maxLoopDiscontinuityRatio: 6.0 } },
    );
    assert.equal(periodicReport.ok, true);
    assert.ok((periodicReport.channels[0]?.loopSeam?.discontinuityRatio ?? 99) < 1.5);

    // Opposing +-0.5 step in L and R cancels in mono, so per-channel seam checking must catch both.
    const left = new Float64Array(sr);
    const right = new Float64Array(sr);
    for (let i = 0; i < sr; i += 1) {
      const ramp = (i / (sr - 1)) * 0.5;
      left[i] = ramp;
      right[i] = -ramp;
    }
    const opposingReport = checkAudio(
      { sampleRate: sr, channels: [left, right], format: 'float32' },
      'opposing.wav',
      { loop: true },
    );
    assert.equal(opposingReport.ok, false);
    assert.ok(opposingReport.findings.some((f) => f.code === 'LOOP_SEAM_DISCONTINUITY' && f.channel === 0));
    assert.ok(opposingReport.findings.some((f) => f.code === 'LOOP_SEAM_DISCONTINUITY' && f.channel === 1));

    // Astra regression: short 20 ms ramp with explicit wrap limit and default loop discontinuity must both fail.
    const shortRamp = new Float64Array(Math.round(sr * 0.02));
    for (let i = 0; i < shortRamp.length; i += 1) {
      shortRamp[i] = -0.2 + (0.4 * i) / (shortRamp.length - 1);
    }
    const shortLoopReport = checkAudio(
      { sampleRate: sr, channels: [shortRamp], format: 'float32' },
      'short-ramp.wav',
      { loop: true, thresholds: { maxLoopWrapDelta: 0.05 } },
    );
    assert.equal(shortLoopReport.ok, false);
    assert.ok(shortLoopReport.findings.some((f) => f.code === 'LOOP_WRAP_DELTA'));

    // Astra regression: isolated impulses in silence caught; clean 4 ms attack decay + 5 ms fade-out NOT false-flagged.
    const sparseL = new Float64Array(sr / 2);
    const sparseR = new Float64Array(sr / 2);
    sparseL[200] = 0.5;
    sparseR[7200] = -0.5;
    const sparseReport = checkAudio(
      { sampleRate: sr, channels: [sparseL, sparseR], format: 'float32' },
      'sparse-clicks.wav',
    );
    assert.ok(sparseReport.findings.some((f) => f.code === 'IMPULSE_CLICK' && f.channel === 0));
    assert.ok(sparseReport.findings.some((f) => f.code === 'IMPULSE_CLICK' && f.channel === 1));

    const smoothDecay = new Float64Array(Math.round(sr * 0.4));
    for (let i = 0; i < smoothDecay.length; i += 1) {
      smoothDecay[i] = Math.sin((2 * Math.PI * 160 * i) / sr) * 0.4 * Math.exp(-i / (sr * 0.004));
    }
    const smoothReport = checkAudio(
      { sampleRate: sr, channels: [smoothDecay], format: 'float32' },
      'smooth-decay.wav',
    );
    assert.equal(smoothReport.findings.some((f) => f.code === 'IMPULSE_CLICK'), false);

    const cleanFade = new Float64Array(Math.round(sr * 0.2));
    const fadeSamples = Math.round(sr * 0.005);
    for (let i = 0; i < cleanFade.length; i += 1) {
      const rem = cleanFade.length - 1 - i;
      const fade = rem < fadeSamples ? rem / fadeSamples : 1;
      cleanFade[i] = Math.sin((2 * Math.PI * 400 * i) / sr) * 0.35 * fade;
    }
    const fadeReport = checkAudio(
      { sampleRate: sr, channels: [cleanFade], format: 'float32' },
      'clean-fade.wav',
    );
    assert.equal(fadeReport.findings.some((f) => f.code === 'CUT_TAIL'), false);

    // Astra regression: invalid recipe fields and invalid CLI flags/thresholds must exit 2.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audio-val-'));
    try {
      const baseLock = JSON.parse(
        fs.readFileSync(path.join(RECIPES_DIR, 'lock-chirp.recipe.json'), 'utf8'),
      ) as Record<string, unknown>;
      const badRecipe = {
        ...baseLock,
        voices: [{ ...(baseLock['voices'] as Record<string, unknown>[])[0], waveform: 'bogus', pan: 4 }],
      };
      const badPath = path.join(tmpDir, 'bad.recipe.json');
      fs.writeFileSync(badPath, JSON.stringify(badRecipe));
      assert.equal(main(['render', badPath, '--out', path.join(tmpDir, 'bad.wav')]), 2);

      const fadeWav = path.join(tmpDir, 'fade.wav');
      fs.writeFileSync(fadeWav, encodeWav([cleanFade], sr, 'pcm16'));
      assert.equal(main(['check', fadeWav, '--thresholdds', '{}']), 2);
      assert.equal(main(['check', fadeWav, '--thresholds', '{"maxEndEdgeRatio":"bogus"}']), 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('deterministic rendering, rounding, and defect-revision workflow', () => {
  it('rounds absolute loop length once (44.1 kHz, 128 BPM, 16 beats === 330750 frames) and is bit-repeatable', () => {
    const loopRecipe: LoopRecipe = {
      schemaVersion: 'agent-audio/recipe/v1',
      kind: 'loop',
      id: 'exact-grid',
      sampleRate: 44100,
      channels: 2,
      encoding: 'pcm16',
      seed: 99,
      bpm: 128,
      beats: 16,
      loopWrap: true,
      tracks: [
        {
          id: 'pulse',
          voice: {
            waveform: 'sine',
            gainDb: -8,
            envelope: { attackS: 0.005, decayS: 0.05, sustainLevel: 0.4, releaseS: 0.08 },
          },
          notes: [{ startBeat: 15.5, durationBeats: 0.5, midi: 60, velocity: 0.9 }],
        },
      ],
    };

    const run1 = renderRecipe(validateRecipe(loopRecipe));
    const run2 = renderRecipe(validateRecipe(loopRecipe));
    assert.equal(run1.channels[0]?.length, 330750);
    const wav1 = encodeWav(run1.channels, run1.sampleRate, 'pcm16');
    const wav2 = encodeWav(run2.channels, run2.sampleRate, 'pcm16');
    assert.deepEqual(wav1, wav2);

    // Release tail wrapped across the boundary should carry nonzero energy onto frame 0 seamlessly.
    assert.ok(Math.abs(run1.channels[0]?.[0] ?? 0) > 0.001);
  });

  it('renders and gates all three shipped recipes, and proves the leading-silence revision loop via CLI', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audio-cli-'));
    try {
      for (const file of ['cannon-shot.recipe.json', 'lock-chirp.recipe.json', 'combat-loop.recipe.json']) {
        const recipePath = path.join(RECIPES_DIR, file);
        const outWav = path.join(tmpDir, file.replace('.recipe.json', '.wav'));
        const isLoop = file.includes('loop');
        assert.equal(main(['render', recipePath, '--out', outWav]), 0);
        const pngDir = path.join(tmpDir, 'png');
        const checkArgs = ['check', outWav, '--png', pngDir];
        if (isLoop) {
          checkArgs.push('--loop');
        }
        assert.equal(main(checkArgs), 0, `${file} should pass default gate`);
        const decoded = decodeWav(fs.readFileSync(outWav));
        assert.equal(decoded.sampleRate, 48000);
      }

      // Defect-revision acceptance loop: plant 40 ms leading silence in lock-chirp, catch it, fix it, re-pass.
      const baseLock = JSON.parse(
        fs.readFileSync(path.join(RECIPES_DIR, 'lock-chirp.recipe.json'), 'utf8'),
      ) as OneShotRecipe;
      const brokenLock: OneShotRecipe = {
        ...baseLock,
        durationS: 0.16,
        voices: baseLock.voices.map((v) => ({ ...v, startS: (v.startS ?? 0) + 0.045 })),
      };
      const brokenRecipePath = path.join(tmpDir, 'lock-broken.recipe.json');
      const brokenWavPath = path.join(tmpDir, 'lock-broken.wav');
      const brokenReportPath = path.join(tmpDir, 'lock-broken.report.json');
      fs.writeFileSync(brokenRecipePath, JSON.stringify(brokenLock, null, 2));

      assert.equal(main(['render', brokenRecipePath, '--out', brokenWavPath]), 0);
      assert.equal(main(['check', brokenWavPath, '--out', brokenReportPath]), 1);
      const brokenReport = JSON.parse(fs.readFileSync(brokenReportPath, 'utf8')) as {
        findings: Array<{ code: string }>;
      };
      assert.ok(brokenReport.findings.some((f) => f.code === 'LEADING_SILENCE'));

      const fixedRecipePath = path.join(tmpDir, 'lock-fixed.recipe.json');
      const fixedWavPath = path.join(tmpDir, 'lock-fixed.wav');
      fs.writeFileSync(fixedRecipePath, JSON.stringify(baseLock, null, 2));
      assert.equal(main(['render', fixedRecipePath, '--out', fixedWavPath]), 0);
      assert.equal(main(['check', fixedWavPath]), 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
