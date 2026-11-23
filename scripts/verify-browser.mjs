import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = Number(process.env.VERIFY_PORT ?? '4179');
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve(process.cwd(), 'artifacts', 'verify');

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for Vite server at ${url}`);
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(`Verification assertion failed: ${message}`);
  }
}

async function run() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const existingFiles = await fs.readdir(OUT_DIR);
  for (const file of existingFiles) {
    if (file.endsWith('.png')) {
      await fs.unlink(path.join(OUT_DIR, file));
    }
  }

  const server = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let serverLogs = '';
  server.stdout.on('data', (chunk) => {
    serverLogs += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverLogs += chunk.toString();
  });

  let browser;
  const consoleErrors = [];
  const pageErrors = [];

  try {
    await waitForServer(BASE_URL, 15000);

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

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(450);

    const readTelemetry = () =>
      page.evaluate(() => {
        const telemetry = globalThis.__SWS_TELEMETRY__;
        if (!telemetry) {
          return null;
        }
        return telemetry.getSnapshot();
      });

    const initial = await readTelemetry();
    assertCondition(initial !== null, 'Telemetry hook missing on window');
    assertCondition(initial.phase === 'briefing', `Expected briefing phase, got ${initial.phase}`);
    await page.screenshot({ path: path.join(OUT_DIR, '01-briefing.png') });

    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const active = await readTelemetry();
    assertCondition(active.phase === 'active', `Expected active phase after Enter, got ${active.phase}`);
    assertCondition(active.tick > 5, `Expected simulation tick progression, got ${active.tick}`);

    await page.keyboard.down('KeyJ');
    await page.waitForTimeout(340);
    const combatSnap = await readTelemetry();
    assertCondition(
      combatSnap.wingmateTargetId !== null,
      'Autonomous wingmate should track an active target',
    );
    assertCondition(
      combatSnap.projectilesCount > 0 || combatSnap.weaponCharge < 100,
      'Firing cannons should consume weapon charge or spawn bolts',
    );
    await page.screenshot({ path: path.join(OUT_DIR, '02-cockpit-combat.png') });
    await page.keyboard.up('KeyJ');

    await page.keyboard.press('KeyE');
    await page.keyboard.down('Space');
    await page.mouse.move(930, 310, { steps: 8 });
    await page.waitForTimeout(420);
    const driftSnap = await readTelemetry();
    assertCondition(
      driftSnap.boostMode === 'drifting' || driftSnap.boostMode === 'recovering',
      `Expected drifting/recovering state, got ${driftSnap.boostMode}`,
    );
    assertCondition(driftSnap.missilesReady < 4, 'Missile count should drop after firing with E');
    await page.screenshot({ path: path.join(OUT_DIR, '03-snap-turn.png') });
    await page.keyboard.up('Space');

    await page.waitForTimeout(1050);
    await page.keyboard.press('KeyV');
    await page.mouse.move(640, 360, { steps: 4 });
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(380);
    const chaseSnap = await readTelemetry();
    assertCondition(chaseSnap.cameraMode === 'chase', `Expected chase camera, got ${chaseSnap.cameraMode}`);
    assertCondition(chaseSnap.boostMode === 'boosting', `Expected boosting state, got ${chaseSnap.boostMode}`);
    await page.screenshot({ path: path.join(OUT_DIR, '04-chase-boost.png') });
    await page.keyboard.up('ShiftLeft');
    await page.keyboard.up('KeyD');

    await page.keyboard.press('KeyR');
    await page.waitForTimeout(260);
    const afterRestart = await readTelemetry();
    if (afterRestart.cameraMode !== 'chase') {
      await page.keyboard.press('KeyV');
      await page.waitForTimeout(100);
    }
    await page.keyboard.down('KeyJ');
    await page.waitForTimeout(360);
    const finalSnap = await readTelemetry();
    assertCondition(
      finalSnap.cameraMode === 'chase',
      `Expected chase camera for 05-chase-combat.png, got ${finalSnap.cameraMode}`,
    );
    await page.screenshot({ path: path.join(OUT_DIR, '05-chase-combat.png') });
    await page.keyboard.up('KeyJ');
    assertCondition(consoleErrors.length === 0, `Console errors: ${consoleErrors.join('; ')}`);
    assertCondition(pageErrors.length === 0, `Page errors: ${pageErrors.join('; ')}`);

    const report = {
      ok: true,
      url: BASE_URL,
      screenshots: [
        '01-briefing.png',
        '02-cockpit-combat.png',
        '03-snap-turn.png',
        '04-chase-boost.png',
        '05-chase-combat.png',
      ],
      snapshots: {
        initial,
        combatSnap,
        driftSnap,
        chaseSnap,
        finalSnap,
      },
    };
    await fs.writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error);
    if (serverLogs.trim().length > 0) {
      console.error('Vite output:\n', serverLogs);
    }
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
    server.kill('SIGTERM');
  }
}

void run();
