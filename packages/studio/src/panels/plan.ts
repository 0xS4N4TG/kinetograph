// plan/<name>.json beside the entry: where a submitted answer is kept. The directory may be a symlink the project owner
// did not intend, so both ways in check that the real plan directory is inside the real project directory and that the
// file is a plain file, never a link; the name is a panel kind or custom-<slug>, never text from a request.

import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isInside } from '../agent-fs.js';
import { StudioFailure } from '../util.js';
import { isApproved } from './stages.js';
import type { PanelStore } from './store.js';
import type { OpenPanel, PanelDraft, PanelKind } from './types.js';
import { CUSTOM_NAME } from './custom.js';
import { PANEL_KINDS, checkAnswer } from './validate.js';

/** The name of a plan file (without ".json"): a panel kind that keeps a file, or custom-<slug>. Never text from a request as it is. */
export const isPlanFile = (name: string): boolean =>
  ((PANEL_KINDS as readonly string[]).includes(name) && name !== 'custom') || (name.startsWith('custom-') && CUSTOM_NAME.test(name.slice(7)));

function checkedKind(kind: string): void {
  if (!isPlanFile(kind)) throw new StudioFailure('INVALID_ARG', `no plan file "${kind}"`);
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

/** What a restored panel carries as its data: only what its answer already says, as the window shows no more than that. */
const restoredData = (kind: PanelKind, answer: Record<string, unknown>): PanelDraft[PanelKind] => {
  switch (kind) {
    case 'script':
      return { lines: answer.lines } as PanelDraft['script'];
    case 'storyboard':
      return { comp: '', shots: answer.shots } as PanelDraft['storyboard'];
    case 'styleframes':
      return { frames: [] };
    case 'review':
      return { comp: '' };
    default:
      return {};
  }
};

/**
 * Rebuilds the stepper after a restart: each plan/<kind>.json that holds an approving answer comes back as a submitted
 * panel, so its stage is approved and can be looked at. A file that does not read, does not check or does not approve is
 * left out, and so is one the safe reader refuses (a link, or a plan directory that leaves the project).
 */
export function restorePanels(store: PanelStore, projectDir: string): void {
  for (const kind of PANEL_KINDS) {
    // A custom panel's answer is values by block id and says nothing of its blocks, so it cannot be shown again.
    if (kind === 'custom') continue;
    let answer: unknown;
    try {
      answer = readPlan(projectDir, kind);
    } catch {
      continue;
    }
    if (answer === null || checkAnswer(kind, answer) !== null) continue;
    const probe = { panel: kind, status: 'submitted', answer } as OpenPanel;
    if (!isApproved(probe)) continue;
    store.restore(kind, restoredData(kind, answer as Record<string, unknown>) as never, answer as never);
  }
}
