// `@kinetograph/compat/doctor` (docs/COMPAT.md §7): the report `kinetograph
// doctor` prints, built from each frame's unsupported items. Stream 4.

import { pathFor, planRuns } from './runs.js';
import type { RenderPath, Run, Unsupported } from './types.js';

export interface DoctorIssue {
  element: string;
  property: string | null;
  reason: string;
  /** Distinct values seen, at most 5. */
  values: string[];
  /** Distinct element paths, at most 5. */
  paths: string[];
  /** Inclusive, ascending. */
  ranges: [first: number, last: number][];
  frames: number;
}

export interface DoctorCompare {
  frame: number;
  path: RenderPath;
  /** Per channel, 0..255. */
  maxDiff: number;
  meanDiff: number;
  /** Pixels with any channel more than 2 levels apart. */
  differingPixels: number;
}

export interface DoctorReport {
  comp: string;
  first: number;
  last: number;
  frames: number;
  nativeFrames: number;
  chromeFrames: number;
  /** 0..1. */
  nativeShare: number;
  /** `planRuns(…, 'auto')`. */
  runs: Run[];
  /** Most frames first. */
  issues: DoctorIssue[];
  compare?: DoctorCompare[];
}

/** The most values and element paths an issue lists. */
const MAX_LISTED = 5;

/** Adds `item` to `list` unless it is there or the list is full. */
function addDistinct(list: string[], item: string | null): void {
  if (item !== null && list.length < MAX_LISTED && !list.includes(item)) list.push(item);
}

/** Consecutive frame numbers joined into inclusive ranges. `frames` must be ascending and distinct. */
function toRanges(frames: readonly number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const frame of frames) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === frame - 1) last[1] = frame;
    else ranges.push([frame, frame]);
  }
  return ranges;
}

/**
 * What the frames of composition `comp` need from Chrome (docs/COMPAT.md §7): the share drawn natively, the runs
 * (`planRuns(…, 'auto')`) and the unsupported items grouped by (element, property, reason), the group on the most
 * frames first. A frame listed twice is one frame with both lists' items.
 */
export function summarize(
  comp: string,
  frames: readonly { frame: number; unsupported: readonly Unsupported[] }[],
): DoctorReport {
  const byFrame = new Map<number, Unsupported[]>();
  for (const { frame, unsupported } of frames) {
    const items = byFrame.get(frame);
    if (items) items.push(...unsupported);
    else byFrame.set(frame, [...unsupported]);
  }
  const merged = [...byFrame].map(([frame, unsupported]) => ({ frame, unsupported })).sort((a, b) => a.frame - b.frame);

  // Frames are ascending, so each group's frame list is too; a frame counts once however many items it has.
  const groups = new Map<string, { issue: DoctorIssue; frames: number[] }>();
  let nativeFrames = 0;
  for (const { frame, unsupported } of merged) {
    if (pathFor(unsupported, 'auto') === 'native') nativeFrames++;
    for (const item of unsupported) {
      const key = JSON.stringify([item.element, item.property, item.reason]);
      let group = groups.get(key);
      if (!group) {
        group = {
          issue: { element: item.element, property: item.property, reason: item.reason, values: [], paths: [], ranges: [], frames: 0 },
          frames: [],
        };
        groups.set(key, group);
      }
      addDistinct(group.issue.values, item.value);
      addDistinct(group.issue.paths, item.path);
      if (group.frames[group.frames.length - 1] !== frame) group.frames.push(frame);
    }
  }

  const issues = [...groups.values()].map(({ issue, frames: seen }) => ({ ...issue, ranges: toRanges(seen), frames: seen.length }));
  issues.sort(
    (a, b) =>
      b.frames - a.frames ||
      a.ranges[0]![0] - b.ranges[0]![0] ||
      a.element.localeCompare(b.element) ||
      (a.property ?? '').localeCompare(b.property ?? '') ||
      a.reason.localeCompare(b.reason),
  );

  const total = merged.length;
  return {
    comp,
    first: merged[0]?.frame ?? 0,
    last: merged[total - 1]?.frame ?? 0,
    frames: total,
    nativeFrames,
    chromeFrames: total - nativeFrames,
    // With no frames nothing needs Chrome.
    nativeShare: total === 0 ? 1 : nativeFrames / total,
    runs: planRuns(merged, 'auto'),
    issues,
  };
}

/** `div transform: skew is not supported`: what an issue is, for a line of text. */
export function describeIssue(issue: Pick<DoctorIssue, 'element' | 'property' | 'reason'>): string {
  return `${issue.element}${issue.property === null ? '' : ` ${issue.property}`}: ${issue.reason}`;
}
