import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globalSkillFolders, updateSkills } from '../src/commands/skills.js';
import { addItems } from '../src/registry/install.js';
import { openRegistry } from '../src/registry/source.js';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'kinetograph-skills-test-'));

const skillItem = {
  name: 'kinetograph-taste-clone',
  type: 'skill',
  title: 'Taste Clone',
  description: 'A skill.',
  kinetograph: '0.1.0',
  files: [
    { path: 'SKILL.md', target: 'src/skills/kinetograph-taste-clone/SKILL.md', content: '---\nname: kinetograph-taste-clone\n---\n' },
    { path: 'scripts/probe.sh', target: 'src/skills/kinetograph-taste-clone/scripts/probe.sh', content: '#!/bin/sh\n' },
  ],
};

function registry(items: object[]): ReturnType<typeof openRegistry> {
  const dir = scratch();
  for (const item of items) writeFileSync(join(dir, `${(item as { name: string }).name}.json`), JSON.stringify(item));
  return openRegistry({ spec: dir });
}

function bundled(): string {
  const dir = scratch();
  mkdirSync(join(dir, 'kinetograph/references'), { recursive: true });
  writeFileSync(join(dir, 'kinetograph/SKILL.md'), 'core');
  writeFileSync(join(dir, 'kinetograph/references/A.md'), 'ref');
  mkdirSync(join(dir, 'not-a-skill'));
  return dir;
}

describe('kinetograph skills update', () => {
  it('writes the bundled skills and the registry skill into every folder', async () => {
    const home = scratch();
    const folders = globalSkillFolders(home, {});
    expect(folders.map((f) => f.slice(home.length + 1))).toEqual(['.claude/skills', '.codex/skills', '.cursor/skills', '.agents/skills']);
    const result = await updateSkills({ folders, registry: registry([skillItem]), bundled: bundled() });
    expect(result.failed).toBeUndefined();
    expect(result.skills).toEqual(['kinetograph', 'kinetograph-taste-clone']);
    for (const folder of folders) {
      expect(readFileSync(join(folder, 'kinetograph/references/A.md'), 'utf8')).toBe('ref');
      expect(readFileSync(join(folder, 'kinetograph-taste-clone/SKILL.md'), 'utf8')).toContain('kinetograph-taste-clone');
      expect(lstatSync(join(folder, 'kinetograph-taste-clone/scripts/probe.sh')).mode & 0o111).not.toBe(0);
    }
    expect(existsSync(join(folders[0]!, 'not-a-skill'))).toBe(false);
  });

  it('still installs the bundled skills when the registry cannot be read, and says so', async () => {
    const folders = [join(scratch(), 'skills')];
    const result = await updateSkills({ folders, registry: registry([]), bundled: bundled() });
    expect(result.failed).toContain('kinetograph-taste-clone not installed');
    expect(existsSync(join(folders[0]!, 'kinetograph/SKILL.md'))).toBe(true);
  });

  it('leaves a symlinked skill alone', async () => {
    const folder = scratch();
    const checkout = scratch();
    writeFileSync(join(checkout, 'SKILL.md'), 'mine');
    symlinkSync(checkout, join(folder, 'kinetograph'));
    const result = await updateSkills({ folders: [folder], registry: registry([skillItem]), bundled: bundled() });
    expect(result.skipped).toEqual([join(folder, 'kinetograph')]);
    expect(readFileSync(join(checkout, 'SKILL.md'), 'utf8')).toBe('mine');
  });

  it('is not installable with `add`', async () => {
    const project = scratch();
    writeFileSync(join(project, 'package.json'), '{}');
    await expect(addItems({ names: ['kinetograph-taste-clone'], dir: project, registry: registry([skillItem]), overwrite: false, yes: false })).rejects.toThrow(/skills update/);
  });
});
