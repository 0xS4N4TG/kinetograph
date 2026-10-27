// `kinetograph track`'s arguments as they reach the addon (the addon itself is mocked; tracking is tested in
// crates/track and against Blender in scripts/track-parity/).

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCommandArgs } from '../src/args.js';
import { findCommand } from '../src/commands/index.js';
import { allOptions } from '../src/commands/types.js';
import { CliError } from '../src/errors.js';

const calls: { path: string; request: Record<string, unknown> }[] = [];
const reply = {
  version: 1,
  clip: { width: 640, height: 360, fps: 30, frames: 10 },
  tracks: ['a', 'p2', 'p3', 'p4', 'p5'].map((name) => ({ name, model: 'loc', frames: [{ frame: 0, center: [1, 2] }], lost: [] })),
  planes: [{ name: 'screen', tracks: ['a', 'p2', 'p3', 'p4'], frames: [{ frame: 0 }, { frame: 9 }] }],
};

vi.mock('../src/native.js', () => ({
  native: () => ({
    track: (path: string, request: Record<string, unknown>) => {
      calls.push({ path, request });
      return JSON.stringify(reply);
    },
  }),
}));

const { command } = findCommand(['track'])!;
const spec = { name: command.name, positionals: command.positionals, options: allOptions(command) };
const context = { progress: () => {}, announce: () => {} };

async function run(argv: string[]) {
  const out = join(mkdtempSync(join(tmpdir(), 'kt-track-cli-')), 'out.json');
  const result = await command.run(parseCommandArgs(spec, ['clip.mp4', ...argv, '-o', out]), context as never);
  return { result: result as { data: Record<string, unknown>; text: string }, request: calls.at(-1)!.request, written: readFileSync(out, 'utf8') };
}

async function refused(argv: string[]): Promise<string> {
  try {
    await run(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return (error as CliError).message;
  }
  throw new Error('not refused');
}

describe('kinetograph track', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('passes Detect Features and its settings, and polygons as numbers', async () => {
    const { request } = await run([
      '--point', 'a=10,20', '--detect', '--detect-threshold', '0.1', '--detect-distance', '60', '--detect-margin', '8',
      '--detect-inside', '0,0,100,0,100,80', '--detect-inside', '200,0,300,0,250,90',
    ]);
    expect(request.points).toEqual([{ name: 'a', x: 10, y: 20 }]);
    expect(request.detect).toEqual({ margin: 8, threshold: 0.1, minDistance: 60, inside: [[0, 0, 100, 0, 100, 80], [200, 0, 300, 0, 250, 90]] });
    const { request: plain } = await run(['--detect']);
    expect(plain.points).toEqual([]);
    expect(plain.detect).toEqual({ margin: undefined, threshold: undefined, minDistance: undefined });
    expect(plain.planes).toBeUndefined();
  });

  it('passes plane tracks: all, named tracks, and corners matched by plane name', async () => {
    const { request, result, written } = await run([
      '--detect', '--plane', 'all', '--plane', 'screen=a,p2,p3,p4', '--plane-corners', 'screen=1,2,3,4,5,6,7,8',
    ]);
    expect(request.planes).toEqual([
      { name: 'plane1' },
      { name: 'screen', tracks: ['a', 'p2', 'p3', 'p4'], corners: [1, 2, 3, 4, 5, 6, 7, 8] },
    ]);
    expect(result.data.planes).toEqual([{ name: 'screen', tracks: ['a', 'p2', 'p3', 'p4'], first: 0, last: 9, frames: 2 }]);
    expect(result.data.detected).toBe(5);
    expect(result.text).toContain('plane screen (4 tracks): frames 0..9');
    expect(JSON.parse(written)).toEqual(reply);
    // Unnamed corners go to the first plane.
    const { request: first } = await run(['--point', '1,1', '--plane', 'p1,p2,p3,p4', '--plane-corners', '0,0,10,0,10,10,0,10']);
    expect(first.planes).toEqual([{ name: 'plane1', tracks: ['p1', 'p2', 'p3', 'p4'], corners: [0, 0, 10, 0, 10, 10, 0, 10] }]);
  });

  it('refuses what cannot be right before tracking', async () => {
    expect(await refused([])).toMatch(/--point x,y, or --detect/);
    expect(await refused(['--point', '1,1', '--detect-threshold', '0.1'])).toMatch(/--detect-threshold needs --detect/);
    expect(await refused(['--detect', '--detect-inside', '0,0,1,1'])).toMatch(/x,y pairs, at least three/);
    expect(await refused(['--detect', '--detect-inside', '0,0,1,0,1,1', '--detect-outside', '0,0,1,0,1,1'])).toMatch(/one placement/);
    expect(await refused(['--detect', '--plane-corners', '0,0,1,0,1,1,0,1'])).toMatch(/needs a --plane/);
    expect(await refused(['--detect', '--plane', 'all', '--plane-corners', 'nope=0,0,1,0,1,1,0,1'])).toMatch(/names no --plane "nope"/);
    expect(await refused(['--detect', '--plane', 'all', '--plane-corners', '0,0,1,0'])).toMatch(/8 numbers/);
    expect(calls).toEqual([]);
  });
});
