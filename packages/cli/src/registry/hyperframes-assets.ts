// What a HyperFrames item loads from the web when it runs (a Google Fonts stylesheet, a font file on a CDN, a JSON file it
// fetches), downloaded when the item is installed and stored in the project, with the item's references changed to the
// local copies. A render then reads only project files: it never needs the network, and a frame stays a function of the
// project. Only what is named here is ever fetched, over https, from the hosts and paths in `allowed`; anything else in
// an item is left as written, and the render's own warning for it stands.
//
//   Google Fonts   `<link href="https://fonts.googleapis.com/css2?…">` and `@import url(…)` become `@font-face` rules
//                  whose files are in `public/fonts/<family>/`, each family with its licence text beside it
//   font files     `url(https://cdn.jsdelivr.net/fontsource/fonts/…)` and `url(https://fonts.gstatic.com/s/…)` in CSS
//   data files     `https://cdn.jsdelivr.net/npm/<package>@<version>/<file>.json` in a script (`fetch(url)`), as
//                  `public/data/<package>-<version>/<file>.json`; `fetch` reads project files beside the entry or in `public/`
//
// Google serves a whole font file (a .ttf) to a client that does not say which browser it is, and these requests send no
// `User-Agent` of their own, so each face is one file. Nothing here reads the clock.

import { posix } from 'node:path';
import postcss from 'postcss';
import { CliError } from '../errors.js';
import { download } from './source.js';

const GOOGLE_CSS_HOST = 'fonts.googleapis.com';
const HOSTS = [GOOGLE_CSS_HOST, 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'raw.githubusercontent.com'] as const;
/** The hosts the localisation reads, for the messages and the docs. */
export const HYPERFRAMES_ASSET_HOSTS: readonly string[] = HOSTS;

const MAX_CSS_BYTES = 1024 * 1024;
const MAX_FONT_BYTES = 25 * 1024 * 1024;
const MAX_DATA_BYTES = 20 * 1024 * 1024;
const MAX_LICENCE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const MAX_FACES = 64;
const FONT_FILE = /\.(woff2?|ttf|otf)$/i;
const DATA_FILE = /\.(json|geojson|topojson)$/i;

type Kind = 'css' | 'font' | 'data' | 'licence';

/** Whether the download of a `kind` may read `url`: https, no credentials or port, and a host and path made for that kind. */
function allowed(kind: Kind, url: URL): boolean {
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return false;
  const { hostname: host, pathname: path } = url;
  switch (kind) {
    case 'css':
      return host === GOOGLE_CSS_HOST && (path === '/css' || path === '/css2');
    case 'font':
      return FONT_FILE.test(path) && ((host === 'fonts.gstatic.com' && path.startsWith('/s/')) || (host === 'cdn.jsdelivr.net' && path.startsWith('/fontsource/fonts/')));
    case 'data':
      return host === 'cdn.jsdelivr.net' && path.startsWith('/npm/') && DATA_FILE.test(path);
    case 'licence':
      return host === 'raw.githubusercontent.com' && path.startsWith('/google/fonts/main/');
  }
}

/** A file to write into the project beside the item's own files. */
export interface LocalAsset {
  target: string;
  data: Uint8Array;
  /** A font file: one already in the project is kept as it is, not compared (Google can serve a newer build under the same name). */
  keep: boolean;
}

export interface LocalFont {
  family: string;
  /** An SPDX id, or `unknown` when the licence text could not be found. */
  licence: string;
  files: string[];
}

export interface LocalizerOptions {
  fetch?: typeof fetch;
  progress?: (message: string) => void;
}

export type LocalFileKind = 'html' | 'css' | 'js';

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'font';
const safe = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '').replace(/\.+$/, '') || 'file';

const LICENCES = [
  { dir: 'ofl', file: 'OFL.txt', spdx: 'OFL-1.1', name: 'OFL.txt' },
  { dir: 'apache', file: 'LICENSE.txt', spdx: 'Apache-2.0', name: 'LICENSE.txt' },
  { dir: 'ufl', file: 'UFL.txt', spdx: 'UFL-1.0', name: 'LICENSE-UFL.txt' },
] as const;

/** One install's downloads: each URL is read once, in total no more than `MAX_TOTAL_BYTES`, and the files wait here to be written. */
export class Localizer {
  readonly assets = new Map<string, LocalAsset>();
  readonly fonts = new Map<string, LocalFont>();
  readonly warnings: string[] = [];
  private readonly fetchImpl: typeof fetch;
  private readonly progress: (message: string) => void;
  private readonly reads = new Map<string, Promise<Uint8Array>>();
  private total = 0;

  constructor(options: LocalizerOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.progress = options.progress ?? (() => undefined);
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  private read(kind: Kind, url: URL, limit: number, notFound?: string): Promise<Uint8Array> {
    const key = `${kind} ${url.href}`;
    let pending = this.reads.get(key);
    if (pending === undefined) {
      this.progress(`downloading ${url.href}`);
      pending = download(url, limit, this.fetchImpl, notFound, HOSTS, (u) => allowed(kind, u)).then((bytes) => {
        this.total += bytes.length;
        if (this.total > MAX_TOTAL_BYTES) throw new CliError('TOO_LARGE', `the fonts and data an item loads are larger than ${MAX_TOTAL_BYTES / 1024 / 1024} MB together`);
        return bytes;
      });
      this.reads.set(key, pending);
    }
    return pending;
  }

  private add(target: string, data: Uint8Array, keep: boolean): string {
    if (!this.assets.has(target)) this.assets.set(target, { target, data, keep });
    return target;
  }

  /** The licence text of a Google Fonts family, stored beside its files; `unknown` (with a warning) when it cannot be found. */
  private async licenceOf(family: string, dir: string): Promise<string> {
    const folder = family.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const licence of LICENCES) {
      try {
        const url = new URL(`https://raw.githubusercontent.com/google/fonts/main/${licence.dir}/${folder}/${licence.file}`);
        const bytes = await this.read('licence', url, MAX_LICENCE_BYTES, `no ${licence.dir} licence for ${family}`);
        this.add(`${dir}/${licence.name}`, bytes, true);
        return licence.spdx;
      } catch (error) {
        if (error instanceof CliError && error.code === 'NOT_FOUND') continue;
        this.warn(`the licence of the font ${family} could not be downloaded: ${error instanceof Error ? error.message : String(error)}`);
        return 'unknown';
      }
    }
    this.warn(`the font ${family} has no licence text in the Google Fonts repository; check its licence before sharing the project`);
    return 'unknown';
  }

  private async noteFont(family: string, dir: string, file: string): Promise<void> {
    let font = this.fonts.get(family);
    if (font === undefined) {
      // Recorded before the licence is fetched, so a second face of the family met meanwhile adds to this record.
      font = { family, licence: 'unknown', files: [] };
      this.fonts.set(family, font);
      font.files.push(file);
      font.licence = await this.licenceOf(family, dir);
      return;
    }
    if (!font.files.includes(file)) font.files.push(file);
  }

  /**
   * The `@font-face` rules for a Google Fonts stylesheet URL, each with its file stored in the project, the file's path
   * written relative to `fromDir`; null (with a warning) when the stylesheet or a file could not be had.
   */
  async googleFonts(href: string, fromDir: string): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(href.replace(/&amp;/g, '&'), 'https://fonts.googleapis.com');
    } catch {
      return null;
    }
    if (!allowed('css', url)) return null;
    try {
      const css = Buffer.from(await this.read('css', url, MAX_CSS_BYTES, `${url.href} was not found`)).toString('utf8');
      const rules: string[] = [];
      let faces = 0;
      const used = new Map<string, string>();
      for (const node of postcss.parse(css).nodes) {
        if (node.type !== 'atrule' || node.name.toLowerCase() !== 'font-face') continue;
        if (++faces > MAX_FACES) throw new CliError('TOO_LARGE', `${url.href} asks for more than ${MAX_FACES} font faces`);
        const decl = (prop: string): string | undefined => {
          let value: string | undefined;
          node.walkDecls((d) => {
            if (d.prop.toLowerCase() === prop) value = d.value;
          });
          return value;
        };
        const family = (decl('font-family') ?? '').replace(/^['"]|['"]$/g, '').trim();
        const src = decl('src') ?? '';
        const remote = /url\(\s*(['"]?)([^'")]+)\1\s*\)/.exec(src)?.[2];
        if (family === '' || remote === undefined) continue;
        const fileUrl = new URL(remote, url);
        if (!allowed('font', fileUrl)) throw new CliError('UNSAFE_URL', `${url.href}: a font file at ${fileUrl.href} is not on an allowed host`);
        const style = (decl('font-style') ?? 'normal').trim().split(/\s+/)[0]!;
        const weight = (decl('font-weight') ?? '400').trim();
        const dir = `public/fonts/${slug(family)}`;
        const ext = posix.extname(fileUrl.pathname).toLowerCase();
        let name = `${slug(family)}-${safe(weight.replace(/\s+/g, '-'))}-${safe(style)}`;
        // Two faces of the same weight and style (unicode-range subsets) get a number each.
        const seen = used.get(`${dir}/${name}`);
        if (seen !== undefined && seen !== fileUrl.href) name += `-${[...used.keys()].filter((k) => k.startsWith(`${dir}/${name}`)).length}`;
        used.set(`${dir}/${name}`, fileUrl.href);
        const target = `${dir}/${name}${ext}`;
        this.add(target, await this.read('font', fileUrl, MAX_FONT_BYTES, `${fileUrl.href} was not found`), true);
        await this.noteFont(family, dir, target);
        const display = decl('font-display');
        const format = /format\(\s*(['"]?)([^'")]+)\1\s*\)/.exec(src)?.[2];
        rules.push(
          [
            '@font-face {',
            `  font-family: ${JSON.stringify(family)};`,
            `  font-style: ${style};`,
            `  font-weight: ${weight};`,
            ...(display !== undefined ? [`  font-display: ${display.trim()};`] : []),
            `  src: url(${JSON.stringify(posix.relative(fromDir, target))})${format !== undefined ? ` format(${JSON.stringify(format)})` : ''};`,
            '}',
          ].join('\n'),
        );
      }
      return rules.length === 0 ? null : rules.join('\n');
    } catch (error) {
      this.warn(`${url.href} was not stored in the project: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** A font file named by a URL in CSS, stored as `public/fonts/<family>/<file>`; its path relative to `fromDir`, or null. */
  async fontFile(href: string, fromDir: string): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (!allowed('font', url)) return null;
    try {
      const parts = url.pathname.split('/');
      const file = safe(decodeURIComponent(parts.at(-1)!));
      // fontsource: /fontsource/fonts/<family>@<version>/<file>; Google: /s/<family>/<version>/<file>
      const family = url.hostname === 'cdn.jsdelivr.net' ? (parts[3] ?? '').replace(/@.*$/, '') : (parts[2] ?? '');
      const dir = `public/fonts/${slug(family)}`;
      const target = `${dir}/${file}`;
      this.add(target, await this.read('font', url, MAX_FONT_BYTES, `${url.href} was not found`), true);
      await this.noteFont(family === '' ? 'font' : family, dir, target);
      return posix.relative(fromDir, target);
    } catch (error) {
      this.warn(`${url.href} was not stored in the project: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** A data file a script fetches, stored as `public/data/<package>-<version>/<file>`; the path `fetch` reads it by, or null. */
  async dataFile(href: string): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (!allowed('data', url)) return null;
    try {
      // /npm/<package>@<version>/<path>, the package possibly scoped.
      const m = /^\/npm\/((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?\/(.+)$/.exec(decodeURIComponent(url.pathname));
      if (m === null) return null;
      const target = `public/data/${safe(`${m[1]!.replace('/', '-')}-${m[2] ?? 'latest'}`)}/${m[3]!.split('/').map(safe).join('-')}`;
      this.add(target, await this.read('data', url, MAX_DATA_BYTES, `${url.href} was not found`), false);
      return target;
    } catch (error) {
      this.warn(`${url.href} was not stored in the project: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * `text`, the contents of the file that installs at `target`, with its Google Fonts, font file and data file
   * references made local. The path of a font in CSS is written relative to the file; a data path as `fetch` reads it.
   */
  async localize(text: string, target: string, kind: LocalFileKind): Promise<string> {
    const dir = posix.dirname(target);
    let out = text;
    if (kind !== 'js') {
      if (kind === 'html') {
        out = await replaceAsync(out, /<link\b[^>]*>/gi, async (tag) => {
          const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
          const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
          if (rel === null || href === null || !/\bstylesheet\b/i.test(rel[1] ?? rel[2] ?? '')) return tag;
          const faces = await this.googleFonts(href[1] ?? href[2] ?? '', dir);
          return faces === null ? tag : `<style>\n/* Google Fonts, stored in the project by \`kinetograph add\` */\n${faces}\n</style>`;
        });
      }
      out = await replaceAsync(out, /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^)\s;'"]+))\s*\)?[^;]*;/gi, async (rule, a, b, c) => {
        const faces = await this.googleFonts((a ?? b ?? c ?? '') as string, dir);
        return faces ?? rule;
      });
      // Font files named in CSS: the whole of a stylesheet, or the `<style>` blocks of a page.
      const files = async (css: string): Promise<string> =>
        replaceAsync(css, /https:\/\/(?:cdn\.jsdelivr\.net\/fontsource\/fonts|fonts\.gstatic\.com\/s)\/[^\s"')]+/g, async (url) => (await this.fontFile(url, dir)) ?? url);
      out = kind === 'css' ? await files(out) : await replaceAsync(out, /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, async (_all, open: string, css: string, close: string) => `${open}${await files(css)}${close}`);
    }
    // Data files named in a script (or anywhere in a page outside its styles).
    if (kind !== 'css') {
      const data = async (code: string): Promise<string> =>
        replaceAsync(code, /https:\/\/cdn\.jsdelivr\.net\/npm\/[^\s"'`)]+\.(?:json|geojson|topojson)(?![\w.])/g, async (url) => (await this.dataFile(url)) ?? url);
      out = kind === 'js' ? await data(out) : (await Promise.all(out.split(/(<style\b[\s\S]*?<\/style>)/gi).map((part, i) => (i % 2 === 1 ? part : data(part))))).join('');
    }
    return out;
  }

  /** The families stored, with their licences and files. */
  get localFonts(): LocalFont[] {
    return [...this.fonts.values()];
  }
}

/** `String.replace` with a callback that waits (the matches are found first, then replaced in order). */
async function replaceAsync(text: string, pattern: RegExp, replace: (...args: any[]) => Promise<string>): Promise<string> {
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return text;
  const replacements = await Promise.all(matches.map((m) => replace(...(m as unknown as string[]))));
  let out = '';
  let at = 0;
  matches.forEach((m, i) => {
    out += text.slice(at, m.index) + replacements[i]!;
    at = m.index! + m[0].length;
  });
  return out + text.slice(at);
}
