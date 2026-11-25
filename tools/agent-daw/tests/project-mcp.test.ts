import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importNotes } from '../src/ops.js';
import { addNotes, addTrack, expandTrackNotes, initProject, parseProject } from '../src/project.js';
import { tmpDir } from './helpers.js';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');

test('parse errors name the JSON path', () => {
  const r = parseProject({ format: 'agent-daw/v1', id: 'x', bars: 2, tracks: [{ id: 't', instrument: 'kazoo', clips: [{ id: 'c', notes: [{ midi: 200, startBeat: 0, durationBeats: 1 }] }] }] });
  assert.equal(r.ok, false);
  const paths = r.ok ? [] : r.errors.map((e) => e.path);
  assert.ok(paths.includes('$.tracks[0].instrument.type'));
  assert.ok(paths.includes('$.tracks[0].clips[0].notes[0].midi'));
});

test('a tempo with a fractional loop length warns; 120 BPM does not', () => {
  const at = (bpm: number): number => {
    const r = initProject({ id: 'x', bpm, bars: 16 });
    assert.ok(r.ok);
    return r.warnings.length;
  };
  assert.equal(at(120), 0);
  assert.equal(at(110), 1);
});

test('patterns expand with repeat and transpose; mutations re-validate', () => {
  const r = parseProject({ format: 'agent-daw/v1', id: 'x', bars: 4, patterns: { riff: { lengthBeats: 2, notes: [{ midi: 50, startBeat: 0, durationBeats: 1 }, { midi: 53, startBeat: 1, durationBeats: 1 }] } }, tracks: [{ id: 'g', instrument: 'guitar-electric', clips: [{ id: 'c', startBeat: 4, pattern: 'riff', repeat: 3, transpose: 2 }] }] });
  assert.ok(r.ok);
  if (!r.ok) return;
  const t = r.value.tracks[0];
  assert.ok(t !== undefined);
  assert.deepEqual(expandTrackNotes(r.value, t).map((n) => [n.midi, n.startBeat]), [[52, 4], [55, 5], [52, 6], [55, 7], [52, 8], [55, 9]]);
  const bad = addNotes(r.value, 'g', 'c', [{ midi: 60, startBeat: 0, durationBeats: 0 }]);
  assert.equal(bad.ok, false);
  const dup = addTrack(r.value, { id: 'g', instrument: 'piano' });
  assert.equal(dup.ok, false);
});

test('notes/v1 scores import with pitch as an alias for midi', () => {
  const r = importNotes({ format: 'notes/v1', bpm: 120, key: { tonic: 'D', mode: 'dorian' }, parts: [{ id: 'lead', instrument: 'brass-horn', notes: [{ pitch: 62, start: 0, dur: 1, vel: 100 }, { pitch: 69, start: 1, dur: 3 }] }] });
  assert.ok(r.ok, JSON.stringify(!r.ok ? r.errors : []));
  if (!r.ok) return;
  assert.equal(r.value.bars, 1);
  assert.equal(r.value.tracks[0]?.clips[0]?.notes[1]?.midi, 69);
});

class McpClient {
  private readonly proc = spawn(process.execPath, [cli, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  private readonly pending = new Map<number, (v: Record<string, unknown>) => void>();
  readonly unsolicited: unknown[] = [];
  private next = 1;
  constructor() {
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      const msg = JSON.parse(line) as { id?: number } & Record<string, unknown>;
      const resolve = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (resolve === undefined) this.unsolicited.push(msg);
      else {
        this.pending.delete(msg.id as number);
        resolve(msg);
      }
    });
  }
  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    });
  }
  notify(method: string): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }
  async call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: unknown }> {
    const msg = await this.request('tools/call', { name, arguments: args });
    const result = msg.result as { isError: boolean; content: { text: string }[] };
    const text = result.content[0]?.text ?? '';
    return { isError: result.isError, data: result.isError ? text : (JSON.parse(text) as unknown) };
  }
  kill(): void {
    if (this.proc.exitCode === null) this.proc.kill();
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.proc.on('exit', () => resolve());
      this.proc.stdin.end();
    });
  }
}

test('MCP stdio server: handshake, the 15 tools, and a compose-render-gate-export round trip', async () => {
  const dir = tmpDir();
  const proj = path.join(dir, 'cue.json');
  const c = new McpClient();
  try {
    await roundTrip(c, dir, proj);
  } finally {
    c.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function roundTrip(c: McpClient, dir: string, proj: string): Promise<void> {
  const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, 'agent-daw');
  c.notify('notifications/initialized');
  const list = await c.request('tools/list');
  const names = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['add_automation', 'add_clip', 'add_fx', 'add_notes', 'add_track', 'analyse', 'edit', 'export_midi', 'gate', 'project_dump', 'project_init', 'project_validate', 'remove_track', 'render', 'set_instrument'].sort());

  assert.equal((await c.call('project_init', { project: proj, id: 'cue', bars: 2, bpm: 120, tonic: 'D', mode: 'minor' })).isError, false);
  assert.equal((await c.call('add_track', { project: proj, track: { id: 'horn', instrument: 'brass-horn', role: 'lead' } })).isError, false);
  assert.equal((await c.call('add_track', { project: proj, track: { id: 'bass', instrument: 'strings-bass' } })).isError, false);
  await c.call('add_clip', { project: proj, trackId: 'horn', clip: { id: 'a', startBeat: 0 } });
  await c.call('add_clip', { project: proj, trackId: 'bass', clip: { id: 'a', startBeat: 0 } });
  await c.call('add_notes', { project: proj, trackId: 'horn', clipId: 'a', notes: [{ midi: 62, startBeat: 0, durationBeats: 1, velocity: 100, articulation: 'accent' }, { midi: 69, startBeat: 1, durationBeats: 3, velocity: 105 }, { midi: 67, startBeat: 4, durationBeats: 2, velocity: 96 }, { midi: 65, startBeat: 6, durationBeats: 2, velocity: 90 }] });
  await c.call('add_notes', { project: proj, trackId: 'bass', clipId: 'a', notes: [{ midi: 38, startBeat: 0, durationBeats: 4, velocity: 100 }, { midi: 45, startBeat: 4, durationBeats: 4, velocity: 100 }] });
  await c.call('set_instrument', { project: proj, trackId: 'horn', instrument: { type: 'brass-horn', params: { players: 4 } } });
  await c.call('add_fx', { project: proj, trackId: 'horn', fx: { type: 'reverb', preset: 'hall', mix: 0.3 } });
  await c.call('add_automation', { project: proj, trackId: 'horn', automation: { param: 'volume', points: [{ beat: 0, value: 0 }, { beat: 4, value: -3 }, { beat: 8, value: 0 }] } });
  assert.equal((await c.call('project_validate', { project: proj })).isError, false);
  const badFx = await c.call('add_fx', { project: proj, trackId: 'horn', fx: { type: 'flanger' } });
  assert.equal(badFx.isError, true);

  const dumped = (await c.call('project_dump', { project: proj })).data as { tracks: { notes: number }[] };
  assert.deepEqual(dumped.tracks.map((t) => t.notes), [4, 2]);

  const wav = path.join(dir, 'cue.wav');
  const rendered = await c.call('render', { project: proj, out: wav, bitDepth: 24 });
  assert.equal(rendered.isError, false);
  assert.ok(fs.existsSync(wav));
  const gate = await c.call('gate', { wav, project: proj, category: 'music' });
  assert.equal(typeof (gate.data as { ok?: unknown }).ok, 'boolean');
  const critic = (await c.call('analyse', { project: proj })).data as { score: number };
  assert.ok(critic.score > 0 && critic.score <= 1);
  const audio = (await c.call('analyse', { wav })).data as { loudness: { integratedLufs: number } };
  assert.ok(Math.abs(audio.loudness.integratedLufs + 16) < 0.5);
  await c.call('edit', { op: 'normalize', inputs: [wav], out: path.join(dir, 'n.wav'), params: { lufs: -18 } });
  assert.ok(fs.existsSync(path.join(dir, 'n.wav')));
  await c.call('export_midi', { project: proj, out: path.join(dir, 'cue.mid') });
  assert.ok(fs.readFileSync(path.join(dir, 'cue.mid')).subarray(0, 4).toString() === 'MThd');
  assert.equal((await c.call('remove_track', { project: proj, trackId: 'bass' })).isError, false);

  const unknown = await c.request('nope/method');
  assert.equal((unknown.error as { code: number }).code, -32601);
  await c.close();
  assert.deepEqual(c.unsolicited, [], 'notifications must not get responses');
}
