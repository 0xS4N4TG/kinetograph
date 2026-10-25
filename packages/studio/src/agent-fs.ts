// The files an agent may read and write through ACP: the project directory and nothing outside it. A path that leaves
// it, by `..` or by a symlink, is refused.

import { constants, lstatSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StudioFailure } from './util.js';

const outside = (path: string) => new StudioFailure('FORBIDDEN', `the agent asked for a file outside the project: ${path}`);

/**
 * `path` with every symlink on the way resolved, walking down from the real `root`. A link that leaves `root` is
 * refused, and so is a dangling one (it could be filled in later to point anywhere). Parts that do not exist yet are
 * appended as they are.
 */
function realish(root: string, path: string, asked: string): string {
  let current = root;
  const rel = relative(root, path);
  const parts = rel === '' ? [] : rel.split(sep);
  for (let i = 0; i < parts.length; i++) {
    const next = join(current, parts[i]!);
    let info;
    try {
      info = lstatSync(next);
    } catch {
      return join(current, ...parts.slice(i));
    }
    if (info.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(next);
      } catch {
        throw outside(asked);
      }
      if (!isInside(root, real)) throw outside(asked);
      current = real;
    } else current = next;
  }
  return current;
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
  const lexical = resolve(realRoot, path);
  if (!isInside(realRoot, lexical)) throw outside(path);
  const target = realish(realRoot, lexical, path);
  if (!isInside(realRoot, target)) throw outside(path);
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
  // The directory was checked; the file itself must not be a link (also refused by O_NOFOLLOW, in case it changes meanwhile).
  try {
    if (lstatSync(target).isSymbolicLink()) throw outside(path);
  } catch (error) {
    if (error instanceof StudioFailure) throw error;
  }
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}
