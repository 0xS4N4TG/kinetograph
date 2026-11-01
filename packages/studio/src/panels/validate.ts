// Light structural checks on what an agent opens a panel with and what a person submits (docs/proposals/studio-panels.md:
// "The server validates each answer against the panel's schema"). They catch a missing field or a wrong type, not
// whether a value makes sense. Each returns the problem in plain words, or null.

import { checkCustomAnswer, checkCustomDraft } from './custom.js';
import { PLACEMENTS } from './placement.js';
import type { CustomDraft, PanelKind, Placement } from './types.js';

export const PANEL_KINDS: readonly PanelKind[] = ['brief', 'script', 'storyboard', 'styleframes', 'review', 'custom'];

type Check = (value: Record<string, unknown>) => string | null;
/** An answer is checked against the panel's draft when the kind needs it (a custom panel's blocks). */
type AnswerCheck = (value: Record<string, unknown>, draft: unknown) => string | null;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The first problem among `rules`: [field, ok(value)], with `what` naming the expected type. */
function fields(value: Record<string, unknown>, rules: [string, (v: unknown) => boolean, string][]): string | null {
  for (const [name, ok, what] of rules) if (!ok(value[name])) return `${name} must be ${what}`;
  return null;
}

/** Every item of the array at `name` is an object that passes `rules`. */
function items(value: Record<string, unknown>, name: string, rules: [string, (v: unknown) => boolean, string][]): string | null {
  const list = value[name];
  if (!Array.isArray(list)) return `${name} must be a list`;
  for (const [i, item] of list.entries()) {
    if (!isObject(item)) return `${name}[${i}] must be an object`;
    const bad = fields(item, rules);
    if (bad) return `${name}[${i}].${bad}`;
  }
  return null;
}

const first = (...problems: (string | null)[]): string | null => problems.find((p) => p !== null) ?? null;
const bool = (v: unknown): boolean => typeof v === 'boolean';
const PLATFORMS = ['reel-9x16', 'youtube-16x9', 'square-1x1', 'ad-slot', 'custom'];

const answers: Record<PanelKind, AnswerCheck> = {
  brief: (a) =>
    first(
      fields(a, [
        ['purpose', isString, 'text'],
        ['audience', isString, 'text'],
        ['platform', (v) => PLATFORMS.includes(v as string), `one of ${PLATFORMS.join(', ')}`],
        ['seconds', isNumber, 'a number'],
        ['takeaway', isString, 'text'],
      ]),
      isObject(a.size) ? fields(a.size, [['width', isNumber, 'a number'], ['height', isNumber, 'a number'], ['fps', isNumber, 'a number']]) : 'size must be { width, height, fps }',
      items(a, 'references', [['kind', (v) => v === 'link' || v === 'file', '"link" or "file"'], ['src', isString, 'text'], ['like', isString, 'text']]),
    ),
  script: (a) => first(items(a, 'lines', [['id', isString, 'text'], ['text', isString, 'text']]), items(a, 'notes', [['line', isString, 'text'], ['text', isString, 'text']]), fields(a, [['approved', bool, 'true or false']])),
  storyboard: (a) =>
    first(
      items(a, 'shots', [['id', isString, 'text'], ['seconds', isNumber, 'a number']]),
      Array.isArray(a.removed) && a.removed.every(isString) ? null : 'removed must be a list of shot ids',
      items(a, 'notes', [['shot', isString, 'text'], ['text', isString, 'text']]),
      fields(a, [['approved', bool, 'true or false']]),
    ),
  styleframes: (a) =>
    first(
      fields(a, [['pick', (v) => v === null || isString(v), 'a frame id or null']]),
      items(a, 'notes', [['frame', isString, 'text'], ['text', isString, 'text']]),
      fields(a, [['approved', bool, 'true or false']]),
    ),
  review: (a) =>
    first(items(a, 'notes', [['frame', isNumber, 'a number'], ['text', isString, 'text']]), fields(a, [['verdict', (v) => v === 'approved' || v === 'changes', '"approved" or "changes"']])),
  custom: (a, draft) => checkCustomAnswer(draft as CustomDraft, a),
};

const drafts: Record<PanelKind, Check> = {
  brief: () => null,
  script: (d) => items(d, 'lines', [['id', isString, 'text'], ['text', isString, 'text']]),
  storyboard: (d) => first(fields(d, [['comp', isString, 'the board composition id']]), items(d, 'shots', [['id', isString, 'text'], ['frame', isNumber, 'a number'], ['seconds', isNumber, 'a number']])),
  styleframes: (d) => items(d, 'frames', [['id', isString, 'text'], ['comp', isString, 'text'], ['frame', isNumber, 'a number']]),
  review: (d) => first(fields(d, [['comp', isString, 'the composition id']]), d.range === undefined || (Array.isArray(d.range) && d.range.length === 2 && d.range.every(isNumber)) ? null : 'range must be [first, last] frames'),
  custom: checkCustomDraft,
};

/** The problem with the data a panel is opened with, or null. */
export function checkDraft(kind: PanelKind, data: unknown): string | null {
  return isObject(data) ? drafts[kind](data) : 'data must be an object';
}

/** The problem with the answer submitted for a panel, or null. */
export function checkAnswer(kind: PanelKind, answer: unknown, draft?: unknown): string | null {
  return isObject(answer) ? answers[kind](answer, draft) : 'the answer must be an object';
}

/** The problem with a placement, or null when it is one of the four or left out. */
export function checkPlacement(placement: unknown): string | null {
  return placement === undefined || PLACEMENTS.includes(placement as Placement) ? null : `placement must be one of ${PLACEMENTS.join(', ')}`;
}
