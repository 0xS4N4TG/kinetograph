// Presets: named sets of props for a composition, kept as `presets/<comp id>/<name>.json` beside the entry.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PresetInfo } from './protocol.js';
import { StudioFailure } from './util.js';

const NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/;
// A composition id is also a directory name, so it takes no separators or dots (Remotion's id rules, as compositions.tsx).
const COMP = /^[a-zA-Z0-9\-　-鿿가-힯]+$/;

export function checkPresetName(name: string): void {
  if (!NAME.test(name)) {
    throw new StudioFailure('INVALID_ARG', `a preset name is lower-case letters, digits, - and _, up to 64, starting with a letter or digit; got ${JSON.stringify(name)}`);
  }
}

function presetDir(entry: string, comp: string): string {
  if (!COMP.test(comp)) throw new StudioFailure('INVALID_ARG', `not a composition id: ${JSON.stringify(comp)}`);
  return join(dirname(entry), 'presets', comp);
}

/** The presets of `comp`, by name; a file that is not a JSON object is skipped. */
export function listPresets(entry: string, comp: string): PresetInfo[] {
  const dir = presetDir(entry, comp);
  if (!existsSync(dir)) return [];
  const presets: PresetInfo[] = [];
  for (const file of readdirSync(dir).sort()) {
    const name = file.replace(/\.json$/, '');
    if (name === file || !NAME.test(name)) continue;
    try {
      const props: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (typeof props === 'object' && props !== null && !Array.isArray(props)) presets.push({ name, props: props as Record<string, unknown> });
    } catch {
      // not JSON: not a preset
    }
  }
  return presets;
}

export function savePreset(entry: string, comp: string, name: string, props: unknown): void {
  checkPresetName(name);
  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    throw new StudioFailure('INVALID_ARG', 'a preset is a JSON object of props');
  }
  const dir = presetDir(entry, comp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(props, null, 2)}\n`);
}
