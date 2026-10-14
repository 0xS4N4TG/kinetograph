import { effectCatalog } from '@kinetograph/scene';
import { CliError } from '../errors.js';
import { native } from '../native.js';
import { listCompositions } from '../source.js';
import { ENTRY, type Command } from './types.js';

export const compositions: Command = {
  name: 'compositions',
  summary: 'List the compositions of a project',
  project: false,
  positionals: [ENTRY],
  options: [],
  async run(args) {
    const list = await listCompositions(String(args.positionals.entry));
    const text = list
      .map((c) => `${c.id}  ${c.width}x${c.height}  ${c.fps} fps  ${c.durationInFrames} frames (${(c.durationInFrames / c.fps).toFixed(2)} s)`)
      .join('\n');
    return { data: { compositions: list }, text: text || '(no compositions)' };
  },
};

export const effects: Command = {
  name: 'effects',
  summary: 'List the effects and their parameters',
  project: false,
  positionals: [],
  options: [],
  async run() {
    const lines: string[] = [];
    for (const effect of effectCatalog) {
      lines.push(`${effect.type}: ${effect.description}`);
      for (const f of effect.fields) {
        const fallback = f.default === undefined ? 'required' : `default ${JSON.stringify(f.default)}`;
        lines.push(`  ${f.name} (${f.type}, ${fallback}): ${f.description}`);
      }
    }
    return { data: { effects: effectCatalog }, text: lines.join('\n') || '(no effects listed)' };
  },
};

export const doctor: Command = {
  name: 'doctor',
  summary: 'Report what this install can do (compat mode is not built yet)',
  project: false,
  positionals: [],
  options: [],
  async run() {
    let addon: { loaded: true; version: string } | { loaded: false; error: string };
    try {
      addon = { loaded: true, version: native().version() };
    } catch (error) {
      addon = { loaded: false, error: error instanceof CliError ? error.message : String(error) };
    }
    const data = {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      addon,
      compat: {
        built: false,
        phase: 5,
        message:
          'Remotion compat mode (CSS subset, Chrome fallback per frame range) is not built yet. Projects must use ' +
          'the Remotion core API and the native elements; imports of other @remotion/* packages fail to bundle.',
      },
    };
    const text = [
      `node ${data.node} on ${data.platform}`,
      addon.loaded ? `addon: loaded, version ${addon.version}` : `addon: NOT loaded: ${addon.error}`,
      `compat mode: not built (Phase 5). ${data.compat.message}`,
    ].join('\n');
    return { data, text };
  },
};
