// Reads a HyperFrames project (an index.html, the compositions it mounts with `data-composition-src`, the scripts and
// stylesheets they load) into the plan the runtime builds a composition from (`@kinetographdev/core/hyperframes`).
// The contract is HyperFrames' (Apache-2.0, heygen-com/hyperframes; its docs "Compositions" and "HTML schema"):
//
//   - the root is the outermost `data-composition-id` element: `data-width`, `data-height`, `data-duration`; 30 fps;
//   - a host with `data-composition-src` gets the content of the file's `<template>` (or its body): the file's root
//     element is replaced by the host, whose attributes win; the file's styles are scoped to the composition and its
//     scripts see only the composition;
//   - paths in the files resolve from the project root, or from the file that names them.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { HfNode, HfPlan, HfScript, HfStylesheet } from '@kinetographdev/core/hyperframes';
import { absolutizeUrls, buildTailwind, readStylesheet, usesTailwind } from '../css.js';
import { CliError } from '../errors.js';
import { lockPathOf } from '@kinetographdev/core/lock';
import { DEFAULT_ALLOWED_HOSTS, dataCachePath, resolveCdnData, resolveCdnScript, useLockFile, verifyIntegrity } from './deps.js';
import { bundleModuleScript, emptyImportMap, mergeImportMaps, parseImportMap, type ImportMap, type ModuleScript } from './modules.js';
import { pickSrcset, remoteImage, rewriteCssImages, type RemoteImage } from './images.js';
import { bundledUses, emptyUse, finishUse, noteCss, noteFamilyValue, noteInline } from './fonts.js';
import {
  extractGoogleFontImports,
  parseGoogleFontsUrl,
  rewriteDocumentSelectors,
  scopeToComposition,
  type GoogleFontRequest,
} from './css.js';

type PNode = DefaultTreeAdapterMap['node'];
type PElement = DefaultTreeAdapterMap['element'];
type PTemplate = DefaultTreeAdapterMap['template'];
type PParent = DefaultTreeAdapterMap['parentNode'];

const SVG_NS = 'http://www.w3.org/2000/svg';
export const DEFAULT_FPS = 30;

const isElement = (node: PNode): node is PElement => 'tagName' in node;
const isText = (node: PNode): node is DefaultTreeAdapterMap['textNode'] => node.nodeName === '#text';
const childrenOf = (node: PParent): PNode[] => (node as { childNodes?: PNode[] }).childNodes ?? [];
const attrOf = (el: PElement, name: string): string | null => el.attrs.find((a) => a.name === name)?.value ?? null;
const textOf = (el: PElement): string => childrenOf(el).map((n) => (isText(n) ? n.value : '')).join('');

/** Attributes that name a file the engine reads. */
const FILE_ATTRIBUTES = new Set(['src', 'poster', 'xlink:href']);
const isRemote = (value: string): boolean => /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value);
const MEDIA_TAGS = new Set(['video', 'audio']);
const THREE_URL = /(^|[/@.-])three(\.module)?(\.min)?\.js(\?|$)|\/three@|\/three\/build\//i;

export interface PlanOptions {
  /** Natural duration of a media file in seconds, or null. */
  probeDuration?: (file: string) => number | null;
  /** Reads a script a URL names (default: the installed package or the cache; see `deps.ts`). */
  resolveScriptUrl?: typeof resolveCdnScript;
  /** Lists what the project loads (`fetch-deps`): a script that is not available is left out instead of failing the read. */
  discoverOnly?: boolean;
  /** Hosts besides the CDNs whose URLs in a script count as files it fetches (`--allow-host`). */
  allowHosts?: string[];
}

export interface BuiltPlan {
  plan: HfPlan;
  /** Every file read, for the bundler to watch. */
  files: string[];
  /** The URLs of the CDN scripts the project loads (`fetch-deps` downloads these). */
  scriptUrls: string[];
  /** The `integrity` attribute of each script URL's tag. */
  scriptIntegrity: Record<string, string>;
  /** URLs of data files the page's scripts name (`d3.json("https://cdn.jsdelivr.net/...")`), on the allowed hosts: `fetch-deps` downloads these. */
  dataUrls: string[];
  /** URLs of remote `<video>`, `<audio>`, `<img>` and `<source>` files, which `fetch-deps` downloads too. */
  mediaUrls: string[];
  /** URLs of remote pictures (`<img>`, CSS `url()`, SVG `<image>`, `<video poster>`), which `fetch-deps` downloads too. */
  imageUrls: string[];
  /** The `<script type="module">`s of the page, in document order. */
  modules: ModuleScript[];
  /** The page's import maps, merged. */
  importMap: ImportMap;
  /** A module script has an `import()` of a specifier built at run time (resolved while the page runs, `dynamic.ts`). */
  computedImports: boolean;
}

interface Context {
  /** The file being read and its directory. */
  file: string;
  dir: string;
  /** The composition the content belongs to (its scripts and styles are scoped to it), or null for the page. */
  scope: string | null;
  /** The root element's id in a mounted file, whose rules apply to the host. */
  rootId: string | null;
  stack: string[];
}

class Builder {
  readonly stylesheets: HfStylesheet[] = [];
  readonly scripts: HfScript[] = [];
  readonly fonts: GoogleFontRequest[] = [];
  /** The font families the page's CSS names (`fonts.ts`). */
  readonly fontUse = emptyUse();
  readonly variables: Record<string, Record<string, unknown>> = {};
  readonly mediaFiles = new Set<string>();
  readonly notes: string[] = [];
  readonly files = new Set<string>();
  readonly scriptUrls: string[] = [];
  readonly scriptIntegrity: Record<string, string> = {};
  readonly dataUrls = new Set<string>();
  readonly mediaUrls = new Set<string>();
  readonly imageUrls = new Set<string>();
  /** Remote files found in the cache, by URL. */
  readonly remoteData: Record<string, string> = {};
  usesThree = false;
  /** The page's import maps, merged, and its `<script type="module">`s in document order. */
  readonly importMap: ImportMap = emptyImportMap();
  readonly modules: ModuleScript[] = [];

  constructor(
    readonly root: string,
    readonly options: PlanOptions,
    /** The entry file, named in the notes that say how to download a picture. */
    readonly entry: string = '<entry>',
  ) {}

  note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  read(file: string): string {
    this.files.add(file);
    return readFileSync(file, 'utf8');
  }

  /** `value` as an absolute path when it names a file next to the current file or in the project root; else as written. */
  asset(value: string, ctx: Context): string {
    const trimmed = value.trim();
    if (trimmed === '' || isRemote(trimmed)) return value;
    const clean = trimmed.split(/[?#]/)[0]!;
    const suffix = trimmed.slice(clean.length);
    const candidates = isAbsolute(clean) ? [clean, join(this.root, clean)] : [resolve(ctx.dir, clean), resolve(this.root, clean)];
    for (const candidate of candidates) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate + suffix;
    }
    return value;
  }

  // ---- the elements that are not nodes ----

  script(el: PElement, ctx: Context): void {
    const type = (attrOf(el, 'type') ?? '').trim().toLowerCase();
    if (type === 'importmap') {
      if (attrOf(el, 'src') !== null) {
        this.note(`${ctx.file}: an import map with a src is not read: put its JSON inside the tag`);
        return;
      }
      const problems: string[] = [];
      const map = parseImportMap(textOf(el), pathToFileURL(ctx.file).href, problems);
      for (const problem of problems) this.note(`${ctx.file}: ${problem}`);
      mergeImportMaps(this.importMap, map);
      if (Object.values(map.imports).some((u) => THREE_URL.test(u))) this.usesThree = true;
      return;
    }
    if (type === 'module') {
      this.moduleScript(el, ctx);
      return;
    }
    if (type !== '' && type !== 'text/javascript' && type !== 'application/javascript') return;
    const src = attrOf(el, 'src');
    let code: string;
    let file: string;
    if (src !== null) {
      if (/^https?:\/\//i.test(src) || src.startsWith('//')) {
        const url = src.startsWith('//') ? `https:${src}` : src;
        this.scriptUrls.push(url);
        const integrity = attrOf(el, 'integrity');
        if (integrity) this.scriptIntegrity[url] = integrity;
        if (THREE_URL.test(url)) this.usesThree = true;
        const found = (this.options.resolveScriptUrl ?? resolveCdnScript)(url, this.root);
        if ('error' in found) {
          if (!this.options.discoverOnly) throw new CliError('SCRIPT_NOT_AVAILABLE', `${ctx.file}: ${found.error}`);
          return;
        }
        code = this.read(found.file);
        this.checkIntegrity(el, found.file, url);
        file = url;
      } else {
        const path = this.asset(src, ctx);
        if (!existsSync(path)) throw new CliError('SCRIPT_NOT_FOUND', `${ctx.file}: <script src="${src}"> was not found beside ${ctx.file} or in ${this.root}`);
        code = this.read(path);
        this.checkIntegrity(el, path, path);
        file = path;
      }
    } else {
      code = textOf(el);
      file = ctx.file;
    }
    if (/\bTHREE\.(WebGLRenderer|Scene|PerspectiveCamera)\b/.test(code)) this.usesThree = true;
    this.scanDataUrls(code, src === null ? null : normalizeUrl(src));
    this.scripts.push({ code, file, scope: src === null ? ctx.scope : null, sourceFile: src === null && ctx.scope !== null ? ctx.file : null });
  }

  /** A `<script type="module">`: kept for the end, when the import maps are all read; it runs after the classic scripts. */
  moduleScript(el: PElement, ctx: Context): void {
    const src = attrOf(el, 'src');
    if (src === null) {
      const code = textOf(el);
      this.scanDataUrls(code, null);
      if (/\bTHREE\.(WebGLRenderer|Scene|PerspectiveCamera)\b/.test(code)) this.usesThree = true;
      this.modules.push({ code, file: ctx.file, base: pathToFileURL(ctx.file).href, scope: ctx.scope, sourceFile: ctx.scope !== null ? ctx.file : null, root: this.root });
      return;
    }
    if (/^https?:\/\//i.test(src) || src.startsWith('//')) {
      const url = normalizeUrl(src);
      if (THREE_URL.test(url)) this.usesThree = true;
      const integrity = attrOf(el, 'integrity');
      if (integrity) this.scriptIntegrity[url] = integrity;
      this.modules.push({ code: null, file: url, base: url, scope: null, sourceFile: null, root: this.root, ...(integrity ? { integrity } : {}) });
      return;
    }
    const path = this.asset(src, ctx).split(/[?#]/)[0]!;
    if (!existsSync(path)) throw new CliError('SCRIPT_NOT_FOUND', `${ctx.file}: <script type="module" src="${src}"> was not found beside ${ctx.file} or in ${this.root}`);
    this.files.add(path);
    this.checkIntegrity(el, path, path);
    this.modules.push({ code: null, file: path, base: pathToFileURL(path).href, scope: null, sourceFile: null, root: this.root });
  }

  /**
   * The URLs a script names on the allowed hosts (the CDNs, and `--allow-host`): files it fetches. Scripts themselves are
   * not among them. A file that is cached is served to `fetch()` of exactly that URL; one that is not is a note.
   */
  scanDataUrls(code: string, own: string | null): void {
    const hosts = new Set([...DEFAULT_ALLOWED_HOSTS, ...(this.options.allowHosts ?? [])]);
    for (const m of code.matchAll(/https:\/\/[^\s'"`<>)\\,;]+/g)) {
      const url = m[0].replace(/[.]+$/, '');
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        continue;
      }
      if (!hosts.has(parsed.hostname) || url === own || this.scriptUrls.includes(url) || /\.(m?js|css|woff2?|ttf|otf)$/i.test(parsed.pathname) || parsed.pathname === '/') continue;
      this.dataUrls.add(url);
      this.useCached(url);
    }
  }

  /** Records the cached file of a remote URL, or the note that says it is not cached. */
  useCached(url: string): string | null {
    const found = resolveCdnData(url);
    if ('file' in found) {
      this.remoteData[url] = found.file;
      return found.file;
    }
    if (!this.options.discoverOnly) this.note(found.error);
    return null;
  }

  /** The script's `integrity` attribute against the bytes about to run, wherever they came from. */
  checkIntegrity(el: PElement, file: string, label: string): void {
    const integrity = attrOf(el, 'integrity');
    if (integrity && !this.options.discoverOnly) verifyIntegrity(readFileSync(file), integrity, label);
  }

  /**
   * The cached file of a remote picture, or null: the URL is then left as written, and a note says how to fix it. The cache
   * is read through its hash (`resolveCdnData`), so a file that was changed is not drawn.
   */
  localImage(image: NonNullable<RemoteImage>, what: string): string | null {
    if ('refused' in image) {
      if (!this.options.discoverOnly) this.note(`${what} ${image.refused} is not downloaded: only https pictures are`);
      return null;
    }
    this.imageUrls.add(image.url);
    const found = resolveCdnData(image.url);
    if ('file' in found) return found.file;
    if (this.options.discoverOnly) return null;
    if (existsSync(dataCachePath(image.url))) {
      this.note(`${what} ${image.url} is drawn without the picture: ${found.error}`);
      return null;
    }
    // The host is pasted into a command to copy: only a plain hostname is (punycode is ASCII), and a URL that does not parse gets none.
    let host = '';
    try {
      host = new URL(image.url).hostname;
    } catch {
      // no host to suggest
    }
    const allow = host === '' || DEFAULT_ALLOWED_HOSTS.includes(host) || !/^[a-z0-9.-]+$/i.test(host) ? '' : ` --allow-host ${host}`;
    this.note(`${what} ${image.url} is not cached, and a render reads no network, so it is drawn without the picture: run \`kinetograph fetch-deps ${this.entry}${allow}\``);
    return null;
  }

  /** CSS text or the declarations of a `style` attribute, with the remote pictures it names read from the cache. */
  localizeCss(css: string): string {
    return rewriteCssImages(css, (image) => this.localImage(image, 'the CSS picture'));
  }

  style(el: PElement, ctx: Context): void {
    this.addCss(textOf(el), ctx.file, ctx);
  }

  /** Registers CSS text: Google Fonts imports taken out, urls made absolute, rules scoped. */
  addCss(text: string, file: string, ctx: Context): void {
    const taken = extractGoogleFontImports(text);
    this.fonts.push(...taken.fonts);
    let css = this.localizeCss(absolutizeUrls(taken.css, ctx.dir));
    css = ctx.scope === null ? rewriteDocumentSelectors(css) : scopeToComposition(css, ctx.scope, ctx.rootId);
    if (css.trim() === '') return;
    noteCss(this.fontUse, css);
    this.stylesheets.push({ css, file });
  }

  async link(el: PElement, ctx: Context): Promise<void> {
    const rel = (attrOf(el, 'rel') ?? '').toLowerCase().split(/\s+/);
    const href = attrOf(el, 'href');
    if (!rel.includes('stylesheet') || href === null) return;
    if (/^(https?:)?\/\//i.test(href)) {
      const fonts = parseGoogleFontsUrl(href.startsWith('//') ? `https:${href}` : href.replace(/&amp;/g, '&'));
      if (fonts.length > 0) this.fonts.push(...fonts);
      else this.note(`${ctx.file}: the stylesheet ${href} is remote and is not loaded`);
      return;
    }
    const path = this.asset(href, ctx);
    if (!existsSync(path)) {
      this.note(`${ctx.file}: <link href="${href}"> was not found`);
      return;
    }
    const read = readStylesheet(path);
    for (const file of read.files) this.files.add(file);
    for (const w of read.warnings) this.note(w);
    let css = read.css;
    if (usesTailwind(readFileSync(path, 'utf8'))) {
      const built = await buildTailwind(path);
      if ('css' in built) css = absolutizeUrls(built.css, dirname(path));
      else this.note(built.error);
    }
    this.addCss(css, path, { ...ctx, dir: dirname(path) });
  }

  // ---- the document ----

  async nodes(parent: PNode[], ctx: Context, svg: boolean): Promise<HfNode[]> {
    const out: HfNode[] = [];
    for (const node of parent) {
      if (isText(node)) out.push({ t: 'text', text: node.value });
      else if (isElement(node)) {
        const converted = await this.element(node, ctx, svg);
        if (converted !== null) out.push(converted);
      }
    }
    return out;
  }

  async element(el: PElement, ctx: Context, parentSvg: boolean): Promise<HfNode | null> {
    const tag = el.tagName;
    switch (tag) {
      case 'script':
        this.script(el, ctx);
        return null;
      case 'style':
        this.style(el, ctx);
        return null;
      case 'link':
        await this.link(el, ctx);
        return null;
      case 'meta':
      case 'title':
      case 'base':
      case 'noscript':
      case 'head':
        return null;
    }
    const svg = parentSvg || el.namespaceURI === SVG_NS;
    const attrs: [string, string][] = [];
    for (const a of el.attrs) {
      const name = a.prefix ? `${a.prefix}:${a.name}` : a.name;
      let value = a.value;
      if (FILE_ATTRIBUTES.has(name) || (name === 'href' && (svg || tag === 'use'))) value = this.asset(value, ctx);
      else if (name === 'style') {
        value = this.localizeCss(absolutizeUrls(value, ctx.dir));
        noteInline(this.fontUse, value);
      } else if (name === 'data-font-family') noteFamilyValue(this.fontUse, value);
      attrs.push([name, value]);
    }
    this.localizePictures(tag, attrs);
    if (MEDIA_TAGS.has(tag) || tag === 'source') {
      const at = attrs.findIndex(([n]) => n === 'src');
      const src = at < 0 ? undefined : attrs[at]![1];
      if (src && /^(https?:)?\/\//i.test(src.trim())) {
        // A remote file: played from the cache `fetch-deps` filled, else not played, and said so on every frame.
        const url = normalizeUrl(src.trim());
        this.mediaUrls.add(url);
        const found = resolveCdnData(url);
        if ('file' in found) {
          attrs[at] = ['src', found.file];
          this.mediaFiles.add(found.file);
        } else if (!this.options.discoverOnly) {
          this.note(`${tag === 'source' ? 'a <source>' : `<${tag}>`} of ${url} is not drawn: ${found.error}`);
        }
      } else if (src && !isRemote(src)) {
        const file = src.split(/[?#]/)[0]!;
        if (existsSync(file)) this.mediaFiles.add(file);
        else if (!this.options.discoverOnly) this.note(`<${tag === 'source' ? 'source' : tag}> src="${src}" was not found beside ${ctx.file} or in ${this.root}: it is not drawn`);
      }
    }
    // A page's `<template>` keeps its content apart from the document: its scripts and styles are not the page's.
    const inert = tag === 'template' ? await this.nodes(childrenOf((el as PTemplate).content), ctx, svg) : null;
    const node: HfNode = {
      t: 'el',
      tag,
      ...(svg ? { svg: true } : {}),
      attrs,
      children: inert === null ? await this.nodes(childrenOf(el), ctx, svg) : [],
      ...(inert !== null ? { content: inert } : {}),
    };
    const src = attrOf(el, 'data-composition-src');
    if (src !== null) await this.mount(node, src, ctx);
    return node;
  }

  /** The remote pictures of an element's attributes: `<img src|srcset>`, `<video poster>`, SVG `<image href>`. */
  localizePictures(tag: string, attrs: [string, string][]): void {
    const set = (name: string, value: string): void => {
      const at = attrs.findIndex(([n]) => n === name);
      if (at >= 0) attrs[at] = [name, value];
      else attrs.push([name, value]);
    };
    const get = (name: string): string | undefined => attrs.find(([n]) => n === name)?.[1];
    if (tag === 'img') {
      // A `srcset` is drawn as the browser would choose, so its candidate stands in for the `src`.
      const candidate = pickSrcset(get('srcset') ?? '');
      const chosen = candidate === null ? null : remoteImage(candidate);
      const src = get('src');
      const own = src === undefined ? null : remoteImage(src);
      const image = chosen ?? own;
      if (image !== null) {
        const file = this.localImage(image, '<img>');
        if (file !== null) set('src', file);
      }
    } else if (tag === 'video') {
      const poster = get('poster');
      const image = poster === undefined ? null : remoteImage(poster);
      if (image !== null) {
        const file = this.localImage(image, '<video poster>');
        if (file !== null) set('poster', file);
      }
    } else if (tag === 'image') {
      for (const name of ['href', 'xlink:href']) {
        const value = get(name);
        const image = value === undefined ? null : remoteImage(value);
        if (image === null) continue;
        const file = this.localImage(image, 'the SVG <image>');
        if (file !== null) set(name, file);
      }
    }
  }

  /** A host with `data-composition-src`: the file's content becomes the host's children. */
  async mount(host: HfNode & { t: 'el' }, src: string, ctx: Context): Promise<void> {
    host.attrs = host.attrs.filter(([n]) => n !== 'data-composition-src');
    const candidates = [resolve(this.root, src), resolve(ctx.dir, src)];
    const file = candidates.find((c) => existsSync(c) && statSync(c).isFile());
    if (file === undefined) {
      this.note(`${ctx.file}: data-composition-src="${src}" was not found beside ${ctx.file} or in ${this.root}`);
      return;
    }
    if (ctx.stack.includes(file)) {
      this.note(`${file}: composition mounts itself (${[...ctx.stack, file].join(' -> ')})`);
      return;
    }
    const doc = parse(this.read(file));
    // The composition's markup is in a `<template>` (anywhere in the file) or, failing that, the body.
    const template = findElement(doc, (e) => e.tagName === 'template') as PTemplate | null;
    const html = childrenOf(doc).find(isElement);
    const content: PNode[] = template
      ? childrenOf(template.content)
      : html
        ? [...childrenOf(html).filter(isElement).filter((e) => e.tagName === 'head').flatMap(childrenOf), ...childrenOf(html).filter(isElement).filter((e) => e.tagName === 'body').flatMap(childrenOf)]
        : [];
    const hostId = attrValue(host, 'data-composition-id');
    const inner = findComposition(content, hostId);
    const scope = hostId ?? (inner ? attrOf(inner, 'data-composition-id') : null) ?? ctx.scope;
    const rootId = inner ? attrOf(inner, 'id') : null;
    const sub: Context = { file, dir: dirname(file), scope, rootId, stack: [...ctx.stack, file] };

    // The variables the composition declares (on its root or `<html>`) under the values the host gives.
    const declared: Record<string, unknown> = {};
    const carriers = [inner, html && isElement(html) ? html : null].filter((e): e is PElement => e !== null);
    for (const carrier of carriers) {
      for (const item of safeJson(attrOf(carrier, 'data-composition-variables')) as { id?: string; default?: unknown }[] | null ?? []) {
        if (item && typeof item.id === 'string' && 'default' in item) declared[item.id] = item.default;
      }
    }
    const given = safeJson(attrValue(host, 'data-variable-values'));
    if (scope !== null) this.variables[scope] = { ...declared, ...(given && typeof given === 'object' ? (given as object) : {}) };

    const children: HfNode[] = [];
    for (const node of content) {
      if (inner !== null && node === inner) {
        if (hostId !== null) {
          children.push(...(await this.nodes(childrenOf(inner), sub, false)));
          mergeRootAttributes(host, inner);
        } else {
          const converted = await this.element(inner, sub, false);
          if (converted) children.push(converted);
        }
      } else if (isElement(node) && (node.tagName === 'style' || node.tagName === 'link' || node.tagName === 'script')) {
        await this.element(node, sub, false);
      }
    }
    if (inner === null) children.push(...(await this.nodes(content, sub, false)));
    host.children.push(...children);
  }
}

function attrValue(node: HfNode & { t: 'el' }, name: string): string | null {
  return node.attrs.find(([n]) => n === name)?.[1] ?? null;
}

function safeJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The mounted file's root gives the host what the host lacks: its classes and style, its `data-*`. */
function mergeRootAttributes(host: HfNode & { t: 'el' }, inner: PElement): void {
  const has = (name: string): boolean => host.attrs.some(([n]) => n === name);
  const set = (name: string, value: string): void => {
    const at = host.attrs.findIndex(([n]) => n === name);
    if (at >= 0) host.attrs[at] = [name, value];
    else host.attrs.push([name, value]);
  };
  for (const a of inner.attrs) {
    if (a.name === 'class') set('class', [attrValue(host, 'class'), a.value].filter(Boolean).join(' '));
    else if (a.name === 'style') set('style', [a.value.replace(/;?\s*$/, ';'), attrValue(host, 'style') ?? ''].join(' ').trim());
    else if (a.name.startsWith('data-') && a.name !== 'data-composition-src' && !has(a.name)) host.attrs.push([a.name, a.value]);
  }
}

function findElement(node: PNode | PParent, test: (el: PElement) => boolean): PElement | null {
  for (const child of childrenOf(node as PParent)) {
    if (isElement(child)) {
      if (test(child)) return child;
      const inner = findElement(child, test);
      if (inner) return inner;
    }
  }
  return null;
}

/** The composition root of a file's content: the element with the host's id, else the first with any. */
function findComposition(nodes: PNode[], id: string | null): PElement | null {
  const search = (list: PNode[], want: string | null): PElement | null => {
    for (const node of list) {
      if (!isElement(node)) continue;
      const own = attrOf(node, 'data-composition-id');
      if (own !== null && (want === null || own === want)) return node;
      const inner = search(childrenOf(node), want);
      if (inner) return inner;
    }
    return null;
  };
  return (id !== null ? search(nodes, id) : null) ?? search(nodes, null);
}

/** The first element, outermost first, that is a composition. */
function rootComposition(nodes: HfNode[]): (HfNode & { t: 'el' }) | null {
  for (const node of nodes) {
    if (node.t !== 'el') continue;
    if (node.attrs.some(([n]) => n === 'data-composition-id')) return node;
  }
  for (const node of nodes) {
    if (node.t !== 'el') continue;
    const inner = rootComposition(node.children);
    if (inner) return inner;
  }
  return null;
}

/** `width=1920, height=1080` of a viewport meta. */
function viewportSize(doc: PNode): { width?: number; height?: number } {
  const meta = findElement(doc as PParent, (e) => e.tagName === 'meta' && attrOf(e, 'name') === 'viewport');
  const content = meta ? (attrOf(meta, 'content') ?? '') : '';
  const width = /width\s*=\s*(\d+)/.exec(content)?.[1];
  const height = /height\s*=\s*(\d+)/.exec(content)?.[1];
  return { ...(width ? { width: Number(width) } : {}), ...(height ? { height: Number(height) } : {}) };
}

const positiveInt = (value: string | null): number | null => {
  const n = value === null ? NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/** `//host/x` is `https://host/x`. */
const normalizeUrl = (url: string): string => (url.startsWith('//') ? `https:${url}` : url);

/** Reads the project whose entry file is `indexFile`. */
export async function buildPlan(indexFile: string, options: PlanOptions = {}): Promise<BuiltPlan> {
  const file = resolve(indexFile);
  const root = dirname(file);
  // The cache is checked against the project's lock file as it is read.
  useLockFile(lockPathOf(file));
  const builder = new Builder(root, options, relative(process.cwd(), file) || file);
  const doc = parse(builder.read(file));
  const html = childrenOf(doc).find(isElement);
  if (html === undefined) throw new CliError('PROJECT_ERROR', `${file} has no <html> element`);
  const head = childrenOf(html).filter(isElement).find((e) => e.tagName === 'head');
  const bodyEl = childrenOf(html).filter(isElement).find((e) => e.tagName === 'body');
  const ctx: Context = { file, dir: root, scope: null, rootId: null, stack: [file] };

  // An index.html that is a fragment (no doctype, no `<html>`) is wrapped by HyperFrames in a document that resets margins
  // and padding, clips the body, paints it black and sets Inter (producer/src/services/htmlCompiler.ts: ensureFullDocument).
  const source = readFileSync(file, 'utf8').trim();
  if (!/^<!DOCTYPE\s+html/i.test(source) && !/^<html/i.test(source)) {
    builder.addCss('*{margin:0;padding:0;box-sizing:border-box}body{overflow:hidden;background:#000;font-family:"Inter",sans-serif}', file, ctx);
  }

  // The head's styles, links and scripts come before the body's, in document order.
  for (const node of head ? childrenOf(head) : []) if (isElement(node)) await builder.element(node, ctx, false);
  const body = await builder.nodes(bodyEl ? childrenOf(bodyEl) : [], ctx, false);

  const composition = rootComposition(body);
  const attr = (name: string): string | null => composition?.attrs.find(([n]) => n === name)?.[1] ?? null;
  const viewport = viewportSize(doc);
  const width = positiveInt(attr('data-width')) ?? viewport.width ?? 1920;
  const height = positiveInt(attr('data-height')) ?? viewport.height ?? 1080;
  const duration = attr('data-duration');
  const durationSeconds = duration !== null && Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : null;
  // A page without the root attributes is drawn at 1920x1080 for as long as its timelines run (1 s with none): say so.
  const absent = [
    ...(composition === null ? ['data-composition-id'] : []),
    ...(positiveInt(attr('data-width')) === null && viewport.width === undefined ? ['data-width'] : []),
    ...(positiveInt(attr('data-height')) === null && viewport.height === undefined ? ['data-height'] : []),
    ...(composition === null ? ['data-duration'] : []),
  ];
  if (absent.length > 0) {
    builder.note(
      `the root element lacks ${absent.join(', ')}, so the page is drawn at ${width}x${height}` +
        `${durationSeconds === null ? ' for as long as its timelines run (1 second with none)' : ''}: ` +
        `write it as <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="10"> ` +
        '(size in pixels, duration in seconds, 30 fps)',
    );
  }

  const attrsOf = (el: PElement | undefined): [string, string][] => (el ? el.attrs.map((a): [string, string] => [a.name, a.value]) : []);
  const mediaDurations: Record<string, number> = {};
  for (const media of builder.mediaFiles) {
    const seconds = options.probeDuration ? options.probeDuration(media) : null;
    if (seconds !== null && Number.isFinite(seconds) && seconds > 0) mediaDurations[media] = seconds;
  }
  // Module scripts are deferred: they run after every classic script, in document order. Their imports come from the
  // cache through the page's import map (`modules.ts`); the pre-download step has stored them.
  let computedImports = false;
  if (!options.discoverOnly) {
    for (const module of builder.modules) {
      try {
        const bundled = await bundleModuleScript(module, builder.importMap);
        computedImports ||= bundled.computed;
        for (const input of bundled.inputs) builder.files.add(input);
        builder.scripts.push({ code: bundled.code, file: module.file, scope: module.scope, sourceFile: module.sourceFile });
      } catch (error) {
        if (error instanceof CliError && (error.code === 'SCRIPT_NOT_AVAILABLE' || error.code === 'INTEGRITY_MISMATCH' || error.code === 'LOCK_MISMATCH')) throw error;
        builder.note(error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (builder.usesThree) builder.note('Three.js is not supported: its scenes are not drawn');

  const fonts = new Map<string, Set<string>>();
  for (const request of builder.fonts) {
    const set = fonts.get(request.family) ?? new Set<string>();
    for (const v of request.variants) set.add(v);
    fonts.set(request.family, set);
  }

  // The families the CSS names that HyperFrames embeds (or maps an operating-system name to): read from the font cache.
  finishUse(builder.fontUse);
  const googleFonts = [...fonts].map(([family, variants]): HfPlan['googleFonts'][number] => ({ family, variants: [...variants] }));
  for (const bundled of bundledUses(builder.fontUse, new Set(googleFonts.map((f) => f.family.toLowerCase())))) {
    const existing = googleFonts.find((f) => f.family === bundled.family);
    if (existing) existing.as = [...new Set([...(existing.as ?? []), ...bundled.as])];
    else googleFonts.push({ family: bundled.family, variants: bundled.weights, as: bundled.as, cacheOnly: true });
  }

  // The root's own variables: what `<html>` and the root element declare, under the values the root element gives.
  const rootId = attr('data-composition-id') ?? 'main';
  const declared: Record<string, unknown> = {};
  for (const text of [attrsOf(html).find(([n]) => n === 'data-composition-variables')?.[1] ?? null, attr('data-composition-variables')]) {
    for (const item of (safeJson(text) as { id?: string; default?: unknown }[] | null) ?? []) {
      if (item && typeof item.id === 'string' && 'default' in item) declared[item.id] = item.default;
    }
  }
  const given = safeJson(attr('data-variable-values'));
  builder.variables[rootId] = { ...declared, ...(given && typeof given === 'object' ? (given as object) : {}), ...builder.variables[rootId] };

  const plan: HfPlan = {
    file,
    baseDir: root,
    compositionId: rootId,
    width,
    height,
    fps: DEFAULT_FPS,
    durationSeconds,
    htmlAttrs: attrsOf(html),
    bodyAttrs: attrsOf(bodyEl),
    body,
    stylesheets: builder.stylesheets,
    scripts: builder.scripts,
    googleFonts,
    variables: builder.variables,
    remoteData: builder.remoteData,
    mediaDurations,
    notes: builder.notes,
    usesThree: builder.usesThree,
  };
  return {
    plan,
    files: [...builder.files],
    scriptUrls: [...new Set(builder.scriptUrls)],
    scriptIntegrity: builder.scriptIntegrity,
    dataUrls: [...builder.dataUrls],
    mediaUrls: [...builder.mediaUrls],
    imageUrls: [...builder.imageUrls],
    modules: builder.modules,
    importMap: builder.importMap,
    computedImports,
  };
}
