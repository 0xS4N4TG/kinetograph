import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleProject, cacheDir, watchProject } from '../src/bundle.js';
import { setNativeForTests } from '../src/native.js';
import { openSource } from '../src/source.js';
import { fakeNative } from './helpers.js';

afterEach(() => setNativeForTests(undefined));

// A real project, bundled for the studio and for a render, and run through the real core on a stand-in addon.
const PROJECT = `import { AbsoluteFill, Composition, registerRoot, Sequence } from 'remotion';
import { Text } from '@kinetographdev/react';

const Title = ({ text }: { text: string }) => (
  <AbsoluteFill>
    <Text font="Inter" size={40}>{text}</Text>
    <Text id="caption" font="Inter" size={20}>small</Text>
  </AbsoluteFill>
);
const Opening = () => <Title text="Rewrote Remotion in Rust, from scratch" />;
const Main = () => (
  <>
    <Sequence from={0} durationInFrames={30}>
      <Opening />
    </Sequence>
    <Sequence name="Outro" from={30} durationInFrames={30}>
      <AbsoluteFill id="bg" />
    </Sequence>
  </>
);
registerRoot(() => <Composition id="Main" component={Main} width={64} height={36} fps={30} durationInFrames={60} />);
`;

function line(needle: string): number {
  return PROJECT.slice(0, PROJECT.indexOf(needle)).split('\n').length;
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kinetograph-cli-names-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
  writeFileSync(join(dir, 'index.tsx'), PROJECT);
  return dir;
}

async function studioBundle(entry: string): Promise<string> {
  const watching = await new Promise<{ code: string; dispose(): Promise<void> }>((resolve, reject) => {
    let dispose!: () => Promise<void>;
    watchProject(entry, (build) => {
      if ('error' in build) reject(build.error);
      else void resolve({ code: build.code, dispose });
    }).then((w) => (dispose = () => w.dispose()), reject);
  });
  await watching.dispose();
  const { mkdirSync } = await import('node:fs');
  const dir = cacheDir(entry);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'studio-names.mjs');
  writeFileSync(file, watching.code);
  return file;
}

describe('names and source locations in a studio build', () => {
  it('a render build carries none, and a studio build draws the same scene with names', async () => {
    setNativeForTests(fakeNative().native);
    const dir = project();
    const entry = join(dir, 'index.tsx');

    const render = await openSource(entry, { bundleFile: (await bundleProject(entry)).file });
    const plain = await render.frame(5);
    expect(plain.names).toBeUndefined();
    expect(plain.sequences?.every((s) => s.label === undefined && s.source === undefined)).toBe(true);

    const studio = await openSource(entry, { bundleFile: await studioBundle(entry) });
    const named = await studio.frame(5);
    // What is drawn is the same either way.
    expect(named.sceneJson).toBe(plain.sceneJson);

    const [opening, outro] = named.sequences!;
    expect(opening).toMatchObject({ label: 'Opening', component: 'Main', source: { file: expect.stringMatching(/index\.tsx$/), line: line('<Sequence from={0}'), column: 5 } });
    expect(outro).toMatchObject({ label: 'Outro', component: 'Main', source: { line: line('<Sequence name="Outro"') } });

    const names = named.names!;
    const scene = JSON.parse(named.sceneJson) as { layers: { id: string; children?: { id: string }[] }[] };
    // $0 is the Opening Sequence's group, $0.0 Title's AbsoluteFill, then its two texts.
    expect(names.$0).toMatchObject({ label: 'Opening' });
    expect(names['$0.0']).toMatchObject({ label: 'Title', component: 'Title', source: { line: line('<AbsoluteFill>\n    <Text') } });
    expect(names['$0.0.0']).toMatchObject({
      label: 'Title · “Rewrote Remotion in Rust, fro…”',
      component: 'Title',
      source: { line: line('<Text font="Inter" size={40}>') },
    });
    expect(names.caption).toMatchObject({ label: 'caption' });
    // An explicit id is the label; the group a named Sequence renders is the Sequence's name.
    const late = (await studio.frame(35)).names!;
    expect(late.$0).toMatchObject({ label: 'Outro', component: 'Main' });
    expect(late.bg).toMatchObject({ label: 'bg' });
    // Every layer the scene has is named.
    const ids: string[] = [];
    const walk = (list: { id: string; children?: { id: string }[] }[]) => list.forEach((l) => (ids.push(l.id), l.children && walk(l.children)));
    walk(scene.layers);
    for (const id of ids) expect(names[id], id).toBeDefined();
  }, 60_000);
});
