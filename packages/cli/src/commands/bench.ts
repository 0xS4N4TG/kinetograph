import type { BenchResult } from '@kinetograph/native';
import { whole } from '../args.js';
import { CliError } from '../errors.js';
import { frameRange, checkFrame } from '../source.js';
import { statsOf, type Stats } from '../time.js';
import { ENTRY, newRenderer, openFromArgs, type Command } from './types.js';

const ADDON_STAGES = ['handoff', 'resolve', 'raster', 'composite', 'readback'] as const;

export const bench: Command = {
  name: 'bench',
  summary: 'ms per frame for each stage: js, stringify, then the addon\'s handoff, resolve, raster, composite, readback',
  project: true,
  positionals: [ENTRY],
  options: [
    { name: 'frame', type: 'number', description: 'Frame to time over and over (default 0)' },
    { name: 'runs', type: 'number', description: 'Timed runs after the warm-up (default 10)' },
    { name: 'range', type: 'string', description: 'Time the frames of a range once each instead: 10..40' },
  ],
  async run(args) {
    const range = args.options.range as string | undefined;
    if (range !== undefined && (args.options.frame !== undefined || args.options.runs !== undefined)) {
      throw new CliError('INVALID_ARG', '--range replaces --frame and --runs');
    }
    const source = await openFromArgs(args);
    try {
      const renderer = newRenderer();
      const duration = source.composition.durationInFrames;
      const js: number[] = [];
      const stringify: number[] = [];
      const addon: Record<(typeof ADDON_STAGES)[number] | 'total', Stats[]> = {
        handoff: [], resolve: [], raster: [], composite: [], readback: [], total: [],
      };
      const keep = (r: BenchResult): void => {
        for (const stage of [...ADDON_STAGES, 'total'] as const) addon[stage].push(r.stages[stage]);
      };
      let detail: Record<string, unknown>;
      let perFrame: { frame: number; jsMs: number; stringifyMs: number; addonMs: number }[] | undefined;

      if (range !== undefined && source.kind === 'scene') {
        // One scene for every frame: the addon runs the range itself, with the layer cache on, as `render` does.
        const [first, last] = frameRange(range, duration);
        const { sceneJson } = await source.frame(first);
        const r = renderer.bench(sceneJson, { range }, source.baseDir);
        keep(r);
        detail = { mode: 'range', first, last, frames: r.frames };
      } else if (range !== undefined) {
        // A project's scene differs from frame to frame, so each frame is handed over and timed on its own (the
        // addon's range mode would repeat the first frame's scene). The layer cache is off, as in the frame mode.
        const [first, last] = frameRange(range, duration);
        perFrame = [];
        for (let frame = first; frame <= last; frame++) {
          const out = await source.frame(frame);
          const r = renderer.bench(out.sceneJson, { frame, runs: 1 }, source.baseDir);
          js.push(out.jsMs);
          stringify.push(out.stringifyMs);
          keep(r);
          perFrame.push({ frame, jsMs: out.jsMs, stringifyMs: out.stringifyMs, addonMs: r.stages.total.mean });
        }
        detail = { mode: 'range', first, last, frames: perFrame };
      } else {
        const frame = checkFrame((args.options.frame as number | undefined) ?? 0, duration);
        const runs = whole('--runs', args.options.runs as number | undefined, 1, 10);
        await source.frame(frame); // warm-up: fonts, caches, first-render work in the project
        let last = await source.frame(frame);
        for (let i = 0; i < runs; i++) {
          last = await source.frame(frame);
          js.push(last.jsMs);
          stringify.push(last.stringifyMs);
        }
        keep(renderer.bench(last.sceneJson, { frame, runs }, source.baseDir));
        detail = { mode: 'frame', frame, runs };
      }

      const stages: Record<string, Stats> = {};
      if (source.kind === 'project') {
        stages.js = statsOf(js);
        stages.stringify = statsOf(stringify);
      }
      for (const stage of ADDON_STAGES) stages[stage] = merge(addon[stage]);
      // The addon's stages wait for the GPU after each step, so they add up to more than its `total`, which is the
      // whole frame without those waits. Ours is the JS work plus that total.
      const addonTotal = merge(addon.total);
      stages.total = {
        mean: addonTotal.mean + (stages.js?.mean ?? 0) + (stages.stringify?.mean ?? 0),
        min: addonTotal.min + (stages.js?.min ?? 0) + (stages.stringify?.min ?? 0),
        max: addonTotal.max + (stages.js?.max ?? 0) + (stages.stringify?.max ?? 0),
      };

      const width = 11;
      const rows = Object.entries(stages).map(
        ([name, s]) => `${name.padEnd(width)}${s.mean.toFixed(3).padStart(10)}${s.min.toFixed(3).padStart(10)}${s.max.toFixed(3).padStart(10)}`,
      );
      return {
        data: { entry: source.entry, composition: source.composition.id, width: source.composition.width, height: source.composition.height, ...detail, stages },
        text:
          `${source.entry}  ${source.composition.width}x${source.composition.height}  ${describeMode(detail)}\n\n` +
          `${'stage (ms)'.padEnd(width)}${'mean'.padStart(10)}${'min'.padStart(10)}${'max'.padStart(10)}\n${rows.join('\n')}\n\n` +
          'The addon stages wait for the GPU after every step, so they add up to more than total, which is the JS\n' +
          'work plus the addon\'s whole frame without those waits. handoff is parsing the JSON and swapping it in.',
      };
    } finally {
      source.dispose();
    }
  },
};

function describeMode(detail: Record<string, unknown>): string {
  return detail.mode === 'frame'
    ? `frame ${detail.frame}, ${detail.runs} runs after warm-up`
    : `frames ${detail.first}..=${detail.last}, once each`;
}

/** Stats of stats: the mean of means, the lowest minimum, the highest maximum. */
function merge(parts: Stats[]): Stats {
  return {
    mean: statsOf(parts.map((p) => p.mean)).mean,
    min: Math.min(...parts.map((p) => p.min)),
    max: Math.max(...parts.map((p) => p.max)),
  };
}
