import { mkdirSync } from 'node:fs';
import type { Renderer } from '@kinetograph/native';
import { dirname } from 'node:path';
import type { OptionSpec, ParsedArgs, PositionalSpec } from '../args.js';
import { PROJECT_OPTIONS } from '../args.js';
import { CliError } from '../errors.js';
import { native } from '../native.js';
import { openSource, type Source } from '../source.js';

export interface Context {
  /** Progress for people (stderr). Silent for `--json`. */
  progress(message: string): void;
  /** For commands that serve until stopped: prints `data` (with `--json`) or `text` now, not when the command returns. */
  announce(data: object, text: string): void;
}

export interface CommandResult {
  /** What `--json` prints. */
  data: object;
  /** What people see. */
  text: string;
  /** 1 for a result that is a failed check (`lint` errors, `snapshot` mismatches). Default 0. */
  exitCode?: number;
}

export interface Command {
  /** `still`, `audio analyze`, … */
  name: string;
  summary: string;
  positionals: PositionalSpec[];
  /** The command's own options; `--json` and, if `project`, `--comp` and `--props` are added. */
  options: OptionSpec[];
  /** Takes a project or scene as its first positional, `entry`. */
  project: boolean;
  run(args: ParsedArgs, context: Context): Promise<CommandResult>;
}

export const ENTRY: PositionalSpec = {
  name: 'entry',
  description: 'A project file (.tsx, .ts, .jsx, .js) or a .json scene',
};

export const OUTPUT_OPTION: OptionSpec = { name: 'output', short: 'o', type: 'string', description: 'Output file path' };

/** `--strict`, on the commands that draw frames (docs/COMPAT.md §6.1). */
export const STRICT_OPTION: OptionSpec = {
  name: 'strict',
  type: 'boolean',
  description: 'Fail on a frame holding content the engine cannot draw (Remotion compat), instead of drawing it without and warning',
};

/** `--dev-react`, on the commands that run a project to render it (docs/AUTHORING.md §9). */
export const DEV_REACT_OPTION: OptionSpec = {
  name: 'dev-react',
  type: 'boolean',
  description: "Run React's development build (warnings, slower: about 5x on a heavy film) instead of the production one",
};

/**
 * Selects the React build the project's bundle loads: React reads `process.env.NODE_ENV` when it is first imported,
 * which is when the bundle is, so this is set before the project is opened. Returns a function that puts the old value
 * back (the render worker threads copy the environment when they start, so they see this one).
 */
export function setReactMode(dev: boolean): () => void {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = dev ? 'development' : 'production';
  return () => {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  };
}

export function allOptions(command: Command): OptionSpec[] {
  return command.project ? [...command.options, ...PROJECT_OPTIONS] : command.options;
}

export function openFromArgs(args: ParsedArgs): Promise<Source> {
  return openSource(String(args.positionals.entry), {
    comp: args.options.comp as string | undefined,
    props: args.options.props as string | undefined,
  });
}

export function requireOutput(args: ParsedArgs): string {
  const output = args.options.output;
  if (typeof output !== 'string' || output === '') throw new CliError('INVALID_ARG', 'missing -o <output>');
  return output;
}

export function ensureParentDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

export function newRenderer(): Renderer {
  return new (native().Renderer)();
}
