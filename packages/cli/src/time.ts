// Benchmark and progress timing. `process.hrtime` is used because the determinism shim, once a project's bundle is
// loaded, replaces `performance.now` and `Date.now` with the virtual clock. This is the one place that reads real time,
// and it only ever feeds numbers that are printed, never a render.

export function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

export interface Stats {
  mean: number;
  min: number;
  max: number;
}

export function statsOf(samples: number[]): Stats {
  if (samples.length === 0) return { mean: 0, min: 0, max: 0 };
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const s of samples) {
    sum += s;
    if (s < min) min = s;
    if (s > max) max = s;
  }
  return { mean: sum / samples.length, min, max };
}
