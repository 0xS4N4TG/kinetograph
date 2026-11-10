// `kinetograph matte`: its options, what reaches the matting package, and its JSON. The addon is a stand-in (matting
// itself is tested in crates/ and packages/video-matting); the model "download" is served from a stand-in too.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetVideoMattingForTests, setAddonForTests, setFetchForTests, setModelsForTests, type MatteVideoOptions } from '@kinetographdev/video-matting/testing';
import { parseCommandArgs } from '../src/args.js';
import { findCommand } from '../src/commands/index.js';
import { allOptions } from '../src/commands/types.js';
import { CliError } from '../src/errors.js';

vi.mock('../src/native.js', () => ({ native: () => ({}) }));

const { command } = findCommand(['matte'])!;
const spec = { name: command.name, positionals: command.positionals, options: allOptions(command) };
const logged: string[] = [];
const context = { progress: (m: string) => logged.push(m), announce: () => {} };

const MODEL = Buffer.alloc(30_000, 5);
const calls: MatteVideoOptions[] = [];
let fetched = 0;
let dir: string;
let video: string;
const before = process.env.KINETOGRAPH_MODEL_DIR;

function addon(over: { available?: boolean } = {}) {
  return {
    mattingSupport: () => ({ available: over.available ?? true, backend: 'cpu' as const, ...(over.available === false ? { reason: 'no backend' } : {}) }),
    probeMedia: () => ({ width: 320, height: 180, durationInSeconds: 1, fps: 10, frames: 10, hasAudio: true }),
    async matteVideo(request: MatteVideoOptions, onProgress?: (d: number, t: number) => void) {
      calls.push(request);
      for (let i = 1; i <= 10; i++) onProgress?.(i, 10);
      writeFileSync(request.foreground, 'FG');
      if (request.base) writeFileSync(request.base, 'BASE');
      return { foreground: request.foreground, ...(request.base ? { base: request.base } : {}), frames: 10, backend: 'cpu' };
    },
  };
}

beforeEach(() => {
  resetVideoMattingForTests();
  calls.length = 0;
  logged.length = 0;
  fetched = 0;
  dir = mkdtempSync(join(tmpdir(), 'kt-matte-cli-'));
  process.env.KINETOGRAPH_MODEL_DIR = join(dir, 'models');
  video = join(dir, 'clip.mp4');
  writeFileSync(video, 'video');
  setModelsForTests(
    ['modnet', 'ben2-base'].map((name) => ({
      name, modelId: `test/${name}`, purpose: 'x', license: 'MIT', revision: 'c'.repeat(40), file: 'onnx/model.onnx', size: MODEL.length,
      sha256: createHash('sha256').update(MODEL).digest('hex'),
    })),
  );
  setFetchForTests((async () => {
    fetched++;
    return new Response(MODEL);
  }) as typeof fetch);
  setAddonForTests(addon());
});

afterEach(() => {
  resetVideoMattingForTests();
  if (before === undefined) delete process.env.KINETOGRAPH_MODEL_DIR;
  else process.env.KINETOGRAPH_MODEL_DIR = before;
});

async function run(argv: string[]) {
  const result = await command.run(parseCommandArgs(spec, [video, ...argv]), context as never);
  return result as { data: Record<string, unknown>; text: string };
}

async function refused(argv: string[]): Promise<CliError> {
  try {
    await run(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error('not refused');
}

describe('kinetograph matte', () => {
  it('writes <video>.foreground.webm by default, downloads the model first, and says so in JSON', async () => {
    const { data, text } = await run([]);
    const foreground = join(dir, 'clip.foreground.webm');
    expect(data).toEqual({
      foreground, model: 'modnet', backend: 'cpu', frames: 10, width: 320, height: 180, durationInSeconds: 1, audio: 'keep', quality: 'very-high', bytes: { foreground: 2 },
    });
    expect(readFileSync(foreground, 'utf8')).toBe('FG');
    expect(fetched).toBe(1);
    expect(calls[0]).toMatchObject({ input: video, model: 'modnet', keepAudio: true, audio: 'both', quality: 'very-high' });
    expect(calls[0]!.base).toBeUndefined();
    expect(text).toContain(`wrote ${foreground}`);
    expect(logged.some((l) => l.startsWith('downloading the modnet model'))).toBe(true);
    expect(logged).toContain('  model 100%');
    expect(logged).toContain('  50% (5 frames)');
    expect(logged.at(-1)).toBe('  finishing the files');
    // Nothing half-written is left beside the output.
    expect(readdirSync(dir).filter((n) => n.includes('partial'))).toEqual([]);
  });

  it('does not download a cached model again', async () => {
    await run([]);
    await run([]);
    expect(fetched).toBe(1);
    expect(logged.filter((l) => l.startsWith('downloading')).length).toBe(1);
  });

  it('takes -o, --base, --model, --audio and --quality, and makes the folders', async () => {
    const out = join(dir, 'public', 'fg.mov');
    const base = join(dir, 'public', 'base.webm');
    const { data } = await run(['-o', out, '--base', base, '--model', 'ben2-base', '--audio', 'drop', '--quality', 'medium']);
    expect(data).toMatchObject({ foreground: out, base, model: 'ben2-base', audio: 'drop', quality: 'medium', bytes: { foreground: 2, base: 4 } });
    expect(calls[0]).toMatchObject({ model: 'ben2-base', keepAudio: false, audio: 'none', quality: 'medium' });
    expect(calls[0]!.foreground.endsWith('.mov') && calls[0]!.base!.endsWith('.webm')).toBe(true);
    expect(readFileSync(base, 'utf8')).toBe('BASE');
    await run(['--quality', 'very-low']);
    expect(calls.at(-1)).toMatchObject({ quality: 'very-low' });
  });

  it('refuses bad options before downloading or running anything', async () => {
    const cases: [string[], RegExp, string][] = [
      [['--model', 'rvm'], /--model must be one of modnet, ben2-base/, 'INVALID_ARG'],
      [['--audio', 'both'], /--audio must be one of keep, drop/, 'INVALID_ARG'],
      [['--quality', 'ultra'], /--quality must be one of very-low, low, medium, high, very-high/, 'INVALID_ARG'],
      [['-o', join(dir, 'fg.mp4')], /--output must end in \.webm/, 'INVALID_ARG'],
      [['--base', join(dir, 'b.gif')], /--base must end in \.webm/, 'INVALID_ARG'],
      [['-o', video.replace('.mp4', '.mov'), '--base', video.replace('.mp4', '.mov')], /same file/, 'INVALID_ARG'],
    ];
    for (const [argv, message, code] of cases) {
      const error = await refused(argv);
      expect(error.message).toMatch(message);
      expect(error.code).toBe(code);
    }
    writeFileSync(join(dir, 'in.webm'), 'v');
    const sameAsInput = parseCommandArgs(spec, [join(dir, 'in.webm'), '-o', join(dir, 'in.webm')]);
    await expect(command.run(sameAsInput, context as never)).rejects.toThrow('overwrite the input');
    video = join(dir, 'missing.mp4');
    expect((await refused([])).code).toBe('IO');
    expect(fetched).toBe(0);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(dir, 'models'))).toBe(false);
  });

  it('with --offline refuses a model that is not cached, and runs one that is', async () => {
    const error = await refused(['--offline']);
    expect(error.code).toBe('MODEL_NOT_DOWNLOADED');
    expect(error.message).toContain('--offline');
    expect(fetched).toBe(0);
    await run([]);
    await run(['--offline']);
    expect(fetched).toBe(1);
  });

  it('says matting is not in this build, before downloading the model', async () => {
    setAddonForTests({});
    const error = await refused([]);
    expect(error.code).toBe('MATTING_UNAVAILABLE');
    expect(error.message).toContain("isn't in this build");
    setAddonForTests(addon({ available: false }));
    expect((await refused([])).message).toContain('no backend');
    expect(fetched).toBe(0);
  });

  it('is a command the CLI lists and takes the video as its positional', () => {
    expect(command.positionals.map((p) => p.name)).toEqual(['video']);
    expect(allOptions(command).map((o) => o.name)).toEqual(['output', 'base', 'model', 'audio', 'quality', 'offline']);
  });
});
