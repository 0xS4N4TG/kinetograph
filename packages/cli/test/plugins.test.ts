import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { bundlePanel, findPlugins } from '../src/plugins.js';
import { parseProps } from '../src/source.js';

const root = mkdtempSync(join(tmpdir(), 'kinetograph-plugins-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// A project with two dependencies that are plugins, one that is not, and one that is not installed.
const project = join(root, 'proj');
write(
  join(project, 'package.json'),
  JSON.stringify({ dependencies: { 'fx-a': '^1.0.0', plain: '1.0.0', missing: '1.0.0' }, devDependencies: { 'fx-b': '2.0.0' } }),
);
write(join(project, 'src/index.tsx'), '');
write(
  join(project, 'node_modules/fx-a/package.json'),
  JSON.stringify({ name: 'fx-a', version: '1.2.3', kinetograph: { skill: './SKILL.md', panel: './studio/panel.ts' } }),
);
write(join(project, 'node_modules/fx-a/SKILL.md'), '# fx-a');
write(join(project, 'node_modules/fx-a/studio/helper.ts'), 'export const label = "from helper";');
write(
  join(project, 'node_modules/fx-a/studio/panel.ts'),
  "import { label } from './helper';\nexport function mount(el: HTMLElement) { el.textContent = label; return { update() {}, unmount() {} }; }\n",
);
// Its skill points outside the package, so it is ignored.
write(join(project, 'node_modules/fx-b/package.json'), JSON.stringify({ name: 'fx-b', version: '2.0.0', kinetograph: { skill: '../escape.md' } }));
write(join(project, 'node_modules/escape.md'), 'x');
write(join(project, 'node_modules/plain/package.json'), JSON.stringify({ name: 'plain', version: '1.0.0' }));

describe('findPlugins', () => {
  it('finds the dependencies with a kinetograph field, from a file or a directory', () => {
    for (const entry of [join(project, 'src/index.tsx'), project]) {
      expect(findPlugins(entry)).toEqual([
        {
          name: 'fx-a',
          version: '1.2.3',
          skill: join(project, 'node_modules/fx-a/SKILL.md'),
          panelFile: join(project, 'node_modules/fx-a/studio/panel.ts'),
        },
        { name: 'fx-b', version: '2.0.0', skill: null, panelFile: null },
      ]);
    }
  });

  it('finds nothing in a project without plugins', () => {
    write(join(root, 'empty/package.json'), '{}');
    expect(findPlugins(join(root, 'empty'))).toEqual([]);
  });

  it('bundles a panel with its imports for the browser', async () => {
    const code = await bundlePanel(join(project, 'node_modules/fx-a/studio/panel.ts'));
    expect(code).toContain('from helper');
    expect(code).toMatch(/export\s*\{/);
  });
});

describe('plugins command', () => {
  const cli = async (...argv: string[]) => {
    const out: string[] = [];
    const code = await run(argv, { out: (s) => void out.push(s), err: () => undefined });
    return { code, text: out.join('') };
  };

  it('lists them as text and as JSON', async () => {
    const text = await cli('plugins', project);
    expect(text.code).toBe(0);
    expect(text.text).toContain('fx-a@1.2.3');
    expect(text.text).toContain('panel: yes');
    const json = JSON.parse((await cli('plugins', project, '--json')).text);
    expect(json.plugins).toEqual([
      { name: 'fx-a', version: '1.2.3', skill: join(project, 'node_modules/fx-a/SKILL.md'), hasPanel: true },
      { name: 'fx-b', version: '2.0.0', skill: null, hasPanel: false },
    ]);
  });
});

describe('parseProps with a file', () => {
  it('reads a JSON file that does not start with a brace', () => {
    write(join(root, 'warm.json'), '{"title":"Warm"}');
    expect(parseProps(join(root, 'warm.json'))).toEqual({ title: 'Warm' });
    expect(parseProps('{"a":1}')).toEqual({ a: 1 });
  });

  it('still reports bad JSON, in a file or inline', () => {
    write(join(root, 'bad.json'), '[1]');
    expect(() => parseProps(join(root, 'bad.json'))).toThrow(/must be a JSON object/);
    expect(() => parseProps(join(root, 'nope.json'))).toThrow(/not valid JSON/);
    expect(() => parseProps('{nope')).toThrow(/not valid JSON/);
  });
});
