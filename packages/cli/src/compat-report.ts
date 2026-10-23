// What the engine could not draw in the frames a command drew (kinetograph site, /docs/compat/): the frame is drawn anyway, with
// the native approximation, and this says what was left out. `--strict` turns it into an error.

import type { Unsupported } from '@kinetograph/scene';
import { CliError } from './errors.js';

/** One kind of thing the engine left out, over the frames it was left out of. */
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
  /** Frames drawn that held something unsupported. */
  unsupportedFrames: number;
  /** What those frames left out, one entry per kind. */
  leftOut: LeftOut[];
}

/** Collects what was left out, frame by frame, into one entry per kind. */
export class LeftOutCollector {
  private readonly kinds = new Map<string, LeftOut>();
  private frames = 0;

  add(frame: number, unsupported: readonly Unsupported[]): void {
    if (unsupported.length > 0) this.frames += 1;
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

  report(): CompatReport {
    return { unsupportedFrames: this.frames, leftOut: this.result() };
  }
}

function describeItem(item: Pick<LeftOut, 'element' | 'property' | 'values'>): string {
  return item.property ? `${item.element} { ${item.property}${item.values.length ? `: ${item.values.join(' | ')}` : ''} }` : item.element;
}

/** The warning `still`, `strip` and `render` print on stderr for what they left out. */
export function describeLeftOut(report: CompatReport, limit = 12): string[] {
  const items = report.leftOut;
  if (items.length === 0) return [];
  const kinds = `${items.length} kind${items.length === 1 ? '' : 's'}`;
  const frames = `${report.unsupportedFrames} frame${report.unsupportedFrames === 1 ? '' : 's'}`;
  const lines = [`warning: ${kinds} of unsupported content in ${frames}, drawn without it or approximated (--strict fails instead):`];
  for (const item of items.slice(0, limit)) {
    const where = item.firstFrame === item.lastFrame ? `frame ${item.firstFrame}` : `${item.frames} frames, ${item.firstFrame}..=${item.lastFrame}`;
    lines.push(`  ${describeItem(item)}: ${item.reason} (${where})`);
  }
  if (items.length > limit) lines.push(`  … and ${items.length - limit} more`);
  return lines;
}

/** `--strict`: the error for the first frame that holds something the engine cannot draw. */
export function strictError(frame: number, unsupported: readonly Unsupported[], limit = 5): CliError {
  const collector = new LeftOutCollector();
  collector.add(frame, unsupported);
  const items = collector.result();
  const lines = items.slice(0, limit).map((item) => `  ${describeItem(item)}: ${item.reason}`);
  if (items.length > limit) lines.push(`  … and ${items.length - limit} more`);
  return new CliError(
    'UNSUPPORTED_CONTENT',
    `--strict: frame ${frame} holds content the engine cannot draw:\n${lines.join('\n')}\n` +
      'run `kinetograph doctor <entry>` for all of it, or leave out --strict to draw the frame without it',
  );
}
