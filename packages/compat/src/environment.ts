// What a DOM island needs from the project around it (packages/cli/skills/kinetograph/references/ENGINE.md §2): where relative paths resolve, and the
// stylesheets the project imported. The bundler turns each `import './x.css'` into a `registerStylesheet(text)` call
// that runs when the project loads, so the list is complete before the first frame.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface DomEnvironment {
  /** Relative paths in `src` and `url()` resolve against this, then `publicDir`. */
  baseDir: string;
  publicDir?: string;
}

let environment: DomEnvironment | null = null;

export function setDomEnvironment(next: DomEnvironment): void {
  environment = { baseDir: next.baseDir, ...(next.publicDir !== undefined ? { publicDir: next.publicDir } : {}) };
}

/**
 * Where relative paths resolve. Set by the host after the project loads; before that (a stylesheet imported while the
 * project loads) the host's environment variables say: `KINETOGRAPH_BASE_DIR`, `KINETOGRAPH_PUBLIC_DIR`.
 */
export function getDomEnvironment(): DomEnvironment {
  if (environment !== null) return environment;
  const publicDir = process.env.KINETOGRAPH_PUBLIC_DIR;
  return { baseDir: process.env.KINETOGRAPH_BASE_DIR ?? process.cwd(), ...(publicDir ? { publicDir } : {}) };
}

// ---- the document's URL ----

/** The document's URL (`location.href`): a URL a script reads back from `src` or `href` is resolved against it. */
export const DOCUMENT_URL = 'http://localhost/';

/** `value` resolved against the document's URL, as HTML reflects a URL attribute; the value itself when it does not parse. */
export function resolveDocumentUrl(value: string): string {
  try {
    return new URL(value, DOCUMENT_URL).href;
  } catch {
    return value;
  }
}

/**
 * The project path a URL of the document's own origin names (`http://localhost/img/a%20b.png` is `img/a b.png`), so
 * `new Image().src = el.src` and `fetch(el.src)` read the project file as a browser reads its server's; null for any other.
 */
export function sameOriginPath(url: string): string | null {
  if (!url.toLowerCase().startsWith(DOCUMENT_URL)) return null;
  const path = url.slice(DOCUMENT_URL.length).split(/[?#]/)[0]!;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

// ---- remote files ----

type RemoteResolver = (url: string) => string | null;
let remoteResolver: RemoteResolver | null = null;

/** The host (core) says where an http(s) image or video is kept after it was downloaded once; null when it cannot be had. */
export function setRemoteAssetResolver(resolver: RemoteResolver | null): void {
  remoteResolver = resolver;
}

/** The local file for an http(s) URL, or null (not a remote URL, no resolver, or the download failed). */
export function resolveRemoteAsset(url: string): string | null {
  if (remoteResolver === null || !/^https?:\/\//i.test(url)) return null;
  return remoteResolver(url);
}

// ---- stylesheets ----

interface Sheet {
  css: string;
  file?: string;
}
const sheets: Sheet[] = [];
const notes: string[] = [];

/** A `@font-face` rule with its first usable source, for the host to register. */
export interface CssFontFace {
  family: string;
  /** The source file as written (relative to the base or public directory, or absolute). */
  url: string;
  weight: string;
  style: string;
  unicodeRange?: string;
}

type FontFaceHandler = (face: CssFontFace) => void;
let fontFaceHandler: FontFaceHandler | null = null;

/** The host (core) registers `@font-face` files with the font registry through this. */
export function setCssFontFaceHandler(handler: FontFaceHandler | null): void {
  fontFaceHandler = handler;
}

/** Declarations of a rule body as `[name, value]` pairs. */
function declarations(body: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let start = 0;
  let quote = '';
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === quote && body[i - 1] !== '\\') quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if ((c === ';' && depth === 0) || i === body.length) {
      const part = body.slice(start, i);
      const colon = part.indexOf(':');
      if (colon > 0) out.push([part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim()]);
      start = i + 1;
    }
  }
  return out;
}

/** The `@font-face` rules of a stylesheet that name a file. */
export function parseFontFaces(css: string): CssFontFace[] {
  const faces: CssFontFace[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /@font-face\s*\{([^}]*)\}/gi;
  for (let match = rule.exec(stripped); match; match = rule.exec(stripped)) {
    const decl = Object.fromEntries(declarations(match[1]!));
    const family = (decl['font-family'] ?? '').replace(/^\s*['"]?|['"]?\s*$/g, '');
    const src = decl.src ?? '';
    // Prefer a source we can read: WOFF2, WOFF, TTF, OTF, in the order written.
    const urls = [...src.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)].map((m) => m[2]!);
    const url = urls.find((u) => !/^https?:|^data:/i.test(u)) ?? urls[0];
    if (family === '' || url === undefined) continue;
    // A weight range (`100 900`, a variable font) is registered at its first value.
    const weight = (decl['font-weight'] ?? 'normal').split(/\s+/)[0]!;
    const face: CssFontFace = { family, url, weight, style: (decl['font-style'] ?? 'normal').split(/\s+/)[0]! };
    if (decl['unicode-range'] !== undefined) face.unicodeRange = decl['unicode-range'];
    faces.push(face);
  }
  return faces;
}

const registeredFaces = new Set<string>();
const seenSheets = new Set<string>();

/** How many `@font-face` rules have been registered: a request built before one was has a stale font list. */
export function fontFacesRegistered(): number {
  return registeredFaces.size;
}

/** Registers the `@font-face` files of `css` through the handler (once per rule). */
function registerFontFaces(css: string): void {
  if (!fontFaceHandler) return;
  for (const face of parseFontFaces(css)) {
    const key = JSON.stringify(face);
    if (registeredFaces.has(key)) continue;
    registeredFaces.add(key);
    fontFaceHandler(face);
  }
}

/** Where a file named in CSS is: absolute as it is; else beside the project's entry, else in the public folder. */
export function resolveProjectFile(name: string): string | null {
  const clean = name.split(/[?#]/)[0]!;
  const { baseDir, publicDir } = getDomEnvironment();
  const roots = [baseDir, publicDir].filter((d): d is string => d !== undefined);
  if (isAbsolute(clean) && existsSync(clean)) return clean;
  const relative = clean.replace(/^[/\\]+/, '');
  for (const root of roots) {
    const candidate = join(root, relative);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Called by the module the bundler makes for an imported `.css` file, when the project loads. */
export function registerStylesheet(css: string, file?: string): void {
  sheets.push(file === undefined ? { css } : { css, file });
  noteStylesheet(css);
}

/** A `<style>` element or `<link>`ed file met at render time: its fonts are registered too. */
export function noteStylesheet(css: string): void {
  if (seenSheets.has(css)) return;
  seenSheets.add(css);
  registerFontFaces(css);
}

/** What the project's imports added, in import order. */
export function importedStylesheets(): string[] {
  return sheets.map((sheet) => sheet.css);
}

/** Problems with the project's stylesheets that `doctor` reports (an unprocessed Tailwind file, a font that did not download). */
export function stylesheetNotes(): string[] {
  return [...notes];
}

/** The bundler's report of what it could not do with a stylesheet (called from the generated module). */
export function noteStylesheetProblem(message: string): void {
  if (!notes.includes(message)) notes.push(message);
}

/** The text of a local `<link rel="stylesheet">` target; null for a remote URL or a missing file. */
export function readLocalStylesheet(href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) return null;
  const path = href.startsWith('file:') ? new URL(href).pathname : resolveProjectFile(href);
  if (path === null || !existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

/** For tests: forgets every stylesheet, note and registered face. */
export function resetStylesheets(): void {
  sheets.length = 0;
  notes.length = 0;
  registeredFaces.clear();
  seenSheets.clear();
}
