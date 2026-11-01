// The custom panel (docs/proposals/studio-panels.md, "A custom panel made of blocks"): the agent sends a list of blocks as
// data, the person fills them in, and the answer is a value per block id. No Node, no DOM: the server checks drafts and
// answers here and the UI uses the same `isFilled` to decide when a panel can be sent.

import type { Block, CustomDraft } from './types.js';

export const CUSTOM_NAME = /^[a-z0-9-]{1,40}$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

/** The limits on what an agent sends; a panel is a question for a person, not a document. */
export const LIMITS = { blocks: 40, options: 24, columns: 12, rows: 200, items: 200, notes: 100, title: 120, label: 200, help: 500, text: 4000, cell: 500, answerText: 10_000 };

/** Block types that take an answer; the rest only show something. */
export const INPUT_TYPES = ['choice', 'slider', 'input', 'list', 'table', 'notes', 'compare'] as const;
export const BLOCK_TYPES = ['heading', 'text', 'still', 'clip', ...INPUT_TYPES] as const;
export type InputBlock = Extract<Block, { type: (typeof INPUT_TYPES)[number] }>;

export const takesAnswer = (block: Block): block is InputBlock => (INPUT_TYPES as readonly string[]).includes(block.type);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isFrame = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000_000;
/** A string of `min` to `max` characters. */
const text = (v: unknown, max: number, min = 0): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const strings = (v: unknown, max: number, count: number): v is string[] => Array.isArray(v) && v.length <= count && v.every((s) => text(s, max));

type Problem = string | null;
const first = (...problems: Problem[]): Problem => problems.find((p) => p !== null) ?? null;

function frameRef(v: unknown, where: string): Problem {
  if (!isObject(v)) return `${where} must be { comp, frame }`;
  if (!text(v.comp, 200, 1)) return `${where}.comp must be a composition id`;
  if (!isFrame(v.frame)) return `${where}.frame must be a whole frame number`;
  return null;
}

function optional(b: Record<string, unknown>, key: string, max: number, where: string): Problem {
  return b[key] === undefined || text(b[key], max) ? null : `${where}.${key} must be text of at most ${max} characters`;
}

function choice(b: Record<string, unknown>, where: string): Problem {
  const options = b.options;
  if (!Array.isArray(options) || options.length < 1 || options.length > LIMITS.options) return `${where}.options must be a list of 1 to ${LIMITS.options} options`;
  const ids = new Set<string>();
  for (const [i, o] of options.entries()) {
    const at = `${where}.options[${i}]`;
    if (!isObject(o)) return `${at} must be an object`;
    if (typeof o.id !== 'string' || !ID.test(o.id)) return `${at}.id must be a letter then letters, digits, _ or -`;
    if (ids.has(o.id)) return `${at}.id "${o.id}" is used twice`;
    ids.add(o.id);
    const bad = first(optional(o, 'label', LIMITS.label, at), optional(o, 'text', LIMITS.cell, at), o.still === undefined ? null : frameRef(o.still, `${at}.still`));
    if (bad) return bad;
    if (o.label === undefined && o.text === undefined && o.still === undefined) return `${at} needs a label, a text or a still`;
  }
  if (b.multiple !== undefined && typeof b.multiple !== 'boolean') return `${where}.multiple must be true or false`;
  if (b.value === undefined) return null;
  const set = (v: unknown) => typeof v === 'string' && ids.has(v);
  if (b.multiple === true) return Array.isArray(b.value) && b.value.every(set) ? null : `${where}.value must be a list of option ids`;
  return set(b.value) ? null : `${where}.value must be one option id`;
}

function slider(b: Record<string, unknown>, where: string): Problem {
  if (!isNumber(b.min) || !isNumber(b.max) || b.min >= b.max) return `${where} needs min and max numbers with min below max`;
  if (b.step !== undefined && !(isNumber(b.step) && b.step > 0)) return `${where}.step must be a number above 0`;
  if (b.value !== undefined && !(isNumber(b.value) && b.value >= b.min && b.value <= b.max)) return `${where}.value must be between min and max`;
  return optional(b, 'unit', 20, where);
}

function table(b: Record<string, unknown>, where: string): Problem {
  const columns = b.columns;
  if (!Array.isArray(columns) || columns.length < 1 || !strings(columns, 100, LIMITS.columns)) return `${where}.columns must be a list of 1 to ${LIMITS.columns} names`;
  if (!Array.isArray(b.rows) || b.rows.length > LIMITS.rows) return `${where}.rows must be a list of at most ${LIMITS.rows} rows`;
  for (const [i, row] of b.rows.entries()) if (!strings(row, LIMITS.cell, columns.length) || (row as unknown[]).length !== columns.length) return `${where}.rows[${i}] must be ${columns.length} cells of text`;
  return null;
}

const byType: Record<string, (b: Record<string, unknown>, where: string) => Problem> = {
  heading: (b, w) => (text(b.text, LIMITS.label, 1) ? null : `${w}.text must be text of 1 to ${LIMITS.label} characters`),
  text: (b, w) => (text(b.text, LIMITS.text, 1) ? null : `${w}.text must be text of 1 to ${LIMITS.text} characters`),
  still: (b, w) => first(frameRef(b, w), optional(b, 'caption', LIMITS.label, w)),
  clip: (b, w) =>
    first(
      text(b.comp, 200, 1) ? null : `${w}.comp must be a composition id`,
      isFrame(b.from) && isFrame(b.to) && b.from <= b.to ? null : `${w} needs whole frame numbers from and to, with from first`,
      optional(b, 'caption', LIMITS.label, w),
    ),
  choice,
  slider,
  input: (b, w) =>
    first(
      b.multiline === undefined || typeof b.multiline === 'boolean' ? null : `${w}.multiline must be true or false`,
      optional(b, 'placeholder', LIMITS.label, w),
      optional(b, 'value', LIMITS.text, w),
    ),
  list: (b, w) => first(strings(b.items, LIMITS.cell, LIMITS.items) ? null : `${w}.items must be a list of at most ${LIMITS.items} texts`, b.editable === undefined || typeof b.editable === 'boolean' ? null : `${w}.editable must be true or false`),
  table: (b, w) => first(table(b, w), b.editable === undefined || typeof b.editable === 'boolean' ? null : `${w}.editable must be true or false`),
  notes: (b, w) => frameRef(b.still, `${w}.still`),
  compare: (b, w) => {
    for (const side of ['a', 'b']) {
      const bad = frameRef(b[side], `${w}.${side}`);
      if (bad) return bad;
      const long = optional(b[side] as Record<string, unknown>, 'label', LIMITS.label, `${w}.${side}`);
      if (long) return long;
    }
    return null;
  },
};

/** The problem with the data a custom panel is opened with, or null. */
export function checkCustomDraft(d: Record<string, unknown>): Problem {
  if (typeof d.name !== 'string' || !CUSTOM_NAME.test(d.name)) return 'name must be a slug of 1 to 40 lowercase letters, digits or hyphens';
  if (!text(d.title, LIMITS.title, 1)) return `title must be text of 1 to ${LIMITS.title} characters`;
  if (d.submitLabel !== undefined && !text(d.submitLabel, 40, 1)) return 'submitLabel must be text of 1 to 40 characters';
  if (!Array.isArray(d.blocks) || d.blocks.length < 1 || d.blocks.length > LIMITS.blocks) return `blocks must be a list of 1 to ${LIMITS.blocks} blocks`;
  const ids = new Set<string>();
  for (const [i, b] of d.blocks.entries()) {
    const where = `blocks[${i}]`;
    if (!isObject(b)) return `${where} must be an object`;
    if (typeof b.id !== 'string' || !ID.test(b.id)) return `${where}.id must be a letter then letters, digits, _ or - (40 at most)`;
    if (ids.has(b.id)) return `${where}.id "${b.id}" is used twice`;
    ids.add(b.id);
    const check = typeof b.type === 'string' && Object.hasOwn(byType, b.type) ? byType[b.type] : undefined;
    if (!check) return `${where}.type must be one of ${BLOCK_TYPES.join(', ')}`;
    const bad = first(
      optional(b, 'label', LIMITS.label, where),
      optional(b, 'help', LIMITS.help, where),
      b.required === undefined || typeof b.required === 'boolean' ? null : `${where}.required must be true or false`,
      check(b, where),
    );
    if (bad) return bad;
  }
  return null;
}

/** Whether a block has a value to send: a required block must, and the panel's button waits for it. */
export function isFilled(block: Block, value: unknown): boolean {
  switch (block.type) {
    case 'choice':
      return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value !== '';
    case 'slider':
      return isNumber(value);
    case 'input':
      return typeof value === 'string' && value.trim() !== '';
    case 'list':
      return Array.isArray(value) && value.some((s) => typeof s === 'string' && s.trim() !== '');
    case 'table':
      return Array.isArray(value) && value.length > 0;
    case 'notes':
      return Array.isArray(value) && value.some((n) => isObject(n) && typeof n.text === 'string' && n.text.trim() !== '');
    case 'compare':
      return value === 'a' || value === 'b';
    default:
      return true;
  }
}

function checkValue(block: InputBlock, v: unknown, where: string): Problem {
  const bad = `${where} is not the shape a ${block.type} block answers with`;
  switch (block.type) {
    case 'choice': {
      const ids = block.options.map((o) => o.id);
      if (block.multiple) return Array.isArray(v) && new Set(v).size === v.length && v.every((x) => typeof x === 'string' && ids.includes(x)) ? null : `${where} must be a list of option ids`;
      return v === null || (typeof v === 'string' && ids.includes(v)) ? null : `${where} must be an option id or null`;
    }
    case 'slider':
      return isNumber(v) && v >= block.min && v <= block.max ? null : `${where} must be a number from ${block.min} to ${block.max}`;
    case 'input':
      return text(v, LIMITS.answerText) ? null : `${where} must be text`;
    case 'list':
      return strings(v, LIMITS.cell, LIMITS.items) ? null : `${where} must be a list of texts`;
    case 'table':
      return Array.isArray(v) && v.length <= LIMITS.rows && v.every((r) => strings(r, LIMITS.cell, block.columns.length) && (r as unknown[]).length === block.columns.length) ? null : `${where} must be rows of ${block.columns.length} cells`;
    case 'notes':
      return Array.isArray(v) &&
        v.length <= LIMITS.notes &&
        v.every((n) => isObject(n) && text(n.text, LIMITS.answerText) && (n.box === undefined || (isObject(n.box) && ['x', 'y', 'w', 'h'].every((k) => isNumber((n.box as Record<string, unknown>)[k])))))
        ? null
        : bad;
    case 'compare':
      return v === null || v === 'a' || v === 'b' ? null : `${where} must be "a", "b" or null`;
  }
}

/** The problem with an answer to `draft`: only its input blocks, in the shapes they answer with, and every required one filled. */
export function checkCustomAnswer(draft: CustomDraft, a: Record<string, unknown>): Problem {
  const values = a.values;
  if (!isObject(values)) return 'values must be an object of block ids';
  const blocks = new Map(draft.blocks.map((b) => [b.id, b]));
  for (const key of Object.keys(values)) {
    const block = blocks.get(key);
    if (!block || !takesAnswer(block)) return `values.${key} is not a block that takes an answer`;
    const bad = checkValue(block, values[key], `values.${key}`);
    if (bad) return bad;
  }
  for (const block of draft.blocks) if (block.required && takesAnswer(block) && !isFilled(block, values[block.id])) return `${block.id} is required`;
  return null;
}
