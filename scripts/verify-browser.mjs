import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { chromium } from 'playwright';

const REQUESTED_PORT = process.env.VERIFY_PORT;
const OUT_DIR = path.resolve(process.cwd(), 'artifacts', 'verify');

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(`Verification assertion failed: ${message}`);
  }
}

function waitForViteUrl(server, getStdout, getAllLogs, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Timed out waiting for Vite to report its listening URL.\n${getAllLogs()}`));
      }
    }, timeoutMs);

    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const inspectStdout = () => {
      const clean = stripVTControlCharacters(getStdout());
      const match = clean.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+)/);
      if (match !== null && match[1] !== undefined) {
        finish(resolve, match[1]);
      }
    };

    server.stdout.on('data', inspectStdout);
    server.once('error', (err) => finish(reject, err));
    server.once('exit', (code, signal) => {
      finish(
        reject,
        new Error(`Vite exited before listening (code=${String(code)}, signal=${String(signal)}).\n${getAllLogs()}`),
      );
    });
    inspectStdout();
  });
}

async function waitForServer(server, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Vite exited unexpectedly with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server still binding HTTP listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Vite server at ${url}`);
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

  const viteArgs = ['vite', '--host', '127.0.0.1', '--port', REQUESTED_PORT ?? '0'];
  if (REQUESTED_PORT !== undefined) {
    viteArgs.push('--strictPort');
  }
  const server = spawn('npx', viteArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let stdoutLogs = '';
  let stderrLogs = '';
  let serverExitInfo = null;
  server.stdout.on('data', (chunk) => {
    stdoutLogs += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    stderrLogs += chunk.toString();
  });
  server.once('exit', (code, signal) => {
    serverExitInfo = { code, signal };
  });

  const getAllLogs = () => `${stdoutLogs}${stderrLogs}`;
  const assertServerAlive = () => {
    assertCondition(
      server.exitCode === null && serverExitInfo === null,
      `Spawned Vite server exited prematurely (${JSON.stringify(serverExitInfo)})`,
    );
  };

  let browser;
  const consoleErrors = [];
  const pageErrors = [];

  try {
    const baseUrl = await waitForViteUrl(server, () => stdoutLogs, getAllLogs, 15000);
    await waitForServer(server, baseUrl, 10000);
    assertServerAlive();

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
    const cockpitGlSignal = await measureWebglSignal(page);
    assertCondition(
      cockpitGlSignal.nonBlackRatio >= 0.15 && cockpitGlSignal.uniqueColors >= 24,
      `Cockpit 3D canvas lacks visual signal (${JSON.stringify(cockpitGlSignal)})`,
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
    const chaseGlSignal = await measureWebglSignal(page);
    assertCondition(
      chaseGlSignal.nonBlackRatio >= 0.15 && chaseGlSignal.uniqueColors >= 24,
      `Chase 3D canvas lacks visual signal (${JSON.stringify(chaseGlSignal)})`,
    );
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
    assertServerAlive();
    assertCondition(consoleErrors.length === 0, `Console errors: ${consoleErrors.join('; ')}`);
    assertCondition(pageErrors.length === 0, `Page errors: ${pageErrors.join('; ')}`);

    const report = {
      ok: true,
      url: baseUrl,
      glSignal: {
        cockpit: cockpitGlSignal,
        chase: chaseGlSignal,
      },
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
    const logs = getAllLogs().trim();
    if (logs.length > 0) {
      console.error('Vite output:\n', logs);
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
