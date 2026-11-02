import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { setNativeForTests } from '../src/native.js';
import { projectRootOf } from '../src/source.js';
import { fakeNative, type Calls } from './helpers.js';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'kinetograph-layout-test-'));

async function cli(...argv: string[]): Promise<{ code: number; json: any; text: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (s) => void out.push(s), err: (s) => void err.push(s) });
  const text = out.join('');
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { code, json, text, err: err.join('') };
}

const files = (dir: string): string[] => (readdirSync(dir, { recursive: true }) as string[]).map((f) => f.replaceAll('\\', '/')).sort();

describe('default output paths', () => {
  let calls: Calls;
  beforeEach(() => {
    const fake = fakeNative();
    calls = fake.calls;
    setNativeForTests(fake.native);
  });
  afterEach(() => setNativeForTests(undefined));

  const scene = {
    width: 64, height: 36, fps: 30, durationInFrames: 90, background: '#000',
    layers: [{ id: 'bg', type: 'shape', shape: { kind: 'rect', width: 64, height: 36 }, fill: '#fff' }],
  };
  /** A project folder with a package.json and a scene file two levels down; returns [root, entry]. */
  function project(): [string, string] {
    const root = scratch();
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, 'src/deep'), { recursive: true });
    const entry = join(root, 'src/deep/clip.json');
    writeFileSync(entry, JSON.stringify(scene));
    return [root, entry];
  }

  it('writes a still to out/stills under the package.json folder', async () => {
    const [root, entry] = project();
    const r = await cli('still', entry, '3', '--json');
    expect(r.code).toBe(0);
    const expected = join(root, 'out/stills/clip-f3.png');
    expect(r.json.output).toBe(expected);
    expect(readFileSync(expected).subarray(1, 4).toString()).toBe('PNG');
    expect((await cli('still', entry, '4')).text).toContain(`wrote ${join(root, 'out/stills/clip-f4.png')}`);
  });

  it('writes strip and onion sheets to out/sheets', async () => {
    const [root, entry] = project();
    const strip = await cli('strip', entry, '-n', '3', '--json');
    expect(strip.json.output).toBe(join(root, 'out/sheets/clip-strip.png'));
    const onion = await cli('onion', entry, '0..30', '-n', '3', '--json');
    expect(onion.json.output).toBe(join(root, 'out/sheets/clip-onion.png'));
    expect(files(join(root, 'out'))).toEqual(['sheets', 'sheets/clip-onion.png', 'sheets/clip-strip.png']);
  });

  it('writes a render to out/renders with the extension of --codec', async () => {
    const [root, entry] = project();
    expect((await cli('render', entry, '--json')).json.output).toBe(join(root, 'out/renders/clip.mp4'));
    expect(calls.render[0]!.output).toBe(join(root, 'out/renders/clip.mp4'));
    for (const [codec, ext] of [['h265', 'mp4'], ['prores', 'mov'], ['vp9', 'webm'], ['gif', 'gif']] as const) {
      const r = await cli('render', entry, '--codec', codec, '--json');
      expect(r.json.output).toBe(join(root, `out/renders/clip.${ext}`));
    }
  });

  it('uses the entry\'s folder when there is no package.json above it', async () => {
    const dir = scratch();
    const entry = join(dir, 'clip.json');
    writeFileSync(entry, JSON.stringify(scene));
    expect((await cli('still', entry, '0', '--json')).json.output).toBe(join(dir, 'out/stills/clip-f0.png'));
  });

  it('keeps -o exactly as given and makes no out/ folder', async () => {
    const [root, entry] = project();
    const own = join(scratch(), 'mine', 'f.png');
    expect((await cli('still', entry, '3', '-o', own, '--json')).json.output).toBe(own);
    expect(existsSync(own)).toBe(true);
    const video = join(scratch(), 'v.mp4');
    expect((await cli('render', entry, '-o', video, '--json')).json.output).toBe(video);
    expect(existsSync(join(root, 'out'))).toBe(false);
  });

  it('finds the project folder from a file, a folder or a missing path', () => {
    const [root, entry] = project();
    expect(projectRootOf(entry)).toBe(root);
    expect(projectRootOf(join(root, 'src'))).toBe(root);
    const loose = scratch();
    expect(projectRootOf(join(loose, 'a.json'))).toBe(loose);
  });
});
