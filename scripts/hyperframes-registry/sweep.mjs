#!/usr/bin/env node
// Which HyperFrames registry items does Kinetograph render? For every block, and every component that has a demo.html,
// this installs the item into a temporary project with `kinetograph add hyperframes/<name>`, then runs `doctor` and
// `still` at two frames, and records:
//   works    nothing unsupported
//   partial  renders, with doctor warnings (listed)
//   fails    an install, doctor or still error
// plus the time. It writes status.json beside this file and keeps no renders; each temporary project is deleted once it
// has been checked. Nothing from the registry is stored in this repository: items are fetched when the sweep runs.
//
//   node scripts/hyperframes-registry/sweep.mjs [--ref <commit>] [--only a,b] [--limit N] [--out file] [--resume]
//                                              [--timeout <seconds>] [--jobs N] [--cli <path to cli.js>]
//
// Needs the built CLI (`npm run build -w kinetograph`), the native addon, and the network. It never starts a browser.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, platform, arch, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

function parseArgs(argv) {
  const out = { ref: undefined, only: undefined, limit: Infinity, out: join(here, 'status.json'), resume: false, timeout: 240, jobs: 1, cli: join(repo, 'packages/cli/dist/cli.js') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--ref') out.ref = value();
    else if (arg === '--only') out.only = new Set(value().split(',').filter(Boolean));
    else if (arg === '--limit') out.limit = Number(value());
    else if (arg === '--out') out.out = resolve(value());
    else if (arg === '--resume') out.resume = true;
    else if (arg === '--timeout') out.timeout = Number(value());
    else if (arg === '--jobs') out.jobs = Math.max(1, Number(value()));
    else if (arg === '--cli') out.cli = resolve(value());
    else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

/** Runs the CLI; resolves with the exit code, the parsed `--json` output (or null) and stderr. Never throws. */
function cli(options, args, timeoutSeconds) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [options.cli, ...args, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KINETOGRAPH_NO_UPDATE_CHECK: '1', CI: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSeconds * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        // not JSON: the error text is in stderr
      }
      done({ code: code ?? 1, json, stderr, timedOut });
    });
  });
}

const short = (text, n = 300) => {
  const line = String(text).replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/** Why a CLI call failed, in one line. */
function failure(step, result) {
  if (result.timedOut) return `${step}: timed out`;
  const message = result.json?.error?.message ?? result.json?.error ?? result.stderr;
  return `${step}: ${short(typeof message === 'string' ? message : JSON.stringify(message))}`;
}

/** One doctor issue as the sentence the report prints. */
const issueText = (issue) => `${issue.element}${issue.property == null ? '' : ` ${issue.property}`}: ${issue.reason}`;

const MAX_WARNINGS = 12;

/** The wrapper page that mounts a block the way HyperFrames does. */
function blockPage(entry, name, file) {
  const width = entry.dimensions?.width ?? 1920;
  const height = entry.dimensions?.height ?? 1080;
  const duration = entry.duration ?? 5;
  return `<!doctype html>
<html><head><meta charset="utf-8" /></head><body>
<div id="stage" data-composition-id="main" data-start="0" data-width="${width}" data-height="${height}" data-duration="${duration}" style="position:relative;width:${width}px;height:${height}px;overflow:hidden">
  <div data-composition-id="${name}" data-composition-src="${file}" data-start="0" data-duration="${duration}" data-track-index="1" data-width="${width}" data-height="${height}"></div>
</div>
</body></html>
`;
}

async function checkItem(options, listing, ref) {
  const { name, type } = listing;
  const record = { type, status: 'fails', warnings: [] };
  const dir = mkdtempSync(join(tmpdir(), 'hf-sweep-'));
  try {
    // A root page first, so the install finds the project here; it is replaced below.
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body></body></html>\n');
    const added = await cli(options, ['add', `hyperframes/${name}`, '--dir', dir, ...(ref ? ['--ref', ref] : [])], options.timeout);
    if (added.code !== 0 || added.json?.added === undefined) {
      record.error = failure('install', added);
      return record;
    }
    const entry = added.json.added.find((a) => a.name === name);
    record.files = added.json.added.reduce((n, a) => n + a.written.length + a.unchanged.length, 0);
    record.licence = entry.license ?? null;
    if (type === 'block') {
      const html = entry.written.concat(entry.unchanged).find((t) => t.endsWith('.html'));
      if (html === undefined) {
        record.error = 'install: the block has no html file';
        return record;
      }
      writeFileSync(join(dir, 'index.html'), blockPage(entry, name, html));
    } else {
      const url = `https://raw.githubusercontent.com/heygen-com/hyperframes/${added.json.ref}/registry/components/${name}/demo.html`;
      let demo;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (response.status === 404) {
          record.status = 'skipped';
          record.error = 'no demo.html';
          return record;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        demo = await response.text();
      } catch (error) {
        record.error = `demo: ${short(error.message)}`;
        return record;
      }
      writeFileSync(join(dir, 'index.html'), demo);
    }

    const started = Date.now();
    const doctor = await cli(options, ['doctor', join(dir, 'index.html')], options.timeout);
    record.doctorMs = Date.now() - started;
    const report = doctor.json;
    if (report === null || report.error !== undefined || report.frames === undefined) {
      record.error = failure('doctor', doctor);
      return record;
    }
    record.frames = report.frames;
    for (const e of report.renderErrors ?? []) record.warnings.push(`error: ${short(e.message)}`);
    for (const issue of report.issues ?? []) record.warnings.push(issueText(issue));
    for (const imp of report.unsupportedImports ?? []) record.warnings.push(`unsupported import: ${imp.specifier}`);
    for (const note of report.notes ?? []) record.warnings.push(`note: ${short(note)}`);
    if ((report.renderErrors ?? []).length > 0) {
      record.error = `doctor: the scene is refused: ${short(report.renderErrors[0].message)}`;
      return record;
    }

    // Two frames, a third and four fifths of the way in.
    const n = Math.max(1, report.frames);
    const frames = [...new Set([Math.floor(n * 0.3), Math.floor(n * 0.8)].map((f) => Math.min(report.first + f, report.last)))];
    record.stillMs = [];
    record.stills = [];
    for (const frame of frames) {
      const out = join(dir, 'out', `still-${frame}.png`);
      mkdirSync(dirname(out), { recursive: true });
      const still = await cli(options, ['still', join(dir, 'index.html'), String(frame), '-o', out], options.timeout);
      if (still.code !== 0 || still.json?.ms === undefined) {
        record.error = failure(`still ${frame}`, still);
        return record;
      }
      record.stillMs.push(Math.round(still.json.ms));
      record.stills.push(frame);
      for (const item of still.json.compat?.leftOut ?? []) {
        const text = typeof item === 'string' ? item : issueText(item);
        if (!record.warnings.includes(text)) record.warnings.push(text);
      }
    }
    record.status = record.warnings.length > 0 ? 'partial' : 'works';
    return record;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (record.warnings.length > MAX_WARNINGS) {
      const more = record.warnings.length - MAX_WARNINGS;
      record.warnings = [...record.warnings.slice(0, MAX_WARNINGS), `… and ${more} more`];
    }
  }
}

/** Counts of items per distinct warning, most common first. */
function top(items, pick, n = 10) {
  const counts = new Map();
  for (const [name, item] of Object.entries(items)) {
    for (const text of new Set(pick(item))) counts.set(text, [...(counts.get(text) ?? []), name]);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([feature, names]) => ({ feature, items: names.length, examples: names.slice(0, 3) }));
}

function summarize(items, meta) {
  const counts = { works: 0, partial: 0, fails: 0, skipped: 0 };
  for (const item of Object.values(items)) counts[item.status]++;
  const rendered = Object.values(items).filter((i) => i.stillMs?.length > 0);
  const ms = rendered.flatMap((i) => i.stillMs).sort((a, b) => a - b);
  return {
    ...meta,
    counts,
    stillMs: ms.length === 0 ? null : { median: ms[Math.floor(ms.length / 2)], p90: ms[Math.floor(ms.length * 0.9)], max: ms.at(-1) },
    topUnsupported: top(items, (i) => (i.status === 'partial' ? i.warnings.filter((w) => !w.startsWith('… and ')) : [])),
    topFailures: top(items, (i) => (i.status === 'fails' && i.error ? [i.error] : [])),
    items: Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b))),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.cli)) throw new Error(`${options.cli} is not built: run \`npm run build -w kinetograph\``);
  const listed = await cli(options, ['add', 'hyperframes', '--list', ...(options.ref ? ['--ref', options.ref] : [])], 600);
  if (listed.json?.items === undefined) throw new Error(failure('list', listed));
  const ref = listed.json.ref;
  const todo = listed.json.items.filter((i) => (options.only === undefined || options.only.has(i.name))).slice(0, options.limit);

  let items = {};
  if (options.resume && existsSync(options.out)) items = JSON.parse(readFileSync(options.out, 'utf8')).items ?? {};
  const version = JSON.parse(readFileSync(resolve(dirname(options.cli), '../package.json'), 'utf8')).version;
  const meta = {
    registry: `https://github.com/heygen-com/hyperframes/tree/${ref}/registry`,
    ref,
    machine: `${platform()}-${arch()} ${cpus()[0]?.model ?? ''} (${availableParallelism()} cores)`.trim(),
    kinetograph: version,
    jobs: options.jobs,
  };
  const save = () => writeFileSync(options.out, `${JSON.stringify(summarize(items, meta), null, 2)}\n`);

  let done = 0;
  const queue = todo.filter((l) => !(options.resume && items[l.name] !== undefined));
  const worker = async () => {
    for (;;) {
      const listing = queue.shift();
      if (listing === undefined) return;
      const started = Date.now();
      const r = await checkItem(options, listing, options.ref);
      items[listing.name] = r;
      done++;
      process.stderr.write(`[${Object.keys(items).length}/${todo.length}] ${listing.name} ${r.status} ${((Date.now() - started) / 1000).toFixed(1)}s${r.error ? `  ${r.error}` : ''}\n`);
      if (done % 10 === 0) save();
    }
  };
  await Promise.all(Array.from({ length: options.jobs }, worker));
  save();
  const summary = JSON.parse(readFileSync(options.out, 'utf8'));
  process.stdout.write(`${JSON.stringify({ counts: summary.counts, topUnsupported: summary.topUnsupported }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
