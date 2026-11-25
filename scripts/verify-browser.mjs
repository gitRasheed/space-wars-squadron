import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const REQUESTED_PORT = process.env.VERIFY_PORT ? Number(process.env.VERIFY_PORT) : 0;
const OUT_DIR = path.resolve(process.cwd(), process.env.VERIFY_OUT_DIR ?? path.join('artifacts', 'verify'));
const WAIT_TIMEOUT_MS = 15_000;

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

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    const initial = await waitForTelemetry(page, (snap) => snap.phase === 'briefing', 'initial briefing phase');
    await page.screenshot({ path: path.join(OUT_DIR, '01-briefing.png') });

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
      (snap) => snap.projectilesCount > 0 || snap.weaponCharge < 100,
      'cockpit cannons firing',
    );
    assertCondition(
      combatSnap.wingmateTargetId !== null,
      'Autonomous wingmate should track an active target',
    );
    await page.screenshot({ path: path.join(OUT_DIR, '02-cockpit-combat.png') });
    const cockpitGlSignal = await measureWebglSignal(page);
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
    await page.screenshot({ path: path.join(OUT_DIR, '03-overheat.png') });
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
    await page.screenshot({ path: path.join(OUT_DIR, '04-overdrive.png') });
    const overdriveGlSignal = await measureWebglSignal(page);
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
    await page.keyboard.press('KeyE');
    const homingSnap = await waitForTelemetry(
      page,
      (snap, lockedId) => snap.playerMissileTargets.includes(lockedId),
      'locked missile homing on the locked target',
      lockSnap.lockTargetId,
    );
    await page.keyboard.down('KeyJ');
    const finalSnap = await waitForTelemetry(
      page,
      (snap) => snap.missilesReady < 4 && snap.projectilesCount > 0,
      'missile and cannon combat after restart',
    );
    await page.screenshot({ path: path.join(OUT_DIR, '05-missile-combat.png') });
    await page.keyboard.up('KeyJ');

    // 5. Mission selector: the briefing card swaps sorties on 2 and back on 1, before launch.
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await waitForTelemetry(page, (snap) => snap.phase === 'briefing' && snap.level === 'saturn', 'default Saturn briefing');
    await page.keyboard.press('Digit2');
    await waitForTelemetry(page, (snap) => snap.phase === 'briefing' && snap.level === 'planetary', 'mission 2 selected');
    await page.screenshot({ path: path.join(OUT_DIR, '06-mission-select.png') });
    await page.keyboard.press('Digit1');
    await waitForTelemetry(page, (snap) => snap.level === 'saturn' && snap.enemiesRemaining > 0, 'mission 1 reselected');

    // 6. Planetary sortie, direct boot: canyon, pads and markers, then flak engaging the player.
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
    assertCondition(
      canyonSnap.stage === 'ground_attack' && canyonSnap.enemiesRemaining === 0 && canyonSnap.groundTargetsRemaining === 8,
      `Planetary stage 1 should open with 8 ground targets and no air (${JSON.stringify(canyonSnap)})`,
    );
    assertCondition(canyonSnap.altitude > 40, 'Player should start well above the canyon floor');
    await page.screenshot({ path: path.join(OUT_DIR, 'planetary-01-canyon.png') });
    const canyonGlSignal = await measureWebglSignal(page);
    assertCondition(
      canyonGlSignal.nonBlackRatio >= 0.15 && canyonGlSignal.uniqueColors >= 24,
      `Planetary 3D canvas lacks visual signal (${JSON.stringify(canyonGlSignal)})`,
    );
    const flakSnap = await waitForTelemetry(page, (snap) => snap.flakBursts > 0, 'flak bursting around the player', null, 180_000);
    await page.screenshot({ path: path.join(OUT_DIR, 'planetary-02-flak.png') });

    // 7. Stage 2 boot: the air wave dives through the cloud deck over the canyon.
    planetaryUrl.searchParams.set('stage', 'air');
    await page.goto(planetaryUrl.href, { waitUntil: 'networkidle' });
    await waitForTelemetry(page, (snap) => snap.phase === 'briefing' && snap.stage === 'air_superiority', 'planetary stage 2 briefing');
    await page.keyboard.press('Enter');
    const airSnap = await waitForTelemetry(
      page,
      (snap) => snap.phase === 'active' && snap.enemiesRemaining === 4 && snap.enemyInViewRange !== null && snap.enemyInViewRange < 600,
      'air wave closing on the player',
      null,
      180_000,
    );
    await page.screenshot({ path: path.join(OUT_DIR, 'planetary-03-air-wave.png') });

    assertCondition(
      await page.evaluate(() => globalThis.__SW_PROFILE__ === undefined),
      'Profiler must stay off without ?profile=1',
    );
    const profileUrl = new URL(baseUrl);
    profileUrl.searchParams.set('profile', '1');
    await page.goto(profileUrl.href, { waitUntil: 'networkidle' });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (globalThis.__SW_PROFILE__?.snapshot().frames ?? 0) >= 60, null, {
      timeout: WAIT_TIMEOUT_MS,
    });
    const profile = await page.evaluate(() => globalThis.__SW_PROFILE__.snapshot());
    assertCondition(
      profile.frame.p50 > 0 && profile.frame.p99 >= profile.frame.p50 && profile.render.p50 > 0,
      `Profiler snapshot looks empty (${JSON.stringify(profile)})`,
    );

    assertCondition(consoleErrors.length === 0, `Console errors: ${consoleErrors.join('; ')}`);
    assertCondition(pageErrors.length === 0, `Page errors: ${pageErrors.join('; ')}`);

    const report = {
      ok: true,
      url: baseUrl,
      profile,
      glSignal: {
        cockpit: cockpitGlSignal,
        overdrive: overdriveGlSignal,
        canyon: canyonGlSignal,
      },
      screenshots: [
        '01-briefing.png',
        '02-cockpit-combat.png',
        '03-overheat.png',
        '04-overdrive.png',
        '05-missile-combat.png',
        '06-mission-select.png',
        'planetary-01-canyon.png',
        'planetary-02-flak.png',
        'planetary-03-air-wave.png',
      ],
      snapshots: {
        initial,
        combatSnap,
        overheatSnap,
        overdriveSnap,
        lockSnap,
        homingSnap,
        finalSnap,
        canyonSnap,
        flakSnap,
        airSnap,
      },
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

void run();
