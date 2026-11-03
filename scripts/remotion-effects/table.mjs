#!/usr/bin/env node
// Rewrites the effects table of the docs page from the parity harness's status.json, so the page says what was measured.
//
//   node scripts/remotion-effects/table.mjs [status.json] [page.mdx]
//
// The table sits between the markers `{/* effects:start */}` and `{/* effects:end */}`.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const statusFile = resolve(process.argv[2] ?? join(here, 'status.json'));
const pageFile = resolve(process.argv[3] ?? join(here, '..', '..', 'packages', 'site', 'content', 'docs', 'guides', 'remotion-effects.mdx'));
const status = JSON.parse(readFileSync(statusFile, 'utf8'));
const { version } = status;
// The harness's own cases (the chain) are not effects of the package.
const effects = Object.fromEntries(Object.entries(status.effects).filter(([, e]) => !e.sub.startsWith('(')));

const label = { supported: 'Supported', approximated: 'Approximated', 'not yet': 'Not yet', 'not checked': 'Not checked yet' };
const rows = Object.entries(effects)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, e]) => `| \`${name}()\` | ${e.backends.join(', ')} | ${label[e.status] ?? e.status}${e.note ? `. ${e.note}` : ''} |`);
const counts = Object.fromEntries(['supported', 'approximated', 'not yet', 'not checked'].map((s) => [s, Object.values(effects).filter((e) => e.status === s).length]));
const summary = `${counts.supported} of ${rows.length} are supported, ${counts.approximated} approximated, ${counts['not yet']} not yet${counts['not checked'] ? `, ${counts['not checked']} not checked yet` : ''}. Measured against Remotion ${version} in Chrome.`;
const table = ['| Effect | Backends | Status |', '| --- | --- | --- |', ...rows].join('\n');

const page = readFileSync(pageFile, 'utf8');
const start = page.indexOf('{/* effects:start */}');
const end = page.indexOf('{/* effects:end */}');
if (start === -1 || end === -1) throw new Error(`${pageFile} has no effects:start and effects:end markers`);
writeFileSync(pageFile, `${page.slice(0, start)}{/* effects:start */}\n${summary}\n\n${table}\n${page.slice(end)}`);
console.log(summary);
