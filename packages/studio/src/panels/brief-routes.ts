// The Brief panel's file drop (docs/proposals/studio-panels.md, "Brief"): a dropped reference is stored as
// plan/refs/<safe-name>, and a video also gets plan/refs/<name>.sheet.png, a contact sheet of 8 evenly spaced frames
// for an agent that reads pictures.
//
//   PUT /api/panels/brief/ref?name=<file name>   raw file body  ->  { src, sheet? }
//   GET /api/panels/brief/ref?path=plan/refs/<file>              ->  the file (for the panel's thumbnails)
//
// Both need the window's token. Nothing is written outside <projectDir>/plan/refs/.
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, extname, join, posix } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PanelRoute } from './routes.js';

/** The largest file the panel takes. */
export const MAX_REF_BYTES = 500 * 1024 * 1024;

const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const FRAMES = 8;
const REFS = 'plan/refs';
const PATH_RE = /^plan\/refs\/[A-Za-z0-9._-]+$/;

/**
 * A file name that is safe to store: the last segment only, letters, digits, dot, dash and underscore, no leading dot,
 * at most 100 characters before the extension. Null when nothing is left or the type is not a video or an image.
 */
export function safeRefName(raw: string): string | null {
  const last = raw.split(/[\\/]/).pop() ?? '';
  const ext = extname(last).toLowerCase();
  if (!VIDEO.has(ext) && !IMAGE.has(ext)) return null;
  const stem = last
    .slice(0, last.length - ext.length)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 100);
  return stem === '' ? null : `${stem}${ext}`;
}

function reply(res: ServerResponse, status: number, body: unknown): true {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
  return true;
}

const fail = (res: ServerResponse, status: number, code: string, message: string): true => reply(res, status, { error: { code, message } });

/** The ffmpeg program to run: `KINETOGRAPH_FFMPEG`, the platform package's `bin/ffmpeg`, then the `PATH`'s (the order the addon uses). */
export function findFfmpeg(): string {
  const env = process.env.KINETOGRAPH_FFMPEG;
  if (env) return env;
  const platform = ({ 'darwin-arm64': 'darwin-arm64', 'linux-x64': 'linux-x64-gnu', 'win32-x64': 'win32-x64-msvc' } as Record<string, string>)[`${process.platform}-${process.arch}`];
  if (platform) {
    try {
      const require = createRequire(import.meta.url);
      const nativeDir = dirname(require.resolve('@kinetographdev/native/package.json'));
      const pkg = createRequire(join(nativeDir, 'package.json')).resolve(`@kinetographdev/native-${platform}/package.json`);
      const binary = join(dirname(pkg), 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
      if (existsSync(binary)) return binary;
    } catch {
      // Not installed here: fall through to the PATH.
    }
  }
  return 'ffmpeg';
}

function run(program: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(program, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      resolve({ ok: error === null, stderr: String(stderr) });
    });
  });
}

/** Seconds of `file` as ffmpeg reports them, or null when it cannot be read. */
async function durationOf(program: string, file: string): Promise<number | null> {
  const { stderr } = await run(program, ['-hide_banner', '-i', file]);
  const found = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!found) return null;
  const seconds = Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3]);
  return seconds > 0 ? seconds : null;
}

/** Writes `sheet`: 8 frames spread evenly over the video, 4 by 2. Resolves false when there is no ffmpeg or it fails. */
export async function makeContactSheet(video: string, sheet: string): Promise<boolean> {
  const program = findFfmpeg();
  const seconds = await durationOf(program, video);
  if (seconds === null) return false;
  const filter = `fps=${FRAMES}/${seconds.toFixed(6)},scale=360:-2,tile=4x2:padding=4:color=black`;
  const { ok } = await run(program, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', filter, '-frames:v', '1', sheet]);
  return ok && existsSync(sheet);
}

/** A name that is not taken in `dir`: `a.mp4`, then `a-2.mp4`, `a-3.mp4`. */
function freeName(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; existsSync(join(dir, candidate)) || existsSync(join(dir, `${candidate}.sheet.png`)); n++) candidate = `${stem}-${n}${ext}`;
  return candidate;
}

async function receive(req: IncomingMessage, to: string): Promise<void> {
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(size > MAX_REF_BYTES ? new RangeError('too large') : null, chunk);
    },
  });
  await pipeline(req, limit, createWriteStream(to));
}

export const briefRoute: PanelRoute = async (req, res, url, ctx) => {
  if (url.pathname !== '/api/panels/brief/ref') return false;
  const method = req.method ?? 'GET';
  if (method !== 'PUT' && method !== 'GET') return false;
  if (!ctx.fromWindow) return fail(res, 403, 'FORBIDDEN', 'references are added from the studio window, with its token');
  const dir = join(ctx.projectDir, ...REFS.split('/'));

  if (method === 'GET') {
    const requested = url.searchParams.get('path') ?? '';
    if (!PATH_RE.test(requested) || posix.normalize(requested) !== requested || requested.includes('..')) {
      return fail(res, 400, 'INVALID_ARG', `path must be a file directly in ${REFS}/`);
    }
    const type = TYPES[extname(requested).toLowerCase()];
    const file = join(dir, basename(requested));
    if (!type || !existsSync(file)) return fail(res, 404, 'NOT_FOUND', `no reference ${requested}`);
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
    res.end(bytes);
    return true;
  }

  const name = safeRefName(url.searchParams.get('name') ?? '');
  if (name === null) return fail(res, 400, 'INVALID_ARG', 'name must be a video or image file name (mp4, mov, webm, png, jpg, ...)');
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > MAX_REF_BYTES) return fail(res, 413, 'INVALID_ARG', `the file is over ${MAX_REF_BYTES / 1024 / 1024} MB`);

  await mkdir(dir, { recursive: true });
  const stored = freeName(dir, name);
  const file = join(dir, stored);
  const partial = `${file}.part`;
  try {
    await receive(req, partial);
  } catch (error) {
    await rm(partial, { force: true });
    if (error instanceof RangeError) return fail(res, 413, 'INVALID_ARG', `the file is over ${MAX_REF_BYTES / 1024 / 1024} MB`);
    return fail(res, 500, 'IO', `could not store the file: ${(error as Error).message}`);
  }
  if ((await stat(partial)).size === 0) {
    await rm(partial, { force: true });
    return fail(res, 400, 'INVALID_ARG', 'the file is empty');
  }
  await rename(partial, file);

  const result: { src: string; sheet?: string } = { src: `${REFS}/${stored}` };
  if (VIDEO.has(extname(stored).toLowerCase())) {
    const sheet = `${file}.sheet.png`;
    if (await makeContactSheet(file, sheet)) result.sheet = `${REFS}/${stored}.sheet.png`;
  }
  return reply(res, 201, result);
};
