// The browser's `FontFace` and `document.fonts`, as far as a project loading its own font files uses them
// (kinetograph site, /docs/compat/): `new FontFace(family, "url(...)", { weight, style })`, `await face.load()` and
// `document.fonts.add(face)` register the file with `registerFont`. Installed in Node only where the globals are missing.
//
// A remote `url(https://…)` is downloaded once into the font cache (`~/.cache/kinetograph/fonts`) and read from there
// after that, as `@remotion/google-fonts` does: `face.load()` downloads it, and `document.fonts.add(face)` blocks until
// it is there. A download that fails does not stop the project from loading: it is noted (`doctor` and `lint` print
// it) and the face is not registered, so the text that uses it is reported as a missing font.
//
// One file is kept per family, weight and style. A face split by `unicodeRange` into several files (Google Fonts'
// `latin` and `latin-ext`) keeps the one that covers basic Latin.

import { fetchFileCached, fetchFileCachedSync, FontDownloadError, type FontDownloadOptions } from './font-files.js';
import { noteFontProblem, registerFont } from './font-registry.js';

interface FaceDescriptors {
  weight?: string;
  style?: string;
  unicodeRange?: string;
  display?: string;
}

const WEIGHTS: Record<string, number> = { normal: 400, bold: 700 };

/** `url("a.woff2") format('woff2'), url(b.ttf)` → the first URL. */
function firstUrl(source: string): string | null {
  const match = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(source);
  return match ? match[2]! : null;
}

/** Whether a CSS `unicode-range` includes U+0041 ('A'); no range is everything. */
function coversBasicLatin(range: string | undefined): boolean {
  if (range === undefined || range.trim() === '') return true;
  return range.split(',').some((part) => {
    const m = /^\s*U\+([0-9A-F?]+)(?:-([0-9A-F]+))?\s*$/i.exec(part);
    if (!m) return false;
    const lo = parseInt(m[1]!.replace(/\?/g, '0'), 16);
    const hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1]!.replace(/\?/g, 'F'), 16);
    return lo <= 0x41 && 0x41 <= hi;
  });
}

// Per family/weight/style: whether the file kept covers basic Latin.
const kept = new Map<string, boolean>();

export class NodeFontFace {
  readonly family: string;
  readonly weight: string;
  readonly style: string;
  readonly unicodeRange: string;
  readonly display: string;
  status: 'unloaded' | 'loading' | 'loaded' | 'error' = 'unloaded';
  /** The file the source names; for a remote one, empty until it is downloaded. */
  path: string;
  /** The URL of a remote source. */
  readonly remote: string | null;
  private readonly download: FontDownloadOptions;

  constructor(
    family: string,
    source: string | ArrayBuffer | ArrayBufferView,
    descriptors: FaceDescriptors = {},
    /** Replaces the network and the cache (tests). */
    download: FontDownloadOptions = {},
  ) {
    if (typeof source !== 'string') {
      throw new TypeError(`new FontFace("${family}", <binary data>): only a url(...) source is supported in Node`);
    }
    const url = firstUrl(source);
    if (url === null) throw new TypeError(`new FontFace("${family}", ${JSON.stringify(source)}): no url(...) in the source`);
    this.download = download;
    this.remote = /^https?:\/\//i.test(url) ? url : null;
    this.family = family.replace(/^['"]|['"]$/g, '');
    this.path = this.remote === null ? url : '';
    this.weight = descriptors.weight ?? 'normal';
    this.style = descriptors.style ?? 'normal';
    this.unicodeRange = descriptors.unicodeRange ?? 'U+0-10FFFF';
    this.display = descriptors.display ?? 'auto';
  }

  /** A local file is read when a frame is drawn; a remote one is downloaded now (rejects with a `FontDownloadError`). */
  async load(): Promise<this> {
    if (this.remote !== null && this.path === '') {
      this.status = 'loading';
      try {
        this.path = await fetchFileCached(this.remote, this.download);
      } catch (error) {
        this.status = 'error';
        throw error;
      }
    }
    this.status = 'loaded';
    return this;
  }

  /** Blocks until the file is here; false (with a note for `doctor` and `lint`) when it cannot be had. */
  resolveSync(): boolean {
    if (this.remote === null || this.path !== '') return true;
    try {
      this.path = fetchFileCachedSync(this.remote, this.download);
      this.status = 'loaded';
      return true;
    } catch (error) {
      this.status = 'error';
      if (!(error instanceof FontDownloadError)) throw error;
      noteFontProblem(`FontFace "${this.family}": ${error.message}; the font is not registered`);
      return false;
    }
  }

  get loaded(): Promise<this> {
    return Promise.resolve(this);
  }
}

export function addFace(face: NodeFontFace): void {
  if (!face.resolveSync()) return;
  const weight = WEIGHTS[face.weight] ?? (Number.isFinite(Number(face.weight)) ? Number(face.weight) : 400);
  const style = face.style === 'italic' || face.style === 'oblique' ? 'italic' : 'normal';
  const key = `${face.family}:${weight}:${style}`;
  const latin = coversBasicLatin(face.unicodeRange);
  if (kept.has(key) && (kept.get(key) || !latin)) return;
  kept.set(key, latin);
  registerFont({ family: face.family, path: face.path, weight, style });
}

/** `document.fonts`: a set of the faces added. */
class NodeFontFaceSet extends Set<NodeFontFace> {
  readonly ready: Promise<this> = Promise.resolve(this);
  status: 'loaded' = 'loaded';

  override add(face: NodeFontFace): this {
    if (!(face instanceof NodeFontFace)) throw new TypeError('document.fonts.add() takes a FontFace');
    addFace(face);
    return super.add(face);
  }

  check(): boolean {
    return true;
  }

  async load(): Promise<NodeFontFace[]> {
    return [...this];
  }
}

/** Puts `FontFace` and `document.fonts` on the global object where they are missing. */
export function installFontFace(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.FontFace === undefined) g.FontFace = NodeFontFace;
  if (g.document === undefined) g.document = { fonts: new NodeFontFaceSet() };
}
