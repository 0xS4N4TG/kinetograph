// A bundle whose inputs have not changed is used again instead of built again (`bundle-cache.ts`), and any change to
// what it was built from builds it again. "Used again" is seen by marking the bundle's file: a build writes the file anew.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleProject } from '../src/bundle.js';

const MARK = '\n/* reused */';

/**
 * Writes a project with every file's modification time minutes back, as files a build is not racing with, and the
 * cache directory already there: the first build of a project makes `node_modules`, which is then too new to trust.
 */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kinetograph-bundle-cache-test-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
  mkdirSync(join(dir, 'node_modules', '.cache', 'kinetograph'), { recursive: true });
  for (const [name, text] of Object.entries(files)) write(dir, name, text);
  for (const old of ['package.json', 'node_modules', '.']) utimesSync(join(dir, old), (clock - 5000) / 1000, (clock - 5000) / 1000);
  return dir;
}

let clock = Date.now() - 600_000;
/** Writes a file and dates it on its own minute-old moment, so no two writes of one file share a modification time. */
function write(dir: string, name: string, text: string): void {
  mkdirSync(join(dir, name, '..'), { recursive: true });
  writeFileSync(join(dir, name), text);
  clock += 1000;
  utimesSync(join(dir, name), clock / 1000, clock / 1000);
  // The directory too: a file added to it changes its time, and a build must see that as long after it was read.
  utimesSync(join(dir, name, '..'), clock / 1000, clock / 1000);
}

/** The bundle's text, and whether it is the one marked earlier (reused) and not made again. */
async function bundle(entry: string): Promise<{ file: string; code: string; reused: boolean }> {
  const { file } = await bundleProject(entry);
  const code = readFileSync(file, 'utf8');
  return { file, code, reused: code.endsWith(MARK) };
}

const INDEX = [`import { registerRoot } from 'remotion';`, `import { helper } from './helper';`, `registerRoot(() => null); console.log(helper);`].join('\n');

describe('a bundle used again', () => {
  it('is the same file and not built again while nothing it read changed', async () => {
    const dir = project({ 'index.ts': INDEX, 'helper.ts': `export const helper = 'FIRST';` });
    const first = await bundle(join(dir, 'index.ts'));
    expect(first.reused).toBe(false);
    appendFileSync(first.file, MARK);
    const again = await bundle(join(dir, 'index.ts'));
    expect(again.file).toBe(first.file);
    expect(again.reused).toBe(true);
  });

  it('is built again when a source file it read is edited', async () => {
    const dir = project({ 'index.ts': INDEX, 'helper.ts': `export const helper = 'FIRST';` });
    const first = await bundle(join(dir, 'index.ts'));
    expect(first.code).toContain('FIRST');
    appendFileSync(first.file, MARK);
    expect((await bundle(join(dir, 'index.ts'))).reused).toBe(true);

    write(dir, 'helper.ts', `export const helper = 'SECOND-EDIT';`);
    const edited = await bundle(join(dir, 'index.ts'));
    expect(edited.reused).toBe(false);
    expect(edited.code).toContain('SECOND-EDIT');
    expect(edited.code).not.toContain('FIRST');

    // The edit is the bundle now used again, and a same-size edit is seen too (the modification time is part of what is read).
    appendFileSync(edited.file, MARK);
    expect((await bundle(join(dir, 'index.ts'))).reused).toBe(true);
    write(dir, 'helper.ts', `export const helper = 'THIRD--EDIT';`);
    expect(statSync(join(dir, 'helper.ts')).size).toBe(Buffer.byteLength(`export const helper = 'SECOND-EDIT';`));
    const third = await bundle(join(dir, 'index.ts'));
    expect(third.reused).toBe(false);
    expect(third.code).toContain('THIRD--EDIT');
  });

  it('is built again when a file is added that an import now means (helper.tsx beside helper.ts)', async () => {
    const dir = project({ 'index.ts': INDEX, 'helper.ts': `export const helper = 'PLAIN';` });
    const first = await bundle(join(dir, 'index.ts'));
    appendFileSync(first.file, MARK);
    expect((await bundle(join(dir, 'index.ts'))).reused).toBe(true);
    write(dir, 'helper.tsx', `export const helper = 'SHADOWING';`);
    const next = await bundle(join(dir, 'index.ts'));
    expect(next.reused).toBe(false);
    expect(next.code).toContain('SHADOWING');
  });

  it('is built again when a file it read is removed, and when the project is given another entry', async () => {
    const dir = project({ 'index.ts': INDEX, 'helper.ts': `export const helper = 'KEPT';`, 'other.ts': `import { registerRoot } from 'remotion'; registerRoot(() => null);` });
    const first = await bundle(join(dir, 'index.ts'));
    appendFileSync(first.file, MARK);
    // Another entry has a bundle of its own: the first's stays as it was.
    expect((await bundle(join(dir, 'other.ts'))).reused).toBe(false);
    expect((await bundle(join(dir, 'index.ts'))).reused).toBe(true);
    // `helper.ts` goes; `index.ts` now has nothing to import, and the build says so rather than use the bundle it had.
    rmSync(join(dir, 'helper.ts'));
    await expect(bundle(join(dir, 'index.ts'))).rejects.toThrow(/helper/);
  });

  it('does not record a build whose inputs were modified while it ran', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinetograph-bundle-cache-test-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
    // Written now, with no back-dating: a change this close to the build may have come after the read.
    writeFileSync(join(dir, 'index.ts'), INDEX);
    writeFileSync(join(dir, 'helper.ts'), `export const helper = 'NOW';`);
    const first = await bundle(join(dir, 'index.ts'));
    appendFileSync(first.file, MARK);
    expect((await bundle(join(dir, 'index.ts'))).reused).toBe(false);
  });

  it('follows a HyperFrames project: the page is read again for what it makes of the bundle', async () => {
    const page = (duration: number): string =>
      `<!doctype html><html><body><div id="root" data-composition-id="main" data-width="320" data-height="180" data-start="0" data-duration="${duration}"></div></body></html>`;
    const dir = project({ 'index.html': page(1) });
    const first = await bundle(join(dir, 'index.html'));
    appendFileSync(first.file, MARK);
    expect((await bundle(join(dir, 'index.html'))).reused).toBe(true);
    write(dir, 'index.html', page(2));
    const edited = await bundle(join(dir, 'index.html'));
    expect(edited.reused).toBe(false);
    expect(edited.code).toMatch(/"?durationSeconds"?: 2\b/);
  });
});
