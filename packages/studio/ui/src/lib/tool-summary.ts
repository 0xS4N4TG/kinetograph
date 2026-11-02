// What a tool call in the chat says about itself, in a line: pure functions over the fields the server forwards (title,
// kind, files, input, output, diffs), so the rows only draw. Paths are shown relative to the project (`.`) and the home
// directory (`~`); commands lose a leading `cd <dir> &&`.

import type { ChatItem } from '@/lib/chat';

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

/** Where paths are made short from: the project directory and the home directory (either may be empty when unknown). */
export interface PathContext {
  cwd: string;
  home: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const trimSlash = (dir: string) => (dir.length > 1 ? dir.replace(/\/+$/, '') : dir);

const swap = (text: string, dir: string, to: string): string => {
  const d = trimSlash(dir);
  if (d === '' || d === '/') return text;
  return text.replace(new RegExp(`(?<![\\w./~-])${escapeRegExp(d)}(?=$|[/\\s'"\`;:)\\]])`, 'g'), to);
};

/** Writes the project directory as `.` and the home directory as `~` wherever they start a path in `text`. */
export function tidyPaths(text: string, ctx: PathContext): string {
  return swap(swap(text, ctx.cwd, '.'), ctx.home, '~');
}

const CD = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s&;|]+)\s*(?:&&|;)\s*/;

/** A command without the `cd <dir> &&` (or `;`) the agent puts in front of it; unchanged when nothing else is left. */
export function stripCd(command: string): string {
  let rest = command;
  for (;;) {
    const next = rest.replace(CD, '');
    if (next === rest || next.trim() === '') return rest.trim();
    rest = next;
  }
}

/** The command as a one-line summary: no `cd`, paths short, whitespace collapsed. */
export function commandLine(command: string, ctx: PathContext): string {
  return tidyPaths(stripCd(command), ctx).replace(/\s*\n\s*/g, ' ').trim();
}

/** Text from a terminal without its colour and cursor codes. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g, '');
}

/** A path shortened in the middle to at most `max` characters, keeping the start and the file name. */
export function middleTruncate(path: string, max = 44): string {
  if (path.length <= max) return path;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const tail = Math.min(Math.max(name.length + 1, Math.floor((max - 1) * 0.6)), max - 6);
  const head = max - 1 - tail;
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
}

/** A path from the agent made relative: `./x` for the project, `~/x` for the home directory; the rest as it is. */
export function displayPath(path: string, ctx: PathContext): string {
  const tidy = tidyPaths(path, ctx);
  return tidy === '.' ? '.' : tidy.startsWith('./') ? tidy.slice(2) : tidy;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export interface ToolSummary {
  /** A word before the text ("Read", "Edit"), or empty. */
  verb: string;
  text: string;
  /** The text is a command or a pattern: set in monospace. */
  mono: boolean;
  /** The text is a path: shortened in the middle. */
  isPath: boolean;
  added?: number;
  removed?: number;
}

const FILE_VERBS: Record<string, string> = { read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move' };

/** Whether the agent's title says more than the command it names (a description, not the command again). */
function isDescription(title: string, command: string | undefined, ctx: PathContext): boolean {
  if (title.trim() === '') return false;
  if (!command) return false;
  const a = commandLine(title, ctx).toLowerCase();
  const b = commandLine(command, ctx).toLowerCase();
  const probe = (s: string) => s.slice(0, Math.min(24, s.length));
  return !(a.includes(probe(b)) || b.includes(probe(a)));
}

/** The one line for a tool call. */
export function summarize(tool: ToolItem, ctx: PathContext): ToolSummary {
  const input = tool.input;
  const title = tool.title.trim();
  const mono = (text: string, extra: Partial<ToolSummary> = {}): ToolSummary => ({ verb: '', text, mono: true, isPath: false, ...extra });
  switch (tool.toolKind) {
    case 'execute': {
      const command = input?.command ?? (title !== '' ? title : undefined);
      const description = input?.description ?? (isDescription(title, input?.command, ctx) ? title : undefined);
      if (description) return { verb: '', text: tidyPaths(description, ctx), mono: false, isPath: false };
      return command ? mono(commandLine(command, ctx)) : { verb: '', text: 'Running a command', mono: false, isPath: false };
    }
    case 'read':
    case 'edit':
    case 'delete':
    case 'move': {
      const verb = FILE_VERBS[tool.toolKind]!;
      const paths = tool.files.length > 0 ? tool.files : input?.path ? [input.path] : (tool.diffs ?? []).map((d) => d.path);
      const added = (tool.diffs ?? []).reduce((n, d) => n + d.added, 0);
      const removed = (tool.diffs ?? []).reduce((n, d) => n + d.removed, 0);
      const delta = tool.diffs && tool.diffs.length > 0 ? { added, removed } : {};
      if (paths.length === 0) return { verb: '', text: title || verb, mono: false, isPath: false, ...delta };
      const shown = tool.toolKind === 'move' && paths.length > 1 ? `${displayPath(paths[0]!, ctx)} → ${displayPath(paths[1]!, ctx)}` : displayPath(paths[0]!, ctx);
      const more = tool.toolKind === 'move' ? 0 : paths.length - 1;
      return { verb, text: more > 0 ? `${shown} +${more} more` : shown, mono: true, isPath: more === 0 && tool.toolKind !== 'move', ...delta };
    }
    case 'search': {
      const pattern = input?.pattern;
      return pattern ? mono(pattern, { verb: 'Search' }) : { verb: '', text: title || 'Searching', mono: false, isPath: false };
    }
    case 'fetch': {
      const target = input?.url ?? input?.pattern;
      return target ? mono(target.replace(/^https?:\/\//, ''), { verb: 'Fetch' }) : { verb: '', text: title || 'Fetching', mono: false, isPath: false };
    }
    case 'think':
      return { verb: '', text: title || 'Thinking', mono: false, isPath: false };
    default:
      return { verb: '', text: tidyPaths(title, ctx) || 'Working', mono: false, isPath: false };
  }
}

const NOUNS: Record<string, [string, string, string]> = {
  // kind: [verb phrase before the count, singular, plural]
  execute: ['ran', 'command', 'commands'],
  read: ['read', 'file', 'files'],
  edit: ['edited', 'file', 'files'],
  delete: ['deleted', 'file', 'files'],
  move: ['moved', 'file', 'files'],
  search: ['ran', 'search', 'searches'],
  fetch: ['fetched', 'page', 'pages'],
  think: ['thought', 'time', 'times'],
};

/** "Ran 3 commands · read 2 files": the calls of a group counted by kind, in the order the kinds first appear. */
export function groupLabel(tools: ToolItem[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.toolKind, (counts.get(t.toolKind) ?? 0) + 1);
  const parts = [...counts].map(([kind, n]) => {
    const [verb, one, many] = NOUNS[kind] ?? ['used', 'tool', 'tools'];
    return kind === 'think' ? 'thought' : `${verb} ${n} ${n === 1 ? one : many}`;
  });
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
