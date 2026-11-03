// `@remotion/effects` in a project: the backend flag, and what `doctor` says about the installed package.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import type { OptionSpec } from './args.js';
import { CliError } from './errors.js';

const BACKENDS = ['auto', 'webgpu', 'webgl2', '2d'];

/** `--preferred-effect-backend`, as Remotion's CLI names it. */
export const PREFERRED_EFFECT_BACKEND_OPTION: OptionSpec = {
  name: 'preferred-effect-backend',
  type: 'string',
  description: 'The backend an effect tries first: webgpu, webgl2 or 2d (default auto: webgpu, webgl2, 2d, whichever the effect has and can draw)',
};

/** The flag's value, refused with `INVALID_ARG` when it is not a backend. */
export function parsePreferredEffectBackend(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !BACKENDS.includes(value)) {
    throw new CliError('INVALID_ARG', `--preferred-effect-backend must be "auto", "webgpu", "webgl2" or "2d", got ${String(value)}`);
  }
  return value;
}

/**
 * Sets what Remotion's CLI sets in the page: `window.remotion_preferredEffectBackend` (the window is the global object
 * here). Without the flag it is cleared, so a command that follows one with the flag (an MCP server) does not inherit it.
 */
export function setPreferredEffectBackend(value: string | undefined): void {
  const g = globalThis as { remotion_preferredEffectBackend?: string };
  if (value === undefined) delete g.remotion_preferredEffectBackend;
  else g.remotion_preferredEffectBackend = value;
}

export interface EffectsReport {
  /** The version of the project's `@remotion/effects`. */
  installed: string;
  /** The version the parity harness was last run against (scripts/remotion-effects). */
  tested: string;
  /** Effects the project imports whose status is not "supported". */
  gaps: { name: string; status: string }[];
  /** Lines for people. */
  lines: string[];
}

type Parity = { version: string; effects: Record<string, { sub: string; status: string }> };

/** The harness's last run (`packages/cli/assets/remotion-effects.json`, written by scripts/remotion-effects/table.mjs). */
export function parityStatus(): Parity {
  return JSON.parse(readFileSync(new URL('../assets/remotion-effects.json', import.meta.url), 'utf8')) as Parity;
}

/** The `package.json` of the `@remotion/effects` the project at `dir` resolves, looking up the folders as Node does. */
function installedVersion(dir: string): string | null {
  for (let at = dir; ; at = dirname(at)) {
    const file = join(at, 'node_modules', '@remotion', 'effects', 'package.json');
    if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? null;
    if (at === parse(at).root) return null;
  }
}

/**
 * What `doctor` says about `@remotion/effects`, or null when the project does not use it. `bundle` is the project's
 * bundle: esbuild names each file it includes in a comment, which is how the effects it imports are known.
 */
export function effectsReport(entryDir: string, bundle: string, parity: Parity = parityStatus()): EffectsReport | null {
  const subs = new Set([...bundle.matchAll(/node_modules\/@remotion\/effects\/dist\/esm\/([A-Za-z0-9_-]+)\.mjs/g)].map((m) => m[1]!));
  if (subs.size === 0) return null;
  const installed = installedVersion(entryDir) ?? 'unknown';
  const lines: string[] = [];
  const mark = installed === parity.version ? '' : ` (the parity run was against ${parity.version}: effects may differ)`;
  lines.push(`@remotion/effects ${installed}${mark}`);
  const gaps = Object.entries(parity.effects)
    .filter(([, e]) => subs.has(e.sub) && e.status !== 'supported')
    .map(([name, e]) => ({ name, status: e.status }));
  for (const { name, status } of gaps) lines.push(`  ${name}(): ${status} (see /docs/guides/remotion-effects/)`);
  return { installed, tested: parity.version, gaps, lines };
}
