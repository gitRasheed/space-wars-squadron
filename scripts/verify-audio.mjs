import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import combatCues from '../src/audio/combat-cues.json' with { type: 'json' };
import gameCues from '../src/audio/game-cues.json' with { type: 'json' };

const work = mkdtempSync(join(tmpdir(), 'space-wars-audio-'));
try {
  for (const [id, recipe] of Object.entries({ ...combatCues, ...gameCues })) {
    writeFileSync(join(work, id + '.recipe.json'), JSON.stringify(recipe));
  }
  copyFileSync(new URL('../src/audio/combat-loop.recipe.json', import.meta.url), join(work, 'combat-loop.recipe.json'));
  // Batch checks the encoded WAVs and applies the seam check to loop recipes.
  execFileSync('kleos', ['batch', work, '--out', join(work, 'renders'), '--summary'], { stdio: 'inherit' });
} finally {
  rmSync(work, { recursive: true, force: true });
}
