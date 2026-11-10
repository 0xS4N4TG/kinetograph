// Stage timers for profiling a render, off unless `KINETOGRAPH_PROFILE` is set: the milliseconds of a stage and how
// many times it ran (`<stage>_n`) go to `globalThis.__kprof`, which the render loop reads and empties after each frame.

const PROFILING = typeof process !== 'undefined' && process.env?.KINETOGRAPH_PROFILE !== undefined;
const clock = (): number => Number(process.hrtime.bigint()) / 1e6; // `performance.now` is held still while frames render

/** Now, when profiling (0 otherwise): pass it to `lap`. */
export const stamp = (): number => (PROFILING ? clock() : 0);

/** Adds the time since `since` to `stage` and counts one; returns now, for the next stage. */
export function lap(stage: string, since: number): number {
  if (!PROFILING) return 0;
  const now = clock();
  const table = ((globalThis as { __kprof?: Record<string, number> }).__kprof ??= {});
  table[stage] = (table[stage] ?? 0) + (now - since);
  table[`${stage}_n`] = (table[`${stage}_n`] ?? 0) + 1;
  return now;
}
