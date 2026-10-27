// The remote pictures a HyperFrames page names: `<img src|srcset>`, `<video poster>`, SVG `<image href>`, and CSS `url()`
// in picture properties (`background`, `mask`, `border-image`, `list-style`, `content`, ...). `fetch-deps` downloads them
// (`deps.ts`), the plan reads them from that cache, and a render never touches the network.

import { DEFAULT_ALLOWED_HOSTS } from './deps.js';

/** How the page's runtime asks the host for the cached file of a remote picture a script set (`dynamic.ts`). */
export const REMOTE_PICTURE = Symbol.for('kinetograph.hf.remotePicture');

/**
 * Why a remote picture is drawn without, and the command that fixes it: `fetch-deps`, with `--allow-host` when its host is
 * not one of the defaults. `http:` is refused outright.
 */
export function notCachedPicture(url: string, entry = '<entry>', what = 'the picture'): string {
  if (/^http:/i.test(url)) return `${what} ${url} is not downloaded: only https pictures are`;
  // The host is pasted into a command to copy: only a plain hostname is (punycode is ASCII), and a URL that does not parse gets none.
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // no host to suggest
  }
  const allow = host === '' || DEFAULT_ALLOWED_HOSTS.includes(host) || !/^[a-z0-9.-]+$/i.test(host) ? '' : ` --allow-host ${host}`;
  return `${what} ${url} is not cached, and a render reads no network, so it is drawn without the picture: run \`kinetograph fetch-deps ${entry}${allow}\``;
}

/** The most bytes of one remote picture. */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** The CSS properties whose `url()` is a picture the engine draws (not `src` of an `@font-face`, `cursor`, `filter`). */
const IMAGE_PROPERTIES = /^(?:-webkit-)?(?:background(?:-image)?|mask(?:-image)?|border-image(?:-source)?|list-style(?:-image)?|content|shape-outside|--[\w-]+)$/i;

export type RemoteImage = { url: string } | { refused: string } | null;

/**
 * What a picture reference is: an `https` URL (a `//host/x` one is `https`), a `http` URL that is refused, or null for
 * anything else (a relative path is a file of the project, `data:` is the picture itself).
 */
export function remoteImage(value: string): RemoteImage {
  const v = value.trim();
  if (/^https:\/\//i.test(v)) return { url: v };
  if (v.startsWith('//')) return { url: `https:${v}` };
  if (/^http:\/\//i.test(v)) return { refused: v };
  return null;
}

/**
 * The candidate of a `srcset` that is drawn: the 1x one (or one with no descriptor), else the smallest density above 1,
 * else the first. A width descriptor has no viewport to measure against here, so the first of those is taken.
 */
export function pickSrcset(srcset: string): string | null {
  const candidates: { url: string; density: number | null }[] = [];
  // A URL may hold a comma (a resizer's); a candidate ends at a comma followed by whitespace, or at the end.
  for (const part of srcset.split(/,\s+|,$/)) {
    const m = /^\s*(\S+)(?:\s+(\d+(?:\.\d+)?)([xw]))?\s*,?\s*$/.exec(part);
    if (m === null) continue;
    candidates.push({ url: m[1]!, density: m[3] === 'x' ? Number(m[2]) : m[3] === 'w' ? null : 1 });
  }
  if (candidates.length === 0) return null;
  const sized = candidates.filter((c) => c.density !== null);
  const one = sized.find((c) => c.density === 1);
  if (one) return one.url;
  const above = sized.filter((c) => c.density! > 1).sort((a, b) => a.density! - b.density!)[0];
  return (above ?? candidates[0]!).url;
}

/**
 * `css` (a stylesheet, or the declarations of a `style` attribute) with each remote `url()` of a picture property passed
 * through `local`: its result replaces the URL when it is a file, else the URL stays as written.
 */
export function rewriteCssImages(css: string, local: (image: NonNullable<RemoteImage>) => string | null): string {
  if (!/(?:https?:|\/\/)/i.test(css)) return css;
  return css.replace(/([-\w]+)(\s*:\s*)([^;{}]*)/g, (whole, property: string, colon: string, value: string) => {
    if (!IMAGE_PROPERTIES.test(property) || !/url\(/i.test(value)) return whole;
    const rewritten = value.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (match, _quote: string, target: string) => {
      const image = remoteImage(target);
      if (image === null) return match;
      const file = local(image);
      return file === null ? match : `url("${file.replace(/"/g, '%22')}")`;
    });
    return `${property}${colon}${rewritten}`;
  });
}
