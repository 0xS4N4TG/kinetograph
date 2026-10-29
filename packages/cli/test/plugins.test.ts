import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { bundlePanel, findPlugins, loadPluginTools, mcpToolName } from '../src/plugins.js';
import { parseProps } from '../src/source.js';
import { toolsProject } from './helpers.js';

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
          toolsFile: null,
        },
        { name: 'fx-b', version: '2.0.0', skill: null, panelFile: null, toolsFile: null },
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
      { name: 'fx-a', version: '1.2.3', skill: join(project, 'node_modules/fx-a/SKILL.md'), hasPanel: true, tools: [] },
      { name: 'fx-b', version: '2.0.0', skill: null, hasPanel: false, tools: [] },
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

describe('plugin tools', () => {
  it('maps names: the scope is dropped and dashes become underscores', () => {
    expect(mcpToolName({ name: '@kinetographdev/hexed' }, { name: 'roll' })).toBe('hexed_roll');
    expect(mcpToolName({ name: 'my-fx' }, { name: 'a' })).toBe('my_fx_a');
  });

  it('loads a plugin\'s tools; one whose module throws or whose tool is invalid fails to load', async () => {
    const dir = toolsProject(root);
    const [dice, bad, shape] = findPlugins(dir);
    const tools = await loadPluginTools(dice!);
    expect(tools.map((t) => t.name)).toEqual(['roll', 'fail']);
    expect(await tools[0]!.run({ sides: 6, count: 2 })).toEqual({ total: 12 });
    await expect(loadPluginTools(bad!)).rejects.toThrow(/boom/);
    await expect(loadPluginTools(shape!)).rejects.toThrow(/snake_case/);
  });

  it('lists the MCP names in `plugins --json`, none for a plugin whose tools do not load', async () => {
    const dir = toolsProject(root);
    const out: string[] = [];
    const err: string[] = [];
    await run(['plugins', dir, '--json'], { out: (s) => void out.push(s), err: (s) => void err.push(s) });
    const json = JSON.parse(out.join(''));
    expect(json.plugins.map((p: { name: string; tools: string[] }) => [p.name, p.tools])).toEqual([
      ['@fx/dice', ['dice_roll', 'dice_fail']],
      ['fx-bad', []],
      ['fx-shape', []],
    ]);
  });
});
