// The driver's local server (docs/COMPAT.md §6.2): the page, the bundle, the registered fonts, the project's files, the
// picture of a video or GIF at a moment (decoded by the addon, so Chrome shows what the engine would), and the two
// calls the page makes synchronously because Remotion's helpers are synchronous: text layout and a media file's header.
// It listens on 127.0.0.1 only, serves files from the project and nothing else, and ends with the renderer.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { CliError } from '../errors.js';
import type { Native } from '../native.js';
import { gifSourceTime, clipSourceTime } from './clip-time.js';
import { encodePng } from './png.js';

/** What the page reads from `window.__kinetographSettings` before the bundle runs (see the prelude). */
export interface PageSettings {
  cwd: string;
  publicDir: string;
}

export interface FrameServerOptions {
  /** The bundle's code, served at `/bundle.js`. */
  bundle: string;
  settings: PageSettings;
  /** Relative paths in the project resolve against this (the entry's directory). */
  baseDir: string;
  /** Directories the server may read files from; anything else is refused. */
  roots: string[];
  native: Pick<Native, 'probeMedia' | 'videoFrame' | 'layoutText'>;
  /** The Node side's registered fonts, added to every text layout the page asks for. */
  fonts: () => Record<string, string>;
}

export interface FrameServer {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** The URL the page loads a registered font file from. */
  fontUrl(file: string): string;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.txt': 'text/plain',
};

/** The page: an empty stage, the font sheet, and the bundle. `</script>` cannot occur in the JSON of the settings. */
export function pageHtml(settings: PageSettings): string {
  const json = JSON.stringify(settings).replace(/</g, '\\u003c');
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }</style>',
    '<style id="kg-fonts"></style>',
    `<script>window.__kinetographSettings = ${json};</script>`,
    '</head><body><div id="kg-stage"></div><script type="module" src="/bundle.js"></script></body></html>',
  ].join('\n');
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, type: string, body: Buffer | string): void {
  const data = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { 'content-type': type, 'content-length': data.length, 'cache-control': 'no-store' });
  res.end(data);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json', JSON.stringify(value));
}

function readBody(req: IncomingMessage, limit = 4 << 20): Promise<string> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'TOO_LARGE', 'the request is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

function numberParam(query: URLSearchParams, name: string, fallback?: number): number {
  const raw = query.get(name);
  if (raw === null) {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, 'INVALID_ARG', `missing ${name}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new HttpError(400, 'INVALID_ARG', `${name} must be a number, got ${raw}`);
  return value;
}

/** Starts the server. */
export async function startFrameServer(options: FrameServerOptions): Promise<FrameServer> {
  const roots = options.roots.map((root) => resolve(root));
  const fonts = new Map<string, number>();
  const fontFiles: string[] = [];

  const inRoots = (file: string): boolean => roots.some((root) => file === root || file.startsWith(root + sep));

  /** The file a project path names: absolute, or relative to the project, else to its public folder. */
  const projectFile = (path: string): string => {
    const candidates = isAbsolute(path)
      ? [resolve(path)]
      : [resolve(options.baseDir, path), resolve(options.settings.publicDir, path.replace(/^[/\\]+/, ''))];
    const found = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
    if (!inRoots(found)) {
      throw new HttpError(403, 'FORBIDDEN', `${path} is outside the project, which is all the Chrome fallback serves`);
    }
    return found;
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const { pathname, searchParams: query } = url;
    if (req.method === 'POST' && pathname === '/@layout') {
      const request = JSON.parse(await readBody(req)) as Parameters<Native['layoutText']>[0];
      // The page's own registry is empty of downloaded fonts: the Node side's is the one that has them all.
      sendJson(res, 200, options.native.layoutText({ ...request, fonts: { ...request.fonts, ...options.fonts() }, baseDir: request.baseDir ?? options.baseDir }));
      return;
    }
    if (req.method !== 'GET') throw new HttpError(405, 'METHOD', `${req.method} ${pathname} is not served`);

    switch (pathname) {
      case '/':
        send(res, 200, 'text/html; charset=utf-8', pageHtml(options.settings));
        return;
      case '/bundle.js':
        send(res, 200, 'text/javascript; charset=utf-8', options.bundle);
        return;
      case '/@probe':
        sendJson(res, 200, options.native.probeMedia(projectFile(query.get('src') ?? '')));
        return;
      case '/@video': {
        const file = projectFile(query.get('src') ?? '');
        const info = options.native.probeMedia(file);
        const trimAfter = query.get('trimAfter');
        const time = clipSourceTime(
          {
            n: numberParam(query, 'n'),
            fps: numberParam(query, 'fps'),
            trimBefore: numberParam(query, 'trimBefore', 0),
            trimAfter: trimAfter === null ? null : Number(trimAfter),
            loop: query.get('loop') === '1',
          },
          info.durationInSeconds,
        );
        const picture = options.native.videoFrame(file, time);
        send(res, 200, 'image/png', encodePng(picture.width, picture.height, picture.data));
        return;
      }
      case '/@gif': {
        const file = projectFile(query.get('src') ?? '');
        const info = options.native.probeMedia(file);
        const time = gifSourceTime(numberParam(query, 'time'), info.durationInSeconds, query.get('loop') === '1');
        const picture = options.native.videoFrame(file, time);
        send(res, 200, 'image/png', encodePng(picture.width, picture.height, picture.data));
        return;
      }
      case '/@file':
        await sendFile(res, projectFile(query.get('path') ?? ''));
        return;
    }
    if (pathname.startsWith('/@font/')) {
      const file = fontFiles[Number(pathname.slice('/@font/'.length))];
      if (file === undefined) throw new HttpError(404, 'NOT_FOUND', 'no such font');
      await sendFile(res, file);
      return;
    }
    // A DOM `<img src={staticFile('a.png')}>` asks for the file's absolute path.
    await sendFile(res, projectFile(decodeURIComponent(pathname)));
  };

  const sendFile = async (res: ServerResponse, file: string): Promise<void> => {
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, 'NOT_FOUND', `no such file: ${file}`);
    }
    send(res, 200, TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', data);
  };

  const server: Server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : ((error as { code?: unknown })?.code as string | undefined) ?? 'INTERNAL';
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendJson(res, status, { error: { code, message } });
      else res.destroy();
    });
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => done());
  }).catch((error: unknown) => {
    throw new CliError('CHROME_FAILED', `cannot start the driver's server: ${error instanceof Error ? error.message : String(error)}`);
  });
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    fontUrl(file) {
      let id = fonts.get(file);
      if (id === undefined) {
        id = fontFiles.length;
        fontFiles.push(file);
        fonts.set(file, id);
      }
      return `/@font/${id}`;
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
