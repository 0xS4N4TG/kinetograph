// `kinetograph doctor`: what a project holds that the engine cannot draw.

import { describeIssue, summarize, type DoctorReport } from '@kinetograph/compat/doctor';
import type { Unsupported } from '@kinetograph/scene';
import { relative } from 'node:path';
import type { UnsupportedImport } from '../bundle.js';
import { CliError } from '../errors.js';
import { native } from '../native.js';
import { frameRange, type Source } from '../source.js';
import { ENTRY, openFromArgs, type Command, type Context } from './types.js';

/** Runs the JS stage for `first..=last`, in order, and reads each frame's unsupported items. */
async function scan(
  source: Source,
  first: number,
  last: number,
  progress: Context['progress'],
): Promise<{ frame: number; unsupported: Unsupported[] }[]> {
  const frames: { frame: number; unsupported: Unsupported[] }[] = [];
  const total = last - first + 1;
  for (let frame = first; frame <= last; frame++) {
    const out = await source.frame(frame);
    frames.push({ frame, unsupported: out.unsupported ?? [] });
    const done = frame - first + 1;
    if (done === total || done % Math.max(1, Math.floor(total / 10)) === 0) progress(`checked frame ${done}/${total}`);
  }
  return frames;
}

/** Frame numbers as `5` or `0..29`, joined with commas. */
function ranges(list: readonly [number, number][]): string {
  return list.map(([first, last]) => (first === last ? `${first}` : `${first}..${last}`)).join(', ');
}

const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The report as people read it. */
export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  if (report.frames === 0) return `${report.comp}: no frames checked`;
  lines.push(
    `${report.comp}: frames ${report.first}..${report.last} (${plural(report.frames, 'frame')})`,
    `nothing unsupported in ${report.cleanFrames} of ${report.frames} frames (${percent(report.cleanShare)}); ` +
      `with unsupported content: ${report.unsupportedFrames}`,
  );
  if (report.issues.length === 0) {
    lines.push('nothing is left out: every frame is drawn in full by the engine');
  } else {
    lines.push('these are drawn without it or approximated (`render --strict` fails on them instead)');
    lines.push('', `${plural(report.issues.length, 'issue')}, most frames first:`);
    report.issues.forEach((issue, i) => {
      lines.push(`${i + 1}. ${describeIssue(issue)}`);
      lines.push(`     frames ${ranges(issue.ranges)} (${plural(issue.frames, 'frame')})`);
      if (issue.values.length > 0) lines.push(`     values ${issue.values.join('; ')}`);
      lines.push(`     at ${issue.paths.join(', ')}`);
    });
  }
  if (report.notes) lines.push('', 'stylesheets:', ...report.notes.map((note) => `  ${note}`));
  return lines.join('\n');
}

/** The imports of packages Kinetograph does not support, one line each, with the file that imports them. */
export function formatImports(imports: readonly UnsupportedImport[]): string {
  const lines = [`${plural(imports.length, 'import')} of packages Kinetograph does not support (they draw nothing here):`];
  for (const { specifier, file } of imports) lines.push(`  ${specifier}  imported by ${file === null ? 'the entry' : relative(process.cwd(), file) || file}`);
  return lines.join('\n');
}

/** `doctor` with no entry: what this install can do. */
function installReport(): { data: object; text: string } {
  let addon: { loaded: true; version: string } | { loaded: false; error: string };
  try {
    addon = { loaded: true, version: native().version() };
  } catch (error) {
    addon = { loaded: false, error: error instanceof CliError ? error.message : String(error) };
  }
  const data = { node: process.version, platform: `${process.platform}-${process.arch}`, addon };
  const text = [
    `node ${data.node} on ${data.platform}`,
    addon.loaded ? `addon: loaded, version ${addon.version}` : `addon: NOT loaded: ${addon.error}`,
    'kinetograph doctor <entry> reports what a project holds that the engine cannot draw',
  ].join('\n');
  return { data, text };
}

export const doctor: Command = {
  name: 'doctor',
  summary: 'What a project holds that the engine cannot draw, and in which frames (compat mode); with no entry, what this install can do',
  project: true,
  positionals: [{ ...ENTRY, optional: true }],
  options: [{ name: 'range', type: 'string', description: 'Frames to check: 10..40 (10 to 39) or 10..=40 (10 to 40); default all' }],
  async run(args, context) {
    if (args.positionals.entry === undefined) {
      for (const name of ['comp', 'props', 'range']) {
        if (args.options[name] !== undefined) throw new CliError('INVALID_ARG', `--${name} needs an <entry>`);
      }
      return installReport();
    }

    // An import of an unsupported package would fail the bundle: it is listed instead, and the rest is checked.
    const imports: UnsupportedImport[] = [];
    const withImports = <T extends object>(data: T, text: string): { data: T | (T & { unsupportedImports: UnsupportedImport[] }); text: string } =>
      imports.length === 0 ? { data, text } : { data: { ...data, unsupportedImports: imports }, text: `${formatImports(imports)}\n\n${text}` };
    const failed = (error: unknown): { data: object; text: string } => {
      const reason = error instanceof Error ? error.message : String(error);
      return withImports({ error: reason }, `the frames could not be checked: ${reason}`);
    };

    let source: Source;
    try {
      source = await openFromArgs(args, { unsupportedImports: imports });
    } catch (error) {
      if (imports.length === 0) throw error;
      return failed(error);
    }
    try {
      const [first, last] = frameRange(args.options.range as string | undefined, source.composition.durationInFrames);
      const report = summarize(source.composition.id, await scan(source, first, last, context.progress));
      const notes = source.notes?.() ?? [];
      if (notes.length > 0) report.notes = notes;
      return withImports(report, formatReport(report));
    } catch (error) {
      if (imports.length === 0) throw error;
      return failed(error);
    } finally {
      source.dispose();
    }
  },
};
