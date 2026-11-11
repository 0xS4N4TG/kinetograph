// `kinetograph fetch-deps <entry>`: downloads what a HyperFrames project loads from the web (CDN scripts, ES modules,
// pictures and Google Fonts) into the local caches and pins it in `kinetograph.lock.json`. `render`, `still`, `studio`
// and `doctor` do the same by themselves before frame 0 unless `--offline`; this is the explicit form (CI, a warm cache).

import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { lockPathOf } from '@kinetographdev/core/lock';
import { prefetchRemoteAssets, prefetchStylesheetFonts } from '@kinetographdev/core/remote-assets';
import { bundleProject } from '../bundle.js';
import { isStylesheetUrl, scanRemoteUrls } from '../prefetch.js';
import { CliError } from '../errors.js';
import { isHyperframesEntry, resolveEntry } from '../hyperframes/entry.js';
import { recordNet } from '../net.js';
import { cdnCacheDir } from '../hyperframes/deps.js';
import { prefetchHyperframes } from '../hyperframes/prefetch.js';
import { ENTRY, type Command, type CommandResult } from './types.js';

/** A Remotion project: the remote pictures and videos its bundle names, into the asset cache and the lock. */
async function fetchRemotionAssets(entry: string, update: boolean): Promise<CommandResult> {
  if (!existsSync(entry)) throw new CliError('ENTRY_NOT_FOUND', `no such file: ${entry}`);
  const { file } = await bundleProject(entry);
  const lockFile = lockPathOf(entry);
  const urls = scanRemoteUrls(readFileSync(file, 'utf8'));
  const result = await prefetchRemoteAssets(urls, { lockFile, update });
  const fonts = await prefetchStylesheetFonts(urls.filter(isStylesheetUrl), { lockFile, update });
  const lines = [
    `lock: ${relative(process.cwd(), lockFile) || lockFile}`,
    ...result.fetched.map((u) => `  fetched   ${u}`),
    ...result.cached.map((u) => `  cached    ${u}`),
    ...result.failed.map((f) => `  failed    ${f.url}  (${f.error})`),
    ...(fonts.fetched > 0 ? [`  ${fonts.fetched} font file(s) of the imported stylesheets are in the font cache`] : []),
    ...fonts.failed.map((f) => `  failed    ${f.url}  (${f.error})`),
  ];
  return { data: { lock: lockFile, ...result, fonts }, text: lines.join('\n'), exitCode: result.failed.length + fonts.failed.length > 0 ? 1 : 0 };
}

export const fetchDeps: Command = {
  name: 'fetch-deps',
  summary: 'Download what a project loads from the web (CDN scripts, ES modules, remote pictures, media, Google Fonts) into the local cache and kinetograph.lock.json',
  positionals: [ENTRY],
  options: [
    { name: 'allow-host', type: 'string', description: 'Also download from this host (comma-separated for several); by default only cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com and esm.sh' },
    { name: 'url', type: 'string', description: 'Also download this URL (comma-separated for several): a file the page fetches that the scan of its scripts did not find (`doctor` names the ones a render refused)' },
    { name: 'update', type: 'boolean', description: 'Download everything again and rewrite kinetograph.lock.json (the way to accept a file that changed upstream)' },
    { name: 'record', type: 'boolean', description: 'Run every frame with the network open for the --allow-host hosts and keep each response the page fetched (tiles, styles, sprites built at run time) in .kinetograph/net; a render then answers from it, never from the network' },
    { name: 'secret-param', type: 'string', description: 'With --record: also remove this query parameter from the recorded keys (comma-separated; access_token, key, api_key, apikey and token always are)' },
    { name: 'max-media-mb', type: 'string', description: 'The most megabytes of one remote video or audio file to download (default 500)' },
  ],
  project: false,
  async run(args, context) {
    const entry = resolveEntry(String(args.positionals.entry));
    if (args.options.record === true) {
      const split = (value: unknown): string[] => String(value ?? '').split(',').map((h) => h.trim()).filter(Boolean);
      const allowHosts = split(args.options['allow-host']);
      if (allowHosts.length === 0) throw new CliError('USAGE', '--record needs --allow-host: the hosts the page may reach while it is recorded');
      const done = await recordNet(entry, { allowHosts, secretParams: split(args.options['secret-param']), progress: context.progress });
      return {
        data: done,
        text: `recorded ${done.entries} response(s) from ${done.hosts.join(', ') || 'no host'} over ${done.frames} frame(s) into ${relative(process.cwd(), done.dir) || done.dir}\nlock: ${relative(process.cwd(), lockPathOf(entry))}`,
        exitCode: 0,
      };
    }
    if (!isHyperframesEntry(entry)) return fetchRemotionAssets(entry, args.options.update === true);
    const split = (value: unknown): string[] => String(value ?? '').split(',').map((h) => h.trim()).filter(Boolean);
    const result = await prefetchHyperframes(entry, {
      allowHosts: split(args.options['allow-host']),
      extraUrls: split(args.options.url),
      maxMediaMb: Number(args.options['max-media-mb'] ?? 500),
      update: args.options.update === true,
    });
    context.progress(result.summary);
    const { files: scripts, fonts } = result;
    const failed = scripts.filter((s) => s.status === 'failed').length + fonts.filter((f) => f.status === 'failed').length;
    const lines = [
      `cache: ${cdnCacheDir()}`,
      `lock: ${relative(process.cwd(), result.lockFile) || result.lockFile}`,
      ...scripts.map((s) => `  ${s.status.padEnd(9)} ${s.url}${s.error ? `  (${s.error})` : ''}${s.status === 'installed' ? `  -> ${relative(process.cwd(), s.file)}` : ''}`),
      ...fonts.map((f) => `  ${f.status.padEnd(9)} font ${f.family}${f.error ? `  (${f.error})` : ''}`),
    ];
    return { data: { cache: cdnCacheDir(), lock: result.lockFile, scripts, fonts }, text: lines.join('\n'), exitCode: failed > 0 ? 1 : 0 };
  },
};
