import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { whole } from '../args.js';
import { CliError } from '../errors.js';
import { buildOnionScene, buildStripScene, stripLayout, type SheetFrame } from '../scenes.js';
import { evenFrames, frameRange, type Source } from '../source.js';
import { nowMs } from '../time.js';
import {
  ENTRY,
  OUTPUT_OPTION,
  ensureParentDir,
  newRenderer,
  openFromArgs,
  requireOutput,
  type Command,
} from './types.js';

const MAX_FRAMES = 64;

/** Renders `frames` of the source to PNGs in a fresh temp directory. */
async function renderFrames(source: Source, frames: number[]): Promise<{ dir: string; files: SheetFrame[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'kinetograph-sheet-'));
  try {
    const renderer = newRenderer();
    const files: SheetFrame[] = [];
    for (const frame of frames) {
      const { sceneJson } = await source.frame(frame);
      const file = `frame-${frame}.png`;
      writeFileSync(join(dir, file), renderer.still(sceneJson, frame, source.baseDir));
      files.push({ file, frame });
    }
    return { dir, files };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export const strip: Command = {
  name: 'strip',
  summary: 'Contact sheet of evenly spaced frames, labelled with frame and time',
  project: true,
  positionals: [ENTRY],
  options: [
    { name: 'count', short: 'n', type: 'number', description: `Number of frames (default 12, at most ${MAX_FRAMES})` },
    OUTPUT_OPTION,
    { name: 'range', type: 'string', description: 'Frames to sample, as 10..40; default all' },
    { name: 'cols', type: 'number', description: 'Columns of the sheet (default 4 for landscape, 6 for portrait)' },
  ],
  async run(args) {
    const output = requireOutput(args);
    const count = whole('-n', args.options.count as number | undefined, 1, 12);
    if (count > MAX_FRAMES) throw new CliError('INVALID_ARG', `-n is at most ${MAX_FRAMES}`);
    const cols = args.options.cols === undefined ? undefined : whole('--cols', args.options.cols as number, 1);
    const source = await openFromArgs(args);
    const started = nowMs();
    let dir: string | undefined;
    try {
      const [first, last] = frameRange(args.options.range as string | undefined, source.composition.durationInFrames);
      const frames = evenFrames(first, last, count);
      const rendered = await renderFrames(source, frames);
      dir = rendered.dir;
      const scene = buildStripScene(rendered.files, source.composition, cols);
      ensureParentDir(output);
      writeFileSync(output, newRenderer().still(JSON.stringify(scene), 0, dir));
      const layout = stripLayout(frames.length, source.composition.width, source.composition.height, cols);
      const ms = nowMs() - started;
      return {
        data: { output, width: scene.width, height: scene.height, frames, cols: layout.cols, rows: layout.rows, ms },
        text: `wrote ${output} (${scene.width}x${scene.height}, frames ${frames.join(', ')}, ${ms.toFixed(0)} ms)`,
      };
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
      source.dispose();
    }
  },
};

export const onion: Command = {
  name: 'onion',
  summary: 'Frames of a range blended over one another, to show a motion path',
  project: true,
  positionals: [ENTRY, { name: 'range', description: 'Frames to blend, as 10..40 (10 to 39) or 10..=40' }],
  options: [
    { name: 'count', short: 'n', type: 'number', description: `Number of frames (default 6, at most ${MAX_FRAMES})` },
    OUTPUT_OPTION,
  ],
  async run(args) {
    const output = requireOutput(args);
    const count = whole('-n', args.options.count as number | undefined, 1, 6);
    if (count > MAX_FRAMES) throw new CliError('INVALID_ARG', `-n is at most ${MAX_FRAMES}`);
    const source = await openFromArgs(args);
    const started = nowMs();
    let dir: string | undefined;
    try {
      const [first, last] = frameRange(String(args.positionals.range), source.composition.durationInFrames);
      const frames = evenFrames(first, last, count);
      const rendered = await renderFrames(source, frames);
      dir = rendered.dir;
      const scene = buildOnionScene(rendered.files, source.composition);
      ensureParentDir(output);
      writeFileSync(output, newRenderer().still(JSON.stringify(scene), 0, dir));
      const ms = nowMs() - started;
      return {
        data: { output, width: scene.width, height: scene.height, frames, ms },
        text: `wrote ${output} (${scene.width}x${scene.height}, frames ${frames.join(', ')}, ${ms.toFixed(0)} ms)`,
      };
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
      source.dispose();
    }
  },
};
