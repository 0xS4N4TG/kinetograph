import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The UI's built files; `ui/dist` of this package (one level above both `src/` and `dist/`). */
export const UI_DIR = fileURLToPath(new URL('../ui/dist', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const MISSING =
  'The studio UI is not built.\n\n' +
  'The server is running and its API works (/api/project, /api/compositions, ...), but there is nothing to show here:\n' +
  'ui/dist of @kinetographdev/studio is missing. Build it with "npm run build -w @kinetographdev/studio-ui" from the repository.\n';

/**
 * Serves a file of the UI for `pathname`, or `index.html` for a path that is no file (the UI routes itself), or a plain
 * message when the UI is not built. `dir` is replaceable for tests.
 */
export async function serveStatic(pathname: string, res: ServerResponse, head: boolean, dir = UI_DIR): Promise<void> {
  const index = join(dir, 'index.html');
  if (!existsSync(index)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(head ? undefined : MISSING);
    return;
  }

  let file = index;
  try {
    const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
    const candidate = join(dir, relative);
    // Nothing outside the UI directory is ever served.
    if (candidate.startsWith(dir + sep) && statSync(candidate).isFile()) file = candidate;
  } catch {
    // Not a file (or a bad escape): the index.
  }

  const body = await readFile(file);
  const html = file === index;
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // Vite puts a hash in the name of what it puts in /assets/; the page itself must be fetched again.
    'Cache-Control': !html && pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(head ? undefined : body);
}
