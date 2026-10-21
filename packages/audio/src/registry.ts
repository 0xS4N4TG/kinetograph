import type { OfflineAudioContext } from 'node-web-audio-api';

/** node-web-audio-api's `OfflineAudioContext`, which is what `onFrame` callbacks receive. */
export type AudioContextLike = OfflineAudioContext;
/** `time` is in seconds from the start of the rendered range, so a callback schedules against it, not `ctx.currentTime`. */
export type OnFrameCallback = (ctx: AudioContextLike, time: number) => void;

interface Entry {
  frame: number;
  callback: OnFrameCallback;
}
interface Registry {
  entries: Entry[];
}

// The project's bundle carries its own copy of this package, and the CLI that renders the audio has another. Both
// read and write one registry on `globalThis`, under a symbol that `Symbol.for` makes the same in every copy.
const KEY = Symbol.for('kinetograph.audio');

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (holder[KEY] ??= { entries: [] });
}

/** Registers synthesis to start at `frame` (absolute; may be fractional, for a cue between two frames). Call at module level. */
export function onFrame(frame: number, callback: OnFrameCallback): void {
  if (typeof frame !== 'number' || !Number.isFinite(frame) || frame < 0) {
    throw new RangeError(`onFrame: frame must be a number from 0, got ${frame}`);
  }
  if (typeof callback !== 'function') {
    throw new TypeError('onFrame: the second argument must be a function (ctx, time) => void');
  }
  registry().entries.push({ frame, callback });
}

export function clearOnFrame(): void {
  registry().entries.length = 0;
}

/** The callbacks registered for frames `first..=last`, in frame order (registration order within a frame). */
export function registeredCallbacks(first: number, last: number): { frame: number; callback: OnFrameCallback }[] {
  return registry()
    .entries.map((e, index) => ({ e, index }))
    .filter(({ e }) => e.frame >= first && e.frame <= last)
    .sort((a, b) => a.e.frame - b.e.frame || a.index - b.index)
    .map(({ e }) => ({ frame: e.frame, callback: e.callback }));
}

/** True if any `onFrame` callback is registered for a frame in `first..=last`. */
export function hasOnFrame(first: number, last: number): boolean {
  return registry().entries.some((e) => e.frame >= first && e.frame <= last);
}
