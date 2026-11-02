import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The CLI's update notice compares an installed skill's `metadata.version` with the CLI's version, so the stamp must be
// the package version. `node scripts/stamp-skill-version.mjs` sets it (run with the release bump).
describe('the skill version stamp', () => {
  it('equals packages/cli/package.json, in both skills', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    for (const name of ['kinetograph', 'kinetograph-migrate']) {
      const text = readFileSync(join(root, 'skills', name, 'SKILL.md'), 'utf8');
      expect(/^metadata:\n  version: "([^"]+)"$/m.exec(text)?.[1], name).toBe(pkg.version);
    }
  });
});
