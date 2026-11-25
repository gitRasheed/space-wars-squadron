// Stages feedback a scripted sortie cannot reach on demand: each combat signal and each biome card as one frozen frame.
// Usage: node scripts/stage-vfx.mjs   (STAGE_OUT_DIR overrides artifacts/stage-vfx)
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const OUT_DIR = path.resolve(process.cwd(), process.env.STAGE_OUT_DIR ?? path.join('artifacts', 'stage-vfx'));
const VIEWPORT = { width: 1280, height: 720 };
// The brightest sky tier of the sunset biome: the worst backdrop a glass HUD mark has to survive.
const BRIGHT_BACKDROP = '#e9ab78';

const STAGE_PAGE = `<!doctype html>
<html>
  <head>
    <style>
      * { margin: 0; padding: 0; }
      html, body { width: 100%; height: 100%; overflow: hidden; background: #0a0914; }
      canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    </style>
  </head>
  <body>
    <canvas id="gl-canvas"></canvas>
    <canvas id="hud-canvas"></canvas>
    <script type="module">
      import { setActiveBiome } from '/src/render/biome.ts';
      import { computeHudReticlePoint, createCockpitHud } from '/src/render/cockpitHud.ts';
      import { BIOME_CARDS } from '/src/render/palette.ts';
      import { createSceneRenderer } from '/src/render/sceneRenderer.ts';
      import { add, forwardOf, rightOf, scale, upOf } from '/src/sim/math.ts';
      import { DEFAULT_SORTIE_SEED } from '/src/sim/types.ts';
      import { createInitialWorld } from '/src/sim/world.ts';

      const glCanvas = document.getElementById('gl-canvas');
      const hudCanvas = document.getElementById('hud-canvas');
      const renderer = createSceneRenderer(glCanvas);
      const hud = createCockpitHud(hudCanvas);
      renderer.resize(window.innerWidth, window.innerHeight);
      hud.resize(window.innerWidth, window.innerHeight);
      const base = createInitialWorld(DEFAULT_SORTIE_SEED, true);

      function draw(world) {
        renderer.render(world);
        hud.render(world, renderer.projectWorldPoint, false, true);
      }

      function pixels(canvas) {
        const copy = document.createElement('canvas');
        copy.width = window.innerWidth;
        copy.height = window.innerHeight;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0, copy.width, copy.height);
        return ctx.getImageData(0, 0, copy.width, copy.height).data;
      }

      window.__STAGE__ = {
        base,
        biomes: Object.keys(BIOME_CARDS),
        setBiome: (id) => setActiveBiome(BIOME_CARDS[id]),
        /** A point in the player's frame: metres ahead, to the right and up. */
        at(ahead, right = 0, up = 0) {
          const { position, orientation } = base.player;
          return add(position, add(scale(forwardOf(orientation), ahead), add(scale(rightOf(orientation), right), scale(upOf(orientation), up))));
        },
        /** Restarts the timeline, fires \`events\` on tick 1 and holds the scene for \`ticks\` more. */
        play(scene, events, ticks) {
          draw({ ...scene, tick: 0, events: [] });
          draw({ ...scene, tick: 1, events });
          for (let tick = 2; tick <= 1 + ticks; tick += 1) {
            draw({ ...scene, tick, events: [] });
          }
        },
        reticle: (scene) => computeHudReticlePoint(scene, renderer.projectWorldPoint, window.innerWidth, window.innerHeight),
        hudPixels: () => pixels(hudCanvas),
        glPixels: () => pixels(glCanvas),
        /** How far from \`centre\` a HUD colour reaches, looking no further than \`within\` pixels. */
        extent(data, [r, g, b], centre, within) {
          const width = window.innerWidth;
          let reach = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) > 24 || data[i + 3] < 250) continue;
            const radius = Math.hypot(((i / 4) % width) - centre.x, Math.floor(i / 4 / width) - centre.y);
            if (radius <= within) reach = Math.max(reach, radius);
          }
          return reach;
        },
        /** Where two frames differ: pixel count, column split and distance range from \`centre\`. */
        diff(a, b, centre) {
          const width = window.innerWidth;
          const result = { count: 0, left: 0, right: 0, minRadius: Infinity, maxRadius: 0 };
          for (let i = 0; i < a.length; i += 4) {
            if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]) < 24) continue;
            const x = (i / 4) % width;
            const y = Math.floor(i / 4 / width);
            const radius = Math.hypot(x - centre.x, y - centre.y);
            result.count += 1;
            if (x < width * 0.5) result.left += 1; else result.right += 1;
            result.minRadius = Math.min(result.minRadius, radius);
            result.maxRadius = Math.max(result.maxRadius, radius);
          }
          return result;
        },
      };
    </script>
  </body>
</html>`;

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(`Stage assertion failed: ${message}`);
  }
}

/** Runs in the page: the stock sortie rearranged so hostiles sit where the camera can judge them. */
function buildScenes() {
  const stage = globalThis.__STAGE__;
  const { base } = stage;
  const [raider, striker, ...rest] = base.enemies;
  const near = { ...raider, position: stage.at(62, 9, 3) };
  const far = { ...striker, position: stage.at(118, -30, 12) };
  const distant = rest.map((enemy, index) => ({ ...enemy, position: stage.at(500, 80 - index * 150, 30) }));
  const duel = {
    ...base,
    enemies: [near, far, ...distant],
    player: { ...base.player, selectedTargetId: near.id },
    radio: null,
  };
  // Holding station with the player, so no lead pip joins the reticle.
  const ahead = { ...raider, position: stage.at(70), velocity: base.player.velocity };
  const sights = {
    ...base,
    enemies: [ahead, far, ...distant],
    player: { ...base.player, selectedTargetId: ahead.id },
    radio: null,
  };
  return { duel, sights, near, ahead };
}

const HIT = { kind: 'hit_confirmed', isKill: false, shieldHit: false };

/** Each `run` executes in the page, leaves its frame on the canvases and returns what `check` should judge. */
const STAGES = [
  ...['saturnOrbit', 'megastructureTrench', 'sunsetGroundSupport'].map((biome) => ({
    name: `biome-${biome}`,
    arg: biome,
    run: (build, id) => {
      const stage = globalThis.__STAGE__;
      const { duel } = build();
      stage.setBiome(id);
      stage.play({ ...duel, player: { ...duel.player, targetPinned: true } }, [], 2);
      stage.setBiome('saturnOrbit');
    },
  })),
  {
    name: 'crit-hit',
    arg: HIT,
    // A hit also shakes the camera, so the two markers are measured by their own colours rather than by frame diff.
    run: (build, hit) => {
      const stage = globalThis.__STAGE__;
      const { sights } = build();
      const reticle = stage.reticle(sights);
      stage.play(sights, [hit], 2);
      const plain = stage.extent(stage.hudPixels(), [246, 232, 207], reticle, 45);
      stage.play(sights, [{ kind: 'crit_hit', position: stage.at(64, 1.5, 1) }, hit], 2);
      const crit = stage.extent(stage.hudPixels(), [255, 217, 102], reticle, 45);
      return { plain, crit };
    },
    check: ({ plain, crit }) => {
      assertCondition(plain > 0 && crit > 0, `hit markers did not draw (${JSON.stringify({ plain, crit })})`);
      const ratio = crit / plain;
      assertCondition(ratio > 1.3 && ratio < 1.5, `crit marker should be 1.4x a plain hit, got ${ratio.toFixed(2)}x`);
    },
  },
  ...[['left', -1], ['right', 1]].map(([label, side]) => ({
    name: `near-miss-${label}`,
    arg: side,
    run: (build, grazed) => {
      const stage = globalThis.__STAGE__;
      const { duel } = build();
      const behind = stage.at(-1);
      const origin = stage.at(0);
      const bolt = {
        id: 'stage-bolt',
        kind: 'bolt',
        faction: 'hostile',
        owner: 'hostile',
        position: stage.at(-6, grazed * 9, 1),
        velocity: { x: (behind.x - origin.x) * 500, y: (behind.y - origin.y) * 500, z: (behind.z - origin.z) * 500 },
        targetId: null,
        damage: 10,
        ttl: 1,
      };
      const scene = { ...duel, projectiles: [bolt] };
      stage.play(scene, [], 1);
      const quiet = stage.glPixels();
      stage.play(scene, [{ kind: 'near_miss', source: 'bolt', reward: 'shield' }], 1);
      return { grazed, glint: stage.diff(quiet, stage.glPixels(), { x: 0, y: 0 }) };
    },
    check: ({ grazed, glint }) => {
      const [near, away] = grazed < 0 ? [glint.left, glint.right] : [glint.right, glint.left];
      assertCondition(near > 200 && near > away * 2, `near-miss glint should favour the grazed side (${JSON.stringify(glint)})`);
    },
  })),
  {
    name: 'supply-drop',
    run: (build) => {
      const { duel } = build();
      globalThis.__STAGE__.play(duel, [{ kind: 'hit_confirmed', isKill: true, shieldHit: false }, { kind: 'supply_drop', drop: 'heat_flush' }], 8);
    },
  },
  {
    name: 'weapon-ready',
    run: (build) => {
      const { duel } = build();
      globalThis.__STAGE__.play(duel, [{ kind: 'weapon_ready' }], 2);
    },
  },
  {
    name: 'incoming-fire',
    run: (build) => {
      const stage = globalThis.__STAGE__;
      const { duel } = build();
      const shooters = [stage.at(-200, -150, 20), stage.at(120, 320, 0), stage.at(60, 0, 220)];
      stage.play(duel, [], 3);
      const quiet = stage.hudPixels();
      stage.play(duel, shooters.map((position) => ({ kind: 'incoming_fire', position })), 3);
      return stage.diff(quiet, stage.hudPixels(), stage.reticle(duel));
    },
    check: (threats) => {
      assertCondition(threats.count > 0, 'threat chevrons did not draw');
      assertCondition(
        threats.minRadius >= 60 && threats.maxRadius <= 110,
        `threat chevrons must stay on the reticle's outer ring (${JSON.stringify(threats)})`,
      );
    },
  },
  {
    name: 'own-warnings',
    run: (build) => {
      const { duel } = build();
      const player = {
        ...duel.player,
        hull: duel.player.maxHull * 0.2,
        proximityWarning: true,
        energy: { ...duel.player.energy, weaponState: 'overheated', weaponHeat: 70 },
      };
      globalThis.__STAGE__.play({ ...duel, player }, [], 70);
    },
  },
  {
    name: 'shield-break',
    run: (build) => {
      const { duel, near } = build();
      const blast = { id: 'shdbrk-stage', position: near.position, radius: 20, elapsed: 0.13, duration: 0.52, tint: 'cyan' };
      globalThis.__STAGE__.play({ ...duel, explosions: [blast] }, [{ kind: 'shield_broken', position: near.position, targetId: near.id, attackerId: 'player' }], 8);
    },
  },
  {
    name: 'hud-bright-backdrop',
    arg: BRIGHT_BACKDROP,
    run: (build, backdrop) => {
      const stage = globalThis.__STAGE__;
      const { duel } = build();
      const events = [
        { kind: 'crit_hit', position: stage.at(60) },
        { kind: 'incoming_fire', position: stage.at(-200, -150, 20) },
        { kind: 'incoming_fire', position: stage.at(120, 320, 0) },
        { kind: 'supply_drop', drop: 'shield_surge' },
      ];
      stage.play({ ...duel, player: { ...duel.player, targetPinned: true } }, events, 2);
      globalThis.document.getElementById('gl-canvas').style.visibility = 'hidden';
      globalThis.document.body.style.background = backdrop;
    },
    restore: () => {
      globalThis.document.getElementById('gl-canvas').style.visibility = '';
      globalThis.document.body.style.background = '';
    },
  },
];

async function run() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const server = await createServer({
    root: process.cwd(),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    optimizeDeps: { include: ['three'] },
    logLevel: 'error',
    plugins: [
      {
        name: 'stage-page',
        configureServer(dev) {
          dev.middlewares.use('/__stage', (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(STAGE_PAGE);
          });
        },
      },
    ],
  });

  let browser;
  let exitCode = 0;
  const errors = [];
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assertCondition(address !== null && typeof address === 'object', 'Vite server did not bind a TCP port');
    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`http://127.0.0.1:${address.port}/__stage`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => globalThis.__STAGE__ !== undefined, null, { timeout: 30_000 });
    await page.addScriptTag({ content: `globalThis.__BUILD_SCENES__ = ${buildScenes.toString()};` });

    const shots = [];
    async function shoot(name) {
      await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
      await page.evaluate(() => {
        globalThis.document.documentElement.style.filter = 'grayscale(1)';
      });
      await page.screenshot({ path: path.join(OUT_DIR, `${name}-grey.png`) });
      await page.evaluate(() => {
        globalThis.document.documentElement.style.filter = '';
      });
      shots.push(`${name}.png`, `${name}-grey.png`);
    }

    const measurements = {};
    for (const stage of STAGES) {
      const measured = await page.evaluate(
        `(${stage.run.toString()})(globalThis.__BUILD_SCENES__, ${JSON.stringify(stage.arg ?? null)})`,
      );
      await shoot(stage.name);
      if (stage.restore !== undefined) await page.evaluate(stage.restore);
      stage.check?.(measured);
      measurements[stage.name] = measured ?? null;
    }

    assertCondition(errors.length === 0, `Console or page errors: ${errors.join('; ')}`);
    const report = { ok: true, screenshots: shots, measurements };
    await fs.writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
  process.exit(exitCode);
}

void run();
