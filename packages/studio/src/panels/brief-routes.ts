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
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, extname, join, posix, resolve, sep } from 'node:path';
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
  return safeName(raw, (ext) => VIDEO.has(ext) || IMAGE.has(ext));
}

/** `safeRefName` for any set of extensions (lower case, with the dot): the same cleaning, a different list of types. */
export function safeName(raw: string, allowed: (ext: string) => boolean): string | null {
  const last = raw.split(/[\\/]/).pop() ?? '';
  const ext = extname(last).toLowerCase();
  if (!allowed(ext)) return null;
  const stem = last
    .slice(0, last.length - ext.length)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 100);
  return stem === '' ? null : `${stem}${ext}`;
}

export function reply(res: ServerResponse, status: number, body: unknown): true {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
  return true;
}

export const fail = (res: ServerResponse, status: number, code: string, message: string): true => reply(res, status, { error: { code, message } });

/** What a file really is, from its first bytes; the extension is only the name the person gave it. */
export type Sniffed = { kind: 'video'; demuxer: 'mov' | 'matroska' | 'avi'; allow: string } | { kind: 'image' };

/**
 * Accepts only real containers: MP4/MOV ("ftyp"), Matroska/WebM, AVI, PNG, JPEG, GIF and WebP. A text playlist
 * (#EXTM3U, ffconcat) or anything else is null, so ffmpeg never has a file that names other files to read.
 */
export function sniff(head: Buffer): Sniffed | null {
  const at = (offset: number, text: string): boolean => head.subarray(offset, offset + text.length).toString('latin1') === text;
  if (head.length >= 12 && at(4, 'ftyp')) return { kind: 'video', demuxer: 'mov', allow: 'mov,mp4,m4a,3gp,3g2,mj2' };
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { kind: 'video', demuxer: 'matroska', allow: 'matroska,webm' };
  if (head.length >= 12 && at(0, 'RIFF') && at(8, 'AVI ')) return { kind: 'video', demuxer: 'avi', allow: 'avi' };
  if (head.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return { kind: 'image' };
  if (head.length >= 8 && head[0] === 0x89 && at(1, 'PNG')) return { kind: 'image' };
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image' };
  if (head.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return { kind: 'image' };
  return null;
}

/** True when `path` is a regular file and not a symbolic link. */
export async function isPlainFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** True when something (a file, a link, even a dangling one) is at `path`. */
export async function taken(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** True when `path` really lies inside `root` once links are resolved. */
export async function inside(root: string, path: string): Promise<boolean> {
  try {
    return (await realpath(path)).startsWith(root + sep);
  } catch {
    return false;
  }
}

export async function head(file: string): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, 16, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

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

/**
 * The input options that keep ffmpeg to the one file: the demuxer is the one the bytes were sniffed as (not guessed
 * from content), only the `file` protocol is open and only that demuxer's formats are allowed, and the path is absolute.
 */
function inputOf(file: string, video: Extract<Sniffed, { kind: 'video' }>): string[] {
  return ['-protocol_whitelist', 'file', '-format_whitelist', video.allow, '-f', video.demuxer, '-i', resolve(file)];
}

/** Seconds of `file` as ffmpeg reports them, or null when it cannot be read. */
async function durationOf(program: string, file: string, video: Extract<Sniffed, { kind: 'video' }>): Promise<number | null> {
  const { stderr } = await run(program, ['-hide_banner', ...inputOf(file, video)]);
  const found = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!found) return null;
  const seconds = Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3]);
  return seconds > 0 ? seconds : null;
}

/** Writes `sheet`: 8 frames spread evenly over the video, 4 by 2. Resolves false when there is no ffmpeg or it fails. */
export async function makeContactSheet(video: string, sheet: string, kind: Extract<Sniffed, { kind: 'video' }>): Promise<boolean> {
  const program = findFfmpeg();
  // Nothing may sit at the sheet's path (a link there would make ffmpeg write through it).
  await rm(sheet, { force: true });
  const seconds = await durationOf(program, video, kind);
  if (seconds === null) return false;
  const filter = `fps=${FRAMES}/${seconds.toFixed(6)},scale=360:-2,tile=4x2:padding=4:color=black`;
  const { ok } = await run(program, ['-hide_banner', '-loglevel', 'error', '-n', ...inputOf(video, kind), '-vf', filter, '-frames:v', '1', sheet]);
  return ok && (await isPlainFile(sheet));
}

/** A name that is not taken in `dir`: `a.mp4`, then `a-2.mp4`, `a-3.mp4`. */
export async function freeName(dir: string, name: string, siblings: string[] = ['.sheet.png', '.part']): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  const busy = async (c: string): Promise<boolean> => {
    if (await taken(join(dir, c))) return true;
    for (const suffix of siblings) if (await taken(join(dir, `${c}${suffix}`))) return true;
    return false;
  };
  for (let n = 2; await busy(candidate); n++) candidate = `${stem}-${n}${ext}`;
  return candidate;
}

/** Streams the request body into a new file at `to` (flag wx), failing with a RangeError past `max` bytes. */
export async function receive(req: IncomingMessage, to: string, max = MAX_REF_BYTES): Promise<void> {
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(size > max ? new RangeError('too large') : null, chunk);
    },
  });
  await pipeline(req, limit, createWriteStream(to, { flags: 'wx' }));
}

export const briefRoute: PanelRoute = async (req, res, url, ctx) => {
  if (url.pathname !== '/api/panels/brief/ref') return false;
  const method = req.method ?? 'GET';
  if (method !== 'PUT' && method !== 'GET') return false;
  if (!ctx.fromWindow) return fail(res, 403, 'FORBIDDEN', 'references are added from the studio window, with its token');
  const wanted = join(ctx.projectDir, ...REFS.split('/'));

  if (method === 'GET') {
    const requested = url.searchParams.get('path') ?? '';
    if (!PATH_RE.test(requested) || posix.normalize(requested) !== requested || requested.includes('..')) {
      return fail(res, 400, 'INVALID_ARG', `path must be a file directly in ${REFS}/`);
    }
    const type = TYPES[extname(requested).toLowerCase()];
    const file = join(wanted, basename(requested));
    if (!type || !(await taken(file))) return fail(res, 404, 'NOT_FOUND', `no reference ${requested}`);
    // A link, or a file that resolves outside the project's plan/refs, is never served.
    const root = await realpath(ctx.projectDir);
    const refs = await realpath(wanted).catch(() => null);
    if (refs === null || !refs.startsWith(root + sep) || !(await isPlainFile(file)) || !(await inside(refs, file))) {
      return fail(res, 403, 'FORBIDDEN', `${requested} is not a plain file inside ${REFS}/`);
    }
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
    res.end(bytes);
    return true;
  }

  const name = safeRefName(url.searchParams.get('name') ?? '');
  if (name === null) return fail(res, 400, 'INVALID_ARG', 'name must be a video or image file name (mp4, mov, webm, png, jpg, ...)');
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > MAX_REF_BYTES) return fail(res, 413, 'INVALID_ARG', `the file is over ${MAX_REF_BYTES / 1024 / 1024} MB`);

  // plan/ or plan/refs/ may be a link: what is written is only ever inside the project's real directory.
  await mkdir(wanted, { recursive: true });
  const root = await realpath(ctx.projectDir);
  const dir = await realpath(wanted);
  if (!dir.startsWith(root + sep)) return fail(res, 403, 'FORBIDDEN', `${REFS} resolves outside the project`);

  const stored = await freeName(dir, name);
  const file = join(dir, stored);
  const partial = `${file}.part`;
  try {
    await receive(req, partial);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EEXIST: something else is at that path (maybe a link); it is not ours to remove.
    if (code === 'EEXIST') return fail(res, 409, 'IO', 'a file with that name is being written; try again');
    await rm(partial, { force: true });
    if (error instanceof RangeError) return fail(res, 413, 'INVALID_ARG', `the file is over ${MAX_REF_BYTES / 1024 / 1024} MB`);
    return fail(res, 500, 'IO', `could not store the file: ${(error as Error).message}`);
  }
  if (!(await isPlainFile(partial))) {
    await rm(partial, { force: true });
    return fail(res, 500, 'IO', 'could not store the file');
  }
  const sniffed = sniff(await head(partial));
  const asked = VIDEO.has(extname(stored).toLowerCase()) ? 'video' : 'image';
  if (sniffed === null || sniffed.kind !== asked) {
    await rm(partial, { force: true });
    return fail(res, 400, 'INVALID_ARG', `the file is not a real ${asked} (MP4, MOV, WebM, MKV, AVI, PNG, JPEG, GIF or WebP)`);
  }
  if (await taken(file)) {
    await rm(partial, { force: true });
    return fail(res, 409, 'IO', 'a file with that name appeared meanwhile; try again');
  }
  await rename(partial, file);

  const result: { src: string; sheet?: string } = { src: `${REFS}/${stored}` };
  if (sniffed.kind === 'video' && (await isPlainFile(file)) && (await inside(dir, file))) {
    const sheet = `${file}.sheet.png`;
    if (await makeContactSheet(file, sheet, sniffed)) result.sheet = `${REFS}/${stored}.sheet.png`;
  }
  return reply(res, 201, result);
};
