import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNTIMES } from '../src/registry.js';
import { ensureOnnxRuntime, runtimeDir, runtimeLibrary } from '../src/runtime.js';
import { resetVideoMattingForTests, setFetchForTests } from '../src/testing.js';
import { serve, tempDir } from './helpers.js';

const key = `${process.platform}-${process.arch}`;
const original = RUNTIMES[key];
const savedModelDir = process.env.KINETOGRAPH_MODEL_DIR;
const savedOrt = process.env.ORT_DYLIB_PATH;
let dir: string;

/** An archive laid out like Microsoft's (`<folder>/lib/<files>`), and the spec that pins it. */
function fakeArchive(): Buffer {
  const folder = 'onnxruntime-fake';
  const lib = join(dir, 'src', folder, 'lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'libfake.so'), 'the library');
  writeFileSync(join(lib, 'libfake_providers.so'), 'the provider');
  writeFileSync(join(lib, 'unused.txt'), 'left in the archive');
  const archive = join(dir, 'fake.tgz');
  execFileSync('tar', ['-czf', archive, '-C', join(dir, 'src'), folder]);
  const bytes = readFileSync(archive);
  RUNTIMES[key] = { folder, archive: 'fake.tgz', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), library: 'libfake.so', others: ['libfake_providers.so'] };
  return bytes;
}

beforeEach(() => {
  resetVideoMattingForTests();
  dir = tempDir('kt-runtime-test-');
  process.env.KINETOGRAPH_MODEL_DIR = join(dir, 'models');
  delete process.env.ORT_DYLIB_PATH;
});

afterEach(() => {
  RUNTIMES[key] = original!;
  if (savedModelDir === undefined) delete process.env.KINETOGRAPH_MODEL_DIR;
  else process.env.KINETOGRAPH_MODEL_DIR = savedModelDir;
  if (savedOrt !== undefined) process.env.ORT_DYLIB_PATH = savedOrt;
});

describe.skipIf(process.platform === 'win32' || original === undefined)('ensureOnnxRuntime', () => {
  it('downloads the archive once, keeps the library and its neighbour, and drops the rest', async () => {
    const log = { urls: [] as string[], ranges: [] as (string | null)[] };
    setFetchForTests(serve(fakeArchive(), log));
    const path = await ensureOnnxRuntime();
    expect(path).toBe(runtimeLibrary());
    expect(readFileSync(path!, 'utf8')).toBe('the library');
    expect(existsSync(join(dirname(path!), 'libfake_providers.so'))).toBe(true);
    expect(existsSync(join(dirname(path!), 'unused.txt'))).toBe(false);
    expect(existsSync(join(runtimeDir(), 'fake.tgz'))).toBe(false);
    expect(log.urls[0]).toMatch(/^https:\/\/github\.com\/microsoft\/onnxruntime\/releases\/download\/v[\d.]+\/fake\.tgz$/);
    // A second call finds it and fetches nothing.
    expect(await ensureOnnxRuntime()).toBe(path);
    expect(log.urls).toHaveLength(1);
  });

  it('refuses an archive that does not match its pinned hash and leaves no library', async () => {
    const bytes = fakeArchive();
    RUNTIMES[key] = { ...RUNTIMES[key]!, sha256: '0'.repeat(64) };
    setFetchForTests(serve(bytes, { urls: [], ranges: [] }));
    await expect(ensureOnnxRuntime()).rejects.toMatchObject({ code: 'MODEL_CHECKSUM' });
    expect(existsSync(runtimeLibrary())).toBe(false);
  });

  it('downloads nothing when ORT_DYLIB_PATH names a library', async () => {
    process.env.ORT_DYLIB_PATH = '/somewhere/libonnxruntime.so';
    const log = { urls: [] as string[], ranges: [] as (string | null)[] };
    setFetchForTests(serve(Buffer.alloc(1), log));
    expect(await ensureOnnxRuntime()).toBeUndefined();
    expect(log.urls).toHaveLength(0);
  });
});
