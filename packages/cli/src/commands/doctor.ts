// `kinetograph doctor` (docs/COMPAT.md §7): what a project needs Chrome for.

import type { Renderer } from '@kinetograph/native';
import { describeIssue, summarize, type DoctorCompare, type DoctorReport } from '@kinetograph/compat/doctor';
import { pathFor } from '@kinetograph/compat';
import type { Unsupported } from '@kinetograph/scene';
import { whole } from '../args.js';
import { CliError } from '../errors.js';
import { openChromeRenderer, type ChromeRenderer } from '../fallback/index.js';
import { native } from '../native.js';
import { evenFrames, frameRange, type Source } from '../source.js';
import { ENTRY, newRenderer, openFromArgs, type Command, type Context } from './types.js';

/** Two pictures count as different at a pixel when any channel is further apart than this (docs/COMPAT.md §7). */
const TOLERANCE = 2;

/** What `doctor` has learned of a frame by running the JS stage. */
interface Scanned {
  frames: { frame: number; unsupported: Unsupported[] }[];
  /** The scenes of the frames `--compare` samples, kept so that the project does not run a second time. */
  scenes: Map<number, string>;
}

/** Runs the JS stage for `first..=last`, in order, and reads each frame's unsupported items. */
async function scan(source: Source, first: number, last: number, keep: ReadonlySet<number>, progress: Context['progress']): Promise<Scanned> {
  const frames: Scanned['frames'] = [];
  const scenes = new Map<number, string>();
  const total = last - first + 1;
  for (let frame = first; frame <= last; frame++) {
    const out = await source.frame(frame);
    frames.push({ frame, unsupported: out.unsupported ?? [] });
    if (keep.has(frame)) scenes.set(frame, out.sceneJson);
    const done = frame - first + 1;
    if (done === total || done % Math.max(1, Math.floor(total / 10)) === 0) progress(`checked frame ${done}/${total}`);
  }
  return { frames, scenes };
}

/** How far apart two straight-alpha RGBA8 pictures of one size are, over all four channels. */
export function diffRgba(a: Uint8Array, b: Uint8Array): Pick<DoctorCompare, 'maxDiff' | 'meanDiff' | 'differingPixels'> {
  let maxDiff = 0;
  let sum = 0;
  let differingPixels = 0;
  for (let i = 0; i < a.length; i += 4) {
    let pixelMax = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a[i + c]! - b[i + c]!);
      sum += d;
      if (d > pixelMax) pixelMax = d;
    }
    if (pixelMax > maxDiff) maxDiff = pixelMax;
    if (pixelMax > TOLERANCE) differingPixels++;
  }
  return { maxDiff, meanDiff: a.length === 0 ? 0 : sum / a.length, differingPixels };
}

/**
 * Draws each sampled frame natively and in Chrome and measures the difference. `path` is the way `render` would draw
 * the frame by itself.
 */
export async function compareFrames(
  samples: readonly { frame: number; sceneJson: string; unsupported: readonly Unsupported[] }[],
  baseDir: string,
  nativeSide: Pick<Renderer, 'rgba'>,
  chrome: Pick<ChromeRenderer, 'frame'>,
  progress: Context['progress'] = () => {},
): Promise<DoctorCompare[]> {
  const out: DoctorCompare[] = [];
  for (const { frame, sceneJson, unsupported } of samples) {
    progress(`comparing frame ${frame} (${out.length + 1}/${samples.length})`);
    const ours = nativeSide.rgba(sceneJson, frame, baseDir);
    const theirs = await chrome.frame(frame);
    if (ours.width !== theirs.width || ours.height !== theirs.height) {
      throw new CliError(
        'SIZE_MISMATCH',
        `frame ${frame}: the engine drew ${ours.width}x${ours.height} and Chrome ${theirs.width}x${theirs.height}`,
      );
    }
    out.push({ frame, path: pathFor(unsupported, 'auto'), ...diffRgba(ours.data, theirs.data) });
  }
  return out;
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
    `drawn natively: ${report.nativeFrames} of ${report.frames} (${percent(report.nativeShare)}); by Chrome: ${report.chromeFrames}`,
  );
  if (report.issues.length === 0) {
    lines.push('nothing needs Chrome: every frame is drawn by the engine');
  } else {
    lines.push('runs:', ...report.runs.map((r) => `  ${r.path.padEnd(6)} ${ranges([[r.first, r.last]])}`));
    lines.push('', `${plural(report.issues.length, 'issue')}, most frames first:`);
    report.issues.forEach((issue, i) => {
      lines.push(`${i + 1}. ${describeIssue(issue)}`);
      lines.push(`     frames ${ranges(issue.ranges)} (${plural(issue.frames, 'frame')})`);
      if (issue.values.length > 0) lines.push(`     values ${issue.values.join('; ')}`);
      lines.push(`     at ${issue.paths.join(', ')}`);
    });
  }
  if (report.compare) {
    lines.push('', 'native against Chrome (differences in levels, 0..255):');
    for (const c of report.compare) {
      lines.push(
        `  frame ${c.frame} (${c.path}): max ${c.maxDiff}, mean ${c.meanDiff.toFixed(3)}, ` +
          `${plural(c.differingPixels, 'pixel')} more than ${TOLERANCE} apart`,
      );
    }
  }
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
    'kinetograph doctor <entry> reports what a project needs Chrome for',
  ].join('\n');
  return { data, text };
}

export const doctor: Command = {
  name: 'doctor',
  summary: 'Which frames of a project need Chrome and why (compat mode); with no entry, what this install can do',
  project: true,
  positionals: [{ ...ENTRY, optional: true }],
  options: [
    { name: 'range', type: 'string', description: 'Frames to check: 10..40 (10 to 39) or 10..=40 (10 to 40); default all' },
    {
      name: 'compare',
      type: 'number',
      description: 'Draw this many frames, spread over the range, both natively and in Chrome and report how far apart they are (opens the GPU)',
    },
  ],
  async run(args, context) {
    if (args.positionals.entry === undefined) {
      for (const name of ['comp', 'props', 'range', 'compare']) {
        if (args.options[name] !== undefined) throw new CliError('INVALID_ARG', `--${name} needs an <entry>`);
      }
      return installReport();
    }

    const compare = args.options.compare === undefined ? undefined : whole('--compare', args.options.compare as number, 1);
    const source = await openFromArgs(args);
    let chrome: ChromeRenderer | undefined;
    try {
      if (compare !== undefined && source.kind === 'scene') {
        throw new CliError('INVALID_ARG', '--compare needs a project: a .json scene has no DOM for Chrome to draw');
      }
      const [first, last] = frameRange(args.options.range as string | undefined, source.composition.durationInFrames);
      const sampled = compare === undefined ? [] : evenFrames(first, last, compare);
      const { frames, scenes } = await scan(source, first, last, new Set(sampled), context.progress);
      const report = summarize(source.composition.id, frames);

      if (compare !== undefined) {
        context.progress('starting Chrome');
        chrome = await openChromeRenderer(source, { progress: context.progress });
        const samples = sampled.map((frame) => ({
          frame,
          sceneJson: scenes.get(frame)!,
          unsupported: frames[frame - first]!.unsupported,
        }));
        report.compare = await compareFrames(samples, source.baseDir, newRenderer(), chrome, context.progress);
      }
      return { data: report, text: formatReport(report) };
    } finally {
      source.dispose();
      await chrome?.close();
    }
  },
};
