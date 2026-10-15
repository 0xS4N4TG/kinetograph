// `@kinetograph/compat/doctor` (docs/COMPAT.md §7): the report `kinetograph
// doctor` prints, built from each frame's unsupported items. Stream 4.

import type { Unsupported } from './types.js';

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

export interface DoctorReport {
  comp: string;
  first: number;
  last: number;
  frames: number;
  /** Frames with nothing unsupported: drawn in full. */
  cleanFrames: number;
  /** Frames holding at least one unsupported item: drawn without it, or approximated. */
  unsupportedFrames: number;
  /** `cleanFrames / frames`, 0..1. */
  cleanShare: number;
  /** Most frames first. */
  issues: DoctorIssue[];
  /** Problems with the project's stylesheets that no frame shows (Tailwind that could not be built, a remote font). */
  notes?: string[];
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
 * What the engine cannot draw in the frames of composition `comp` (docs/COMPAT.md §7): the share of frames with
 * nothing unsupported and the unsupported items grouped by (element, property, reason), the group on the most frames
 * first. A frame listed twice is one frame with both lists' items.
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
  let cleanFrames = 0;
  for (const { frame, unsupported } of merged) {
    if (unsupported.length === 0) cleanFrames++;
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
    cleanFrames,
    unsupportedFrames: total - cleanFrames,
    // With no frames nothing is unsupported.
    cleanShare: total === 0 ? 1 : cleanFrames / total,
    issues,
  };
}

/** `div transform: skew is not supported`: what an issue is, for a line of text. */
export function describeIssue(issue: Pick<DoctorIssue, 'element' | 'property' | 'reason'>): string {
  return `${issue.element}${issue.property === null ? '' : ` ${issue.property}`}: ${issue.reason}`;
}
