import { parseArgs } from 'node:util';
import { CliError } from './errors.js';

export interface OptionSpec {
  name: string;
  short?: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  /** A string option given any number of times (`--point 10,20 --point 30,40`): its value is the list. */
  multiple?: boolean;
}

export interface PositionalSpec {
  name: string;
  description: string;
  type?: 'string' | 'number';
  optional?: boolean;
}

export interface ParsedArgs {
  positionals: Record<string, string | number | undefined>;
  options: Record<string, string | number | boolean | string[] | undefined>;
  json: boolean;
}

/** Options every command that opens a project takes (packages/cli/skills/kinetograph/references/AUTHORING.md §9). */
export const PROJECT_OPTIONS: OptionSpec[] = [
  { name: 'comp', type: 'string', description: 'Composition id (default: the first composition)' },
  { name: 'props', type: 'string', description: 'Input props as a JSON object' },
  { name: 'offline', type: 'boolean', description: 'Never download: remote scripts, modules, pictures and media must already be cached (a missing one is an error, as before the pre-download step)' },
];

export const JSON_OPTION: OptionSpec = {
  name: 'json',
  type: 'boolean',
  description: 'Print one JSON object; errors are { "error": { "code", "message" } } with exit code 1',
};

interface ParseSpec {
  name: string;
  positionals: PositionalSpec[];
  options: OptionSpec[];
}

/**
 * Parses the arguments after the command name. Unknown options and missing or extra positionals are `INVALID_ARG`
 * errors that say what the command takes.
 */
export function parseCommandArgs(spec: ParseSpec, argv: string[]): ParsedArgs {
  // `-1` would be read as an option. Negative numbers go after `--`, where they are positionals, so the command can
  // refuse them with a message about frames instead of the parser's about unknown options.
  const flags: string[] = [];
  const negatives: string[] = [];
  for (const arg of argv) (/^-\d/.test(arg) ? negatives : flags).push(arg);

  const options = [...spec.options, JSON_OPTION];
  let values: Record<string, string | boolean | string[] | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: negatives.length ? [...flags, '--', ...negatives] : flags,
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries(
        options.map((o) => [
          o.name,
          {
            type: o.type === 'boolean' ? ('boolean' as const) : ('string' as const),
            ...(o.short ? { short: o.short } : {}),
            ...(o.multiple ? { multiple: true } : {}),
          },
        ]),
      ),
    });
    values = parsed.values as Record<string, string | boolean | string[] | undefined>;
    positionals = parsed.positionals;
  } catch (error) {
    throw new CliError('INVALID_ARG', `${error instanceof Error ? error.message : String(error)}\n${usage(spec)}`);
  }

  const required = spec.positionals.filter((p) => !p.optional);
  if (positionals.length < required.length) {
    throw new CliError('INVALID_ARG', `missing <${required[positionals.length]!.name}>\n${usage(spec)}`);
  }
  if (positionals.length > spec.positionals.length) {
    throw new CliError('INVALID_ARG', `unexpected argument "${positionals[spec.positionals.length]}"\n${usage(spec)}`);
  }

  const out: ParsedArgs = { positionals: {}, options: {}, json: values.json === true };
  spec.positionals.forEach((p, i) => {
    const raw = positionals[i];
    out.positionals[p.name] = raw === undefined ? undefined : p.type === 'number' ? toNumber(p.name, raw) : raw;
  });
  for (const o of spec.options) {
    const raw = values[o.name];
    if (raw === undefined) continue;
    out.options[o.name] = o.type === 'number' && !o.multiple ? toNumber(`--${o.name}`, raw as string) : raw;
  }
  return out;
}

function toNumber(what: string, raw: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) throw new CliError('INVALID_ARG', `${what} must be a number, got "${raw}"`);
  return n;
}

export function usage(spec: ParseSpec): string {
  const positionals = spec.positionals.map((p) => (p.optional ? `[${p.name}]` : `<${p.name}>`)).join(' ');
  const lines = [`usage: kinetograph ${spec.name}${positionals ? ' ' + positionals : ''} [options]`];
  for (const o of [...spec.options, JSON_OPTION]) {
    const flag = `${o.short ? `-${o.short}, ` : '    '}--${o.name}${o.type === 'boolean' ? '' : ` <${o.type}>`}${o.multiple ? ' ...' : ''}`;
    lines.push(`  ${flag.padEnd(26)} ${o.description}`);
  }
  return lines.join('\n');
}

/** A whole number option or positional, at least `min`. */
export function whole(what: string, value: number | undefined, min: number, fallback?: number): number {
  const v = value ?? fallback;
  if (v === undefined) throw new CliError('INVALID_ARG', `${what} is required`);
  if (!Number.isInteger(v) || v < min) throw new CliError('INVALID_ARG', `${what} must be a whole number of at least ${min}, got ${v}`);
  return v;
}

/** `"0,30,60"` as frame numbers. */
export function parseFrameList(what: string, text: string): number[] {
  const frames = text.split(',').map((s) => s.trim());
  return frames.map((s) => {
    const n = Number(s);
    if (s === '' || !Number.isInteger(n) || n < 0) {
      throw new CliError('INVALID_ARG', `${what} must be comma-separated whole frame numbers, got "${text}"`);
    }
    return n;
  });
}
