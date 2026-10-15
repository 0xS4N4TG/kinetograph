// Which frames are drawn natively and which by Chrome (docs/COMPAT.md §6.1).
// The rule is per frame, never per scene: a transition overlaps two scenes.

import type { CompatMode, RenderPath, Run, Unsupported } from './types.js';

/** How one frame is drawn: natively unless it holds something unsupported, or `mode` forces a path. */
export function pathFor(unsupported: readonly Unsupported[], mode: CompatMode): RenderPath {
  if (mode !== 'auto') return mode;
  return unsupported.length === 0 ? 'native' : 'chrome';
}

/**
 * The frames, in ascending order, joined into runs of consecutive frames drawn the same way. A gap in the frame
 * numbers starts a new run.
 */
export function planRuns(
  frames: readonly { frame: number; unsupported: readonly Unsupported[] }[],
  mode: CompatMode,
): Run[] {
  const runs: Run[] = [];
  const sorted = [...frames].sort((a, b) => a.frame - b.frame);
  for (const { frame, unsupported } of sorted) {
    const path = pathFor(unsupported, mode);
    const last = runs[runs.length - 1];
    if (last && last.path === path && last.last === frame - 1) last.last = frame;
    else runs.push({ first: frame, last: frame, path });
  }
  return runs;
}
