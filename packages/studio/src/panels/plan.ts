// plan/<kind>.json beside the entry: where a submitted answer is kept. The directory may be a symlink the project owner
// did not intend, so both ways in check that the real plan directory is inside the real project directory and that the
// file is a plain file, never a link; the kind in the name is one of the panel kinds, never text from a request.

import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isInside } from '../agent-fs.js';
import { StudioFailure } from '../util.js';
import { PANEL_KINDS } from './validate.js';

function checkedKind(kind: string): void {
  if (!(PANEL_KINDS as readonly string[]).includes(kind)) throw new StudioFailure('INVALID_ARG', `no panel kind "${kind}"`);
}

/** The real plan directory, or null when it does not exist; throws when it leaves the project. */
function planDir(projectDir: string, create: boolean): string | null {
  const dir = join(projectDir, 'plan');
  if (create) mkdirSync(dir, { recursive: true });
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return null;
  }
  if (!isInside(realpathSync(projectDir), real)) throw new StudioFailure('FORBIDDEN', 'plan/ leads outside the project');
  return real;
}

/** Writes `answer` as pretty JSON: to a new file in the plan directory, then renamed over plan/<kind>.json. */
export function writePlan(projectDir: string, kind: string, answer: unknown): void {
  checkedKind(kind);
  const dir = planDir(projectDir, true)!;
  const target = join(dir, `${kind}.json`);
  let existing;
  try {
    existing = lstatSync(target);
  } catch {
    existing = null;
  }
  if (existing && !existing.isFile()) throw new StudioFailure('FORBIDDEN', `plan/${kind}.json is not a plain file`);
  const temp = join(dir, `.${kind}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(answer, null, 2)}\n`, { flag: 'wx' });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** plan/<kind>.json parsed, or null when there is none or it does not read; throws when it is a link or leaves the project. */
export function readPlan(projectDir: string, kind: string): unknown {
  checkedKind(kind);
  const dir = planDir(projectDir, false);
  if (dir === null) return null;
  const target = join(dir, `${kind}.json`);
  try {
    if (!lstatSync(target).isFile()) throw new StudioFailure('FORBIDDEN', `plan/${kind}.json is not a plain file`);
  } catch (error) {
    if (error instanceof StudioFailure) throw error;
    return null;
  }
  try {
    return JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}
