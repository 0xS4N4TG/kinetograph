import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SKILL_NAMES } from '../src/update-notice.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const folders = readdirSync(join(root, 'skills')).sort();

describe('the agent skills', () => {
  // The update notice looks for installed skills by these names.
  it('are the ones the update notice looks for', () => {
    expect([...SKILL_NAMES].sort()).toEqual(folders);
  });

  it('are named like their folder and say when to use them', () => {
    for (const name of folders) {
      const text = readFileSync(join(root, 'skills', name, 'SKILL.md'), 'utf8');
      expect(/^name: (.+)$/m.exec(text)?.[1], name).toBe(name);
      expect(/^description: (.{40,})$/m.test(text), `${name} description`).toBe(true);
    }
  });
});

// The CLI's update notice compares an installed skill's `metadata.version` with the CLI's version, so the stamp must be
// the package version. `node scripts/stamp-skill-version.mjs` sets it (run with the release bump).
describe('the skill version stamp', () => {
  it('equals packages/cli/package.json, in every skill', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    for (const name of folders) {
      const text = readFileSync(join(root, 'skills', name, 'SKILL.md'), 'utf8');
      expect(/^metadata:\n  version: "([^"]+)"$/m.exec(text)?.[1], name).toBe(pkg.version);
    }
  });
});
