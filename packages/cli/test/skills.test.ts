import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findCommand } from '../src/commands/index.js';
import { globalSkillFolders, updateSkills } from '../src/commands/skills.js';
import { addItems } from '../src/registry/install.js';
import { openRegistry } from '../src/registry/source.js';
import { run } from '../src/index.js';
import { skillVersion } from '../src/update-notice.js';
import { cliVersion } from '../src/version.js';

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

  it('is a command, and installs the packaged skills with the current version stamp into a fresh home', async () => {
    expect(findCommand(['skills', 'update'])?.command.name).toBe('skills update');
    const home = scratch();
    const folders = globalSkillFolders(home, {});
    const packaged = readdirSync(new URL('../skills', import.meta.url)).filter((name) => name.startsWith('kinetograph'));
    expect(packaged).toHaveLength(8);
    const result = await updateSkills({ folders, registry: registry([]) });
    for (const folder of folders) {
      for (const name of packaged) expect(skillVersion(readFileSync(join(folder, name, 'SKILL.md'), 'utf8'))).toBe(cliVersion());
    }
    expect(result.failed).toContain('kinetograph-taste-clone not installed');
  });

  describe('through the CLI', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('`skills update` writes only into the four skill folders of the home folder', async () => {
      const home = scratch();
      const out: string[] = [];
      vi.stubEnv('HOME', home);
      vi.stubEnv('USERPROFILE', home);
      vi.stubEnv('CLAUDE_CONFIG_DIR', '');
      vi.stubEnv('CODEX_HOME', '');
      vi.stubEnv('KINETOGRAPH_REGISTRY', join(scratch()));
      const code = await run(['skills', 'update'], { out: (s) => void out.push(s), err: () => undefined });
      expect(code).toBe(1);
      expect(readdirSync(home).sort()).toEqual(['.agents', '.claude', '.codex', '.cursor']);
      expect(readdirSync(join(home, '.claude'))).toEqual(['skills']);
      expect(existsSync(join(home, '.claude/skills/kinetograph/SKILL.md'))).toBe(true);
      expect(out.join('')).toContain('installed kinetograph');
    });
  });
});
