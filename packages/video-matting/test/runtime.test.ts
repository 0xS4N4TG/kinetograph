import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNTIMES, RUNTIME_PACKAGE } from '../src/registry.js';
import { ensureOnnxRuntime, runtimeDir, runtimeLibrary } from '../src/runtime.js';
import { resetVideoMattingForTests, setFetchForTests } from '../src/testing.js';
import { serve, tempDir } from './helpers.js';

// `writeFileSync` writes half of what it is given to a path `failAt` matches and then throws, as a full disk would.
const disk = vi.hoisted(() => ({ failAt: undefined as RegExp | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const writeFileSync: typeof fs.writeFileSync = (path, data, options) => {
    if (disk.failAt?.test(String(path)) && Buffer.isBuffer(data)) {
      fs.writeFileSync(path, data.subarray(0, data.length >> 1), options);
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    fs.writeFileSync(path, data, options);
  };
  return { ...fs, writeFileSync, default: { ...fs, writeFileSync } };
});

const key = `${process.platform}-${process.arch}`;
const original = RUNTIMES[key];
const originalPackage = { ...RUNTIME_PACKAGE };
const savedModelDir = process.env.KINETOGRAPH_MODEL_DIR;
const savedOrt = process.env.ORT_DYLIB_PATH;
let dir: string;

/** A zip of `files` (name to bytes), deflated, with its central directory. */
function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(n.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, n);
    parts.push(local, n, data);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** A package laid out like Microsoft's (`runtimes/<rid>/native/<files>`), and the pins that go with it. */
function fakePackage(): Buffer {
  const bytes = zip({
    'runtimes/fake/native/libfake.so': 'the library',
    'runtimes/fake/native/libfake_providers.so': 'the provider',
    'runtimes/other/native/libother.so': 'another platform',
  });
  RUNTIMES[key] = { folder: 'onnxruntime-fake', library: 'libfake.so', files: { 'libfake.so': 'runtimes/fake/native/libfake.so', 'libfake_providers.so': 'runtimes/fake/native/libfake_providers.so' } };
  Object.assign(RUNTIME_PACKAGE, { size: bytes.length, sha512: createHash('sha512').update(bytes).digest('hex') });
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
  Object.assign(RUNTIME_PACKAGE, originalPackage);
  if (savedModelDir === undefined) delete process.env.KINETOGRAPH_MODEL_DIR;
  else process.env.KINETOGRAPH_MODEL_DIR = savedModelDir;
  if (savedOrt !== undefined) process.env.ORT_DYLIB_PATH = savedOrt;
  disk.failAt = undefined;
});

describe.skipIf(process.platform === 'win32' || original === undefined)('ensureOnnxRuntime', () => {
  it('downloads the package once, keeps the platform library and its neighbour, and drops the rest', async () => {
    const log = { urls: [] as string[], ranges: [] as (string | null)[] };
    setFetchForTests(serve(fakePackage(), log));
    const path = await ensureOnnxRuntime();
    expect(path).toBe(runtimeLibrary());
    expect(readFileSync(path!, 'utf8')).toBe('the library');
    expect(existsSync(join(dirname(path!), 'libfake_providers.so'))).toBe(true);
    expect(existsSync(join(dirname(path!), 'libother.so'))).toBe(false);
    expect(readdirSync(runtimeDir())).toEqual(['onnxruntime-fake']);
    expect(log.urls[0]).toMatch(/^https:\/\/api\.nuget\.org\/v3-flatcontainer\/microsoft\.ml\.onnxruntime\/[\d.]+\/microsoft\.ml\.onnxruntime\.[\d.]+\.nupkg$/);
    // A second call finds it and fetches nothing.
    expect(await ensureOnnxRuntime()).toBe(path);
    expect(log.urls).toHaveLength(1);
  });

  it('refuses a package that does not match its pinned hash and leaves no library', async () => {
    const bytes = fakePackage();
    RUNTIME_PACKAGE.sha512 = '0'.repeat(128);
    setFetchForTests(serve(bytes, { urls: [], ranges: [] }));
    await expect(ensureOnnxRuntime()).rejects.toMatchObject({ code: 'MODEL_CHECKSUM' });
    expect(existsSync(runtimeLibrary())).toBe(false);
  });

  it('unpacks again after a write that failed partway', async () => {
    const log = { urls: [] as string[], ranges: [] as (string | null)[] };
    setFetchForTests(serve(fakePackage(), log));
    // The last file fails half-written (at its name or beside it), after the others are whole.
    disk.failAt = /libfake_providers\.so(\.tmp)?$/;
    await expect(ensureOnnxRuntime()).rejects.toMatchObject({ code: 'MODEL_DOWNLOAD' });
    disk.failAt = undefined;
    const path = await ensureOnnxRuntime();
    expect(log.urls).toHaveLength(2);
    expect(readFileSync(join(dirname(path!), 'libfake_providers.so'), 'utf8')).toBe('the provider');
  });

  it('downloads nothing when ORT_DYLIB_PATH names a library', async () => {
    process.env.ORT_DYLIB_PATH = '/somewhere/libonnxruntime.so';
    const log = { urls: [] as string[], ranges: [] as (string | null)[] };
    setFetchForTests(serve(Buffer.alloc(1), log));
    expect(await ensureOnnxRuntime()).toBeUndefined();
    expect(log.urls).toHaveLength(0);
  });
});
