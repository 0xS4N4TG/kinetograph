import { format } from 'node:util';

/**
 * Runs `work` with `console.log`, `info` and `debug` going to stderr. A `--json` command prints one JSON document on
 * stdout; a page that logs while it runs (`LiquidGlass: WebGPU renderer initialized`) would put a line before it, and
 * the result would not parse. `console.error` and `warn` are stderr already, and stay as they are.
 */
export async function withConsoleOnStderr<T>(io: { err: (text: string) => void }, work: () => Promise<T>): Promise<T> {
  const { log, info, debug } = console;
  const toStderr = (...args: unknown[]): void => io.err(`${format(...args)}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  try {
    return await work();
  } finally {
    Object.assign(console, { log, info, debug });
  }
}
