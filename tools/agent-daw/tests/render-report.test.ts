import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gateAudio } from '../src/gate.js';
import { renderProject, renderTrack } from '../src/render.js';
import { SR, mono, project, tmpDir, track } from './helpers.js';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');
const chords = [0, 2, 4, 6].flatMap((b) => [50, 57, 62, 66].map((midi) => ({ midi, startBeat: b, durationBeats: 2, velocity: 96 })));

function mix(quietDb: number): Record<string, unknown>[] {
  return [track('horns', 'brass-horn', chords), track('violins', 'strings-ensemble', chords, { gainDb: quietDb })];
}

test('the render report gives each track LUFS and RMS, and flags one buried 16 LU under the loudest', () => {
  const even = renderProject(project({ tracks: mix(0) }));
  for (const t of even.tracks) {
    assert.ok(t.lufs !== null && t.lufs < 0 && t.lufs > -40, `${t.id} lufs ${String(t.lufs)}`);
    assert.ok(t.rmsDbfs !== null && t.rmsDbfs < 0, `${t.id} rms ${String(t.rmsDbfs)}`);
  }
  assert.deepEqual(even.warnings, []);
  const buried = renderProject(project({ tracks: mix(-30) }));
  const [horns, violins] = buried.tracks;
  assert.ok(horns !== undefined && violins !== undefined && horns.lufs !== null && violins.lufs !== null);
  assert.ok(horns.lufs - violins.lufs > 16);
  assert.equal(buried.warnings.length, 1);
  assert.match(buried.warnings[0] ?? '', /^trackBalance: violins sits [\d.]+ LU below horns/);
});

test('render --solo and --tracks render only the named tracks, muted ones included', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'p.json');
  fs.writeFileSync(file, JSON.stringify({ format: 'agent-daw/v1', id: 'solo', kind: 'loop', tempo: { bpm: 120, beatsPerBar: 4 }, key: { tonic: 'D', mode: 'minor' }, bars: 2, tracks: [...mix(0), track('piano', 'piano', chords, { mute: true })] }));
  const render = (...args: string[]): { status: number | null; data: { tracks: { id: string }[]; out: string; repeatedOut: string | null } } => {
    const r = spawnSync(process.execPath, [cli, 'render', file, '--out', path.join(dir, 'o.wav'), ...args], { encoding: 'utf8' });
    return { status: r.status, data: r.status === 0 ? JSON.parse(r.stdout) : { tracks: [], out: '', repeatedOut: null } };
  };
  assert.deepEqual(render().data.tracks.map((t) => t.id), ['horns', 'violins']);
  assert.deepEqual(render('--solo', 'violins').data.tracks.map((t) => t.id), ['violins']);
  assert.deepEqual(render('--tracks', 'piano,horns').data.tracks.map((t) => t.id), ['horns', 'piano']);
  assert.equal(render('--solo', 'tuba').status, 2);
  const looped = render('--repeats', '2').data;
  assert.equal(looped.out, path.join(dir, 'o.wav'));
  assert.equal(looped.repeatedOut, path.join(dir, 'o_x2.wav'));
  assert.ok(fs.existsSync(looped.repeatedOut));
});

test('section brightness: 0 is the existing voicing sample for sample, and raising it lifts the 85% rolloff', () => {
  for (const type of ['brass-horn', 'strings-ensemble']) {
    const at = (params: Record<string, unknown>): Float64Array => {
      const p = project({ tracks: [track('t', { type, params }, chords)] });
      const t = p.tracks[0];
      assert.ok(t !== undefined);
      return mono(renderTrack(p, t).audio);
    };
    const plain = at({});
    assert.deepEqual(at({ brightness: 0 }), plain);
    const rolloff = (x: Float64Array): number => gateAudio({ sampleRate: SR, channels: [x, x] }, { category: 'music' }).rolloff85Hz;
    const bright = at({ brightness: 1 });
    assert.ok(rolloff(bright) > rolloff(plain) * 1.25, `${type} rolloff ${rolloff(plain)} -> ${rolloff(bright)}`);
  }
});
