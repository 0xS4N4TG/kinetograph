// The download step before frame 0: what a HyperFrames project loads from the web (CDN scripts, ES modules, data files,
// remote pictures and media, Google Fonts) goes into the local cache, pinned in `kinetograph.lock.json`. `fetch-deps`
// runs it by itself; `render`, `still`, `studio` and `doctor` run it first unless `--offline`. A frame is drawn after it
// from the cache alone.

import { makeGoogleFont } from '@kinetographdev/core/google-fonts';
import { lockPathOf } from '@kinetographdev/core/lock';
import { CliError } from '../errors.js';
import { cdnCacheDir, fetchCdnData, fetchCdnScripts, MAX_DATA_BYTES, useLockFile, type FetchedDep, type FetchOptions } from './deps.js';
import { MAX_IMAGE_BYTES } from './images.js';
import { fetchModuleGraph } from './modules.js';
import { buildPlan } from './plan.js';

export interface PrefetchOptions {
  /** Hosts besides the default CDNs (`--allow-host`). */
  allowHosts?: string[];
  /** Further URLs to download (`--url`). */
  extraUrls?: string[];
  /** The most megabytes of one remote video or audio file (default 500). */
  maxMediaMb?: number;
  /** Download again what is cached, and replace the lock (`fetch-deps --update`). */
  update?: boolean;
  /** Replaces the network (tests). */
  fetchImpl?: FetchOptions['fetchImpl'];
}

export interface PrefetchResult {
  cache: string;
  lockFile: string;
  files: FetchedDep[];
  fonts: { family: string; status: 'ready' | 'failed'; error?: string }[];
  /** How many files were downloaded just now. */
  fetched: number;
  /** One line: what the project loads from the web. */
  summary: string;
}

/** Everything the HyperFrames project at `entry` (an absolute path to its HTML) loads from the web, downloaded and locked. */
export async function prefetchHyperframes(entry: string, options: PrefetchOptions = {}): Promise<PrefetchResult> {
  const allowHosts = options.allowHosts ?? [];
  const lockFile = lockPathOf(entry);
  useLockFile(lockFile, options.update === true);
  const { plan, scriptUrls, scriptIntegrity, dataUrls, mediaUrls, imageUrls, modules, importMap } = await buildPlan(entry, { discoverOnly: true, allowHosts });
  const extra = options.extraUrls ?? [];
  const common: FetchOptions = { allowHosts, update: options.update === true, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) };
  const summary = `${scriptUrls.length} script URL(s), ${modules.length} module script(s), ${dataUrls.length + extra.length} data URL(s), ${mediaUrls.length} remote media file(s), ${imageUrls.length} remote picture(s), ${plan.googleFonts.length} Google font famil${plan.googleFonts.length === 1 ? 'y' : 'ies'}`;
  const maxMedia = options.maxMediaMb ?? 500;
  if (!Number.isFinite(maxMedia) || maxMedia <= 0) throw new CliError('INVALID_ARG', '--max-media-mb must be a positive number');

  const files = await fetchCdnScripts(scriptUrls, plan.baseDir, { ...common, integrity: scriptIntegrity });
  // Scripts, data, --url files, media and pictures are checked alike: the default CDNs plus --allow-host, never a host the page names.
  files.push(...(await fetchCdnData([...dataUrls, ...extra], { ...common, maxBytes: MAX_DATA_BYTES })));
  files.push(...(await fetchCdnData(mediaUrls, { ...common, maxBytes: Math.round(maxMedia * 1024 * 1024) })));
  files.push(...(await fetchCdnData(imageUrls, { ...common, maxBytes: MAX_IMAGE_BYTES })));
  if (modules.length > 0) files.push(...(await fetchModuleGraph(modules, importMap, { ...common, maxBytes: MAX_DATA_BYTES })));

  const fonts: PrefetchResult['fonts'] = [];
  for (const font of plan.googleFonts) {
    for (const style of ['normal', 'italic'] as const) {
      const weights = font.variants.filter((v) => v.endsWith('i') === (style === 'italic')).map((v) => v.replace(/i$/, ''));
      if (weights.length === 0) continue;
      try {
        await makeGoogleFont(font.family).loadFont(style, { weights }).waitUntilDone();
        fonts.push({ family: `${font.family} ${style}`, status: 'ready' });
      } catch (error) {
        fonts.push({ family: `${font.family} ${style}`, status: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { cache: cdnCacheDir(), lockFile, files, fonts, fetched: files.filter((f) => f.status === 'fetched').length, summary };
}

/**
 * The step `render`, `still`, `studio` and `doctor` run: `prefetchHyperframes`, with a failed download only said (the
 * render then reports the file that is missing as it always has), except a lock mismatch, which stops it.
 */
export async function autoPrefetchHyperframes(entry: string, progress: (message: string) => void): Promise<void> {
  const result = await prefetchHyperframes(entry);
  if (result.fetched > 0) progress(`downloaded ${result.fetched} file(s) into ${result.cache} (locked in ${result.lockFile})`);
  for (const f of result.files) {
    if (f.status !== 'failed') continue;
    if (f.code === 'LOCK_MISMATCH') throw new CliError('LOCK_MISMATCH', f.error ?? `${f.url} does not match the lock`);
    progress(`could not download ${f.url}: ${f.error}`);
  }
  for (const font of result.fonts) if (font.status === 'failed') progress(`could not download font ${font.family}: ${font.error}`);
}
