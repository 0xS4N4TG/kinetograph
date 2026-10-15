// What a render did about frames the native path cannot draw (docs/COMPAT.md §6.1): how many went each way, and, when
// they are drawn natively anyway (`--compat native`), what was left out.

import { pathFor, type CompatMode, type RenderPath, type Run } from '@kinetograph/compat';
import type { Unsupported } from '@kinetograph/scene';
import { CliError } from './errors.js';

/** One kind of thing the native path left out, over the frames it was left out of. */
export interface LeftOut {
  element: string;
  property: string | null;
  reason: string;
  /** Distinct values seen, at most 3. */
  values: string[];
  /** Frames it was left out of. */
  frames: number;
  firstFrame: number;
  lastFrame: number;
}

export interface CompatReport {
  mode: CompatMode;
  nativeFrames: number;
  chromeFrames: number;
  /** The frames in runs of consecutive frames drawn the same way (`planRuns`). */
  runs: Run[];
  /** With `--compat native`: what the native frames leave out. Empty otherwise. */
  leftOut: LeftOut[];
}

/** `--compat`: `auto` (the default), `native` or `chrome`. */
export function parseCompat(value: string | number | boolean | undefined): CompatMode {
  if (value === undefined) return 'auto';
  if (value === 'auto' || value === 'native' || value === 'chrome') return value;
  throw new CliError('INVALID_ARG', `--compat must be auto, native or chrome, got "${String(value)}"`);
}

/** Collects what was left out, frame by frame, into one entry per kind. */
export class LeftOutCollector {
  private readonly kinds = new Map<string, LeftOut>();

  add(frame: number, unsupported: readonly Unsupported[]): void {
    const seen = new Set<string>();
    for (const item of unsupported) {
      const key = `${item.element}\u0000${item.property ?? ''}\u0000${item.reason}`;
      let entry = this.kinds.get(key);
      if (!entry) {
        entry = { element: item.element, property: item.property, reason: item.reason, values: [], frames: 0, firstFrame: frame, lastFrame: frame };
        this.kinds.set(key, entry);
      }
      if (!seen.has(key)) {
        seen.add(key);
        entry.frames += 1;
        entry.lastFrame = Math.max(entry.lastFrame, frame);
        entry.firstFrame = Math.min(entry.firstFrame, frame);
      }
      if (item.value !== null && entry.values.length < 3 && !entry.values.includes(item.value)) entry.values.push(item.value);
    }
  }

  /** Most frames first. */
  result(): LeftOut[] {
    return [...this.kinds.values()].sort((a, b) => b.frames - a.frames || a.element.localeCompare(b.element));
  }
}

/** The lines `--compat native` prints on stderr for what it left out. */
export function describeLeftOut(items: readonly LeftOut[], limit = 12): string[] {
  if (items.length === 0) return [];
  const lines = [`--compat native: ${items.length} kind${items.length === 1 ? '' : 's'} of unsupported content left out of the frames:`];
  for (const item of items.slice(0, limit)) {
    const what = item.property ? `${item.element} { ${item.property}${item.values.length ? `: ${item.values.join(' | ')}` : ''} }` : item.element;
    const where = item.firstFrame === item.lastFrame ? `frame ${item.firstFrame}` : `${item.frames} frames, ${item.firstFrame}..=${item.lastFrame}`;
    lines.push(`  ${what}: ${item.reason} (${where})`);
  }
  if (items.length > limit) lines.push(`  … and ${items.length - limit} more`);
  return lines;
}

/** Which way a frame goes under `mode`, as `pathFor` decides (re-exported so the commands read one place). */
export function pathOf(unsupported: readonly Unsupported[] | undefined, mode: CompatMode): RenderPath {
  return pathFor(unsupported ?? [], mode);
}

/** `12 native, 8 in Chrome (frames 40..=47)`: the sentence the render summary carries. */
export function describeSplit(report: Pick<CompatReport, 'nativeFrames' | 'chromeFrames' | 'runs'>): string {
  const chromeRuns = report.runs.filter((r) => r.path === 'chrome').map((r) => (r.first === r.last ? `${r.first}` : `${r.first}..=${r.last}`));
  const shown = chromeRuns.length > 6 ? `${chromeRuns.slice(0, 6).join(', ')}, …` : chromeRuns.join(', ');
  return `${report.nativeFrames} native, ${report.chromeFrames} in Chrome${chromeRuns.length ? ` (frames ${shown})` : ''}`;
}
