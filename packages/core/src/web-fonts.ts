// `makeWebFont(cssUrl)`: the fonts of any `@font-face` stylesheet URL (Fontshare, Bunny Fonts, a font host's own
// CSS), loaded the way `makeGoogleFont` loads Google's. The stylesheet is asked for on every load that has no cached
// copy and lists the current file links, so a font whose files move (a new release, a new hash in the link) is
// still found. A project's own `fetch` is blocked during a render (ENGINE.md §10), so the download goes through
// the font downloader like the others: each file once into `~/.cache/kinetograph/fonts`, read from there after.

import { registerFont, trackFontLoad } from './font-registry.js';
import {
  fetchFileCached,
  fetchFileCachedSync,
  fetchTextCached,
  fetchTextCachedSync,
  FontDownloadError,
  type FontDownloadOptions,
} from './font-files.js';

export type WebFontStyle = 'normal' | 'italic';

export interface WebFontLoadOptions {
  /** Weights to load, as strings (`'400'`, `'700'`). Default: every weight the stylesheet lists. */
  weights?: string[];
}

export interface WebFontLoadResult {
  fontFamily: string;
  /** Resolves when every file is downloaded and registered. */
  waitUntilDone: () => Promise<void>;
}

export interface WebFontModule {
  /** The `font-family` the stylesheet declares. Reads the stylesheet the first time (blocking, cached after). */
  readonly fontFamily: string;
  loadFont: (style?: WebFontStyle, options?: WebFontLoadOptions) => WebFontLoadResult;
}

interface Source {
  url: string;
  format?: string;
}

interface WebFace {
  family: string;
  style: WebFontStyle;
  weight: string;
  sources: Source[];
}

/** The `@font-face` blocks of a stylesheet, links resolved against `baseUrl` (`//cdn.x/f.ttf` takes its scheme from it). */
export function parseWebFontFaces(css: string, baseUrl: string): WebFace[] {
  const faces: WebFace[] = [];
  for (const [, block] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const family = /font-family:\s*(?:'([^']*)'|"([^"]*)"|([^;]+))/.exec(block!);
    const name = (family?.[1] ?? family?.[2] ?? family?.[3])?.trim();
    const weightWord = /font-weight:\s*(\w+)/.exec(block!)?.[1];
    const weight = weightWord === 'normal' ? '400' : weightWord === 'bold' ? '700' : weightWord;
    const style = /font-style:\s*(\w+)/.exec(block!)?.[1];
    const src = /(?:^|[;\s])src:\s*([^;]*)/.exec(block!)?.[1] ?? '';
    const sources: Source[] = [];
    for (const m of src.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)(?:\s*format\(\s*['"]?([^)'"]+)['"]?\s*\))?/g)) {
      let url: string;
      try {
        url = new URL(m[1]!, baseUrl).href;
      } catch {
        continue;
      }
      if (!/^https?:/.test(url)) continue;
      sources.push({ url, ...(m[2] ? { format: m[2].toLowerCase() } : {}) });
    }
    // The first number of a weight range (`300 700`) is the one the face is registered at, as `loadFont` does.
    if (name && weight && /^\d+$/.test(weight) && sources.length > 0) {
      faces.push({ family: name, style: style === 'italic' ? 'italic' : 'normal', weight, sources });
    }
  }
  return faces;
}

const isPlainFont = (source: Source): boolean =>
  source.format !== undefined
    ? ['truetype', 'opentype', 'ttf', 'otf'].includes(source.format)
    : /\.(ttf|otf)(?:[?#]|$)/i.test(source.url);

/** The file to download for a face: TrueType or OpenType when it lists one, else the first. */
function fileUrl(face: WebFace): string {
  return (face.sources.find(isPlainFont) ?? face.sources[0]!).url;
}

/** The faces a load asked for (one per weight and style, the first block winning), in the order of the stylesheet. */
function select(faces: WebFace[], style: WebFontStyle, weights: readonly string[] | undefined): WebFace[] {
  const seen = new Set<string>();
  return faces.filter((face) => {
    if (face.style !== style || (weights !== undefined && !weights.includes(face.weight))) return false;
    if (seen.has(face.weight)) return false;
    seen.add(face.weight);
    return true;
  });
}

const sameFace = (a: WebFace) => (b: WebFace) => a.weight === b.weight && a.style === b.style;
const isGone = (error: unknown): boolean => error instanceof FontDownloadError && error.status === 404;

/**
 * The module for the stylesheet at `cssUrl`. `loadFont(style, { weights })` downloads the files of the faces that
 * match (every weight of the style by default) and registers each under the stylesheet's family with its weight and
 * style. If a file is gone (HTTP 404), the stylesheet is downloaded again past the cache, and the file is looked up
 * in its new answer; files already cached are used as they are.
 */
export function makeWebFont(cssUrl: string, options: FontDownloadOptions = {}): WebFontModule {
  const loaded = new Map<string, Promise<void>>();
  let family: string | undefined;

  const stylesheetSync = (refresh = false): WebFace[] => {
    const faces = parseWebFontFaces(fetchTextCachedSync(cssUrl, options, undefined, refresh), cssUrl);
    if (faces.length === 0) throw new Error(`${cssUrl} has no @font-face blocks`);
    return faces;
  };
  const stylesheet = async (refresh = false): Promise<WebFace[]> => {
    const faces = parseWebFontFaces(await fetchTextCached(cssUrl, options, undefined, refresh), cssUrl);
    if (faces.length === 0) throw new Error(`${cssUrl} has no @font-face blocks`);
    return faces;
  };
  const familyOf = (): string => (family ??= stylesheetSync()[0]!.family);

  const wanted = (faces: WebFace[], style: WebFontStyle, weights: readonly string[] | undefined): WebFace[] => {
    const chosen = select(faces, style, weights);
    if (chosen.length === 0) {
      throw new Error(
        `${cssUrl} has no ${style} face${weights ? ` of weight ${weights.join(', ')}` : ''} (it lists ${
          faces.map((f) => `${f.weight} ${f.style}`).join(', ') || 'none'
        })`,
      );
    }
    return chosen;
  };

  const loadFont = (style: WebFontStyle = 'normal', loadOptions: WebFontLoadOptions = {}): WebFontLoadResult => {
    const weights = loadOptions.weights?.map(String);
    const name = familyOf();
    const key = `${style}:${weights?.join(',') ?? '*'}`;
    let done = loaded.get(key);
    if (!done) {
      const register = (face: WebFace, path: string) =>
        registerFont({ family: face.family, path, weight: Number(face.weight), style: face.style });
      done = trackFontLoad(
        (async () => {
          let current = await stylesheet();
          let refreshed = false;
          for (const face of wanted(current, style, weights)) {
            let path: string;
            try {
              path = await fetchFileCached(fileUrl(face), options);
            } catch (error) {
              if (!isGone(error)) throw error;
              // The link is stale: ask for the stylesheet again (once), and take the file from its answer.
              if (!refreshed) {
                refreshed = true;
                current = await stylesheet(true);
              }
              const fresh = current.find(sameFace(face));
              if (!fresh || fileUrl(fresh) === fileUrl(face)) throw error;
              path = await fetchFileCached(fileUrl(fresh), options);
            }
            register(face, path);
          }
        })(),
        // `measureText` at module load cannot wait for the downloads above, so it does the same with the thread blocked.
        () => {
          let current = stylesheetSync();
          let refreshed = false;
          for (const face of wanted(current, style, weights)) {
            let path: string;
            try {
              path = fetchFileCachedSync(fileUrl(face), options);
            } catch (error) {
              if (!isGone(error)) throw error;
              if (!refreshed) {
                refreshed = true;
                current = stylesheetSync(true);
              }
              const fresh = current.find(sameFace(face));
              if (!fresh || fileUrl(fresh) === fileUrl(face)) throw error;
              path = fetchFileCachedSync(fileUrl(fresh), options);
            }
            register(face, path);
          }
        },
      );
      loaded.set(key, done);
    }
    return { fontFamily: name, waitUntilDone: () => done };
  };

  return {
    get fontFamily() {
      return familyOf();
    },
    loadFont,
  };
}
