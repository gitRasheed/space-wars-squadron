import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

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

function ticksUntil(step) {
  for (let tick = 1; tick <= 1000; tick++) {
    if (step(tick)) return tick;
  }
  throw new Error('Simulation boundary was not reached in 1000 updates');
}

async function measureSimulation(work) {
  const vite = await createServer({
    root: join(formal, '..'), configFile: false, appType: 'custom',
    cacheDir: join(work, 'vite'), optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, watch: null, ws: false },
  });
  try {
    const { FIXED_DT: dt, NEUTRAL_INPUT } = await vite.ssrLoadModule('/src/sim/types.ts');
    const { ENERGY_RULES, stepEnergy, spendWeaponCharge, absorbShieldDamage } =
      await vite.ssrLoadModule('/src/sim/energy.ts');
    const { COMBAT_TUNING, stepLockState, stepCombat } = await vite.ssrLoadModule('/src/sim/combat.ts');
    const { createInitialWorld } = await vite.ssrLoadModule('/src/sim/world.ts');
    const world = createInitialWorld(1, true);
    assert.equal(dt, 1 / 60);
    assert.deepEqual(world.player.energy, {
      overdrive: false, weaponState: 'ready', weaponCharge: 100, shieldCharge: 100, shieldRegenDelay: 0,
    });
    assert.equal(world.player.missilesReady, world.player.maxMissiles);
    const unit = 600;
    function units(charge) {
      const scaled = charge * unit;
      const rounded = Math.round(scaled);
      assert.ok(Math.abs(scaled - rounded) < 1e-8, `Charge delta ${charge} is off the model grid`);
      return rounded;
    }

    const initial = { ...world.player.energy, weaponCharge: 50, shieldCharge: 50, shieldRegenDelay: 0 };
    const idle = stepEnergy(initial, false, false, dt).energy;
    const od = stepEnergy(initial, true, false, dt).energy;
    const overheated = { ...initial, weaponState: 'overheated', weaponCharge: 50 };
    const cooling = stepEnergy(overheated, false, false, dt).energy;
    let ohState = { ...initial, weaponState: 'overheated', weaponCharge: 0 };
    const overheatTicks = ticksUntil(() => {
      ohState = stepEnergy(ohState, false, false, dt).energy;
      return ohState.weaponState === 'ready';
    });
    const shot = spendWeaponCharge(initial, ENERGY_RULES.primaryShotCost);
    assert.ok(shot !== null);
    const hit = absorbShieldDamage(initial, COMBAT_TUNING.enemyBoltDamage).energy;
    let delayState = hit;
    const shieldRegenDelayTicks = ticksUntil(() => {
      delayState = stepEnergy(delayState, false, false, dt).energy;
      return delayState.shieldRegenDelay <= 0;
    });

    const forward = { x: 0, y: 0, z: -1 };
    const contact = { id: 'target', position: { x: 0, y: 0, z: -50 } };
    let lock = { kind: 'none' };
    const acquire = ticksUntil(() => {
      lock = stepLockState(lock, contact, { x: 0, y: 0, z: 0 }, forward, 1, dt).lockState;
      return lock.kind === 'locked';
    });

    const input = { ...NEUTRAL_INPUT, fireMissile: true, firePrimary: true };
    let player = world.player;
    const missiles = [];
    const shots = [];
    ticksUntil((tick) => {
      const result = stepCombat({
        tick,
        rngState: world.rngState,
        player,
        wingmate: world.wingmate,
        enemies: [],
        friendlyCarrier: world.friendlyCarrier,
        hostileFrigate: world.hostileFrigate,
        asteroids: [],
        projectiles: [],
        explosions: [],
        radio: null,
        input,
        dt,
      });
      player = result.player;
      if (result.events.some(e => e.kind === 'missile_fired')) missiles.push(tick);
      if (result.events.some(e => e.kind === 'cannon_fired' && e.faction === 'friendly')) shots.push(tick);
      return missiles.length === player.maxMissiles + 2;
    });
    const rack = player.maxMissiles;
    assert.equal(missiles[0], 1);
    assert.equal(shots[0], 1);
    return {
      Unit: unit,
      MaxMissiles: rack,
      MinOverdriveShield: units(ENERGY_RULES.minOverdriveShield),
      OverdriveDrain: units(initial.shieldCharge - od.shieldCharge),
      ShieldRecharge: units(idle.shieldCharge - initial.shieldCharge),
      WeaponRecharge: units(idle.weaponCharge - initial.weaponCharge),
      OverheatCooldown: units(cooling.weaponCharge - overheated.weaponCharge),
      ShotCost: units(initial.weaponCharge - shot.energy.weaponCharge),
      BoltDamage: units(initial.shieldCharge - hit.shieldCharge),
      ShieldRegenDelayTicks: shieldRegenDelayTicks,
      OverheatTicks: overheatTicks,
      AcquireTicks: acquire,
      PrimaryCooldown: shots[1] - shots[0],
      MissileCooldown: missiles[1] - missiles[0],
      FreshRearm: missiles[rack] - missiles[0],
      CarriedRearm: missiles[rack + 1] - missiles[rack],
    };
  } finally {
    await vite.close();
  }
}

await ensureJar();
const work = await mkdtemp(join(tmpdir(), 'space-wars-tlc-'));

function run(module, config, coverage = false) {
  const result = spawnSync('java', [
    '-XX:+UseParallelGC', '-Xmx2g', '-cp', jar, 'tlc2.TLC',
    '-workers', coverage ? '4' : '1', '-noGenerateSpecTE',
    ...(coverage ? ['-coverage', '60'] : []),
    '-config', config, module,
  ], { cwd: work, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  assert.equal(result.signal, null, output);
  return { output, status: result.status };
}

function expectViolation(module, config, invariant, traceStates) {
  const { status, output } = run(module, config);
  assert.equal(status, 12, output);
  assert.ok(output.split(/\r?\n/).includes(`Error: Invariant ${invariant} is violated.`), output);
  assert.equal([...output.matchAll(/^State \d+: /gm)].length, traceStates, output);
  console.log(`${module} rejected ${invariant} as expected (exit ${status}).`);
}

try {
  for (const module of [model, mutant]) {
    for (const extension of ['tla', 'cfg']) {
      const name = `${module}.${extension}`;
      await copyFile(join(formal, name), join(work, name));
    }
  }

  const measured = await measureSimulation(work);
  const agreement = Object.entries(measured).map(([name, value]) => `ASSUME ${name} = ${value}`).join('\n');
  const checkedModel = 'SimulationAgreement';
  await writeFile(join(work, `${checkedModel}.tla`),
    `---- MODULE ${checkedModel} ----\nEXTENDS ${model}\n${agreement}\n====\n`);

  const probes = [
    ['NeverOverdrive', 'FlightInit', 2],
    ['NeverOverheated', 'FlightInit', 1 + measured.PrimaryCooldown + 1],
    ['NeverLocked', 'CombatInit', 1 + measured.AcquireTicks],
    ['NeverFiredLastMissile', 'CombatInit', 2 + (measured.MaxMissiles - 1) * measured.MissileCooldown],
    ['NeverFiredOnReload', 'CombatInit', 2 + measured.FreshRearm],
  ];
  for (const [invariant, init, states] of probes) {
    const config = `${invariant}.cfg`;
    await writeFile(join(work, config), `INIT ${init}\nNEXT Next\nINVARIANT ${invariant}\n`);
    expectViolation(model, config, invariant, states);
  }
  expectViolation(mutant, `${mutant}.cfg`, 'LockHasLiveTarget', 2);

  const { status, output } = run(checkedModel, `${model}.cfg`, true);
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
  for (const action of ['Init', 'Fly', 'ShieldHit', 'CombatFrame']) {
    assert.ok(actions.some((row) => row[1] === action), `Missing coverage for ${action}`);
  }
  console.log(output.split('\n')[0]);
  console.log(totals[0]);
  console.log(`TLC checked overheat liveness and exercised ${actions.length} actions including Init.`);
} finally {
  await rm(work, { recursive: true, force: true });
}
