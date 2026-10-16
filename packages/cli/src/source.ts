import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CompositionInfo, FrameRenderer } from '@kinetograph/core';
import type { AudioClipJson, SequenceJson, Unsupported } from '@kinetograph/scene';
import { bundleProject } from './bundle.js';
import { CliError } from './errors.js';
import { modelNotes } from './model-notes.js';
import { native } from './native.js';
import { nowMs } from './time.js';

/** What the bundle exports: the parts of `@kinetograph/core` the CLI drives (docs/AUTHORING.md §7). */
interface ProjectModule {
  getCompositions(): CompositionInfo[];
  createFrameRenderer(id: string, options?: { inputProps?: Record<string, unknown> }): FrameRenderer;
  setPublicDir(dir: string): void;
  setLayoutText(fn: typeof import('@kinetograph/native').layoutText | null): void;
  setMediaProbe(fn: typeof import('@kinetograph/native').probeMedia | null): void;
  setAudioDecoder(fn: ((path: string, sampleRate: number) => ReturnType<typeof import('@kinetograph/native').decodeAudio>) | null): void;
  setDomAddon(addon: object | null): void;
  setDomEnvironment(environment: { baseDir: string; publicDir?: string }): void;
  /** Problems with the project's stylesheets (Tailwind that could not be built, a remote font). */
  stylesheetNotes(): string[];
}

export interface FrameOutput {
  /** The frame's scene as the addon takes it. */
  sceneJson: string;
  audio: AudioClipJson[];
  /** Every `<Sequence>` in the frame's tree (docs/AUTHORING.md §11.4); none for a scene file. */
  sequences?: SequenceJson[];
  /** What the engine cannot draw on this frame (docs/COMPAT.md §6.1); none for a scene file. */
  unsupported?: Unsupported[];
  /** ms spent in `renderFrame` and in `JSON.stringify` (0 for a scene file), for `bench`. */
  jsMs: number;
  stringifyMs: number;
}

/** Something to render frames from: a `.json` scene, or a composition of a bundled project. */
export interface Source {
  kind: 'scene' | 'project';
  entry: string;
  /** Asset paths in the scenes resolve against this. */
  baseDir: string;
  composition: CompositionInfo;
  /** Frames can be asked for in any order, but a project's clock only runs forward, so ascending is cheapest. */
  frame(frame: number): Promise<FrameOutput>;
  /** Problems with the project's stylesheets, for `doctor`. */
  notes?(): string[];
  dispose(): void;
}

export interface OpenOptions {
  comp?: string;
  props?: string;
  /** An already built bundle of the entry (the studio's): used instead of bundling again. */
  bundleFile?: string;
}

export function isSceneFile(entry: string): boolean {
  return extname(entry).toLowerCase() === '.json';
}

export function parseProps(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CliError('INVALID_ARG', `--props is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError('INVALID_ARG', '--props must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function requireEntry(entry: string): string {
  const absolute = resolve(entry);
  if (!existsSync(absolute)) throw new CliError('ENTRY_NOT_FOUND', `no such file: ${entry}`);
  return absolute;
}

/**
 * Where `staticFile` reads from: `public/` beside the entry, or else `public/` beside the nearest package.json (where
 * Remotion keeps it, with the entry in `src/`). Beside the entry when neither exists.
 */
export function publicDirOf(entry: string): string {
  const beside = join(dirname(entry), 'public');
  if (existsSync(beside)) return beside;
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) {
      const atRoot = join(dir, 'public');
      return existsSync(atRoot) ? atRoot : beside;
    }
    if (dirname(dir) === dir) return beside;
  }
}

async function loadProject(entry: string, bundleFile?: string): Promise<ProjectModule> {
  const file = bundleFile ?? (await bundleProject(entry)).file;
  process.setSourceMapsEnabled(true);
  // Set before the import: a staticFile() call made while the project loads (a font, a module-level constant) runs
  // before setPublicDir below can.
  const publicDir = publicDirOf(entry);
  process.env.KINETOGRAPH_PUBLIC_DIR = publicDir;
  process.env.KINETOGRAPH_BASE_DIR = dirname(entry);
  let mod: ProjectModule;
  try {
    mod = (await import(pathToFileURL(file).href)) as ProjectModule;
  } catch (error) {
    throw new CliError(
      'PROJECT_ERROR',
      `${entry} failed while loading: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
  mod.setPublicDir(publicDir);
  mod.setLayoutText(native().layoutText);
  // The DOM engine: islands are styled, laid out and painted by the addon, relative paths resolve from the entry.
  mod.setDomAddon(native());
  mod.setDomEnvironment({ baseDir: dirname(entry), publicDir });
  // A relative `src` is read from where the scenes' assets are (the entry's directory), not the working directory.
  mod.setMediaProbe((path, baseDir) => native().probeMedia(path, baseDir ?? dirname(entry)));
  mod.setAudioDecoder((path, sampleRate) => native().decodeAudio(path, sampleRate, dirname(entry)));
  return mod;
}

/** The compositions a project (or a scene file, which is one) offers. */
export async function listCompositions(entry: string, options: { bundleFile?: string } = {}): Promise<CompositionInfo[]> {
  const absolute = requireEntry(entry);
  if (isSceneFile(absolute)) return [sceneComposition(absolute, readFileSync(absolute, 'utf8'))];
  return (await loadProject(absolute, options.bundleFile)).getCompositions();
}

function sceneComposition(file: string, text: string): CompositionInfo {
  const info = native().validateScene(text, dirname(file));
  return {
    id: basename(file, extname(file)),
    width: info.width,
    height: info.height,
    fps: info.fps,
    durationInFrames: info.durationInFrames,
    defaultProps: {},
  };
}

export async function openSource(entry: string, options: OpenOptions = {}): Promise<Source> {
  const absolute = requireEntry(entry);
  const baseDir = dirname(absolute);

  const notes = modelNotes(baseDir);

  if (isSceneFile(absolute)) {
    const text = readFileSync(absolute, 'utf8');
    return {
      kind: 'scene',
      entry: absolute,
      baseDir,
      composition: sceneComposition(absolute, text),
      frame: async () => ({ sceneJson: text, audio: [], sequences: [], unsupported: notes(text), jsMs: 0, stringifyMs: 0 }),
      dispose: () => {},
    };
  }

  const inputProps = parseProps(options.props);
  const mod = await loadProject(absolute, options.bundleFile);
  const compositions = mod.getCompositions();
  if (compositions.length === 0) {
    throw new CliError('NO_COMPOSITIONS', `${entry} registered no compositions: call registerRoot() with a root that renders <Composition>`);
  }
  const composition = options.comp ? compositions.find((c) => c.id === options.comp) : compositions[0];
  if (!composition) {
    throw new CliError(
      'COMPOSITION_NOT_FOUND',
      `no composition "${options.comp}" in ${entry}; it has: ${compositions.map((c) => c.id).join(', ')}`,
    );
  }
  const renderer = mod.createFrameRenderer(composition.id, { inputProps });
  // calculateMetadata and lazy components resolve asynchronously.
  const config = await renderer.ready();
  return {
    kind: 'project',
    entry: absolute,
    baseDir,
    composition: {
      ...composition,
      width: config.width,
      height: config.height,
      fps: config.fps,
      durationInFrames: config.durationInFrames,
    },
    frame: async (frame) => {
      const started = nowMs();
      const result = await renderer.renderFrame(frame);
      const rendered = nowMs();
      const sceneJson = JSON.stringify(result.scene);
      const unsupported = [...result.unsupported, ...notes(sceneJson)];
      return { sceneJson, audio: result.audio, sequences: result.sequences, unsupported, jsMs: rendered - started, stringifyMs: nowMs() - rendered };
    },
    notes: () => mod.stylesheetNotes(),
    dispose: () => renderer.dispose(),
  };
}

/** A frame number checked against the composition. */
export function checkFrame(frame: number, durationInFrames: number): number {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new CliError('FRAME_OUT_OF_RANGE', `frame ${frame} is out of range: frames are whole numbers from 0`);
  }
  if (frame >= durationInFrames) {
    throw new CliError('FRAME_OUT_OF_RANGE', `frame ${frame} is out of range: the composition has ${durationInFrames} frames (0..${durationInFrames - 1})`);
  }
  return frame;
}

/** `--range a..b` as inclusive first and last frame; the whole composition if left out. */
export function frameRange(range: string | undefined, durationInFrames: number): [number, number] {
  if (range === undefined) return [0, durationInFrames - 1];
  const [first, last] = native().parseRange(range, durationInFrames);
  return [first!, last!];
}

/** `count` frames spread evenly over `first..=last`, ends included, without repeats. */
export function evenFrames(first: number, last: number, count: number): number[] {
  const available = last - first + 1;
  const n = Math.min(count, available);
  if (n <= 1) return [first];
  const frames: number[] = [];
  for (let i = 0; i < n; i++) frames.push(first + Math.round((i * (last - first)) / (n - 1)));
  return [...new Set(frames)];
}

