// The download step before frame 0: what a HyperFrames project loads from the web (CDN scripts, ES modules, data files,
// remote pictures and media, Google Fonts) goes into the local cache, pinned in `kinetograph.lock.json`. `fetch-deps`
// runs it by itself; `render`, `still`, `studio` and `doctor` run it first unless `--offline`. A frame is drawn after it
// from the cache alone.

import { whenFetchesSettle } from '@kinetographdev/compat/shim';
import { makeGoogleFont } from '@kinetographdev/core/google-fonts';
import { lockPathOf } from '@kinetographdev/core/lock';
import { CliError } from '../errors.js';
import { cdnCacheDir, fetchCdnData, fetchCdnScripts, MAX_DATA_BYTES, useLockFile, type FetchedDep, type FetchOptions } from './deps.js';
import { discovered, installDynamicImport, installRemotePictures, setDiscovery } from './dynamic.js';
import { setBeforePlan } from './entry.js';
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
  /** The files the project is made of (HTML, local modules): a change to one can mean a new download. */
  inputs: string[];
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
  const { plan, files: planFiles, scriptUrls, scriptIntegrity, dataUrls, mediaUrls, imageUrls, modules, importMap, runtimePictures } = await buildPlan(entry, { discoverOnly: true, allowHosts });
  const extra = options.extraUrls ?? [];
  const common: FetchOptions = { allowHosts, update: options.update === true, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) };
  const summary = `${scriptUrls.length} script URL(s), ${modules.length} module script(s), ${dataUrls.length + extra.length} data URL(s), ${mediaUrls.length} remote media file(s), ${imageUrls.length} remote picture(s), ${plan.googleFonts.length} Google font famil${plan.googleFonts.length === 1 ? 'y' : 'ies'}`;
  const maxMedia = options.maxMediaMb ?? 500;
  if (!Number.isFinite(maxMedia) || maxMedia <= 0) throw new CliError('INVALID_ARG', '--max-media-mb must be a positive number');

  const files = await fetchCdnScripts(scriptUrls, plan.baseDir, { ...common, integrity: scriptIntegrity });
  // Scripts, data, --url files, media and pictures are checked alike: the default CDNs plus --allow-host, never a host the page names.
  files.push(...(await fetchCdnData([...dataUrls, ...extra], { ...common, maxBytes: MAX_DATA_BYTES })));
  files.push(...(await fetchCdnData(mediaUrls, { ...common, maxBytes: Math.round(maxMedia * 1024 * 1024) })));
  // A picture a script names on an allowed host is a data URL too (`fetch` can read it), with the same size limit: it is downloaded once.
  const data = new Set(dataUrls);
  files.push(...(await fetchCdnData(imageUrls.filter((u) => !data.has(u)), { ...common, maxBytes: MAX_IMAGE_BYTES })));
  const moduleInfo = { inputs: new Set<string>(), computed: false };
  if (modules.length > 0) files.push(...(await fetchModuleGraph(modules, importMap, { ...common, maxBytes: MAX_DATA_BYTES }, moduleInfo)));
  // An `import()` of a specifier built at run time, and a picture a script sets from a URL it builds, are found by running the page.
  if (moduleInfo.computed || runtimePictures) files.push(...(await discoverAtRunTime(entry, common)));

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
  return { cache: cdnCacheDir(), lockFile, files, inputs: [...new Set([entry, ...planFiles, ...moduleInfo.inputs])], fonts, fetched: files.filter((f) => f.status === 'fetched').length, summary };
}

/** Frame 0, the last frame and up to six between: a specifier that depends on the frame is found if it shows in one of them. */
function sampleFrames(total: number): number[] {
  const count = Math.min(total, 8);
  const frames = new Set<number>([0]);
  for (let i = 1; i < count; i++) frames.add(Math.round((i * (total - 1)) / (count - 1)));
  return [...frames];
}

/**
 * Runs the page's JS for a sample of its frames, with a hook on `import()` of a computed specifier (`dynamic.ts`) that
 * resolves each through the import map, downloads it and locks it. A render then finds the modules in the cache. A
 * specifier that only shows in a frame not sampled is downloaded when a render first asks for it, and said so. The
 * remote pictures the page's scripts set on those frames (`img.src = base + name`) are kept and downloaded after, under
 * the rules of the markup's pictures; one that only shows in a frame not sampled is reported by the render.
 */
async function discoverAtRunTime(entry: string, common: FetchOptions): Promise<FetchedDep[]> {
  const options: FetchOptions = { ...common, maxBytes: MAX_DATA_BYTES };
  const { openSource } = await import('../source.js');
  // The bundle the pass builds must not start another download step.
  const saved = setBeforePlan(null);
  setDiscovery(options);
  try {
    installDynamicImport();
    installRemotePictures();
    const source = await openSource(entry, { prefetch: false });
    try {
      for (const frame of sampleFrames(source.composition.durationInFrames)) {
        await source.frame(frame);
        await whenFetchesSettle();
      }
    } finally {
      source.dispose();
    }
  } catch (error) {
    return [{ url: entry, file: '', status: 'failed', error: `running the page to find its computed import() calls and pictures failed: ${error instanceof Error ? error.message : String(error)}` }];
  } finally {
    setDiscovery(null);
    setBeforePlan(saved);
  }
  const seen = new Set<string>();
  const results: FetchedDep[] = [];
  for (const f of discovered.fetched) if (f.status !== 'failed' && !seen.has(f.url)) (seen.add(f.url), results.push(f));
  for (const f of discovered.failed) {
    results.push({ url: f.specifier, file: '', status: 'failed', error: `import(${JSON.stringify(f.specifier)}) from ${f.referrer}: ${f.error}`, ...(f.code ? { code: f.code } : {}) });
  }
  const pictures = [...discovered.pictures].filter((url) => /^https:/i.test(url));
  if (pictures.length > 0) results.push(...(await fetchCdnData(pictures, { ...common, maxBytes: MAX_IMAGE_BYTES })));
  return results;
}

/**
 * The step `render`, `still`, `studio` and `doctor` run: `prefetchHyperframes`, with a failed download only said (the
 * render then reports the file that is missing as it always has), except a lock mismatch, which stops it. Resolves to the
 * files the project is made of.
 */
export async function autoPrefetchHyperframes(entry: string, progress: (message: string) => void, options: PrefetchOptions = {}): Promise<string[]> {
  const result = await prefetchHyperframes(entry, options);
  if (result.fetched > 0) progress(`downloaded ${result.fetched} file(s) into ${result.cache} (locked in ${result.lockFile})`);
  for (const f of result.files) {
    if (f.status !== 'failed') continue;
    if (f.code === 'LOCK_MISMATCH') throw new CliError('LOCK_MISMATCH', f.error ?? `${f.url} does not match the lock`);
    progress(`could not download ${f.url}: ${f.error}`);
  }
  for (const font of result.fonts) if (font.status === 'failed') progress(`could not download font ${font.family}: ${font.error}`);
  return result.inputs;
}
