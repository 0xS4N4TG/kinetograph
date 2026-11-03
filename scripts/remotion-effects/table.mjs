#!/usr/bin/env node
// Rewrites the effects table of the docs page from the parity harness's status.json, so the page says what was measured.
//
//   node scripts/remotion-effects/table.mjs [status.json] [page.mdx]
//
// It also writes packages/cli/assets/remotion-effects.json (the version measured and each effect's status), which `doctor` reads.
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
// The harness's own cases (the chain, the components) are not effects of the package.
const effects = Object.fromEntries(Object.entries(status.effects).filter(([, e]) => !e.sub.startsWith('(')));
const components = Object.entries(status.effects).filter(([, e]) => e.sub.startsWith('(<'));

const label = { supported: 'Supported', approximated: 'Approximated', 'not yet': 'Not yet', 'not checked': 'Not checked yet' };
const rows = Object.entries(effects)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, e]) => `| \`${name}()\` | ${e.backends.join(', ')} | ${label[e.status] ?? e.status}${e.note ? `. ${e.note}` : ''} |`);
const counts = Object.fromEntries(['supported', 'approximated', 'not yet', 'not checked'].map((s) => [s, Object.values(effects).filter((e) => e.status === s).length]));
const summary = `${counts.supported} of ${rows.length} are supported, ${counts.approximated} approximated, ${counts['not yet']} not yet${counts['not checked'] ? `, ${counts['not checked']} not checked yet` : ''}. Measured against Remotion ${version} in Chrome.`;
const table = ['| Effect | Backends | Status |', '| --- | --- | --- |', ...rows].join('\n');

const db = (v) => (v === undefined ? 'not drawn' : v >= 999 ? 'identical' : `${v.toFixed(1)} dB`);
const componentRows = components.map(([, e]) => {
  const drawn = Object.entries(e.measured).filter(([, v]) => v.psnr != null);
  const best = ['webgpu', 'webgl2'].map((b) => e.measured[b]).find((v) => v?.psnr != null);
  return `| ${e.sub.slice(1, -1).replace(/<\w+>/, (c) => `\`${c}\``)} | ${drawn.map(([b, v]) => `${b} ${db(v.psnr)}, SSIM ${v.ssim.toFixed(3)}`).join('; ')} | ${label[e.status]}${e.note ? `. ${e.note}` : ''} |`;
});
const componentTable = ['| Case | PSNR and SSIM against Remotion | Status |', '| --- | --- | --- |', ...componentRows].join('\n');

let page = readFileSync(pageFile, 'utf8');
const replaceBetween = (name, body) => {
  const start = page.indexOf(`{/* ${name}:start */}`);
  const end = page.indexOf(`{/* ${name}:end */}`);
  if (start === -1 || end === -1) throw new Error(`${pageFile} has no ${name}:start and ${name}:end markers`);
  page = `${page.slice(0, start)}{/* ${name}:start */}\n${body}\n${page.slice(end)}`;
};
replaceBetween('effects', `${summary}\n\n${table}`);
if (components.length > 0) replaceBetween('components', componentTable);
writeFileSync(pageFile, page);
// What `kinetograph doctor` knows of the run: the version it was measured against, and each effect's status.
const slim = Object.fromEntries(Object.entries(effects).sort(([a], [b]) => a.localeCompare(b)).map(([name, e]) => [name, { sub: e.sub, status: e.status }]));
writeFileSync(join(here, '..', '..', 'packages', 'cli', 'assets', 'remotion-effects.json'), `{\n "version": ${JSON.stringify(version)},\n "effects": {\n${Object.entries(slim).map(([name, e]) => `  ${JSON.stringify(name)}: ${JSON.stringify(e)}`).join(',\n')}\n }\n}\n`);
console.log(summary);
