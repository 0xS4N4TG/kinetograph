import { createRequire } from 'node:module';

/** The `kinetograph` package version. */
export function cliVersion(): string {
  return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
}
