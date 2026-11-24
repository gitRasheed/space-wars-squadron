# agent-3d

Check a binary glTF asset or a Three.js factory against a style card. The turntable also renders nine labeled views and checks framing and triangle winding.

From this directory, with Node.js 20 or later, run

```bash
npm ci
npx playwright install chromium
npm run build
node dist/cli.js check ./model.glb
node dist/cli.js turntable ./model.glb --card ./style-card.json --out ./turntable
```

Each command prints a JSON report. The turntable also writes `contact-sheet.png` and `report.json`. Run `npm test` for the CLI and Chromium regression suite.

The [skill guide](SKILL.md) covers factory exports, style cards, timeouts, exit codes, and local tarball usage.
