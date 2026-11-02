// Pictures the person drops or pastes into the agent's prompt box: each is stored in the project as public/refs/<safe-name>
// (so a composition can use it with staticFile('refs/<name>')) and the agent is told where. The writing reuses the Brief
// panel's upload helpers (panels/brief-routes.ts): a size cap, the type sniffed from the bytes, `wx` writes, the real
// directory checked to be inside the real project, and no symbolic links.
//
//   PUT /api/agent/image?name=<file name>   raw file body  ->  { file, src }
//   GET /api/agent/image?name=<stored name>                 ->  the file (for the chat's thumbnails)
//
// Both need the window's token. Nothing is written outside <projectDir>/public/refs/.
import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, extname, join, posix, sep } from 'node:path';
import { fail, freeName, head, inside, isPlainFile, receive, reply, safeName, sniff, taken } from './panels/brief-routes.js';
import type { PanelRoute } from './panels/routes.js';

/** The largest picture taken, bytes. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** The most pictures one message carries. */
export const MAX_IMAGES = 6;
/** Where they are kept, relative to the project. */
export const IMAGE_DIR = 'public/refs';

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};
const NAME = /^[A-Za-z0-9._-]+$/;

/** A file name that is safe to store, or null when nothing is left or it is not a picture type the studio takes. */
export const safeImageName = (raw: string): string | null => safeName(raw, (ext) => ext in TYPES);

/** True when the name is one `safeImageName` could have made (so it is a file directly in public/refs, not a path). */
export const isStoredName = (name: string): boolean => NAME.test(name) && !name.startsWith('.') && !name.includes('..') && extname(name).toLowerCase() in TYPES && posix.normalize(name) === name;

/** Whether the first bytes are a PNG, JPEG, GIF, WebP or AVIF picture. */
export function sniffImage(bytes: Buffer): boolean {
  // AVIF is an ISO file ("ftyp" box) whose brand is avif or avis; the Brief sniffer takes every other "ftyp" for video.
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('latin1');
    return brand === 'avif' || brand === 'avis';
  }
  return sniff(bytes)?.kind === 'image';
}

/** The names among `names` that are not pictures stored in the project's public/refs (a missing file, a link, a path). Sync: used where a message arrives. */
export function missingImages(projectDir: string, names: string[]): string[] {
  let dir: string;
  try {
    const root = realpathSync(projectDir);
    dir = realpathSync(join(projectDir, ...IMAGE_DIR.split('/')));
    if (!dir.startsWith(root + sep)) return names;
  } catch {
    return names;
  }
  return names.filter((name) => {
    if (!isStoredName(name)) return true;
    try {
      return !lstatSync(join(dir, name)).isFile();
    } catch {
      return true;
    }
  });
}

export const agentImageRoute: PanelRoute = async (req, res, url, ctx) => {
  if (url.pathname !== '/api/agent/image') return false;
  const method = req.method ?? 'GET';
  if (method !== 'PUT' && method !== 'GET') return false;
  if (!ctx.fromWindow) return fail(res, 403, 'FORBIDDEN', 'pictures are added from the studio window, with its token');
  const wanted = join(ctx.projectDir, ...IMAGE_DIR.split('/'));

  if (method === 'GET') {
    const requested = url.searchParams.get('name') ?? '';
    if (!isStoredName(requested)) return fail(res, 400, 'INVALID_ARG', `name must be a picture directly in ${IMAGE_DIR}/`);
    const file = join(wanted, basename(requested));
    if (!(await taken(file))) return fail(res, 404, 'NOT_FOUND', `no picture ${requested}`);
    const root = await realpath(ctx.projectDir);
    const dir = await realpath(wanted).catch(() => null);
    if (dir === null || !dir.startsWith(root + sep) || !(await isPlainFile(file)) || !(await inside(dir, file))) {
      return fail(res, 403, 'FORBIDDEN', `${requested} is not a plain file inside ${IMAGE_DIR}/`);
    }
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(requested).toLowerCase()]!, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
    res.end(bytes);
    return true;
  }

  const name = safeImageName(url.searchParams.get('name') ?? '');
  if (name === null) return fail(res, 400, 'INVALID_ARG', 'name must be a picture file name (png, jpg, webp, gif or avif)');
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > MAX_IMAGE_BYTES) return fail(res, 413, 'INVALID_ARG', `the picture is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);

  // public/ or public/refs/ may be a link: what is written is only ever inside the project's real directory.
  await mkdir(wanted, { recursive: true });
  const root = await realpath(ctx.projectDir);
  const dir = await realpath(wanted);
  if (!dir.startsWith(root + sep)) return fail(res, 403, 'FORBIDDEN', `${IMAGE_DIR} resolves outside the project`);

  const stored = await freeName(dir, name, ['.part']);
  const file = join(dir, stored);
  const partial = `${file}.part`;
  try {
    await receive(req, partial, MAX_IMAGE_BYTES);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EEXIST: something else is at that path (maybe a link); it is not ours to remove.
    if (code === 'EEXIST') return fail(res, 409, 'IO', 'a file with that name is being written; try again');
    await rm(partial, { force: true });
    if (error instanceof RangeError) return fail(res, 413, 'INVALID_ARG', `the picture is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    return fail(res, 500, 'IO', `could not store the picture: ${(error as Error).message}`);
  }
  if (!(await isPlainFile(partial))) {
    await rm(partial, { force: true });
    return fail(res, 500, 'IO', 'could not store the picture');
  }
  if (!sniffImage(await head(partial))) {
    await rm(partial, { force: true });
    return fail(res, 400, 'INVALID_ARG', 'the file is not a real picture (PNG, JPEG, GIF, WebP or AVIF)');
  }
  if (await taken(file)) {
    await rm(partial, { force: true });
    return fail(res, 409, 'IO', 'a file with that name appeared meanwhile; try again');
  }
  await rename(partial, file);
  return reply(res, 201, { file: stored, src: `${IMAGE_DIR}/${stored}` });
};
