// The files an agent may read and write through ACP: the project directory and nothing outside it. A path that leaves
// it, by `..` or by a symlink, is refused.

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StudioFailure } from './util.js';

/** The real path of `path`, or of its nearest existing parent with the rest appended (for a file about to be created). */
function realish(path: string): string {
  const rest: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return join(realpathSync(current), ...rest);
}

/** Whether `child` is `root` or inside it. */
export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** `path` (absolute, or relative to `root`) as an absolute real path inside `root`; throws `FORBIDDEN` when it is not. */
export function resolveInside(root: string, path: string): string {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) throw new StudioFailure('FORBIDDEN', 'the path is empty or invalid');
  const realRoot = realpathSync(root);
  const target = realish(resolve(realRoot, path));
  if (!isInside(realRoot, target)) throw new StudioFailure('FORBIDDEN', `the agent asked for a file outside the project: ${path}`);
  return target;
}

/** The text of the file, or of `limit` lines of it from the 1-based `line`. */
export async function readTextFile(root: string, path: string, line?: number | null, limit?: number | null): Promise<string> {
  const text = await readFile(resolveInside(root, path), 'utf8');
  if (line == null && limit == null) return text;
  const lines = text.split('\n');
  const start = Math.max(1, line ?? 1) - 1;
  return lines.slice(start, limit == null ? undefined : start + Math.max(0, limit)).join('\n');
}

export async function writeTextFile(root: string, path: string, content: string): Promise<void> {
  const target = resolveInside(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}
