// `@kinetograph/compat/doctor` (docs/COMPAT.md §7): the report `kinetograph
// doctor` prints, built from each frame's unsupported items. Stream 4.

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

export function summarize(
  _comp: string,
  _frames: readonly { frame: number; unsupported: readonly Unsupported[] }[],
): DoctorReport {
  throw new Error('not implemented: summarize (docs/COMPAT.md §7)');
}
