// The Chrome fallback's driver (docs/COMPAT.md §6.2): the project bundled for
// the browser, rendered frame by frame in headless Chrome and read back as
// RGBA. Stream 3 (`feat/chrome-fallback`) implements it; `render`, `still`,
// `strip` and `doctor --compare` use it.

import type { Source } from '../source.js';

export interface ChromeOptions {
  /** The Chrome executable; default `KINETOGRAPH_CHROME`, else the pinned Chrome for Testing (installed on first use). */
  executablePath?: string;
  /** Where progress goes (the CLI's `--json` silences it). */
  progress?: (message: string) => void;
}

export interface ChromeFrame {
  width: number;
  height: number;
  /** Straight-alpha sRGB RGBA8, `width * height * 4` bytes. */
  data: Buffer;
}

export interface ChromeRenderer {
  /** One frame of the source's composition, drawn by Chrome. Frames may come in any order. */
  frame(frame: number): Promise<ChromeFrame>;
  close(): Promise<void>;
}

/** Starts Chrome on `source`'s project (a `.json` scene source is an `INVALID_ARG` error: it has no DOM to draw). */
export function openChromeRenderer(_source: Source, _options?: ChromeOptions): Promise<ChromeRenderer> {
  throw new Error('not implemented: openChromeRenderer (docs/COMPAT.md §6.2)');
}
