#!/usr/bin/env node
// Finds where Kinetograph's renderer dies on a machine whose GPU crashes it (issues #141, #153). Needs only Node 22+ and
// the addon file `kinetograph.win32-x64-msvc.node`: no network, nothing installed, nothing written except `--out`.
//
//   node windows-debug-probe.mjs [path\to\kinetograph.win32-x64-msvc.node] [--out report.txt]
//
// With no path it looks next to this script. It starts the renderer and draws one 64x36 white rectangle in a child
// process, once for each setting below, with the addon's start-up trace (KINETOGRAPH_TRACE_START) and, on Windows, its
// crash report (KINETOGRAPH_CRASH_REPORT) on. Per run it prints the trace lines, the crash report and the exit code.
// It prints no environment variables, no user name and no directories: module and file names only.

import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 90_000;
const BACKENDS = [
  ['default', {}],
  ['WGPU_BACKEND=vulkan', { WGPU_BACKEND: 'vulkan' }],
  ['WGPU_BACKEND=dx12', { WGPU_BACKEND: 'dx12' }],
];
const RUNS = [...BACKENDS, ...BACKENDS.map(([name, env]) => [`${name} KINETOGRAPH_SKIA_CPU=1`, { ...env, KINETOGRAPH_SKIA_CPU: '1' }])];
const SCENE = JSON.stringify({
  width: 64, height: 36, fps: 30, durationInFrames: 1, background: '#000',
  layers: [{ id: 'bg', type: 'shape', shape: { kind: 'rect', width: 64, height: 36 }, fill: '#fff' }],
});

// The child: loads the addon, starts the renderer, draws the still, says each step as a JSON line on stdout.
const CHILD = `
const fs = require('node:fs');
const say = (o) => fs.writeSync(1, JSON.stringify(o) + '\\n');
try {
  say({ step: 'load addon' });
  const native = require(process.argv[1]);
  say({ step: 'addon loaded', version: native.version() });
  say({ step: 'start renderer' });
  const r = new native.Renderer();
  say({ step: 'renderer started', backend: r.backend(), reason: r.backendReason() });
  say({ step: 'draw one still' });
  const png = r.still(process.argv[2], 0);
  say({ step: 'still drawn', bytes: png.length, png: png.subarray(1, 4).toString() === 'PNG' });
} catch (e) {
  say({ error: e instanceof Error ? e.message : String(e) });
}
`;

const NT_STATUS = {
  '0xC0000005': 'access violation',
  '0xC0000374': 'heap corruption',
  '0xC0000409': 'fail-fast stop (stack buffer overrun or abort)',
  '0xC000001D': 'illegal instruction',
  '0xC00000FD': 'stack overflow',
  '0xC0000135': 'a DLL was not found',
  '0xC000007B': 'a DLL of the wrong bitness',
};

/** Hides what identifies the person: user name, home folder, and the directories of any path (file names stay). */
function scrub(text) {
  let out = text;
  for (const secret of [homedir(), safeUser()].filter((s) => s && s.length > 2)) out = out.split(secret).join('<user>');
  return out.replace(/(?:[A-Za-z]:|\\\\[^\s\\]+)[\\/][^\s"'<>|]*|\/(?:[^\s"'<>|/]+\/)+[^\s"'<>|/]*/g, (p) => basename(p.replace(/\\/g, '/')) || p);
}
function safeUser() {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

function describeExit(status, signal) {
  if (signal) return signal;
  if (status === 0) return 'exit code 0';
  const hex = `0x${(status >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  return NT_STATUS[hex] ? `${hex} (${NT_STATUS[hex]})` : `exit code ${status} (${hex})`;
}

function findAddon(args, outFile) {
  const given = args.find((a) => !a.startsWith('-') && a !== outFile);
  if (given) return resolve(given);
  const here = dirname(fileURLToPath(import.meta.url));
  const found = readdirSync(here).filter((f) => /^kinetograph\..*\.node$/.test(f)).sort((a, b) => Number(b.includes('win32-x64')) - Number(a.includes('win32-x64')));
  return found.length > 0 ? join(here, found[0]) : undefined;
}

/** One run: the child with `env` on top of what this process has (minus any WGPU_ or KINETOGRAPH_ setting). */
function run(addon, env) {
  return new Promise((done) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(WGPU_|KINETOGRAPH_)/.test(k)));
    const child = spawn(process.execPath, ['-e', CHILD, addon, SCENE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...base, ...env, KINETOGRAPH_TRACE_START: '1', KINETOGRAPH_CRASH_REPORT: '1' },
    });
    let out = '';
    let err = '';
    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ out, err, hung, status: null, signal: null, spawnError: e.message });
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      done({ out, err, hung, status, signal });
    });
  });
}

function report(label, r) {
  const lines = [`==== ${label} ====`];
  const steps = [];
  for (const l of r.out.split(/\r?\n/)) {
    try {
      steps.push(JSON.parse(l));
    } catch {
      // not a step line
    }
  }
  const errLines = r.err.split(/\r?\n/).filter(Boolean);
  const trace = errLines.filter((l) => l.startsWith('kinetograph-trace: '));
  const crash = errLines.filter((l) => l.startsWith('kinetograph-crash: '));
  const other = errLines.length - trace.length - crash.length;
  lines.push('steps the child reported:');
  for (const s of steps) lines.push(`  ${s.error !== undefined ? `ERROR: ${s.error}` : Object.entries(s).map(([k, v]) => (k === 'step' ? v : `${k}=${v}`)).join(' ')}`);
  // A run that finished does not need its ~80 lines of shader and pipeline creation; one that did not needs every line.
  const finished = !r.hung && r.status === 0 && !r.signal;
  const shown = finished ? trace.filter((l) => !/^kinetograph-trace: \d+ (start|done) (shader-module|pipeline) /.test(l)) : trace;
  lines.push(`start-up trace (${trace.length} lines; a line "start" with no "done" after it is where it stopped):`);
  for (const l of shown) lines.push(`  ${l.slice('kinetograph-trace: '.length)}`);
  if (shown.length < trace.length) lines.push(`  (${trace.length - shown.length} shader module and pipeline lines left out of a run that finished)`);
  lines.push(crash.length > 0 ? 'crash report:' : 'crash report: none (it is written on Windows only, and only on a fatal exception)');
  for (const l of crash) lines.push(`  ${l.slice('kinetograph-crash: '.length)}`);
  if (other > 0) lines.push(`(${other} other lines on stderr, not shown)`);
  const drew = steps.some((s) => s.step === 'still drawn');
  const how = r.spawnError
    ? `could not start: ${r.spawnError}`
    : r.hung
      ? `HUNG, stopped after ${TIMEOUT_MS / 1000} s`
      : `${drew ? 'drew the still, ' : 'DID NOT draw the still, '}${describeExit(r.status, r.signal)}`;
  lines.push(`result: ${how}`);
  return scrub(lines.join('\n'));
}

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outFile = outAt >= 0 ? args[outAt + 1] : undefined;
if (args.includes('--help') || args.includes('-h') || (outAt >= 0 && outFile === undefined)) {
  console.log('usage: node windows-debug-probe.mjs [path/to/kinetograph.win32-x64-msvc.node] [--out report.txt]');
  process.exit(args.includes('--help') || args.includes('-h') ? 0 : 2);
}
const addon = findAddon(args, outFile);
if (addon === undefined) {
  console.error('no kinetograph.*.node found next to this script; give its path as the first argument');
  process.exit(2);
}

const text = [];
const say = (s) => {
  text.push(s);
  console.log(s);
};
say(`Kinetograph debug probe: node ${process.version}, ${process.platform}-${process.arch}, addon ${basename(addon)}`);
say(`${RUNS.length} runs, each in its own process, one 64x36 still of a white rectangle`);
say('');
for (const [label, env] of RUNS) {
  say(report(label, await run(addon, env)));
  say('');
}
say('Please send everything above (or the --out file) to the issue.');
if (outFile !== undefined) writeFileSync(outFile, `${text.join('\n')}\n`);
