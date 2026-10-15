import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneJson, Unsupported } from '@kinetograph/scene';
import { run } from '../src/index.js';
import { setNativeForTests } from '../src/native.js';
import type { Source } from '../src/source.js';
import { LABEL_FONT_PATH } from '../src/scenes.js';
import { fakeNative, type Calls } from './helpers.js';

// `openSource` is the seam to things that need a real bundle.
const seam = vi.hoisted(() => ({ source: undefined as undefined | (() => unknown) }));
vi.mock('../src/source.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/source.js')>();
  return { ...actual, openSource: (entry: string, options: object) => seam.source?.() ?? actual.openSource(entry, options) };
});

let calls: Calls;
const scratch = (): string => mkdtempSync(join(tmpdir(), 'kinetograph-compat-cli-'));

async function cli(...argv: string[]): Promise<{ code: number; json: any; text: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) });
  const text = out.join('');
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { code, json, text, err: err.join('') };
}

const issue: Unsupported = { path: '$0 <div>', element: 'div', property: 'filter', value: 'url(#x)', reason: 'an SVG filter is not supported' };

/** A project whose frames in `unsupported` hold something the engine cannot draw. */
function project(unsupported: number[]): Source {
  const dir = scratch();
  return {
    kind: 'project',
    entry: join(dir, 'index.tsx'),
    baseDir: dir,
    composition: { id: 'Main', width: 64, height: 36, fps: 30, durationInFrames: 90, defaultProps: {} },
    async frame(frame) {
      const scene: SceneJson = {
        width: 64, height: 36, fps: 30, durationInFrames: 90, background: '#000', fonts: { 'DM Sans': LABEL_FONT_PATH },
        layers: [{ id: `frame-${frame}`, type: 'shape', shape: { kind: 'rect', width: 8, height: 8 }, fill: '#fff' }],
      };
      return { sceneJson: JSON.stringify(scene), audio: [], unsupported: unsupported.includes(frame) ? [issue] : [], jsMs: 1, stringifyMs: 0 };
    },
    dispose() {},
  };
}

beforeEach(() => {
  const fake = fakeNative();
  calls = fake.calls;
  setNativeForTests(fake.native);
  seam.source = undefined;
});

describe('still', () => {
  it('draws a frame with unsupported content anyway and warns on stderr', async () => {
    seam.source = () => project([7]);
    const clean = await cli('still', 'index.tsx', '3', '-o', join(scratch(), 'a.png'), '--json');
    expect(clean.json).toMatchObject({ frame: 3, compat: { unsupportedFrames: 0, leftOut: [] } });
    expect(clean.err).not.toContain('warning');

    const r = await cli('still', 'index.tsx', '7', '-o', join(scratch(), 'b.png'));
    expect(r.code).toBe(0);
    expect(calls.still.map((c) => c.frame)).toEqual([3, 7]);
    expect(r.err).toContain('warning: 1 kind of unsupported content in 1 frame, drawn without it or approximated');
    expect(r.err).toContain('div { filter: url(#x) }: an SVG filter is not supported (frame 7)');
  });

  it('keeps what it left out in the JSON result', async () => {
    seam.source = () => project([7]);
    const r = await cli('still', 'index.tsx', '7', '-o', join(scratch(), 'c.png'), '--json');
    expect(r.code).toBe(0);
    expect(r.json.compat).toMatchObject({ unsupportedFrames: 1, leftOut: [{ element: 'div', property: 'filter', frames: 1 }] });
  });

  it('--strict fails on a frame with unsupported content and draws nothing', async () => {
    seam.source = () => project([7]);
    const output = join(scratch(), 'd.png');
    const r = await cli('still', 'index.tsx', '7', '-o', output, '--strict', '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('UNSUPPORTED_CONTENT');
    expect(r.json.error.message).toContain('div { filter: url(#x) }: an SVG filter is not supported');
    expect(calls.still).toHaveLength(0);
    expect(existsSync(output)).toBe(false);
    const ok = await cli('still', 'index.tsx', '3', '-o', output, '--strict', '--json');
    expect(ok.code).toBe(0);
  });

  it('no longer takes --compat', async () => {
    seam.source = () => project([]);
    const r = await cli('still', 'index.tsx', '3', '-o', join(scratch(), 'e.png'), '--compat', 'native', '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('INVALID_ARG');
  });
});

describe('strip', () => {
  it('draws every sampled frame, builds the sheet and warns', async () => {
    seam.source = () => project([30]);
    const output = join(scratch(), 'sheet.png');
    const r = await cli('strip', 'index.tsx', '-n', '4', '-o', output, '--json');
    expect(r.code).toBe(0);
    expect(r.json.frames).toEqual([0, 30, 59, 89]);
    expect(r.json.compat).toMatchObject({ unsupportedFrames: 1 });
    expect(calls.still.map((c) => c.frame)).toEqual([0, 30, 59, 89, 0]);
    const sheet = calls.still[4]!.scene as SceneJson;
    expect(sheet.layers.filter((l) => l.type === 'image')).toHaveLength(4);
    const text = await cli('strip', 'index.tsx', '-n', '4', '-o', output);
    expect(text.err).toContain('warning: 1 kind of unsupported content');
  });

  it('--strict fails before the sheet is built', async () => {
    seam.source = () => project([30]);
    const r = await cli('strip', 'index.tsx', '-n', '4', '-o', join(scratch(), 'sheet.png'), '--strict', '--json');
    expect(r.json.error.code).toBe('UNSUPPORTED_CONTENT');
    expect(calls.still.map((c) => c.frame)).toEqual([0]);
  });
});

describe('render', () => {
  it('draws every frame and says in the text how many left something out', async () => {
    seam.source = () => project([2, 3]);
    const r = await cli('render', 'index.tsx', '-o', join(scratch(), 'p.mp4'), '--range', '0..6');
    expect(r.code).toBe(0);
    expect(calls.pushed.map((p) => p.frame)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.text).toContain('unsupported content left out of 2 frames');
    expect(r.err).toContain('warning: 1 kind of unsupported content in 2 frames');
    expect(r.err).toContain('(2 frames, 2..=3)');
  });

  it('puts what it left out in the JSON result', async () => {
    seam.source = () => project([2, 3]);
    const r = await cli('render', 'index.tsx', '-o', join(scratch(), 'p.mp4'), '--range', '0..6', '--json');
    expect(r.json.compat).toMatchObject({ unsupportedFrames: 2, leftOut: [{ element: 'div', frames: 2, firstFrame: 2, lastFrame: 3 }] });
  });

  it('says nothing about it for a project with nothing unsupported', async () => {
    seam.source = () => project([]);
    const r = await cli('render', 'index.tsx', '-o', join(scratch(), 'p.mp4'), '--range', '0..3');
    expect(r.text).not.toContain('unsupported');
    expect(r.err).not.toContain('warning');
  });

  it('--strict fails on the first frame with unsupported content', async () => {
    seam.source = () => project([2, 3]);
    const r = await cli('render', 'index.tsx', '-o', join(scratch(), 'p.mp4'), '--range', '0..6', '--strict', '--json');
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('UNSUPPORTED_CONTENT');
    expect(r.json.error.message).toContain('frame 2 holds content the engine cannot draw');
    expect(calls.pushed.map((p) => p.frame)).toEqual([0, 1]);
    expect(calls.aborted).toBe(1);
  });

  it('--strict is an option of the commands that draw frames, and the MCP tools see it', async () => {
    const { toolCommands, inputShape } = await import('../src/mcp.js');
    for (const name of ['still', 'render', 'strip']) {
      const command = toolCommands().find((c) => c.name === name)!;
      expect(Object.keys(inputShape(command)), name).toContain('strict');
    }
    const onion = toolCommands().find((c) => c.name === 'onion')!;
    expect(Object.keys(inputShape(onion))).not.toContain('strict');
  });
});
