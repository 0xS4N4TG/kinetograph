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
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { HfNode, HfPlan, HfScript, HfStylesheet, HfSvgRule } from '@kinetographdev/core/hyperframes';
import { absolutizeUrls, buildTailwind, readStylesheet, usesTailwind } from '../css.js';
import { CliError } from '../errors.js';
import { resolveCdnScript } from './deps.js';
import {
  crossingRules,
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
}

export interface BuiltPlan {
  plan: HfPlan;
  /** Every file read, for the bundler to watch. */
  files: string[];
  /** The URLs of the CDN scripts the project loads (`fetch-deps` downloads these). */
  scriptUrls: string[];
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
  readonly svgRules: HfSvgRule[] = [];
  private ruleOrder = 0;
  readonly scripts: HfScript[] = [];
  readonly fonts: GoogleFontRequest[] = [];
  readonly variables: Record<string, Record<string, unknown>> = {};
  readonly mediaFiles = new Set<string>();
  readonly notes: string[] = [];
  readonly files = new Set<string>();
  readonly scriptUrls: string[] = [];
  usesThree = false;

  constructor(
    readonly root: string,
    readonly options: PlanOptions,
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
      this.note('import maps are not supported: scripts that import by bare name are not run');
      return;
    }
    if (type !== '' && type !== 'text/javascript' && type !== 'application/javascript' && type !== 'module') return;
    const src = attrOf(el, 'src');
    let code: string;
    let file: string;
    if (src !== null) {
      if (/^https?:\/\//i.test(src) || src.startsWith('//')) {
        const url = src.startsWith('//') ? `https:${src}` : src;
        this.scriptUrls.push(url);
        if (THREE_URL.test(url)) this.usesThree = true;
        const found = (this.options.resolveScriptUrl ?? resolveCdnScript)(url, this.root);
        if ('error' in found) {
          if (!this.options.discoverOnly) throw new CliError('SCRIPT_NOT_AVAILABLE', `${ctx.file}: ${found.error}`);
          return;
        }
        code = this.read(found.file);
        file = url;
      } else {
        const path = this.asset(src, ctx);
        if (!existsSync(path)) throw new CliError('SCRIPT_NOT_FOUND', `${ctx.file}: <script src="${src}"> was not found beside ${ctx.file} or in ${this.root}`);
        code = this.read(path);
        file = path;
      }
    } else {
      code = textOf(el);
      file = ctx.file;
    }
    if (type === 'module') {
      if (/^\s*import\s[^(]|^\s*export\s/m.test(code)) {
        this.note(`${file}: an ES module script (it imports) is not run`);
        return;
      }
    }
    if (/\bTHREE\.(WebGLRenderer|Scene|PerspectiveCamera)\b/.test(code)) this.usesThree = true;
    this.scripts.push({ code, file, scope: src === null ? ctx.scope : null, sourceFile: src === null && ctx.scope !== null ? ctx.file : null });
  }

  style(el: PElement, ctx: Context): void {
    this.addCss(textOf(el), ctx.file, ctx);
  }

  /** Registers CSS text: Google Fonts imports taken out, urls made absolute, rules scoped. */
  addCss(text: string, file: string, ctx: Context): void {
    const taken = extractGoogleFontImports(text);
    this.fonts.push(...taken.fonts);
    let css = absolutizeUrls(taken.css, ctx.dir);
    css = ctx.scope === null ? rewriteDocumentSelectors(css) : scopeToComposition(css, ctx.scope, ctx.rootId);
    if (css.trim() === '') return;
    this.stylesheets.push({ css, file });
    this.svgRules.push(...crossingRules(css, this.ruleOrder));
    // The next sheet's rules come after this one's: their order counts the blocks of the sheets so far.
    this.ruleOrder += css.split('{').length + 1;
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
      case 'template':
      case 'head':
        return null;
    }
    const svg = parentSvg || el.namespaceURI === SVG_NS;
    const attrs: [string, string][] = [];
    for (const a of el.attrs) {
      const name = a.prefix ? `${a.prefix}:${a.name}` : a.name;
      let value = a.value;
      if (FILE_ATTRIBUTES.has(name) || (name === 'href' && (svg || tag === 'use'))) value = this.asset(value, ctx);
      else if (name === 'style') value = absolutizeUrls(value, ctx.dir);
      attrs.push([name, value]);
    }
    if (MEDIA_TAGS.has(tag)) {
      const src = attrs.find(([n]) => n === 'src')?.[1];
      if (src && !isRemote(src) && existsSync(src.split(/[?#]/)[0]!)) this.mediaFiles.add(src.split(/[?#]/)[0]!);
    }
    if (tag === 'source') {
      const src = attrs.find(([n]) => n === 'src')?.[1];
      if (src && !isRemote(src) && existsSync(src.split(/[?#]/)[0]!)) this.mediaFiles.add(src.split(/[?#]/)[0]!);
    }
    const content = tag === 'template' ? [] : childrenOf(el);
    const node: HfNode = { t: 'el', tag, ...(svg ? { svg: true } : {}), attrs, children: await this.nodes(content, ctx, svg) };
    const src = attrOf(el, 'data-composition-src');
    if (src !== null) await this.mount(node, src, ctx);
    return node;
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

/** Reads the project whose entry file is `indexFile`. */
export async function buildPlan(indexFile: string, options: PlanOptions = {}): Promise<BuiltPlan> {
  const file = resolve(indexFile);
  const root = dirname(file);
  const builder = new Builder(root, options);
  const doc = parse(builder.read(file));
  const html = childrenOf(doc).find(isElement);
  if (html === undefined) throw new CliError('PROJECT_ERROR', `${file} has no <html> element`);
  const head = childrenOf(html).filter(isElement).find((e) => e.tagName === 'head');
  const bodyEl = childrenOf(html).filter(isElement).find((e) => e.tagName === 'body');
  const ctx: Context = { file, dir: root, scope: null, rootId: null, stack: [file] };

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

  const attrsOf = (el: PElement | undefined): [string, string][] => (el ? el.attrs.map((a): [string, string] => [a.name, a.value]) : []);
  const mediaDurations: Record<string, number> = {};
  for (const media of builder.mediaFiles) {
    const seconds = options.probeDuration ? options.probeDuration(media) : null;
    if (seconds !== null && Number.isFinite(seconds) && seconds > 0) mediaDurations[media] = seconds;
  }
  if (builder.usesThree) builder.note('Three.js is not supported: its scenes are not drawn');

  const fonts = new Map<string, Set<string>>();
  for (const request of builder.fonts) {
    const set = fonts.get(request.family) ?? new Set<string>();
    for (const v of request.variants) set.add(v);
    fonts.set(request.family, set);
  }

  const plan: HfPlan = {
    file,
    baseDir: root,
    compositionId: attr('data-composition-id') ?? 'main',
    width,
    height,
    fps: DEFAULT_FPS,
    durationSeconds,
    htmlAttrs: attrsOf(html),
    bodyAttrs: attrsOf(bodyEl),
    body,
    stylesheets: builder.stylesheets,
    scripts: builder.scripts,
    svgRules: builder.svgRules,
    googleFonts: [...fonts].map(([family, variants]) => ({ family, variants: [...variants] })),
    variables: builder.variables,
    mediaDurations,
    notes: builder.notes,
    usesThree: builder.usesThree,
  };
  return { plan, files: [...builder.files], scriptUrls: [...new Set(builder.scriptUrls)] };
}
