// `kinetograph fetch-deps <entry>`: downloads what a HyperFrames project loads from the web (CDN scripts, ES modules,
// pictures and Google Fonts) into the local caches and pins it in `kinetograph.lock.json`. `render`, `still`, `studio`
// and `doctor` do the same by themselves before frame 0 unless `--offline`; this is the explicit form (CI, a warm cache).

import { relative } from 'node:path';
import { CliError } from '../errors.js';
import { isHyperframesEntry, resolveEntry } from '../hyperframes/entry.js';
import { cdnCacheDir } from '../hyperframes/deps.js';
import { prefetchHyperframes } from '../hyperframes/prefetch.js';
import { ENTRY, type Command } from './types.js';

export const fetchDeps: Command = {
  name: 'fetch-deps',
  summary: 'Download the CDN scripts, remote pictures, media and Google Fonts a HyperFrames project loads, into the local cache',
  positionals: [ENTRY],
  options: [
    { name: 'allow-host', type: 'string', description: 'Also download from this host (comma-separated for several); by default only cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com and esm.sh' },
    { name: 'url', type: 'string', description: 'Also download this URL (comma-separated for several): a file the page fetches that the scan of its scripts did not find (`doctor` names the ones a render refused)' },
    { name: 'update', type: 'boolean', description: 'Download everything again and rewrite kinetograph.lock.json (the way to accept a file that changed upstream)' },
    { name: 'max-media-mb', type: 'string', description: 'The most megabytes of one remote video or audio file to download (default 500)' },
  ],
  project: false,
  async run(args, context) {
    const entry = resolveEntry(String(args.positionals.entry));
    if (!isHyperframesEntry(entry)) throw new CliError('INVALID_ARG', `${entry} is not an HTML file: fetch-deps is for HyperFrames projects`);
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
