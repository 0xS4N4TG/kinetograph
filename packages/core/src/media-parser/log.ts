import type { MediaParserLogLevel } from './types.js';

export const logLevels = ['trace', 'verbose', 'info', 'warn', 'error'] as const;

/** True when a message of `level` is shown at `currentLevel`: the level itself and the more severe ones. */
export const isEqualOrBelowLogLevel = (currentLevel: MediaParserLogLevel, level: MediaParserLogLevel): boolean =>
  logLevels.indexOf(currentLevel) <= logLevels.indexOf(level);

const write =
  (level: MediaParserLogLevel, sink: (...args: unknown[]) => void) =>
  (logLevel: MediaParserLogLevel, message?: unknown, ...rest: unknown[]) => {
    if (isEqualOrBelowLogLevel(logLevel, level)) sink(message, ...rest);
  };

/** The parser's log, filtered by the `logLevel` option. */
export const Log = {
  trace: write('trace', (...args) => console.log(...args)),
  verbose: write('verbose', (...args) => console.log(...args)),
  info: write('info', (...args) => console.log(...args)),
  warn: write('warn', (...args) => console.warn(...args)),
  error: (message?: unknown, ...rest: unknown[]) => console.error(message, ...rest),
};
