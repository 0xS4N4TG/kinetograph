/// <reference lib="dom" />
// The Chrome fallback's driver (docs/COMPAT.md §6.2): the project bundled for the browser, rendered frame by frame in
// headless Chrome and read back as RGBA. `render`, `still`, `strip` and `doctor --compare` use it.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from 'puppeteer-core';
import type { FrameReport } from '@kinetograph/compat/browser';
import { CliError } from '../errors.js';
import { native } from '../native.js';
import { decodePng } from '../png.js';
import type { Source } from '../source.js';
import { buildBrowserBundle } from './bundle.js';
import { chromeArgs, findChrome, launchChrome } from './chrome.js';
import { startFrameServer } from './server.js';

export interface ChromeOptions {
  /** The Chrome executable; default `KINETOGRAPH_CHROME`, else the pinned Chrome for Testing (installed on first use). */
  executablePath?: string;
  /** Where progress goes (the CLI's `--json` silences it). */
  progress?: (message: string) => void;
  /**
   * Draws at this fraction of the composition's size (`render --draft` is 0.5): Chrome's device scale factor, so
   * vectors and text are drawn at the smaller size and not shrunk afterwards. Default 1.
   */
  scale?: number;
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

/** The directory a project's files may be read from: the nearest one with a package.json above the entry, else its own. */
export function projectRoot(entry: string): string {
  let dir = dirname(entry);
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(entry);
    dir = parent;
  }
}

/**
 * The `@font-face` rule for a registered font, and the spec `document.fonts.load` takes to load it. The family, weight
 * and style are those of the key (`fontKey`: `Inter`, `Inter:700`, `Inter:400i`), so a CSS `font-family`, `font-weight`
 * and `font-style` pick the file the engine would, in the `Text` element and in a DOM `div` alike.
 */
export function fontFace(key: string, url: string): { css: string; load: string } {
  const match = /^(.*?)(?::(\d+)(i)?)?$/.exec(key)!;
  const family = match[1]!.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const weight = match[2] ?? '400';
  const style = match[3] ? 'italic' : 'normal';
  return {
    css: `@font-face { font-family: "${family}"; font-weight: ${weight}; font-style: ${style}; src: url("${url}"); }`,
    load: `${style} ${weight} 16px "${family}"`,
  };
}

/** Starts Chrome on `source`'s project (a `.json` scene source is an `INVALID_ARG` error: it has no DOM to draw). */
export async function openChromeRenderer(source: Source, options: ChromeOptions = {}): Promise<ChromeRenderer> {
  if (source.kind === 'scene') {
    throw new CliError('INVALID_ARG', 'Chrome draws projects, not .json scenes: a scene has no DOM to draw');
  }
  const progress = options.progress ?? (() => {});
  const scale = options.scale ?? 1;
  const { width, height } = source.composition;
  const expected = { width: Math.round(width * scale), height: Math.round(height * scale) };

  const chrome = await findChrome({ executablePath: options.executablePath, progress });
  const publicDir = source.publicDir ?? join(source.baseDir, 'public');
  progress('bundling the project for Chrome');
  const bundle = await buildBrowserBundle(source.entry, {
    composition: source.composition.id,
    inputProps: source.inputProps ?? {},
    cwd: process.cwd(),
    publicDir,
  });
  for (const warning of bundle.warnings) progress(`warning: ${warning}`);

  const server = await startFrameServer({
    bundle: bundle.code,
    settings: { cwd: process.cwd(), publicDir },
    baseDir: source.baseDir,
    roots: [projectRoot(source.entry), source.baseDir, publicDir],
    native: native(),
    fonts: () => source.fonts?.() ?? {},
  });

  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  const problems: string[] = [];
  const close = async (): Promise<void> => {
    await browser?.close().catch(() => undefined);
    await server.close();
  };

  let page: Page;
  try {
    progress(`starting Chrome (${chrome.executablePath})`);
    browser = await launchChrome({ executablePath: chrome.executablePath, args: chromeArgs() });
    page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: scale });
    // A bundle that throws while it loads never defines the runtime; its error is a better message than a timeout.
    const crashed = new Promise<never>((_, reject) => {
      page.on('pageerror', (error) => {
        const message = error instanceof Error ? error.message : String(error);
        problems.push(message);
        // The top of the stack says which of the project's lines threw (the bundle is not minified).
        const where = error instanceof Error ? (error.stack ?? '').split('\n').slice(1, 4).join('\n') : '';
        reject(new Error(where ? `${message}\n${where}` : message));
      });
    });
    crashed.catch(() => undefined);
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('requestfailed', (request) => problems.push(`${request.url()} failed: ${request.failure()?.errorText ?? 'unknown'}`));
    await page.goto(`${server.origin}/`, { waitUntil: 'load' });
    await Promise.race([page.waitForFunction(() => window.__kinetograph !== undefined, { timeout: 60_000 }), crashed]);
  } catch (error) {
    await close();
    if (error instanceof CliError) throw error;
    throw new CliError('CHROME_FAILED', `the project did not start in Chrome: ${error instanceof Error ? error.message : String(error)}`);
  }

  const declared = new Map<string, string>();
  /** Declares the fonts registered since the last frame, and waits for Chrome to load them. */
  const declareFonts = async (): Promise<void> => {
    const fresh = Object.entries(source.fonts?.() ?? {}).filter(([key, file]) => declared.get(key) !== file);
    if (fresh.length === 0) return;
    const faces = fresh.map(([key, file]) => fontFace(key, server.fontUrl(file)));
    for (const [key, file] of fresh) declared.set(key, file);
    await page.evaluate(
      async (css: string, loads: string[], registry: Record<string, string>) => {
        const sheet = document.getElementById('kg-fonts')!;
        sheet.textContent += `${css}\n`;
        (window as unknown as { __kinetographRegisterFonts(fonts: Record<string, string>): void }).__kinetographRegisterFonts(registry);
        await Promise.all(loads.map((spec) => document.fonts.load(spec)));
      },
      faces.map((f) => f.css).join('\n'),
      faces.map((f) => f.load),
      Object.fromEntries(fresh),
    );
  };

  // Frames are drawn one at a time: there is one page.
  let queue: Promise<unknown> = Promise.resolve();
  const draw = async (frame: number): Promise<ChromeFrame> => {
    problems.length = 0;
    await declareFonts();
    let report: FrameReport;
    try {
      report = await page.evaluate((n: number) => window.__kinetograph!.setFrame(n), frame);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CliError('CHROME_FRAME_FAILED', `Chrome could not draw frame ${frame}: ${detail}${problems.length ? `\n${problems.join('\n')}` : ''}`);
    }
    for (const warning of report.warnings) progress(`warning: ${warning}`);
    const png = await page.screenshot({
      type: 'png',
      omitBackground: report.transparent,
      captureBeyondViewport: false,
      optimizeForSpeed: true,
    });
    const picture = decodePng(png);
    if (picture.width !== expected.width || picture.height !== expected.height) {
      throw new CliError(
        'CHROME_FRAME_FAILED',
        `Chrome drew frame ${frame} at ${picture.width}x${picture.height}, but the composition is ${expected.width}x${expected.height}`,
      );
    }
    return { width: picture.width, height: picture.height, data: Buffer.from(picture.data.buffer, picture.data.byteOffset, picture.data.byteLength) };
  };

  return {
    frame(frame) {
      const run = queue.then(() => draw(frame));
      queue = run.catch(() => undefined);
      return run;
    },
    close,
  };
}
