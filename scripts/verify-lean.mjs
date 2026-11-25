import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../formal/lean/', import.meta.url));
const proofDir = join(root, 'SpaceWars');
const env = { ...process.env, PATH: [join(homedir(), '.elan', 'bin'), process.env.PATH].join(delimiter) };

const ALLOWED_AXIOMS = new Set(['propext', 'Classical.choice', 'Quot.sound']);

const FORBIDDEN = [
  ['sorry', /\bsorry\b/],
  ['sorryAx', /\bsorryAx\b/],
  ['admit', /\badmit\b/],
  ['axiom', /\baxiom\b/],
  ['native_decide', /\bnative_decide\b/],
  ['implemented_by', /\bimplemented_by\b/],
  ['extern', /\bextern\b/],
  ['unsafe', /\bunsafe\b/],
  ['partial', /\bpartial\b/],
  ['opaque', /\bopaque\b/],
  ['ofReduceBool', /\bofReduceBool\b/],
  ['skipKernelTC', /\bskipKernelTC\b/],
  ['debug option', /\bset_option\s+debug\./],
  ['meta command', /^\s*(#eval|run_cmd|run_meta|run_elab|elab|macro|syntax)\b/m],
  ['import Lean', /^\s*import\s+Lean\b/m],
];

// Theorems the spec names; deleting or renaming one must fail the gate.
const REQUIRED = [
  'SpaceWars.SweptHit.closest_approach_global_min',
  'SpaceWars.SweptHit.tStar_mem',
  'SpaceWars.SweptHit.sweptHit_complete',
  'SpaceWars.SweptHit.sweptHit_sound',
  'SpaceWars.SweptHit.entered_hit_sphere_not_nearMiss',
  'SpaceWars.SweptHit.outside_hit_sphere_no_hit',
  'SpaceWars.SweptHit.hit_nearMiss_disjoint',
  'SpaceWars.SweptHit.rel_is_relative_motion',
  'SpaceWars.LeadIntercept.intercept_exact',
  'SpaceWars.LeadIntercept.linear_case_exact',
  'SpaceWars.LeadIntercept.zero_velocity_exact',
  'SpaceWars.LeadIntercept.quadratic_root_exact',
  'SpaceWars.HeatEconomy.trace_inv',
  'SpaceWars.HeatEconomy.inv_bounds',
  'SpaceWars.HeatEconomy.inv_hot_zone_disjoint',
  'SpaceWars.HeatEconomy.inv_full_heat_locks',
  'SpaceWars.HeatEconomy.inv_overheat_no_fire',
  'SpaceWars.HeatEconomy.inv_mutual_exclusion',
  'SpaceWars.HeatEconomy.overheat_terminates',
  'SpaceWars.Counterexamples.end_of_tick_incomplete',
  'SpaceWars.Counterexamples.unclamped_unsound',
  'SpaceWars.Counterexamples.static_ship_breaks_disjointness',
  'SpaceWars.Counterexamples.unclamped_breaks_inv_bounds',
];

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 << 20, ...options });
  if (result.error) throw result.error;
  return result;
}

function fail(message, output = '') {
  if (output) console.error(output);
  console.error(`verify-lean: FAIL: ${message}`);
  process.exit(1);
}

function scan(source) {
  return FORBIDDEN.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}

function selfTestScanner() {
  const seeded = ['theorem t : 1 = 2 := by sorry', 'axiom bad : False', 'example : 1 = 1 := by native_decide'];
  for (const line of seeded) {
    if (scan(line).length === 0) fail(`scanner missed seeded construct: ${line}`);
  }
}

const modules = readdirSync(proofDir)
  .filter((f) => f.endsWith('.lean'))
  .map((f) => `SpaceWars.${f.slice(0, -'.lean'.length)}`)
  .sort();
const sources = [join(root, 'SpaceWars.lean'), ...readdirSync(proofDir).map((f) => join(proofDir, f))];

console.log('== lake build');
const build = run('lake', ['build']);
if (build.status !== 0) fail(`lake build exited ${build.status}`, build.stdout + build.stderr);
if (/declaration uses 'sorry'|\berror\b/.test(build.stdout + build.stderr)) {
  fail('lake build reported sorry or an error', build.stdout + build.stderr);
}

console.log('== forbidden-construct scan');
selfTestScanner();
const sourceTheorems = [];
for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  const hits = scan(text);
  if (hits.length > 0) fail(`${file} contains ${hits.join(', ')}`);
  for (const match of text.matchAll(/^(?:private\s+)?theorem\s+(\S+)/gm)) sourceTheorems.push(match[1]);
}
console.log(`   ${sources.length} files clean`);

console.log('== #print axioms audit');
const audit = run('lake', ['env', 'lean', 'audit/Axioms.lean']);
if (audit.status !== 0) fail(`axiom audit exited ${audit.status}`, audit.stdout + audit.stderr);
const lines = audit.stdout.trim().split('\n');
const end = lines.pop()?.match(/^AUDIT-END (\d+)$/);
if (!end) fail('axiom audit output has no AUDIT-END line', audit.stdout);
const rows = lines.map((line) => {
  const m = line.match(/^AUDIT (\w+) (\S+) \[(.*)\]$/);
  if (!m) fail(`unparsed audit line: ${line}`);
  return { kind: m[1], name: m[2], axioms: m[3] ? m[3].split(', ') : [] };
});
if (rows.length !== Number(end[1]) || rows.length === 0) fail(`audit saw ${end[1]} constants, parsed ${rows.length}`);
for (const row of rows) {
  if (row.kind === 'axiom' || row.kind === 'opaque') fail(`${row.name} is declared as ${row.kind}`);
  const bad = row.axioms.filter((a) => !ALLOWED_AXIOMS.has(a));
  if (bad.length > 0) fail(`${row.name} depends on ${bad.join(', ')}`);
}
const theorems = rows.filter((r) => r.kind === 'theorem');
const promoted = theorems.filter((t) => sourceTheorems.some((s) => t.name === s || t.name.endsWith(`.${s}`)));
const missingSource = sourceTheorems.filter((s) => !theorems.some((t) => t.name.endsWith(`.${s}`)));
if (missingSource.length > 0) fail(`theorems in source but not in the environment: ${missingSource.join(', ')}`);
const missingRequired = REQUIRED.filter((name) => !theorems.some((t) => t.name === name));
if (missingRequired.length > 0) fail(`required theorems missing: ${missingRequired.join(', ')}`);
for (const t of promoted) console.log(`   ${t.name}: [${t.axioms.join(', ')}]`);
console.log(`   ${promoted.length} promoted theorems, ${rows.length} constants, all within {${[...ALLOWED_AXIOMS].join(', ')}}`);

console.log('== leanchecker kernel replay');
// One module per process: leanchecker 4.36 replays a module prefix in parallel tasks and
// intermittently segfaults. The root `SpaceWars` module only re-exports these, and naming it
// would select every module by prefix.
for (const module of modules) {
  const check = run('lake', ['env', 'leanchecker', module], { timeout: 120_000 });
  if (check.status !== 0) fail(`leanchecker ${module} exited ${check.status}`, check.stdout + check.stderr);
}
console.log(`   ${modules.length} modules replayed: ${modules.join(', ')}`);

console.log('== leanchecker negative control');
const scratch = mkdtempSync(join(tmpdir(), 'verify-lean-'));
try {
  const olean = join(scratch, 'KernelNegativeControl.olean');
  const compile = run('lake', ['env', 'lean', 'audit/KernelNegativeControl.lean', '-o', olean]);
  if (compile.status !== 0) fail('negative control did not compile', compile.stdout + compile.stderr);
  const leanPath = run('lake', ['env', 'printenv', 'LEAN_PATH']).stdout.trim();
  const control = run('leanchecker', ['KernelNegativeControl'], {
    env: { ...env, LEAN_PATH: [scratch, leanPath].join(delimiter) },
    timeout: 120_000,
  });
  const output = control.stdout + control.stderr;
  if (control.status === 0 || !/one_eq_two/.test(output) || !/type mismatch/.test(output)) {
    fail(`leanchecker accepted a forged proof of 1 = 2 (exit ${control.status})`, output);
  }
  console.log('   forged 1 = 2 rejected by the kernel');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('verify-lean: OK');
