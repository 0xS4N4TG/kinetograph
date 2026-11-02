// What the chat shows of a tool call beyond its title: the few fields of the agent's own input that say what it does, its
// output (bounded), and the diffs of the files it changed, as lines with a sign. All of it is cut to a size the chat log can
// keep (see chat-log.ts), so a long command or a whole file read never fills it.

import { relative } from 'node:path';
import type { ToolDiff, ToolInput } from './protocol.js';

const FIELD_MAX = 4_000;
const OUTPUT_HEAD = 2_000;
const OUTPUT_TAIL = 6_000;
const DIFF_LINES = 400;
const CONTEXT = 2;
/** Above this many cells the line-by-line comparison is skipped: the old text is shown removed and the new added. */
const LCS_CELLS = 250_000;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value.slice(0, FIELD_MAX) : undefined);

/** The fields of an agent's tool input worth showing, whatever the agent calls them. */
export function toolInput(raw: unknown): ToolInput | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const command = Array.isArray(r.command) ? text(r.command.filter((p) => typeof p === 'string').join(' ')) : text(r.command);
  const input: ToolInput = {};
  if (command) input.command = command;
  const description = text(r.description);
  if (description) input.description = description;
  const pattern = text(r.pattern) ?? text(r.query) ?? text(r.regex);
  if (pattern) input.pattern = pattern;
  const url = text(r.url);
  if (url) input.url = url;
  const path = text(r.file_path) ?? text(r.filePath) ?? text(r.path);
  if (path) input.path = path;
  return Object.keys(input).length > 0 ? input : undefined;
}

/** A long output keeps its start and, longer, its end (where a command says how it went). */
export function cutOutput(output: string): string {
  if (output.length <= OUTPUT_HEAD + OUTPUT_TAIL) return output;
  const left = output.length - OUTPUT_HEAD - OUTPUT_TAIL;
  return `${output.slice(0, OUTPUT_HEAD)}\n… ${left} characters left out …\n${output.slice(-OUTPUT_TAIL)}`;
}

/** The text a tool printed: the text content of the call, else the raw output. */
export function toolOutput(content: unknown, rawOutput: unknown): string | undefined {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const item of content as { type?: string; content?: { type?: string; text?: string } }[]) {
      if (item?.type === 'content' && item.content?.type === 'text' && typeof item.content.text === 'string') parts.push(item.content.text);
    }
  }
  let out = parts.join('\n');
  if (out === '' && typeof rawOutput === 'string') out = rawOutput;
  if (out === '' && typeof rawOutput === 'object' && rawOutput !== null) {
    const r = rawOutput as Record<string, unknown>;
    out = [r.stdout, r.stderr, r.output].filter((p): p is string => typeof p === 'string' && p !== '').join('\n');
  }
  return out.trim() === '' ? undefined : cutOutput(out);
}

const lines = (s: string): string[] => (s === '' ? [] : s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));

/** A line diff of two texts: counts, and the changed lines with `CONTEXT` lines around each change, each starting with ' ', '+' or '-'. */
export function lineDiff(oldText: string | null | undefined, newText: string): Omit<ToolDiff, 'path'> {
  const a = lines(oldText ?? '');
  const b = lines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: string[] = [];
  if (midA.length * midB.length <= LCS_CELLS) {
    const table = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        ops.push(` ${midA[i]}`);
        i++;
        j++;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) ops.push(`-${midA[i++]}`);
      else ops.push(`+${midB[j++]}`);
    }
    while (i < midA.length) ops.push(`-${midA[i++]}`);
    while (j < midB.length) ops.push(`+${midB[j++]}`);
  } else {
    for (const l of midA) ops.push(`-${l}`);
    for (const l of midB) ops.push(`+${l}`);
  }
  const added = ops.filter((o) => o[0] === '+').length;
  const removed = ops.filter((o) => o[0] === '-').length;
  const all = [...a.slice(Math.max(0, start - CONTEXT), start).map((l) => ` ${l}`), ...ops, ...a.slice(endA, endA + CONTEXT).map((l) => ` ${l}`)];
  // Unchanged lines far from any change are dropped, with a mark where they were.
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((line, index) => {
    if (line[0] === ' ') return;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(all.length - 1, index + CONTEXT); k++) keep[k] = true;
  });
  const shown: string[] = [];
  let gap = false;
  all.forEach((line, index) => {
    if (!keep[index]) {
      gap = true;
      return;
    }
    if (gap && shown.length > 0) shown.push(' …');
    gap = false;
    shown.push(line);
  });
  if (shown.length > DIFF_LINES) {
    const left = shown.length - DIFF_LINES;
    shown.length = DIFF_LINES;
    shown.push(` … ${left} more lines`);
  }
  return { added, removed, lines: shown };
}

/** The diffs among a call's content, with paths relative to the project. */
export function toolDiffs(cwd: string, content: unknown): ToolDiff[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const out: ToolDiff[] = [];
  for (const item of content as { type?: string; path?: string; oldText?: string | null; newText?: string }[]) {
    if (item?.type !== 'diff' || typeof item.path !== 'string' || typeof item.newText !== 'string') continue;
    const path = item.path.startsWith(cwd) ? relative(cwd, item.path) || '.' : item.path;
    out.push({ path, ...lineDiff(item.oldText, item.newText) });
  }
  return out.length > 0 ? out : undefined;
}
