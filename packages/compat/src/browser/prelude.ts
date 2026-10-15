/// <reference lib="dom" />
// Evaluated first in the Chrome bundle (docs/COMPAT.md §6.2), before the determinism shim captures the page's real
// timers: it gives the page the few Node globals that `@kinetograph/core` reaches for, so one build of core serves
// both hosts. Nothing here reads the clock.

const g = globalThis as Record<string, unknown>;

// The frame loop yields with `setImmediate`, which browsers do not have. A MessageChannel message is not throttled
// the way a timer is, and the shim leaves it alone (it patches the timer functions only).
if (typeof g.setImmediate !== 'function') {
  const queue: Array<() => void> = [];
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const next = queue.shift();
    if (next) next();
  };
  g.setImmediate = (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
    queue.push(() => callback(...args));
    channel.port2.postMessage(0);
  };
}

// `process.env` and `process.cwd()` are read by the asset helpers; the driver passes the Node side's values in.
if (typeof g.process === 'undefined') {
  const settings = (g.__kinetographSettings ?? {}) as { cwd?: string; publicDir?: string };
  g.process = {
    env: {
      NODE_ENV: 'production',
      ...(settings.publicDir ? { KINETOGRAPH_PUBLIC_DIR: settings.publicDir } : {}),
    },
    cwd: () => settings.cwd ?? '/',
    pid: 1,
    platform: 'browser',
    versions: {},
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => callback(...args)),
  };
}

export {};
