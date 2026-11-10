// A delayRender() that nothing clears (issue #101): `still`, `render` and `doctor` fail with the label and a code, in
// the time `--timeout` or `timeoutInMilliseconds` gives, and never leave Node to exit with code 13 on an unsettled await.
//
// One project is run in this process (the first test): once a project has installed the frame clock, the next project
// bundled here would capture its fake timers, so the rest run the built CLI, one process each (skipped without
// `npm run build`). The addon is not reached: the frame fails before anything is drawn.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCommandArgs } from '../src/args.js';
import { allOptions } from '../src/commands/types.js';
import { findCommand } from '../src/commands/index.js';
import { run } from '../src/index.js';
import { setNativeForTests } from '../src/native.js';
import { fakeNative } from './helpers.js';

vi.setConfig({ testTimeout: 60_000 });

beforeEach(() => setNativeForTests(fakeNative().native));
afterEach(() => {
  setNativeForTests(undefined);
  delete process.env.KINETOGRAPH_DELAY_RENDER_TIMEOUT;
});

const STUCK = `
import { useState } from 'react';
import { Composition, registerRoot, AbsoluteFill, delayRender } from 'remotion';

const S = () => {
  useState(() => delayRender('waiting for the page'));
  return <AbsoluteFill style={{ background: '#000' }} />;
};
registerRoot(() => <Composition id="T" component={S} durationInFrames={2} fps={24} width={64} height={64} />);
`;

const OWN_TIMEOUT = STUCK.replace("delayRender('waiting for the page')", "delayRender('waiting for the page', { timeoutInMilliseconds: 120 })");

function project(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kinetograph-delay-render-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
  writeFileSync(join(dir, 'index.tsx'), source);
  return join(dir, 'index.tsx');
}

const label = (after: number) => `A delayRender() "waiting for the page" was called but not cleared after ${after}ms`;

describe('--timeout', () => {
  it('is an option of still, render and doctor, a number of milliseconds', () => {
    for (const name of ['still', 'render', 'doctor']) {
      expect(allOptions(findCommand([name])!.command).map((o) => o.name)).toContain('timeout');
    }
    const command = findCommand(['still'])!.command;
    const spec = { name: command.name, positionals: command.positionals, options: allOptions(command) };
    expect(parseCommandArgs(spec, ['a.tsx', '0', '--timeout', '500']).options.timeout).toBe(500);
  });
});

describe('a delayRender() that is never cleared, in this process', () => {
  it('fails still with the label, the code and --json', async () => {
    const out: string[] = [];
    const code = await run(['still', project(STUCK), '0', '--timeout', '150', '--json'], { out: (s) => void out.push(s), err: () => undefined });
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({
      error: { code: 'DELAY_RENDER_TIMEOUT', message: expect.stringContaining(label(150)) },
    });
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, '..', 'dist', 'cli.js');

describe.skipIf(!existsSync(built))('the built CLI on a delayRender() that is never cleared', () => {
  const kinetograph = (...argv: string[]) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [built, ...argv], { encoding: 'utf8', timeout: 50_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, seconds: (Date.now() - started) / 1000 };
  };

  it('still: the labelled error as JSON, exit code 1, never 13', () => {
    const r = kinetograph('still', project(STUCK), '0', '--timeout', '300', '--json');
    expect(r.stderr).not.toContain('unsettled top-level await');
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: { code: 'DELAY_RENDER_TIMEOUT', message: expect.stringContaining(label(300)) } });
  });

  it('still: says it on stderr without --json', () => {
    const r = kinetograph('still', project(STUCK), '0', '--timeout', '300');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`error: ${label(300)}`);
  });

  it('render: the same error', () => {
    const entry = project(STUCK);
    const r = kinetograph('render', entry, '--timeout', '300', '--concurrency', '1', '-o', join(dirname(entry), 'out.mp4'), '--json');
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: { code: 'DELAY_RENDER_TIMEOUT', message: expect.stringContaining(label(300)) } });
  });

  it('render with workers: the code survives the worker thread', () => {
    const entry = project(STUCK);
    const r = kinetograph('render', entry, '--timeout', '300', '--concurrency', '2', '-o', join(dirname(entry), 'out.mp4'), '--json');
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: { code: 'DELAY_RENDER_TIMEOUT', message: expect.stringContaining(label(300)) } });
  });

  it('doctor: reported for the composition as a render error, exit code 1', () => {
    const r = kinetograph('doctor', project(STUCK), '--timeout', '300', '--json');
    expect(r.stderr).not.toContain('unsettled top-level await');
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.comp).toBe('T');
    expect(report.renderErrors).toEqual([{ message: expect.stringContaining(label(300)), ranges: [[0, 0]], frames: 1 }]);
  });

  it('timeoutInMilliseconds in the project wins over --timeout', () => {
    const r = kinetograph('still', project(OWN_TIMEOUT), '0', '--timeout', '60000', '--json');
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error.message).toContain(label(120));
    expect(r.seconds).toBeLessThan(30);
  });

  it('--timeout is refused unless it is a positive whole number', () => {
    for (const bad of ['0', '1.5', 'soon']) {
      const r = kinetograph('still', project(STUCK), '0', '--timeout', bad, '--json');
      expect(r.status, bad).toBe(1);
      expect(JSON.parse(r.stdout).error.code, bad).toBe('INVALID_ARG');
    }
  });
});
