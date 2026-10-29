import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StudioServer } from '../src/index.js';
import { api, cleanup, projectSource, start, stopAll, tempDir, text } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let studio: StudioServer;
let dir: string;

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

beforeAll(async () => {
  dir = tempDir();
  write(join(dir, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@fx/hexed': '1.0.0', 'fx-broken': '1.0.0', plain: '1.0.0' } }));
  write(join(dir, 'index.tsx'), projectSource('Plugins'));
  const hexed = join(dir, 'node_modules/@fx/hexed');
  write(join(hexed, 'package.json'), JSON.stringify({ name: '@fx/hexed', version: '1.0.0', kinetograph: { skill: './SKILL.md', panel: './studio/panel.ts', tools: './tools.ts' } }));
  write(join(hexed, 'tools.ts'), "import { z } from 'zod';\nexport const tools = [{ name: 'roll', description: 'Rolls.', input: z.object({}), run: () => 1 }];\n");
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(join(import.meta.dirname, '../../../node_modules/zod'), join(dir, 'node_modules/zod'));
  write(join(hexed, 'SKILL.md'), '# hexed');
  write(join(hexed, 'studio/label.ts'), 'export const label: string = "hexed panel";');
  write(join(hexed, 'studio/panel.ts'), "import { label } from './label';\nexport const mount = (el: HTMLElement) => { el.textContent = label; };\n");
  const broken = join(dir, 'node_modules/fx-broken');
  write(join(broken, 'package.json'), JSON.stringify({ name: 'fx-broken', version: '0.1.0', kinetograph: { panel: './panel.ts' } }));
  write(join(broken, 'panel.ts'), "import './missing';\n");
  write(join(dir, 'node_modules/plain/package.json'), JSON.stringify({ name: 'plain', version: '1.0.0' }));
  studio = await start(join(dir, 'index.tsx'));
});
afterAll(async () => {
  await stopAll();
  cleanup();
});

describe('plugins', () => {
  it('GET /api/plugins lists the installed plugins with a skill path and a panel URL', async () => {
    const r = await api(studio, '/api/plugins');
    expect(r.status).toBe(200);
    expect(r.json.plugins).toEqual([
      { name: '@fx/hexed', version: '1.0.0', skill: join(dir, 'node_modules/@fx/hexed/SKILL.md'), panel: '/api/plugins/%40fx%2Fhexed/panel.js', tools: ['hexed_roll'] },
      { name: 'fx-broken', version: '0.1.0', skill: null, panel: '/api/plugins/fx-broken/panel.js', tools: [] },
    ]);
  });

  it('serves the panel bundled, as JavaScript', async () => {
    const r = await api(studio, '/api/plugins/%40fx%2Fhexed/panel.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/javascript');
    expect(text(r.body)).toContain('hexed panel');
    expect(text(r.body)).toContain('mount');
  });

  it('answers 404 for an unknown plugin and a BUILD error for a panel that does not build', async () => {
    expect((await api(studio, '/api/plugins/nope/panel.js')).status).toBe(404);
    expect((await api(studio, '/api/plugins/plain/panel.js')).status).toBe(404);
    const r = await api(studio, '/api/plugins/fx-broken/panel.js');
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('BUILD');
    expect(r.json.error.message).toContain('did not build');
  });
});
