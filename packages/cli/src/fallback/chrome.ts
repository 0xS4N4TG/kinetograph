// Finding, installing and starting Chrome for the fallback (docs/COMPAT.md §6.2).

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'puppeteer-core';
import { CliError } from '../errors.js';

/**
 * The Chrome for Testing build the fallback is pinned to: the one `puppeteer-core` 25.12.0 is released with, so the
 * protocol matches. Pixels differ between Chrome versions (text, filters), so changing it is a decision, not routine.
 */
export const CHROME_VERSION = '154.0.8037.57';

/** Where the pinned Chrome is installed. */
export function chromeCacheDir(): string {
  return join(homedir(), '.cache', 'kinetograph', 'chrome');
}

export interface ChromeLocation {
  /** `KINETOGRAPH_CHROME`, an `executablePath` option, or the pinned build. */
  executablePath: string;
  source: 'option' | 'environment' | 'installed' | 'downloaded';
}

export interface FindChromeOptions {
  executablePath?: string;
  progress?: (message: string) => void;
  /** For tests: the environment to read `KINETOGRAPH_CHROME` from. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The Chrome to run: the `executablePath` option, else `KINETOGRAPH_CHROME`, else the pinned Chrome for Testing in
 * `~/.cache/kinetograph/chrome`, downloaded on first use with `@puppeteer/browsers`.
 */
export async function findChrome(options: FindChromeOptions = {}): Promise<ChromeLocation> {
  const env = options.env ?? process.env;
  const given = options.executablePath
    ? { path: options.executablePath, source: 'option' as const, name: 'the executablePath option' }
    : env.KINETOGRAPH_CHROME
      ? { path: env.KINETOGRAPH_CHROME, source: 'environment' as const, name: 'KINETOGRAPH_CHROME' }
      : null;
  if (given) {
    if (!existsSync(given.path)) {
      throw new CliError('CHROME_UNAVAILABLE', `${given.name} is ${given.path}, which does not exist`);
    }
    return { executablePath: given.path, source: given.source };
  }

  const { Browser: BrowserKind, computeExecutablePath, install } = await import('@puppeteer/browsers');
  const cacheDir = chromeCacheDir();
  const installed = computeExecutablePath({ browser: BrowserKind.CHROME, buildId: CHROME_VERSION, cacheDir });
  if (existsSync(installed)) return { executablePath: installed, source: 'installed' };

  options.progress?.(`downloading Chrome for Testing ${CHROME_VERSION} into ${cacheDir} (once)`);
  try {
    let lastShown = -1;
    const result = await install({
      browser: BrowserKind.CHROME,
      buildId: CHROME_VERSION,
      cacheDir,
      downloadProgressCallback: (downloaded: number, total: number) => {
        const percent = total > 0 ? Math.floor((downloaded / total) * 10) * 10 : 0;
        if (percent !== lastShown) {
          lastShown = percent;
          options.progress?.(`downloading Chrome: ${percent}%`);
        }
      },
    });
    return { executablePath: result.executablePath, source: 'downloaded' };
  } catch (error) {
    throw new CliError(
      'CHROME_UNAVAILABLE',
      `cannot install Chrome for Testing ${CHROME_VERSION}: ${error instanceof Error ? error.message : String(error)}. ` +
        'Set KINETOGRAPH_CHROME to the path of a Chrome or Chromium executable to use one you have.',
    );
  }
}

/** The command-line flags Chrome runs with: headless, no GPU, sRGB, and nothing that varies with the machine. */
export function chromeArgs(options: { root?: boolean } = {}): string[] {
  const root = options.root ?? (typeof process.getuid === 'function' && process.getuid() === 0);
  return [
    // Pixels must not depend on the GPU: composite on the CPU.
    '--disable-gpu',
    // Never touch the macOS keychain ("Chromium Safe Storage"): nothing here stores passwords or cookies.
    '--use-mock-keychain',
    '--password-store=basic',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--font-render-hinting=none',
    '--disable-lcd-text',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    // A page that is not being looked at must still run its work at full speed.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-dev-shm-usage',
    // Chrome refuses to start as root with its sandbox on (a container's user usually is).
    ...(root ? ['--no-sandbox'] : []),
  ];
}

export interface LaunchOptions {
  executablePath: string;
  args?: string[];
}

/** Starts Chrome headless. */
export async function launchChrome(options: LaunchOptions): Promise<Browser> {
  const { default: puppeteer } = await import('puppeteer-core');
  try {
    return await puppeteer.launch({
      executablePath: options.executablePath,
      headless: true,
      args: options.args ?? chromeArgs(),
      defaultViewport: null,
    });
  } catch (error) {
    throw new CliError(
      'CHROME_FAILED',
      `cannot start Chrome (${options.executablePath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
