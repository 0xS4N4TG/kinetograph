// The default engine on a real project, for everything that needs no GPU: loading, the JS stage, `inspect` (CPU only) and
// the timeline. Nothing here asks for a preview or a render, so no `Renderer` is ever made. Needs the built addon (to
// measure text), so it is skipped where that is missing.

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Client, api, cleanup, start, stopAll, tempDir, until } from './helpers.js';

// Workers start slowly on a busy machine: each test spawns several.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const addon = (() => {
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
    return true;
  } catch {
    return false;
  }
})();

afterAll(async () => {
  await stopAll();
  cleanup();
});

const SOURCE = `
import { Composition, Layer, Rect, Sequence, Series, registerRoot } from 'remotion';


const Dot = () => <Rect id="dot" width={10} height={10} fill="#fff" />;
const Main = ({ label }: { label?: string }) => (
  <>
    <Rect id="bg" width={64} height={36} fill="#000" />
    <Sequence name="intro" from={5} durationInFrames={10}>
      <Dot />
      <Sequence name="inner" from={2} durationInFrames={3}>
        <Layer id="tag" />
      </Sequence>
    </Sequence>
    <Series>
      <Series.Sequence durationInFrames={8}><Layer id="s1" /></Series.Sequence>
      <Series.Sequence durationInFrames={8} name="second"><Layer id="s2" /></Series.Sequence>
    </Series>
  </>
);
registerRoot(() => <Composition id="Main" component={Main} width={64} height={36} fps={30} durationInFrames={20} defaultProps={{ label: 'hi' }} />);
`;

describe.skipIf(!addon)('the default engine (no GPU)', () => {
  it('loads a project, runs its JS stage for the timeline and inspects a frame', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
    const entry = join(dir, 'index.tsx');
    writeFileSync(entry, SOURCE);
    const server = await start(entry, { engine: undefined });

    expect((await api(server, '/api/project')).json).toMatchObject({ buildId: 1, buildError: null });
    const compositions = await api(server, '/api/compositions');
    expect(compositions.json).toEqual([{ id: 'Main', width: 64, height: 36, fps: 30, durationInFrames: 20, defaultProps: { label: 'hi' } }]);

    const timeline = await api(server, '/api/timeline?comp=Main');
    expect(timeline.status).toBe(200);
    expect(timeline.json).toMatchObject({ comp: 'Main', fps: 30, durationInFrames: 20 });
    const at = (needle: string) => SOURCE.slice(0, SOURCE.indexOf(needle)).split('\n').length;
    // A Sequence a library component makes (`<Series>`) is where the project wrote that component.
    const here = { file: expect.stringMatching(/index\.tsx$/), column: expect.any(Number) };
    expect(timeline.json.sequences).toMatchObject([
      { key: '/Sequence@0+8', name: null, from: 0, durationInFrames: 8, parent: null, layer: expect.any(String), label: 'Sequence', component: 'Main', source: { ...here, line: at('<Series>') } },
      { key: '/intro@5+10', name: 'intro', from: 5, durationInFrames: 10, parent: null, layer: expect.any(String), label: 'intro', component: 'Main', source: { ...here, line: at('<Sequence name="intro"') } },
      { key: '/intro@5+10/inner@7+3', name: 'inner', from: 7, durationInFrames: 3, parent: '/intro@5+10', layer: expect.any(String), label: 'inner' },
      { key: '/second@8+8', name: 'second', from: 8, durationInFrames: 8, parent: null, layer: expect.any(String), label: 'second' },
    ]);
    const layer = (id: string) => timeline.json.layers.find((l: { id: string }) => l.id === id);
    expect(layer('bg')).toMatchObject({
      id: 'bg', type: 'shape', parent: null, ranges: [[0, 19]],
      label: 'bg', component: 'Main', source: { ...here, line: at('<Rect id="bg"') },
    });
    // The Dot component drew the layer, on its own line; a Sequence's group is named after the Sequence.
    expect(layer('dot')).toMatchObject({ label: 'dot', component: 'Dot', source: { line: at('const Dot') } });
    expect(layer('dot')).toMatchObject({ parent: expect.any(String), ranges: [[5, 14]] });
    expect(layer('tag')).toMatchObject({ type: 'group', ranges: [[7, 9]] });
    // A layer in a Sequence's group says which Sequence, so the UI can nest it there.
    expect(layer('dot')).toMatchObject({ sequence: '/intro@5+10' });
    expect(layer('s1').ranges).toEqual([[0, 7]]);
    expect(layer('s2').ranges).toEqual([[8, 15]]);

    const inspected = await api(server, '/api/inspect?comp=Main&frame=8');
    expect(inspected.status).toBe(200);
    expect(inspected.json).toMatchObject({ width: 64, height: 36, fps: 30, frame: 8 });
    // The inspect has the same names as the timeline.
    expect(inspected.json.layers.find((l: { id: string }) => l.id === 'bg')).toMatchObject({ label: 'bg', component: 'Main' });
    const names = JSON.stringify(inspected.json.layers);
    for (const id of ['bg', 'dot', 'tag', 's2']) expect(names).toContain(`"id":"${id}"`);
    expect(names).not.toContain('"id":"s1"');

    expect((await api(server, '/api/inspect?comp=Main&frame=20')).status).toBe(400);
    expect((await api(server, '/api/inspect?comp=Main&frame=-1')).status).toBe(400);
  });

  it('rebuilds a real project on a save', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
    const entry = join(dir, 'index.tsx');
    writeFileSync(entry, SOURCE);
    const server = await start(entry, { engine: undefined });
    const client = await Client.connect(server);
    writeFileSync(entry, SOURCE.replace('durationInFrames={20}', 'durationInFrames={40}'));
    await client.waitForMessage('reload', (m) => m.buildId === 2, 15000);
    const compositions = await until(
      async () => (await api(server, '/api/compositions')).json,
      (list) => list[0]?.durationInFrames === 40,
    );
    expect(compositions[0].durationInFrames).toBe(40);

    // A project that throws while rendering is an error on that request, not a dead server.
    writeFileSync(entry, SOURCE.replace('<Dot />', '{(() => { throw new Error("boom in the project"); })()}'));
    await client.waitForMessage('reload', (m) => m.buildId === 3, 15000);
    const broken = await api(server, '/api/inspect?comp=Main&frame=6');
    expect(broken.status).toBe(500);
    expect(broken.json.error.message).toContain('boom in the project');
    client.close();
  });
});
