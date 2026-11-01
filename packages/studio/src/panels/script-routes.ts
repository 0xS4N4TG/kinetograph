// The Script panel's track (docs/proposals/studio-panels.md, "Script"): a music-led script names its track by a path
// relative to the project, and the panel plays it.
//
//   GET /api/panels/script/audio?path=<file relative to the project>   ->  the audio file (Range requests are answered)
//
// Needs the window's token. A file is served only when it is an audio file by its extension, is a plain file, and no
// part of its path is a link: its real path is exactly the project's real directory plus the path asked for.
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { extname, join, posix, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { PanelRoute } from './routes.js';

const TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

function fail(res: ServerResponse, status: number, code: string, message: string): true {
  const text = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
  return true;
}

/** `path` as segments below the project when it is a plain relative path with an audio extension, else null. */
export function audioSegments(path: string): string[] | null {
  if (path === '' || path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  if (!TYPES[extname(path).toLowerCase()]) return null;
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return posix.normalize(path) === path ? segments : null;
}

/** The byte range a `Range` header asks for in a file of `size` bytes: null for no header, 'bad' when it cannot be met. */
export function rangeOf(header: string | undefined, size: number): { start: number; end: number } | 'bad' | null {
  if (!header) return null;
  const found = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!found || (found[1] === '' && found[2] === '')) return 'bad';
  let start: number;
  let end: number;
  if (found[1] === '') {
    // The last N bytes.
    start = Math.max(0, size - Number(found[2]));
    end = size - 1;
  } else {
    start = Number(found[1]);
    end = found[2] === '' ? size - 1 : Math.min(size - 1, Number(found[2]));
  }
  return start > end || start >= size ? 'bad' : { start, end };
}

export const scriptRoute: PanelRoute = async (req, res, url, ctx) => {
  if (url.pathname !== '/api/panels/script/audio') return false;
  if (req.method !== 'GET') return false;
  if (!ctx.fromWindow) return fail(res, 403, 'FORBIDDEN', 'the track is played from the studio window, with its token');
  const requested = url.searchParams.get('path') ?? '';
  const segments = audioSegments(requested);
  if (segments === null) return fail(res, 400, 'INVALID_ARG', 'path must be an audio file (mp3, wav, ogg, m4a, aac, flac or opus) relative to the project');

  const root = await realpath(ctx.projectDir);
  const expected = join(root, ...segments);
  let real: string;
  try {
    real = await realpath(expected);
  } catch {
    return fail(res, 404, 'NOT_FOUND', `no file ${requested}`);
  }
  // A link anywhere on the way (or a project directory that is one) would make the real path differ from the asked one.
  if (real !== expected || !real.startsWith(root + sep)) return fail(res, 403, 'FORBIDDEN', `${requested} is not a plain file inside the project`);
  const info = await lstat(real).catch(() => null);
  if (!info?.isFile()) return fail(res, 403, 'FORBIDDEN', `${requested} is not a plain file inside the project`);

  const headers: Record<string, string | number> = {
    'Content-Type': TYPES[extname(real).toLowerCase()]!,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const range = rangeOf(req.headers.range, info.size);
  if (range === 'bad') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` });
    res.end();
    return true;
  }
  const [start, end] = range ? [range.start, range.end] : [0, info.size - 1];
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'Content-Length': info.size === 0 ? 0 : end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
  });
  if (info.size === 0) {
    res.end();
    return true;
  }
  await new Promise<void>((done) => {
    const stream = createReadStream(real, { start, end });
    stream.on('error', () => {
      res.destroy();
      done();
    });
    res.on('close', () => {
      stream.destroy();
      done();
    });
    stream.pipe(res);
  });
  return true;
};
