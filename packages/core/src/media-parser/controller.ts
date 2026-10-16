import { UnsupportedApiError } from '../unsupported.js';
import { MediaParserAbortError } from './errors.js';
import type { CallbackListener, MediaParserController, MediaParserEventTypes } from './types.js';

/**
 * What a caller uses to stop or hold a parse from outside: `abort()` makes the parse reject with a
 * `MediaParserAbortError`, `pause()` holds it at its next step until `resume()`, and listeners hear each of them.
 * A parse here reads a file's header in a few steps, so there is little to interrupt and nothing to seek in:
 * `seek()` tells the listeners and changes nothing, and `simulateSeek()` is not supported.
 */
export const mediaParserController = (): MediaParserController => {
  const abortController = new AbortController();
  const listeners: { [T in MediaParserEventTypes]: CallbackListener<T>[] } = { pause: [], resume: [], abort: [], seek: [] };
  let paused = false;
  let waiting: (() => void)[] = [];

  const dispatch = <T extends MediaParserEventTypes>(name: T, detail: Parameters<CallbackListener<T>>[0]['detail']) => {
    for (const listener of [...listeners[name]]) listener({ detail });
  };

  return {
    abort: (reason?: unknown) => {
      abortController.abort(reason);
      dispatch('abort', { reason });
      // Whoever is held by a pause finds out about the abort.
      for (const wake of waiting) wake();
      waiting = [];
    },
    pause: () => {
      if (paused) return;
      paused = true;
      dispatch('pause', undefined);
    },
    resume: () => {
      if (!paused) return;
      paused = false;
      dispatch('resume', undefined);
      for (const wake of waiting) wake();
      waiting = [];
    },
    seek: (timeInSeconds: number) => dispatch('seek', { seek: timeInSeconds }),
    simulateSeek: async () => {
      throw new UnsupportedApiError(
        '@remotion/media-parser',
        'simulateSeek()',
        'a parse reads a file whole, so there is no seeking to simulate',
      );
    },
    addEventListener: (name, callback) => {
      (listeners[name] as CallbackListener<typeof name>[]).push(callback);
    },
    removeEventListener: (name, callback) => {
      const list = listeners[name] as CallbackListener<typeof name>[];
      const at = list.indexOf(callback);
      if (at >= 0) list.splice(at, 1);
    },
    getSeekingHints: async () => null,
    _internals: {
      signal: abortController.signal,
      checkForAbortAndPause: async () => {
        while (paused && !abortController.signal.aborted) await new Promise<void>((resolve) => waiting.push(resolve));
        if (abortController.signal.aborted) throw new MediaParserAbortError('Aborted');
      },
      markAsReadyToEmitEvents: () => {},
    },
  };
};
