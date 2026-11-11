// What a DOM island needs from the project around it (packages/cli/skills/kinetograph-markup/references/ENGINE.md §2): where relative paths resolve, and the
// stylesheets the project imported. The bundler turns each `import './x.css'` into a `registerStylesheet(text)` call
// that runs when the project loads, so the list is complete before the first frame.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  /** The top of a weight range (`font-weight: 300 1000`); `weight` is its first value. */
  weightMax?: string;
  style: string;
  unicodeRange?: string;
  /** The rule came from a remote stylesheet: its file is never read from the project. */
  remote?: boolean;
}

type FontFaceHandler = (face: CssFontFace) => void;
let fontFaceHandler: FontFaceHandler | null = null;

/** The host (core) registers `@font-face` files with the font registry through this. */
export function setCssFontFaceHandler(handler: FontFaceHandler | null): void {
  fontFaceHandler = handler;
}

// ---- reading CSS ----
//
// One small reader for everything here (local `@font-face` rules, a remote stylesheet's, `@import`s): comments, strings and an
// unquoted `url(...)` are skipped whole, so a `}`, a `;` or a `/*` inside one never ends a rule or a comment.

const URL_OPEN = /url\(\s*/iy;

/** Where the comment, string or unquoted `url(...)` that starts at `i` ends, or null when none starts there. */
function opaqueEnd(css: string, i: number): number | null {
  const c = css[i];
  if (c === '/' && css[i + 1] === '*') {
    const end = css.indexOf('*/', i + 2);
    return end === -1 ? css.length : end + 2;
  }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1;
    return Math.min(j + 1, css.length);
  }
  if ((c === 'u' || c === 'U') && !/[\w-]/.test(css[i - 1] ?? ' ')) {
    URL_OPEN.lastIndex = i;
    const open = URL_OPEN.exec(css);
    if (open !== null && css[URL_OPEN.lastIndex] !== '"' && css[URL_OPEN.lastIndex] !== "'") {
      let j = URL_OPEN.lastIndex;
      while (j < css.length && css[j] !== ')') j += css[j] === '\\' ? 2 : 1;
      return Math.min(j + 1, css.length);
    }
  }
  return null;
}

/** `css` without its comments. */
function stripComments(css: string): string {
  let out = '';
  for (let i = 0; i < css.length; ) {
    const end = opaqueEnd(css, i);
    if (end === null) out += css[i++];
    else {
      if (!(css[i] === '/' && css[i + 1] === '*')) out += css.slice(i, end);
      i = end;
    }
  }
  return out;
}

interface CssRule {
  /** The at-rule's name without the `@` (`font-face`, `import`), else null. */
  name: string | null;
  prelude: string;
  /** What is between the braces; null for a rule that ends at `;`. */
  body: string | null;
  start: number;
  end: number;
}

/** The top-level rules of comment-free `css`. */
function scanRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i]!)) i++;
    const start = i;
    let j = i;
    while (j < css.length) {
      const end = opaqueEnd(css, j);
      if (end !== null) j = end;
      else if (css[j] === '{' || css[j] === ';' || css[j] === '}') break;
      else j++;
    }
    if (j >= css.length) break;
    if (css[j] === '}') {
      i = j + 1;
      continue;
    }
    const prelude = css.slice(start, j).trim();
    const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? null;
    if (css[j] === ';') {
      rules.push({ name, prelude, body: null, start, end: j + 1 });
      i = j + 1;
      continue;
    }
    let depth = 1;
    let k = j + 1;
    while (k < css.length && depth > 0) {
      const end = opaqueEnd(css, k);
      if (end !== null) k = end;
      else {
        if (css[k] === '{') depth++;
        else if (css[k] === '}') depth--;
        k++;
      }
    }
    // A block that is never closed has no body.
    rules.push({ name, prelude, body: depth === 0 ? css.slice(j + 1, k - 1) : null, start, end: k });
    i = k;
  }
  return rules;
}

/** The `url(...)` values in `value`, in order, each read the one way: a quoted string, or an unquoted run with no space, quote or parenthesis. */
function urlsIn(value: string): string[] {
  const out: string[] = [];
  const unescape = (text: string): string => text.replace(/\\(.)/gs, '$1');
  for (let i = 0; i < value.length; ) {
    if ((value[i] === 'u' || value[i] === 'U') && !/[\w-]/.test(value[i - 1] ?? ' ')) {
      URL_OPEN.lastIndex = i;
      if (URL_OPEN.exec(value) !== null) {
        let j = URL_OPEN.lastIndex;
        const quote = value[j];
        if (quote === '"' || quote === "'") {
          const end = opaqueEnd(value, j)!;
          const closed = value[end - 1] === quote && end - j >= 2;
          const after = /^\s*\)/.exec(value.slice(end));
          if (closed && after !== null) out.push(unescape(value.slice(j + 1, end - 1)));
          i = closed && after !== null ? end + after[0].length : end;
        } else {
          const end = opaqueEnd(value, i) ?? i + 1;
          const raw = value.slice(j, value[end - 1] === ')' ? end - 1 : end);
          if (value[end - 1] === ')' && !/[\s"'(]/.test(raw.trim())) out.push(unescape(raw.trim()));
          i = end;
        }
        continue;
      }
    }
    i = opaqueEnd(value, i) ?? i + 1;
  }
  return out;
}

/** Declarations of a rule body as `[name, value]` pairs. */
function declarations(body: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; ) {
    const end = i < body.length ? opaqueEnd(body, i) : null;
    if (end !== null) {
      i = end;
      continue;
    }
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if ((c === ';' && depth === 0) || i === body.length) {
      const part = body.slice(start, i);
      const colon = part.indexOf(':');
      if (colon > 0) out.push([part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim()]);
      start = i + 1;
    }
    i++;
  }
  return out;
}

/** How deep `@media` and its kind are followed for an `@font-face`. */
const MAX_NESTING = 32;

/** The bodies of the `@font-face` rules in comment-free `css`, inside `@media`, `@supports` and `@layer` too (to `MAX_NESTING` deep). */
function fontFaceBodies(css: string, depth = 0): string[] {
  const out: string[] = [];
  if (depth > MAX_NESTING) return out;
  for (const rule of scanRules(css)) {
    if (rule.name === 'font-face' && rule.body !== null) out.push(rule.body);
    else if (rule.body !== null && ['media', 'supports', 'layer', 'container'].includes(rule.name ?? '')) out.push(...fontFaceBodies(rule.body, depth + 1));
  }
  return out;
}

/** The face a `@font-face` body declares, with `url` as the source it picked, or null when it names none. */
function faceOf(body: string, pick: (urls: string[]) => string | undefined): CssFontFace | null {
  const decl = Object.fromEntries(declarations(body));
  const family = (decl['font-family'] ?? '').replace(/^\s*['"]?|['"]?\s*$/g, '');
  const url = pick(urlsIn(decl.src ?? ''));
  if (family === '' || url === undefined) return null;
  // A weight range (`100 900`, a variable font) is registered from its first value up to its second.
  const [weight = 'normal', weightMax] = (decl['font-weight'] ?? 'normal').split(/\s+/);
  const face: CssFontFace = { family, url, weight, ...(weightMax === undefined ? {} : { weightMax }), style: (decl['font-style'] ?? 'normal').split(/\s+/)[0]! };
  if (decl['unicode-range'] !== undefined) face.unicodeRange = decl['unicode-range'];
  return face;
}

/** The `@font-face` rules of a stylesheet of the project that name a file: a local one is preferred (WOFF2, WOFF, TTF, OTF, in the order written). */
export function parseFontFaces(css: string): CssFontFace[] {
  const faces: CssFontFace[] = [];
  for (const body of fontFaceBodies(stripComments(css))) {
    const face = faceOf(body, (urls) => urls.find((u) => u !== '' && !/^https?:|^data:/i.test(u)) ?? urls.find((u) => u !== ''));
    if (face !== null) faces.push(face);
  }
  return faces;
}

/** `target` resolved against `base`, when that is an https URL. */
function httpsUrl(target: string, base: string): string | null {
  try {
    const url = new URL(target.trim(), base);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * What a remote stylesheet adds: the https stylesheets it imports and its `@font-face` rules (each marked `remote`), read
 * once into structures, with every URL resolved against the sheet's own `base`. Nothing else of it is kept: no other rule and
 * no URL that is not https reaches a page or the file resolver.
 */
export function parseRemoteSheet(css: string, base: string): { imports: string[]; faces: CssFontFace[] } {
  const text = stripComments(css);
  const imports: string[] = [];
  for (const rule of scanRules(text)) {
    if (rule.name !== 'import') continue;
    const prelude = rule.prelude.replace(/^@import\s*/i, '');
    const target = prelude[0] === '"' || prelude[0] === "'" ? urlsIn(`url(${prelude.slice(0, opaqueEnd(prelude, 0) ?? 0)})`)[0] : urlsIn(prelude)[0];
    const href = target === undefined ? null : httpsUrl(target, base);
    if (href !== null) imports.push(href);
  }
  const faces: CssFontFace[] = [];
  for (const body of fontFaceBodies(text)) {
    const face = faceOf(body, (urls) => urls.map((u) => httpsUrl(u, base)).find((u): u is string => u !== null));
    if (face !== null) faces.push({ ...face, remote: true });
  }
  return { imports, faces };
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

const projectRoots = new Map<string, string>();

/**
 * The folder a project's own files may be read from: the nearest one at or above `from` that holds a `.git` (the repository,
 * so a kit or shared folder beside the episode is in), else the nearest with a package.json, else `from`.
 */
function projectRootOf(from: string): string {
  let root = projectRoots.get(from);
  if (root === undefined) {
    let packageRoot: string | null = null;
    root = null as unknown as string;
    for (let dir = resolve(from); ; dir = dirname(dir)) {
      if (existsSync(join(dir, '.git'))) {
        root = dir;
        break;
      }
      if (packageRoot === null && existsSync(join(dir, 'package.json'))) packageRoot = dir;
      if (dirname(dir) === dir) break;
    }
    root ??= packageRoot ?? from;
    projectRoots.set(from, root);
  }
  return root;
}

const isInside = (parent: string, path: string): boolean => {
  const rel = relative(resolve(parent), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Where a file named in CSS or a `src` is: beside the project's entry, else in the public folder; an absolute path (the
 * bundler writes the project's own files that way) only when it is inside the project's repository. A path that would leave
 * it (`/etc/passwd`, `../../x`) is never a project file.
 */
export function resolveProjectFile(name: string): string | null {
  const clean = name.split(/[?#]/)[0]!;
  const { baseDir, publicDir } = getDomEnvironment();
  const roots = [baseDir, publicDir].filter((d): d is string => d !== undefined);
  const project = projectRootOf(baseDir);
  const allowed = (path: string): boolean => [project, ...roots].some((root) => isInside(root, path));
  if (isAbsolute(clean) && allowed(clean) && existsSync(clean)) return clean;
  const relativeName = clean.replace(/^[/\\]+/, '');
  for (const root of roots) {
    const candidate = join(root, relativeName);
    if (allowed(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

// Remote stylesheets: only https, only ones `fetch-deps` downloaded and locked, each at most once per sheet, and bounded.
/** The most remote stylesheets one top-level sheet may pull in, and the most text they may add. */
export const MAX_REMOTE_IMPORTS = 16;
export const MAX_REMOTE_IMPORT_BYTES = 1 << 20;

type RemoteStylesheetResolver = (url: string) => string | null;
let stylesheetResolver: RemoteStylesheetResolver | null = null;

/**
 * The host says where a remote stylesheet is kept: only a file already downloaded and locked (`fetch-deps`), never a
 * download made during a render. null when there is none.
 */
export function setRemoteStylesheetResolver(resolver: RemoteStylesheetResolver | null): void {
  stylesheetResolver = resolver;
}

/**
 * The local file for an https URL that `fetch-deps` downloaded and locked (what `fetch()` and an `@import` may read), or
 * null: nothing is downloaded during a render, and a URL that was not scanned and locked is not read.
 */
export function resolveCachedRemoteFile(url: string): string | null {
  return stylesheetResolver === null || !/^https:\/\//i.test(url) ? null : stylesheetResolver(url);
}

/** Registers the faces of a remote stylesheet through the handler (once per rule). */
function registerRemoteFaces(faces: CssFontFace[]): void {
  if (!fontFaceHandler) return;
  for (const face of faces) {
    const key = JSON.stringify(face);
    if (registeredFaces.has(key)) continue;
    registeredFaces.add(key);
    fontFaceHandler(face);
  }
}

/**
 * Takes the `@import`s that name another origin out of `css` (a page does not load them any other way) and, for each https
 * one that `fetch-deps` downloaded and locked, reads the sheet once into its fonts (`parseRemoteSheet`) and registers
 * them as remote faces; the sheet's text is not put in the page. A stylesheet is read at most once per top-level sheet
 * (a cycle or a repeat adds nothing), at most `MAX_REMOTE_IMPORTS` of them and `MAX_REMOTE_IMPORT_BYTES` of text.
 */
function withoutRemoteImports(css: string): string {
  if (!/@import/i.test(css)) return css;
  const text = stripComments(css);
  const queue: string[] = [];
  let kept = '';
  let from = 0;
  for (const rule of scanRules(text)) {
    if (rule.name !== 'import') continue;
    const target = urlsIn(rule.prelude.replace(/^@import\s*/i, ''))[0] ?? /^@import\s*(["'])(.*?)\1/is.exec(rule.prelude)?.[2];
    if (target === undefined || !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    kept += text.slice(from, rule.start);
    from = rule.end;
    const href = httpsUrl(target, 'https://invalid.invalid/');
    if (href !== null) queue.push(href);
  }
  kept += text.slice(from);
  const visited = new Set<string>();
  let bytes = 0;
  for (let i = 0; i < queue.length && visited.size < MAX_REMOTE_IMPORTS; i++) {
    const url = queue[i]!;
    if (visited.has(url)) continue;
    visited.add(url);
    const file = stylesheetResolver?.(url) ?? null;
    if (file === null || !existsSync(file)) continue;
    const sheet = readFileSync(file, 'utf8');
    bytes += sheet.length;
    if (bytes > MAX_REMOTE_IMPORT_BYTES) break;
    const parsed = parseRemoteSheet(sheet, url);
    registerRemoteFaces(parsed.faces);
    queue.push(...parsed.imports);
  }
  return kept;
}

/** Called by the module the bundler makes for an imported `.css` file, when the project loads. */
export function registerStylesheet(css: string, file?: string): void {
  const text = withoutRemoteImports(css);
  sheets.push(file === undefined ? { css: text } : { css: text, file });
  seenSheets.add(css);
  seenSheets.add(text);
  registerFontFaces(text);
}

/** A `<style>` element or `<link>`ed file met at render time: its remote imports are read for their fonts, and its own fonts registered. */
export function noteStylesheet(css: string): void {
  if (seenSheets.has(css)) return;
  seenSheets.add(css);
  registerFontFaces(withoutRemoteImports(css));
}

let defaultSheet: string | null = null;

/**
 * CSS the page has before the project's own (null for none). A Remotion render page sets `box-sizing: border-box` on every
 * element, so the host lays that under a Remotion project's styles; a plain HTML page has no such rule.
 */
export function setDefaultStylesheet(css: string | null): void {
  defaultSheet = css;
}

/** What the page's CSS is: the default sheet, then what the project's imports added, in import order. */
export function importedStylesheets(): string[] {
  return [...(defaultSheet === null ? [] : [defaultSheet]), ...sheets.map((sheet) => sheet.css)];
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
  defaultSheet = null;
  notes.length = 0;
  registeredFaces.clear();
  seenSheets.clear();
}
