import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LayerName, StudioError } from './protocol.js';

/** A failure with a studio error code (`INVALID_ARG`, `NOT_FOUND`, `BUILD`, …). */
export class StudioFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StudioFailure';
  }
}

/**
 * The `StudioError` of any thrown value; the CLI's and the addon's errors keep their codes. (As the CLI's
 * `toErrorObject`, which is not imported so that a worker that does not need the CLI does not load it.)
 */
export function toStudioError(error: unknown): StudioError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { code: typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'INTERNAL', message: error.message };
  }
  return { code: 'INTERNAL', message: String(error) };
}

/** The HTTP status for an error, with the code the client sees (packages/cli/skills/kinetograph/references/AUTHORING.md §11.5). */
export function httpError(error: unknown): { status: number; error: StudioError } {
  const { code, message } = toStudioError(error);
  switch (code) {
    case 'INVALID_ARG':
    case 'FRAME_OUT_OF_RANGE':
      return { status: 400, error: { code: 'INVALID_ARG', message } };
    case 'NOT_FOUND':
    case 'COMPOSITION_NOT_FOUND':
      return { status: 404, error: { code: 'NOT_FOUND', message } };
    case 'FORBIDDEN':
      return { status: 403, error: { code, message } };
    case 'BUILD':
    case 'SUPERSEDED':
      return { status: 409, error: { code, message } };
    default:
      return { status: 500, error: { code, message } };
  }
}

/**
 * The name of layer `id`. The addon adds layers of its own under an element's path (`$0.1.border.top`, `$0.1.shadow2`,
 * `$0.1.svg.3`): they are named after the element, with what the id adds.
 */
export function lookupName(names: Record<string, LayerName> | undefined, id: string): LayerName | undefined {
  if (names === undefined) return undefined;
  const known = names[id];
  if (known !== undefined) return known;
  const parts = id.split('.');
  for (let n = parts.length - 1; n > 0; n--) {
    const base = names[parts.slice(0, n).join('.')];
    if (base !== undefined) return { ...base, label: `${base.label} \u00b7 ${parts.slice(n).join(' ')}` };
  }
  return undefined;
}

/** `JSON.stringify` with object keys sorted, so equal props are equal keys. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The path of a built file of this package: beside this one when it is the built copy, else in `dist/` (the sources
 * run directly under vitest, and a worker cannot load TypeScript).
 */
export function builtFile(name: string): string {
  const beside = fileURLToPath(new URL(`./${name}`, import.meta.url));
  return existsSync(beside) ? beside : fileURLToPath(new URL(`../dist/${name}`, import.meta.url));
}

/** `peaks` taken down (the loudest of the ones each new bucket covers) or stretched to `buckets`. */
export function resamplePeaks(peaks: number[], buckets: number): number[] {
  if (peaks.length === 0 || buckets <= 0) return [];
  const out = new Array<number>(buckets).fill(0);
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor((b * peaks.length) / buckets);
    const hi = Math.max(lo + 1, Math.floor(((b + 1) * peaks.length) / buckets));
    let peak = 0;
    for (let i = lo; i < hi && i < peaks.length; i++) peak = Math.max(peak, peaks[i]!);
    out[b] = peak;
  }
  return out;
}

/**
 * What a sound is, apart from the path id of the `<Audio>` that plays it: ids are paths in the tree, so when a sibling
 * before it unmounts the same sound gets a new one. The timeline and the waveforms name a sound by this.
 */
export function soundKey(clip: { src: string; from: number; trimBefore: number; trimAfter: number | null; playbackRate: number; loop: boolean; video?: boolean }): string {
  return JSON.stringify([clip.src, clip.from, clip.trimBefore, clip.trimAfter, clip.playbackRate, clip.loop, clip.video === true]);
}
