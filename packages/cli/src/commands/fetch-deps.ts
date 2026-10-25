// `kinetograph fetch-deps <entry>`: downloads what a HyperFrames project loads from the web (CDN scripts and Google
// Fonts) into the local caches, so that `render` never has to. The only command that fetches a script.

import { relative } from 'node:path';
import { makeGoogleFont } from '@kinetographdev/core/google-fonts';
import { CliError } from '../errors.js';
import { isHyperframesEntry, resolveEntry } from '../hyperframes/entry.js';
import { cdnCacheDir, fetchCdnData, fetchCdnScripts, MAX_DATA_BYTES } from '../hyperframes/deps.js';
import { buildPlan } from '../hyperframes/plan.js';
import { ENTRY, type Command } from './types.js';

export const fetchDeps: Command = {
  name: 'fetch-deps',
  summary: 'Download the CDN scripts and Google Fonts a HyperFrames project loads, into the local cache',
  positionals: [ENTRY],
  options: [
    { name: 'allow-host', type: 'string', description: 'Also download from this host (comma-separated for several); by default only cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com and esm.sh' },
    { name: 'url', type: 'string', description: 'Also download this URL (comma-separated for several): a file the page fetches that the scan of its scripts did not find (`doctor` names the ones a render refused)' },
    { name: 'max-media-mb', type: 'string', description: 'The most megabytes of one remote video or audio file to download (default 500)' },
  ],
  project: false,
  async run(args, context) {
    const entry = resolveEntry(String(args.positionals.entry));
    if (!isHyperframesEntry(entry)) throw new CliError('INVALID_ARG', `${entry} is not an HTML file: fetch-deps is for HyperFrames projects`);
    const allowHosts = String(args.options['allow-host'] ?? '').split(',').map((h) => h.trim()).filter(Boolean);
    const { plan, scriptUrls, scriptIntegrity, dataUrls, mediaUrls } = await buildPlan(entry, { discoverOnly: true, allowHosts });
    const extra = String(args.options.url ?? '').split(',').map((u) => u.trim()).filter(Boolean);
    context.progress(
      `${scriptUrls.length} script URL(s), ${dataUrls.length + extra.length} data URL(s), ${mediaUrls.length} remote media file(s), ${plan.googleFonts.length} Google font famil${plan.googleFonts.length === 1 ? 'y' : 'ies'}`,
    );
    const scripts = await fetchCdnScripts(scriptUrls, plan.baseDir, { integrity: scriptIntegrity, allowHosts });
    const hostOf = (u: string): string[] => {
      try {
        return [new URL(u).hostname];
      } catch {
        return [];
      }
    };
    const maxMedia = Number(args.options['max-media-mb'] ?? 500);
    if (!Number.isFinite(maxMedia) || maxMedia <= 0) throw new CliError('INVALID_ARG', '--max-media-mb must be a positive number');
    // A URL named with --url, and the file of a media element of the page, are the author's own choice of host.
    const data = await fetchCdnData([...dataUrls, ...extra], { allowHosts: [...allowHosts, ...extra.flatMap(hostOf)], maxBytes: MAX_DATA_BYTES });
    const media = await fetchCdnData(mediaUrls, { allowHosts: [...allowHosts, ...mediaUrls.flatMap(hostOf)], maxBytes: Math.round(maxMedia * 1024 * 1024) });
    scripts.push(...data, ...media);
    const fonts: { family: string; status: 'ready' | 'failed'; error?: string }[] = [];
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
    const failed = scripts.filter((s) => s.status === 'failed').length + fonts.filter((f) => f.status === 'failed').length;
    const lines = [
      `cache: ${cdnCacheDir()}`,
      ...scripts.map((s) => `  ${s.status.padEnd(9)} ${s.url}${s.error ? `  (${s.error})` : ''}${s.status === 'installed' ? `  -> ${relative(process.cwd(), s.file)}` : ''}`),
      ...fonts.map((f) => `  ${f.status.padEnd(9)} font ${f.family}${f.error ? `  (${f.error})` : ''}`),
    ];
    return { data: { cache: cdnCacheDir(), scripts, fonts }, text: lines.join('\n'), exitCode: failed > 0 ? 1 : 0 };
  },
};
