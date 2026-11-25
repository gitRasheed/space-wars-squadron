#!/usr/bin/env node
import fs from 'node:fs';
import { serveStdio } from './mcp.js';
import { importNotes } from './ops.js';
import { saveProjectFile } from './project.js';
import { ToolError, findTool } from './tools.js';

const USAGE = `agent-daw <command> [args]

Project
  init <project.json> --id <id> [--bpm 120 --bars 16 --tonic D --mode minor --kind loop --target-lufs -16]
  validate <project.json>
  dump <project.json> [--full]
  add-track <project.json> --track '<json>'
  remove-track <project.json> --track-id <id>
  add-clip <project.json> --track-id <id> --clip '<json>'
  add-notes <project.json> --track-id <id> --clip-id <id> --notes '<json array>'
  set-instrument <project.json> --track-id <id> --instrument '<json|type>'
  add-fx <project.json> --track-id <id> --fx '<json>'
  add-automation <project.json> --track-id <id> --automation '<json>'
  import-notes <score.notes.json> <project.json>

Sound
  render <project.json> --out <file.wav> [--bit-depth 24] [--stems-dir dir] [--repeats 2] [--layers base,combat]
  critique <project.json> [--min 0.85]
  gate <file.wav> [--project p.json] [--category music|sfx|ui|ambience] [--png-dir dir] [--loop] [--bpm 120]
  analyse <file.wav | project.json>
  edit <op> --in <a.wav> [--in <b.wav>] --out <file> [--backend native|sox|rubberband|ffmpeg] [--<param> value ...]
       ops: trim-silence, fade, normalize, pitch, stretch, layer, export
  export-midi <project.json> --out <file.mid>

  mcp     stdio MCP server exposing the same 15 tools

Exit codes: 0 pass, 1 failed check (invalid project, gate findings, critic below --min), 2 usage or runtime error.`;

interface Parsed {
  readonly positional: string[];
  readonly flags: Map<string, string[]>;
}

function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next === undefined || next.startsWith('--') ? 'true' : (i += 1, next);
      flags.set(key, [...(flags.get(key) ?? []), value]);
    } else positional.push(a);
  }
  return { positional, flags };
}

const camel = (k: string): string => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function jsonish(v: string): unknown {
  const t = v.trim();
  if (t === 'true' || t === 'false') return t === 'true';
  if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) return JSON.parse(t) as unknown;
  return v;
}

function flagArgs(flags: Map<string, string[]>, skip: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, vs] of flags) if (!skip.includes(k)) out[camel(k)] = jsonish(vs[vs.length - 1] ?? '');
  return out;
}

const COMMAND_TOOL: Readonly<Record<string, string>> = {
  init: 'project_init',
  validate: 'project_validate',
  dump: 'project_dump',
  'add-track': 'add_track',
  'remove-track': 'remove_track',
  'add-clip': 'add_clip',
  'add-notes': 'add_notes',
  'set-instrument': 'set_instrument',
  'add-fx': 'add_fx',
  'add-automation': 'add_automation',
  render: 'render',
  'export-midi': 'export_midi',
};

function print(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function callTool(name: string, args: Record<string, unknown>): number {
  const tool = findTool(name);
  if (tool === undefined) throw new ToolError(`no tool ${name}`);
  const r = tool.run(args);
  print(r.data);
  return r.ok ? 0 : 1;
}

function main(argv: readonly string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === 'help' || cmd === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return cmd === undefined ? 2 : 0;
  }
  if (cmd === 'mcp') {
    serveStdio();
    return -1;
  }
  const { positional, flags } = parseArgs(rest);
  const first = positional[0];
  const tool = COMMAND_TOOL[cmd];
  if (tool !== undefined) {
    if (first === undefined) throw new ToolError(`${cmd} needs a project path`);
    const args: Record<string, unknown> = { project: first, ...flagArgs(flags) };
    if (cmd === 'render' && typeof args.layers === 'string') args.layers = args.layers.split(',');
    return callTool(tool, args);
  }
  switch (cmd) {
    case 'critique': {
      if (first === undefined) throw new ToolError('critique needs a project path');
      const t = findTool('analyse');
      const r = t?.run({ project: first });
      print(r?.data);
      const min = Number(flags.get('min')?.[0] ?? 'NaN');
      const score = (r?.data as { score?: number } | undefined)?.score ?? 0;
      return Number.isFinite(min) && score < min ? 1 : 0;
    }
    case 'analyse':
      if (first === undefined) throw new ToolError('analyse needs a file');
      return callTool('analyse', first.endsWith('.wav') ? { wav: first } : { project: first });
    case 'gate':
      if (first === undefined) throw new ToolError('gate needs a WAV path');
      return callTool('gate', { wav: first, ...flagArgs(flags) });
    case 'edit': {
      const op = first;
      if (op === undefined) throw new ToolError('edit needs an op');
      const inputs = flags.get('in') ?? [];
      const out = flags.get('out')?.[0];
      if (out === undefined) throw new ToolError('edit needs --out');
      const backend = flags.get('backend')?.[0];
      const bitDepth = flags.get('bit-depth')?.[0];
      return callTool('edit', {
        op,
        inputs,
        out,
        ...(backend !== undefined ? { backend } : {}),
        ...(bitDepth !== undefined ? { bitDepth: Number(bitDepth) } : {}),
        params: flagArgs(flags, ['in', 'out', 'backend', 'bit-depth']),
      });
    }
    case 'import-notes': {
      const out = positional[1];
      if (first === undefined || out === undefined) throw new ToolError('import-notes needs <score.notes.json> <project.json>');
      const r = importNotes(JSON.parse(fs.readFileSync(first, 'utf8')) as unknown);
      if (!r.ok) {
        print({ errors: r.errors });
        return 1;
      }
      saveProjectFile(out, r.value);
      print({ project: out, warnings: r.warnings });
      return 0;
    }
    default:
      throw new ToolError(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

try {
  const code = main(process.argv.slice(2));
  if (code >= 0) process.exitCode = code;
} catch (err) {
  process.stderr.write(`agent-daw: ${(err as Error).message}\n`);
  process.exitCode = 2;
}
