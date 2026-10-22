// Per-frame stage timings for `render`, off unless `KINETOGRAPH_PROFILE=<path prefix>` is set (no cost when it is not).
// Each thread that draws frames appends one JSON line per frame to `<prefix>.<main|wN>.jsonl`: the frame, absolute start
// and end times (ms, comparable across threads) and stage milliseconds: js (renderFrame, DOM engine included as dom_prep,
// dom_native, dom_asm), stringify, parse/set_scene/resolve/start/gpu_sync (the addon building and submitting the frame),
// finish/rb_wait/rb_copy (waiting for and reading back the frame), send (handing it to the encoder), yuv (RGBA to YUV in a
// worker), post (copy and hand-off to the main thread).

import { appendFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { native } from './native.js';
import { nowMs } from './time.js';

const PREFIX = process.env.KINETOGRAPH_PROFILE;

/** Whether profiling is on. */
export const profiling = PREFIX !== undefined && PREFIX !== '';

/** Milliseconds on a clock shared by all threads (the monotonic one; `performance.now` is held still while frames render). */
export const now = (): number => nowMs();

type Stages = Record<string, number>;

/** What the project's JS stages recorded since the last call (`dom_*` from the DOM engine), emptied. */
export function takeJs(): Stages {
  const g = globalThis as { __kprof?: Stages };
  const table = g.__kprof ?? {};
  g.__kprof = {};
  return table;
}

/** This thread's addon stages since the last call (`takeProfile`), emptied. */
export function takeAddon(): Stages {
  return native().takeProfile();
}

/** One thread's log. */
export class ProfileLog {
  private readonly file: string;
  private lines: string[] = [];

  constructor(main: boolean) {
    this.file = `${PREFIX}.${main ? 'main' : `w${threadId}`}.jsonl`;
  }

  /** Records `row` (a frame's stages, or any event with a `kind`). */
  add(row: Record<string, number | string>): void {
    this.lines.push(JSON.stringify(row));
    if (this.lines.length >= 64) this.flush();
  }

  flush(): void {
    if (this.lines.length === 0) return;
    appendFileSync(this.file, this.lines.join('\n') + '\n');
    this.lines = [];
  }
}

/** The encoder thread's totals and the DOM island thread's, written once when a render ends. */
export function writeShared(): void {
  if (!profiling) return;
  appendFileSync(`${PREFIX}.shared.json`, JSON.stringify(native().takeProfile(true)) + '\n');
}
