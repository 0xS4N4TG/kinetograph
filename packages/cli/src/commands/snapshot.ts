import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parseFrameList } from '../args.js';
import { decodePng, diffPng } from '../png.js';
import { checkFrame, evenFrames, type Source } from '../source.js';
import { ENTRY, newRenderer, openFromArgs, type Command } from './types.js';

/** The largest difference in any channel that still counts as the same picture (packages/cli/skills/kinetograph/references/AUTHORING.md §9). */
const TOLERANCE = 2;

export type SnapshotStatus = 'match' | 'mismatch' | 'missing' | 'created' | 'updated';

export interface SnapshotResult {
  frame: number;
  status: SnapshotStatus;
  snapshot: string;
  /** The new render, written beside the snapshot when it differs. */
  actual?: string;
  maxDiff?: number;
  differingPixels?: number;
}

/** `__snapshots__/<entry>[.<composition>].f<frame>.png` next to the entry. */
export function snapshotPath(source: Source, frame: number): string {
  const stem = basename(source.entry, extname(source.entry));
  const name = source.kind === 'project' ? `${stem}.${source.composition.id}` : stem;
  return join(dirname(source.entry), '__snapshots__', `${name}.f${frame}.png`);
}

/** Compares a rendered PNG with the approved file, or writes it if asked to. */
export function compareSnapshot(png: Uint8Array, frame: number, snapshot: string, update: boolean): SnapshotResult {
  const actual = snapshot.replace(/\.png$/, '.actual.png');
  const existed = existsSync(snapshot);
  if (update) {
    if (existed && Buffer.from(png).equals(readFileSync(snapshot))) return { frame, status: 'match', snapshot };
    mkdirSync(dirname(snapshot), { recursive: true });
    writeFileSync(snapshot, png);
    rmSync(actual, { force: true });
    return { frame, status: existed ? 'updated' : 'created', snapshot };
  }
  if (!existed) {
    mkdirSync(dirname(snapshot), { recursive: true });
    writeFileSync(actual, png);
    return { frame, status: 'missing', snapshot, actual };
  }
  const approved = readFileSync(snapshot);
  const identical = Buffer.from(png).equals(approved);
  const diff = identical ? undefined : diffPng(decodePng(approved), decodePng(png), TOLERANCE);
  if (identical || (diff && diff.sameSize && diff.maxDiff <= TOLERANCE)) {
    rmSync(actual, { force: true });
    return { frame, status: 'match', snapshot, maxDiff: diff?.maxDiff ?? 0, differingPixels: 0 };
  }
  writeFileSync(actual, png);
  return { frame, status: 'mismatch', snapshot, actual, maxDiff: diff!.maxDiff, differingPixels: diff!.differingPixels };
}

export const snapshot: Command = {
  name: 'snapshot',
  summary: 'Compare frames with the approved PNGs in __snapshots__/ next to the entry',
  project: true,
  positionals: [ENTRY],
  options: [
    { name: 'frames', type: 'string', description: 'Frames, comma separated (default: first, middle, last)' },
    { name: 'update', type: 'boolean', description: 'Write the current renders as the approved PNGs' },
  ],
  async run(args) {
    const source = await openFromArgs(args);
    try {
      const { durationInFrames } = source.composition;
      const update = args.options.update === true;
      const frames = (
        args.options.frames === undefined
          ? evenFrames(0, durationInFrames - 1, 3)
          : parseFrameList('--frames', String(args.options.frames))
      )
        .map((f) => checkFrame(f, durationInFrames))
        .sort((a, b) => a - b);

      const renderer = newRenderer();
      const results: SnapshotResult[] = [];
      for (const frame of frames) {
        const { sceneJson } = await source.frame(frame);
        const png = renderer.still(sceneJson, frame, source.baseDir);
        results.push(compareSnapshot(png, frame, snapshotPath(source, frame), update));
      }
      const failed = results.filter((r) => r.status === 'mismatch' || r.status === 'missing');
      const text = results
        .map((r) => {
          const detail =
            r.status === 'mismatch'
              ? ` (max channel difference ${r.maxDiff}, ${r.differingPixels} pixels; new render at ${r.actual})`
              : r.status === 'missing'
                ? ` (no approved PNG; run with --update to approve the render at ${r.actual})`
                : '';
          return `frame ${r.frame}: ${r.status}${detail}`;
        })
        .join('\n');
      return {
        data: { ok: failed.length === 0, tolerance: TOLERANCE, results },
        text,
        exitCode: failed.length > 0 ? 1 : 0,
      };
    } finally {
      source.dispose();
    }
  },
};
