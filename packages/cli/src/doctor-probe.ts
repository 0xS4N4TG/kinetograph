// The install check of `kinetograph doctor`, run in a child process: loading the addon and opening the GPU are native
// calls that a driver can kill the process in (an access violation prints nothing). In a child, a crash is an exit code
// the parent reports, with the stage it died in and a hint.

import { spawn } from 'node:child_process';

export type Stage = 'addon' | 'renderer';

/** How the probe went wrong, when it did. `exit`: it had finished, then died while the process shut down. */
export interface ProbeFailure {
  stage: Stage | 'exit';
  kind: 'crash' | 'hang' | 'error';
  /** A crash: the exit code as Windows writes it (`0xC0000005`) or the signal (`SIGSEGV`). */
  code?: string;
  /** What the code means, if known. */
  meaning?: string;
  /** An `error`: what the addon threw. */
  message?: string;
}

export interface ProbeResult {
  addon: { loaded: true; version: string } | { loaded: false; error: string };
  renderer: string | null;
  rendererReason: string | null;
  failure?: ProbeFailure;
}

/** Windows exit codes that a native crash leaves (`NTSTATUS`). */
const NT_STATUS: Record<string, string> = {
  '0xC0000005': 'access violation: the process read or wrote memory it does not own',
  '0xC0000374': 'heap corruption: something wrote outside its memory block',
  '0xC0000409': 'a fail-fast stop (stack buffer overrun or an abort)',
  '0xC000001D': 'illegal instruction: the CPU does not have an instruction the code uses',
  '0xC00000FD': 'stack overflow',
  '0xC0000135': 'a DLL the addon needs was not found',
  '0xC0000139': 'a DLL the addon needs lacks a function it asks for',
  '0xC000007B': 'a DLL of the wrong bitness',
};

/** The exit status or signal of a child that died, as a code and what it means. `undefined` for a clean exit. */
export function describeExit(status: number | null, signal: string | null): { code: string; meaning?: string } | undefined {
  if (signal) return { code: signal };
  if (status === null || status === 0) return undefined;
  // Windows hands the status over signed or unsigned depending on who reads it: -1073741819 is 0xC0000005.
  const code = `0x${(status >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  const meaning = NT_STATUS[code];
  return meaning === undefined ? { code: process.platform === 'win32' ? code : `exit code ${status}` } : { code, meaning };
}

/** The lines the probe's child says, parsed; anything that is not one of its lines is ignored. */
export function parseProbeLines(text: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) lines.push(parsed as Record<string, unknown>);
    } catch {
      // Not ours (a driver or layer printing to stdout).
    }
  }
  return lines;
}

/**
 * What the child said and how it ended, as a result. `lines` are its stage lines in order: `{stage}` before a stage,
 * `{stage, done: true, ...}` after, `{stage, error}` when the addon threw. `ended` is how it exited: `hung` when it was
 * killed for taking too long.
 */
export function interpret(lines: Record<string, unknown>[], ended: { status: number | null; signal: string | null; hung: boolean }): ProbeResult {
  let addon: ProbeResult['addon'] | undefined;
  let renderer: string | null = null;
  let rendererReason: string | null = null;
  let rendererDone = false;
  let started: Stage | undefined;
  let failure: ProbeFailure | undefined;
  for (const line of lines) {
    const stage = line.stage as Stage;
    if (typeof line.error === 'string') {
      if (stage === 'addon') addon = { loaded: false, error: line.error };
      else failure = { stage, kind: 'error', message: line.error };
    } else if (line.done === true && stage === 'addon') {
      addon = { loaded: true, version: String(line.version) };
    } else if (line.done === true && stage === 'renderer') {
      rendererDone = true;
      renderer = String(line.backend);
      rendererReason = typeof line.reason === 'string' ? line.reason : null;
    } else if (line.done === undefined) {
      started = stage;
    }
  }
  const exit = describeExit(ended.status, ended.signal);
  if (ended.hung || exit !== undefined) {
    const finished = addon !== undefined && (!addon.loaded || rendererDone || failure !== undefined);
    const stage: ProbeFailure['stage'] = finished ? 'exit' : (started ?? 'addon');
    failure = ended.hung ? { stage, kind: 'hang' } : { stage, kind: 'crash', code: exit?.code, ...(exit?.meaning ? { meaning: exit.meaning } : {}) };
  }
  if (addon === undefined) {
    addon = { loaded: false, error: failure?.kind === 'error' ? (failure.message ?? 'unknown') : 'the process ended before the addon said it had loaded' };
  }
  return { addon, renderer, rendererReason, ...(failure ? { failure } : {}) };
}

/** What a person can do about `failure`. */
export function hintFor(failure: ProbeFailure, platform: string = process.platform): string {
  const where =
    failure.stage === 'addon'
      ? 'while loading the native addon'
      : failure.stage === 'renderer'
        ? 'while starting the renderer (the first thing that opens the GPU)'
        : 'after the check had finished, while the process shut down';
  const what = failure.kind === 'hang' ? `hung ${where} and was stopped` : `crashed ${where}`;
  const tries =
    failure.stage === 'renderer'
      ? platform === 'win32'
        ? 'Try KINETOGRAPH_SKIA_CPU=1, WGPU_BACKEND=dx12 or WGPU_BACKEND=vulkan, WGPU_POWER_PREF=low or WGPU_ADAPTER_NAME=<part of the GPU name>, update the GPU driver, and turn off Vulkan overlays (game and screen-capture overlays).'
        : 'Try KINETOGRAPH_SKIA_CPU=1, WGPU_BACKEND=vulkan, WGPU_POWER_PREF=low or WGPU_ADAPTER_NAME=<part of the GPU name>, and update the GPU driver.'
      : 'Reinstall the package, and check that the Microsoft Visual C++ Redistributable is installed on Windows.';
  return `the check ${what}. ${tries} Report it at https://github.com/0xS4N4TG/kinetograph/issues with this output.`;
}

/** The report's lines for `failure`: what happened, and for a crash or a hang what to do. */
export function describeFailure(failure: ProbeFailure, platform: string = process.platform): string[] {
  if (failure.kind === 'error') return [`why it could not start: ${failure.message}`];
  const code = failure.code === undefined ? '' : `: ${failure.code}${failure.meaning ? ` (${failure.meaning})` : ''}`;
  return [`${failure.kind === 'hang' ? 'hung' : 'crashed'}${code}`, `hint: ${hintFor(failure, platform)}`];
}

/** The child's program: loads the addon at `process.argv[1]`, opens the renderer, says each step as one JSON line. */
const CHILD = `
const fs = require('node:fs');
const say = (o) => fs.writeSync(1, JSON.stringify(o) + '\\n');
let stage = 'addon';
try {
  say({ stage });
  const native = require(process.argv[1]);
  say({ stage, done: true, version: native.version() });
  stage = 'renderer';
  say({ stage });
  const r = new native.Renderer();
  say({ stage, done: true, backend: r.backend(), reason: r.backendReason() });
} catch (e) {
  say({ stage, error: e instanceof Error ? e.message : String(e) });
}
`;

/** Env vars that change what the renderer does, as set here, for the report. */
export function relevantEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = ['WGPU_BACKEND', 'WGPU_POWER_PREF', 'WGPU_ADAPTER_NAME', 'WGPU_DX12_COMPILER', 'KINETOGRAPH_SKIA_CPU'];
  return names.filter((n) => env[n] !== undefined).map((n) => `${n}=${env[n]}`);
}

export const PROBE_TIMEOUT_MS = 60_000;

/**
 * Loads `addonPath` and opens the renderer in a child process. `onStage` is told each stage before it starts, as the
 * child reaches it. Never rejects: a child that crashes or hangs is a result with a `failure`.
 */
export function probeInstall(addonPath: string, onStage: (stage: Stage) => void, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let out = '';
    let hung = false;
    let told = 0;
    const child = spawn(process.execPath, ['-e', CHILD, addonPath], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => {
      hung = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const tell = (): void => {
      const lines = parseProbeLines(out.slice(0, out.lastIndexOf('\n') + 1));
      for (; told < lines.length; told++) {
        const line = lines[told]!;
        if (line.done === undefined && line.error === undefined) onStage(line.stage as Stage);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      tell();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ addon: { loaded: false, error: `cannot start the check process: ${error.message}` }, renderer: null, rendererReason: null });
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve(interpret(parseProbeLines(out), { status, signal, hung }));
    });
  });
}
