import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const formal = fileURLToPath(new URL('../formal/', import.meta.url));
const jar = join(formal, 'tla2tools.jar');
const model = 'EnergyAndLock';
const mutant = 'EnergyAndLockMutant';

async function ensureJar() {
  try {
    await access(jar);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const staging = await mkdtemp(join(formal, '.tlc-download-'));
  try {
    const url = 'https://nightly.tlapl.us/dist/tla2tools.jar';
    console.log(`Downloading TLC from ${url}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`TLC download failed with HTTP ${response.status}`);
    const temporary = join(staging, 'tla2tools.jar');
    await writeFile(temporary, new Uint8Array(await response.arrayBuffer()));
    await rename(temporary, jar);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

await ensureJar();
const work = await mkdtemp(join(tmpdir(), 'space-wars-tlc-'));

function run(module, config, coverage = false) {
  const result = spawnSync('java', [
    '-XX:+UseParallelGC', '-Xmx2g', '-cp', jar, 'tlc2.TLC',
    '-workers', '4', '-noGenerateSpecTE',
    ...(coverage ? ['-coverage', '60'] : []),
    '-config', config, module,
  ], { cwd: work, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  assert.equal(result.signal, null, output);
  return { output, status: result.status };
}

function expectViolation(module, config, invariant) {
  const { status, output } = run(module, config);
  assert.notEqual(status, 0, `TLC accepted ${invariant}\n${output}`);
  assert.ok(output.split(/\r?\n/).includes(`Error: Invariant ${invariant} is violated.`), output);
  assert.match(output, /^State 2: /m, output);
  console.log(`${module} rejected ${invariant} as expected (exit ${status}).`);
}

try {
  for (const module of [model, mutant]) {
    for (const extension of ['tla', 'cfg']) {
      const name = `${module}.${extension}`;
      await copyFile(join(formal, name), join(work, name));
    }
  }

  for (const invariant of ['NeverRecovering', 'NeverLocked', 'NeverFiredLastMissile', 'NeverAtDriftLimit']) {
    const config = `${invariant}.cfg`;
    await writeFile(join(work, config), `INIT Init\nNEXT Next\nINVARIANT ${invariant}\n`);
    expectViolation(model, config, invariant);
  }
  expectViolation(mutant, `${mutant}.cfg`, 'LockHasLiveTarget');

  const { status, output } = run(model, `${model}.cfg`, true);
  assert.equal(status, 0, output);
  assert.match(output, /^Model checking completed\. No error has been found\.$/m, output);
  assert.match(output, /Finished checking temporal properties/, output);
  const totals = output.match(/^(\d+) states generated, (\d+) distinct states found, (\d+) states left on queue\.$/m);
  assert.ok(totals && Number(totals[2]) > 0 && Number(totals[3]) === 0, output);
  assert.doesNotMatch(output, /^<[^\n]+>: 0:0$/m, 'TLC reported an unreachable action');
  const actions = [...output.matchAll(/^<(\w+) [^>\n]+>: (\d+):(\d+)$/gm)];
  assert.ok(actions.length > 0, 'TLC emitted no action coverage');
  for (const [, action, , generated] of actions) {
    assert.ok(Number(generated) > 0, `TLC never exercised ${action}`);
  }
  for (const action of ['Init', 'Fly', 'Recover', 'CombatDraw', 'CombatFrame']) {
    assert.ok(actions.some((row) => row[1] === action), `Missing coverage for ${action}`);
  }
  console.log(output.split('\n')[0]);
  console.log(totals[0]);
  console.log(`TLC checked recovery liveness and exercised ${actions.length} actions including Init.`);
} finally {
  await rm(work, { recursive: true, force: true });
}
