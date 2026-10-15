import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { whole } from '../args.js';
import { parseCompat } from '../compat-report.js';
import { CliError } from '../errors.js';
import { FrameDrawer } from '../frame-drawer.js';
import { buildOnionScene, buildStripScene, stripLayout, type SheetFrame } from '../scenes.js';
import { evenFrames, frameRange, type Source } from '../source.js';
import { nowMs } from '../time.js';
import {
  COMPAT_OPTION,
  ENTRY,
  OUTPUT_OPTION,
  ensureParentDir,
  newRenderer,
  openFromArgs,
  requireOutput,
  type Command,
} from './types.js';

const MAX_FRAMES = 64;

/** Renders `frames` of the source to PNGs in a fresh temp directory, each the way `drawer` draws it. */
async function renderFrames(frames: number[], drawer: FrameDrawer): Promise<{ dir: string; files: SheetFrame[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'kinetograph-sheet-'));
  try {
    const files: SheetFrame[] = [];
    for (const frame of frames) {
      const file = `frame-${frame}.png`;
      writeFileSync(join(dir, file), (await drawer.png(frame)).png);
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
    COMPAT_OPTION,
  ],
  async run(args, context) {
    const output = requireOutput(args);
    const count = whole('-n', args.options.count as number | undefined, 1, 12);
    if (count > MAX_FRAMES) throw new CliError('INVALID_ARG', `-n is at most ${MAX_FRAMES}`);
    const cols = args.options.cols === undefined ? undefined : whole('--cols', args.options.cols as number, 1);
    const compat = parseCompat(args.options.compat);
    const source = await openFromArgs(args);
    const drawer = new FrameDrawer(source, { mode: compat, renderer: newRenderer, progress: context.progress });
    const started = nowMs();
    let dir: string | undefined;
    try {
      const [first, last] = frameRange(args.options.range as string | undefined, source.composition.durationInFrames);
      const frames = evenFrames(first, last, count);
      const rendered = await renderFrames(frames, drawer);
      dir = rendered.dir;
      drawer.reportLeftOut();
      const scene = buildStripScene(rendered.files, source.composition, cols);
      ensureParentDir(output);
      writeFileSync(output, newRenderer().still(JSON.stringify(scene), 0, dir));
      const layout = stripLayout(frames.length, source.composition.width, source.composition.height, cols);
      const ms = nowMs() - started;
      return {
        data: { output, width: scene.width, height: scene.height, frames, cols: layout.cols, rows: layout.rows, ms, compat: drawer.report() },
        text: `wrote ${output} (${scene.width}x${scene.height}, frames ${frames.join(', ')}, ${ms.toFixed(0)} ms)`,
      };
    } finally {
      await drawer.close();
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
    // `onion` is native only (docs/COMPAT.md §6.1).
    const drawer = new FrameDrawer(source, { mode: 'native', renderer: newRenderer });
    const started = nowMs();
    let dir: string | undefined;
    try {
      const [first, last] = frameRange(String(args.positionals.range), source.composition.durationInFrames);
      const frames = evenFrames(first, last, count);
      const rendered = await renderFrames(frames, drawer);
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
