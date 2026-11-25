import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const REQUESTED_PORT = process.env.VERIFY_PORT ? Number(process.env.VERIFY_PORT) : 0;
const OUT_DIR = path.resolve(process.cwd(), process.env.VERIFY_OUT_DIR ?? path.join('artifacts', 'verify'));
const WAIT_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 25_000);
const SUITE = process.env.VERIFY_SUITE ?? 'all';
const VALID_SUITES = new Set(['all', 'saturn', 'trench', 'planetary']);

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(`Verification assertion failed: ${message}`);
  }
}

async function waitForTelemetry(page, predicate, description, arg = null, timeoutMs = WAIT_TIMEOUT_MS) {
  const handle = await page.waitForFunction(
    ({ fnSource, payload }) => {
      const telemetry = globalThis.__SWS_TELEMETRY__;
      if (!telemetry) return false;
      const snap = telemetry.getSnapshot();
      const check = new Function('snap', 'arg', `return (${fnSource})(snap, arg);`);
      return check(snap, payload) ? snap : false;
    },
    { fnSource: predicate.toString(), payload: arg },
    { timeout: timeoutMs },
  ).catch(async (err) => {
    const latest = await page.evaluate(() => globalThis.__SWS_TELEMETRY__?.getSnapshot() ?? null).catch(() => null);
    throw new Error(`Timed out waiting for ${description} (latest=${JSON.stringify(latest)}): ${err.message}`);
  });
  const snap = await handle.jsonValue();
  await handle.dispose();
  return snap;
}

async function measureWebglSignal(page) {
  await page.evaluate(() => {
    const hud = globalThis.document.getElementById('hud-canvas');
    if (hud) {
      hud.style.visibility = 'hidden';
    }
  });
  let pngBuffer;
  try {
    pngBuffer = await page.locator('#gl-canvas').screenshot();
  } finally {
    await page.evaluate(() => {
      const hud = globalThis.document.getElementById('hud-canvas');
      if (hud) {
        hud.style.visibility = '';
      }
    });
  }

  const base64 = pngBuffer.toString('base64');
  return page.evaluate(async (encoded) => {
    const binary = globalThis.atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const bitmap = await globalThis.createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const sampleW = 160;
    const sampleH = 90;
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = sampleW;
    canvas.height = sampleH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, sampleW, sampleH);
    bitmap.close();

    const { data } = ctx.getImageData(0, 0, sampleW, sampleH);
    const totalPixels = sampleW * sampleH;
    let nonBlack = 0;
    const buckets = new Set();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (Math.max(r, g, b) > 12) {
        nonBlack += 1;
      }
      buckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
    return {
      nonBlackRatio: nonBlack / totalPixels,
      uniqueColors: buckets.size,
    };
  }, base64);
}

async function run() {
  assertCondition(VALID_SUITES.has(SUITE), `Unknown VERIFY_SUITE="${SUITE}" (expected all|saturn|trench|planetary)`);
  const runSaturn = SUITE === 'all' || SUITE === 'saturn';
  const runTrench = SUITE === 'all' || SUITE === 'trench';
  const runPlanetary = SUITE === 'all' || SUITE === 'planetary';

  await fs.mkdir(OUT_DIR, { recursive: true });
  const existingFiles = await fs.readdir(OUT_DIR);
  for (const file of existingFiles) {
    if (file.endsWith('.png')) {
      await fs.unlink(path.join(OUT_DIR, file));
    }
  }

  const server = await createServer({
    root: process.cwd(),
    server: {
      host: '127.0.0.1',
      port: REQUESTED_PORT,
      strictPort: REQUESTED_PORT !== 0,
    },
    logLevel: 'error',
  });

  let browser;
  const consoleErrors = [];
  const pageErrors = [];
  let exitCode = 0;

  try {
    await server.listen();
    const address = server.httpServer?.address();
    assertCondition(
      address !== null && address !== undefined && typeof address === 'object',
      'In-process Vite server did not bind a TCP port',
    );
    const baseUrl = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({
      headless: true,
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
      ],
    });

    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });
    const requestedScores = new Set();
    page.on('request', (request) => {
      const score = /\/audio\/([a-z-]+)\.ogg$/.exec(new URL(request.url()).pathname);
      if (score) requestedScores.add(score[1]);
    });
    const { LEVEL_PRESENTATION } = await server.ssrLoadModule('/src/levelPresentation.ts');
    const { briefingLayout } = await server.ssrLoadModule('/src/render/overlayLayout.ts');

    /** The card must draw this mission's title and objective and the score must switch to its .ogg. */
    async function expectBriefing(level, description) {
      const { title, objective, soundtrack } = LEVEL_PRESENTATION[level];
      const snap = await waitForTelemetry(
        page,
        (snap, want) => snap.phase === 'briefing' && snap.level === want.level && snap.briefing?.level === want.level
          && snap.briefing.title === want.title && snap.briefing.objective === want.objective && snap.soundtrack === want.soundtrack,
        description,
        { level, title, objective, soundtrack },
      );
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      while (!requestedScores.has(soundtrack) && Date.now() < deadline) await page.waitForTimeout(50);
      assertCondition(requestedScores.has(soundtrack), `${level} briefing never requested audio/${soundtrack}.ogg (saw ${[...requestedScores]})`);
      return snap;
    }

    const screenshots = [];
    const glSignal = {};
    const snapshots = {};
    let profile = null;

    if (runSaturn) {
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      snapshots.initial = await waitForTelemetry(page, (snap) => snap.phase === 'briefing', 'initial briefing phase');
      await page.screenshot({ path: path.join(OUT_DIR, '01-briefing.png') });
      screenshots.push('01-briefing.png');

      await page.keyboard.press('Enter');
      await waitForTelemetry(
        page,
        (snap) => snap.phase === 'active' && snap.tick > 5,
        'active cockpit flight',
      );

      // 1. Fire reciprocating cannons in cockpit view.
      await page.keyboard.down('KeyJ');
      const combatSnap = await waitForTelemetry(
        page,
        (snap) => snap.projectilesCount > 0 || snap.weaponHeat > 0,
        'cockpit cannons firing',
      );
      snapshots.combatSnap = combatSnap;
      assertCondition(
        combatSnap.wingmateTargetId !== null,
        'Autonomous wingmate should track an active target',
      );
      await page.screenshot({ path: path.join(OUT_DIR, '02-cockpit-combat.png') });
      screenshots.push('02-cockpit-combat.png');
      snapshots.hotZoneSnap = await waitForTelemetry(
        page,
        (snap) => snap.hotZone && snap.weaponState === 'ready' && snap.weaponHeat >= 80,
        'cannons firing in the Hot Zone',
      );
      await page.screenshot({ path: path.join(OUT_DIR, '02b-hot-zone.png') });
      screenshots.push('02b-hot-zone.png');
      const cockpitGlSignal = await measureWebglSignal(page);
      glSignal.cockpit = cockpitGlSignal;
      assertCondition(
        cockpitGlSignal.nonBlackRatio >= 0.15 && cockpitGlSignal.uniqueColors >= 24,
        `Cockpit 3D canvas lacks visual signal (${JSON.stringify(cockpitGlSignal)})`,
      );

      // 2. Keep holding fire until weapon overheat lockout triggers.
      const overheatSnap = await waitForTelemetry(
        page,
        (snap) => snap.weaponState === 'overheated',
        'weapon overheat lockout',
      );
      snapshots.overheatSnap = overheatSnap;
      await page.screenshot({ path: path.join(OUT_DIR, '03-overheat.png') });
      screenshots.push('03-overheat.png');
      await page.keyboard.up('KeyJ');

      // 3. Restart fresh (full shields) before pushing throttle to 100% detent and tapping W for 120% Overdrive.
      await page.keyboard.press('KeyR');
      await waitForTelemetry(
        page,
        (snap, prevTick) => snap.phase === 'active' && snap.tick < prevTick && snap.shieldCharge >= 90,
        'fresh sortie before overdrive',
        overheatSnap.tick,
      );
      await page.keyboard.down('KeyW');
      await waitForTelemetry(page, (snap) => snap.throttle >= 0.995, 'throttle reaching 100% detent');
      await page.keyboard.up('KeyW');
      await page.keyboard.press('KeyW');
      const overdriveSnap = await waitForTelemetry(
        page,
        (snap) => snap.overdrive === true && snap.throttle > 1.15,
        '120% throttle overdrive',
      );
      snapshots.overdriveSnap = overdriveSnap;
      await page.screenshot({ path: path.join(OUT_DIR, '04-overdrive.png') });
      screenshots.push('04-overdrive.png');
      const overdriveGlSignal = await measureWebglSignal(page);
      glSignal.overdrive = overdriveGlSignal;
      assertCondition(
        overdriveGlSignal.nonBlackRatio >= 0.15 && overdriveGlSignal.uniqueColors >= 24,
        `Overdrive 3D canvas lacks visual signal (${JSON.stringify(overdriveGlSignal)})`,
      );

      // 4. Restart and fire lock-on missile + cannons in cockpit view.
      await page.keyboard.press('KeyR');
      await waitForTelemetry(
        page,
        (snap, prevTick) => snap.phase === 'active' && snap.tick < prevTick,
        'sortie restart',
        overdriveSnap.tick,
      );
      const lockSnap = await waitForTelemetry(
        page,
        (snap) => snap.lockState === 'locked' && snap.lockTargetId !== null,
        'missile lock on the centred raider',
      );
      snapshots.lockSnap = lockSnap;
      await page.keyboard.press('KeyE');
      snapshots.homingSnap = await waitForTelemetry(
        page,
        (snap, lockedId) => snap.playerMissileTargets.includes(lockedId),
        'locked missile homing on the locked target',
        lockSnap.lockTargetId,
      );
      await page.keyboard.down('KeyJ');
      snapshots.finalSnap = await waitForTelemetry(
        page,
        (snap) => snap.missilesReady < 4 && snap.projectilesCount > 0,
        'missile and cannon combat after restart',
      );
      await page.screenshot({ path: path.join(OUT_DIR, '05-missile-combat.png') });
      screenshots.push('05-missile-combat.png');
      await page.keyboard.up('KeyJ');

      // 5. Mission selector: keys and clicks swap the card's mission, its text and its score before launch.
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      requestedScores.clear();
      await waitForTelemetry(page, (snap) => snap.phase === 'briefing' && snap.level === 'saturn', 'default Saturn briefing');
      await page.keyboard.press('Digit3');
      const briefings = { planetary: await expectBriefing('planetary', 'mission 3 briefing card and score') };
      await page.screenshot({ path: path.join(OUT_DIR, '06-mission-select.png') });
      screenshots.push('06-mission-select.png');
      const trenchButton = briefingLayout(1280, 720).missions.find((m) => m.level === 'trench').box;
      await page.mouse.click(trenchButton.x + trenchButton.w / 2, trenchButton.y + trenchButton.h / 2);
      briefings.trench = await expectBriefing('trench', 'clicked mission 2 briefing card and score');
      await page.screenshot({ path: path.join(OUT_DIR, '06b-mission-click.png') });
      screenshots.push('06b-mission-click.png');
      await page.keyboard.press('Digit1');
      briefings.saturn = await expectBriefing('saturn', 'mission 1 briefing card and score');
      assertCondition(briefings.saturn.enemiesRemaining > 0, 'Saturn sortie should be reloaded with raiders');
      snapshots.briefings = briefings;
      snapshots.requestedScores = [...requestedScores];

      // 6. Profiler opt-in check.
      assertCondition(
        await page.evaluate(() => globalThis.__SW_PROFILE__ === undefined),
        'Profiler must stay off without ?profile=1',
      );
      const profileUrl = new URL(baseUrl);
      profileUrl.searchParams.set('profile', '1');
      await page.goto(profileUrl.href, { waitUntil: 'networkidle' });
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (globalThis.__SW_PROFILE__?.snapshot().frames ?? 0) >= 20, null, {
        timeout: Math.max(WAIT_TIMEOUT_MS, 60_000),
      });
      profile = await page.evaluate(() => globalThis.__SW_PROFILE__.snapshot());
      assertCondition(
        profile.frame.p50 > 0 && profile.frame.p99 >= profile.frame.p50 && profile.render.p50 > 0,
        `Profiler snapshot looks empty (${JSON.stringify(profile)})`,
      );
    }

    if (runTrench) {
      // Level 2: boot straight into the trench briefing, fly in through the mouth and down the spine.
      const trenchUrl = new URL(baseUrl);
      trenchUrl.searchParams.set('level', 'trench');
      await page.goto(trenchUrl.href, { waitUntil: 'networkidle' });
      snapshots.trenchBriefing = await waitForTelemetry(
        page,
        (snap) => snap.phase === 'briefing' && snap.level === 'trench' && snap.reactorsRemaining === 3,
        'trench briefing from ?level=trench',
      );
      await page.screenshot({ path: path.join(OUT_DIR, 'trench-01-briefing.png') });
      screenshots.push('trench-01-briefing.png');
      await page.keyboard.press('Enter');
      snapshots.trenchMouth = await waitForTelemetry(
        page,
        (snap) => snap.phase === 'active' && snap.playerPosition.z < 840,
        'player inside the trench mouth',
        null,
        Math.max(WAIT_TIMEOUT_MS, 60_000),
      );
      await page.screenshot({ path: path.join(OUT_DIR, 'trench-02-mouth.png') });
      screenshots.push('trench-02-mouth.png');
      const trenchGlSignal = await measureWebglSignal(page);
      glSignal.trench = trenchGlSignal;
      assertCondition(
        trenchGlSignal.nonBlackRatio >= 0.15 && trenchGlSignal.uniqueColors >= 24,
        `Trench 3D canvas lacks visual signal (${JSON.stringify(trenchGlSignal)})`,
      );
      await page.keyboard.down('KeyW');
      await waitForTelemetry(page, (snap) => snap.throttle >= 0.995, 'trench throttle at 100% detent');
      await page.keyboard.up('KeyW');
      await page.keyboard.press('KeyW');
      await page.keyboard.down('KeyJ');
      const trenchDeep = await waitForTelemetry(
        page,
        (snap) => snap.phase === 'active' && snap.overdrive && snap.playerPosition.z < 470,
        'overdrive run deep in the spine',
        null,
        Math.max(WAIT_TIMEOUT_MS, 60_000),
      );
      snapshots.trenchDeep = trenchDeep;
      await page.screenshot({ path: path.join(OUT_DIR, 'trench-03-spine-run.png') });
      screenshots.push('trench-03-spine-run.png');
      await page.keyboard.up('KeyJ');
      const inside = trenchDeep.playerPosition;
      assertCondition(
        trenchDeep.level === 'trench' && Math.abs(inside.x) < 78 && inside.y > -51.5 && inside.y < 51.5,
        `Player should be flying inside the trench envelope (${JSON.stringify(inside)})`,
      );
    }

    if (runPlanetary) {
      // Planetary sortie, direct boot: canyon, pads and markers, then flak engaging the player.
      const planetaryUrl = new URL(baseUrl);
      planetaryUrl.searchParams.set('level', 'planetary');
      await page.goto(planetaryUrl.href, { waitUntil: 'networkidle' });
      await waitForTelemetry(page, (snap) => snap.phase === 'briefing' && snap.level === 'planetary', 'planetary briefing');
      await page.keyboard.press('Enter');
      const canyonSnap = await waitForTelemetry(
        page,
        (snap) => snap.phase === 'active' && snap.tick > 60,
        'planetary flight under way',
      );
      snapshots.canyonSnap = canyonSnap;
      assertCondition(
        canyonSnap.stage === 'ground_attack' && canyonSnap.enemiesRemaining === 0 && canyonSnap.groundTargetsRemaining === 8,
        `Planetary stage 1 should open with 8 ground targets and no air (${JSON.stringify(canyonSnap)})`,
      );
      assertCondition(canyonSnap.altitude > 40, 'Player should start well above the canyon floor');
      await page.screenshot({ path: path.join(OUT_DIR, 'planetary-01-canyon.png') });
      screenshots.push('planetary-01-canyon.png');
      const canyonGlSignal = await measureWebglSignal(page);
      glSignal.canyon = canyonGlSignal;
      assertCondition(
        canyonGlSignal.nonBlackRatio >= 0.15 && canyonGlSignal.uniqueColors >= 24,
        `Planetary 3D canvas lacks visual signal (${JSON.stringify(canyonGlSignal)})`,
      );
      snapshots.flakSnap = await waitForTelemetry(page, (snap) => snap.flakBursts > 0, 'flak bursting around the player', null, 180_000);
      await page.screenshot({ path: path.join(OUT_DIR, 'planetary-02-flak.png') });
      screenshots.push('planetary-02-flak.png');

      // Stage 2 boot: the air wave dives through the cloud deck over the canyon.
      planetaryUrl.searchParams.set('stage', 'air');
      await page.goto(planetaryUrl.href, { waitUntil: 'networkidle' });
      await waitForTelemetry(page, (snap) => snap.phase === 'briefing' && snap.stage === 'air_superiority', 'planetary stage 2 briefing');
      await page.keyboard.press('Enter');
      snapshots.airSnap = await waitForTelemetry(
        page,
        (snap) => snap.phase === 'active' && snap.enemiesRemaining === 4 && snap.enemyInViewRange !== null && snap.enemyInViewRange < 600,
        'air wave closing on the player',
        null,
        180_000,
      );
      await page.screenshot({ path: path.join(OUT_DIR, 'planetary-03-air-wave.png') });
      screenshots.push('planetary-03-air-wave.png');
    }

    assertCondition(consoleErrors.length === 0, `Console errors: ${consoleErrors.join('; ')}`);
    assertCondition(pageErrors.length === 0, `Page errors: ${pageErrors.join('; ')}`);

    const report = {
      ok: true,
      suite: SUITE,
      url: baseUrl,
      profile,
      glSignal,
      screenshots,
      snapshots,
    };
    await fs.writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    await server.close().catch(() => undefined);
  }
  process.exit(exitCode);
}

run();
