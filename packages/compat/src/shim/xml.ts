// XML documents (`DOMParser` for `text/xml`, `application/xml`, `application/xhtml+xml` and `image/svg+xml`, and
// `XMLHttpRequest.responseXML`). XML is not HTML: names keep their case, any name is an element, namespaces are real, and
// a document that is not well formed is not repaired. So it has its own parser and its own small tree instead of the
// host tree the reconciler draws (which only holds the element names the engine can lay out). A parsed document is data
// to read, never painted, and is not changed after parsing: the tree has no mutators. The selector matcher is shared
// (querySelector on an XML document is the one `querySelector` on the page's).

import { cssPropertyName } from '../request/style.js';
import { attributeMapOf, AttrShim, type NamedNodeMapShim } from './attributes.js';
import { DomNodeBase } from './element.js';
import { isKnownCssProperty } from './css-names.js';
import type { HostElement } from './host.js';
import { collectionOf, nodeListOf, type HTMLCollection, type NodeList } from './lists.js';
import { queryAll, matches, type SelectorContext } from './selector.js';
import { declarations } from './stylesheet.js';

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

// ---- the tree ----

/** What every node has: where it hangs, and its neighbours (the tree is not changed after parsing, so the position is kept). */
export abstract class XmlNode extends DomNodeBase {
  parent: XmlParent | null = null;
  /** The node's position among its parent's children. */
  index = 0;
  owner: XmlDocument | null = null;

  abstract override get nodeType(): number;
  abstract override get nodeName(): string;
  abstract get textContent(): string | null;
  override get nodeValue(): string | null {
    return null;
  }
  override get ownerDocument(): XmlDocument | null {
    return this.owner;
  }
  get parentNode(): XmlParent | null {
    return this.parent;
  }
  get parentElement(): XmlElement | null {
    return this.parent instanceof XmlElement ? this.parent : null;
  }
  get previousSibling(): XmlNode | null {
    return this.parent?.kids[this.index - 1] ?? null;
  }
  get nextSibling(): XmlNode | null {
    return this.parent?.kids[this.index + 1] ?? null;
  }
  get previousElementSibling(): XmlElement | null {
    for (let i = this.index - 1; i >= 0; i--) {
      const node = this.parent!.kids[i]!;
      if (node instanceof XmlElement) return node;
    }
    return null;
  }
  get nextElementSibling(): XmlElement | null {
    const kids = this.parent?.kids ?? [];
    for (let i = this.index + 1; i < kids.length; i++) if (kids[i] instanceof XmlElement) return kids[i] as XmlElement;
    return null;
  }
  get isConnected(): boolean {
    return true;
  }
  hasChildNodes(): boolean {
    return false;
  }
  contains(other: unknown): boolean {
    for (let node = other as XmlNode | null; node instanceof XmlNode; node = node.parent) if (node === this) return true;
    return false;
  }
  getRootNode(): XmlNode {
    let node: XmlNode = this;
    while (node.parent !== null) node = node.parent;
    return node;
  }
}

/** A node with children: an element or a document. */
export abstract class XmlParent extends XmlNode {
  readonly kids: NodeList<XmlNode> = nodeListOf<XmlNode>([]);
  private elementList: HTMLCollection<XmlElement> | null = null;

  /** Appends a parsed child (what the parser uses). */
  add(node: XmlNode): void {
    node.parent = this;
    node.index = this.kids.length;
    node.owner = this instanceof XmlDocument ? this : this.owner;
    this.kids.push(node);
  }
  get childNodes(): NodeList<XmlNode> {
    return this.kids;
  }
  get children(): HTMLCollection<XmlElement> {
    return (this.elementList ??= collectionOf(this.kids.filter((n): n is XmlElement => n instanceof XmlElement)));
  }
  get childElementCount(): number {
    return this.children.length;
  }
  get firstChild(): XmlNode | null {
    return this.kids[0] ?? null;
  }
  get lastChild(): XmlNode | null {
    return this.kids.at(-1) ?? null;
  }
  get firstElementChild(): XmlElement | null {
    return this.children[0] ?? null;
  }
  get lastElementChild(): XmlElement | null {
    return this.children.at(-1) ?? null;
  }
  override hasChildNodes(): boolean {
    return this.kids.length > 0;
  }

  /** The elements below this node, in document order. */
  descendantElements(): XmlElement[] {
    const out: XmlElement[] = [];
    const todo: XmlNode[] = [...this.kids].reverse();
    for (let node = todo.pop(); node !== undefined; node = todo.pop()) {
      if (!(node instanceof XmlElement)) continue;
      out.push(node);
      for (let i = node.kids.length - 1; i >= 0; i--) todo.push(node.kids[i]!);
    }
    return out;
  }
  getElementsByTagName(name: string): HTMLCollection<XmlElement> {
    const all = this.descendantElements();
    return collectionOf(name === '*' ? all : all.filter((e) => e.tagName === String(name)));
  }
  /** `ns` null (or empty) is no namespace; `*` for either argument is any. */
  getElementsByTagNameNS(ns: string | null, localName: string): HTMLCollection<XmlElement> {
    const space = ns === '' ? null : ns;
    return collectionOf(this.descendantElements().filter((e) => (space === '*' || e.namespaceURI === space) && (localName === '*' || e.localName === localName)));
  }
  getElementsByClassName(names: string): HTMLCollection<XmlElement> {
    const wanted = String(names).split(/\s+/).filter(Boolean);
    return collectionOf(this.descendantElements().filter((e) => wanted.every((w) => (e.getAttribute('class') ?? '').split(/\s+/).includes(w))));
  }
  querySelectorAll(selector: string): NodeList<XmlElement> {
    return nodeListOf(queryAll(this.descendantElements() as unknown as HostElement[], selector, context, false) as unknown as XmlElement[]);
  }
  querySelector(selector: string): XmlElement | null {
    return (queryAll(this.descendantElements() as unknown as HostElement[], selector, context, true)[0] as unknown as XmlElement | undefined) ?? null;
  }
}

/** Text in the tree: a text node, a CDATA section, a comment or a processing instruction. */
export abstract class XmlCharacterData extends XmlNode {
  constructor(public data: string) {
    super();
  }
  override get nodeValue(): string {
    return this.data;
  }
  get length(): number {
    return this.data.length;
  }
  get textContent(): string {
    return this.data;
  }
}
export class XmlText extends XmlCharacterData {
  get nodeType(): number {
    return 3;
  }
  get nodeName(): string {
    return '#text';
  }
}
export class XmlCDATASection extends XmlText {
  override get nodeType(): number {
    return 4;
  }
  override get nodeName(): string {
    return '#cdata-section';
  }
}
export class XmlComment extends XmlCharacterData {
  get nodeType(): number {
    return 8;
  }
  get nodeName(): string {
    return '#comment';
  }
}
export class XmlProcessingInstruction extends XmlCharacterData {
  constructor(readonly target: string, data: string) {
    super(data);
  }
  get nodeType(): number {
    return 7;
  }
  get nodeName(): string {
    return this.target;
  }
}

interface XmlAttribute {
  name: string;
  prefix: string | null;
  localName: string;
  namespaceURI: string | null;
  value: string;
}

export class XmlElement extends XmlParent {
  constructor(
    /** The name as written (`rdf:Description`). */
    readonly tagName: string,
    readonly prefix: string | null,
    readonly localName: string,
    readonly namespaceURI: string | null,
    readonly attrs: XmlAttribute[],
  ) {
    super();
  }
  get nodeType(): number {
    return 1;
  }
  get nodeName(): string {
    return this.tagName;
  }
  get id(): string {
    return this.getAttribute('id') ?? '';
  }
  get className(): string {
    return this.getAttribute('class') ?? '';
  }
  get textContent(): string {
    let text = '';
    const todo: XmlNode[] = [...this.kids].reverse();
    for (let node = todo.pop(); node !== undefined; node = todo.pop()) {
      if (node instanceof XmlText) text += node.data;
      else if (node instanceof XmlElement) for (let i = node.kids.length - 1; i >= 0; i--) todo.push(node.kids[i]!);
    }
    return text;
  }

  // Attributes are found by the name as written, with its case.
  private find(name: string): XmlAttribute | undefined {
    return this.attrs.find((a) => a.name === name);
  }
  getAttribute(name: string): string | null {
    return this.find(String(name))?.value ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.find(String(name)) !== undefined;
  }
  getAttributeNames(): string[] {
    return this.attrs.map((a) => a.name);
  }
  hasAttributes(): boolean {
    return this.attrs.length > 0;
  }
  private findNS(ns: string | null, localName: string): XmlAttribute | undefined {
    const space = ns === '' ? null : ns;
    return this.attrs.find((a) => a.namespaceURI === space && a.localName === localName);
  }
  getAttributeNS(ns: string | null, localName: string): string | null {
    return this.findNS(ns, String(localName))?.value ?? null;
  }
  hasAttributeNS(ns: string | null, localName: string): boolean {
    return this.findNS(ns, String(localName)) !== undefined;
  }
  getAttributeNode(name: string): AttrShim | null {
    const found = this.find(String(name));
    return found === undefined ? null : new AttrShim(this, found.name, found.value);
  }
  get attributes(): NamedNodeMapShim {
    return attributeMapOf(this, this);
  }
  setAttribute(name: string, value: unknown): void {
    const found = this.find(String(name));
    if (found !== undefined) found.value = String(value);
    else {
      const colon = String(name).indexOf(':');
      this.attrs.push({ name: String(name), prefix: colon < 0 ? null : name.slice(0, colon), localName: colon < 0 ? String(name) : name.slice(colon + 1), namespaceURI: null, value: String(value) });
    }
  }
  removeAttribute(name: string): void {
    const at = this.attrs.findIndex((a) => a.name === String(name));
    if (at >= 0) this.attrs.splice(at, 1);
  }

  /** `element.style` of an SVG or XHTML element: the `style` attribute's declarations. XML elements of other namespaces have none. */
  get style(): CSSStyleDeclaration | undefined {
    if (this.namespaceURI !== SVG_NS && this.namespaceURI !== XHTML_NS) return undefined;
    return (this.styleObject ??= inlineStyleOf(this));
  }
  private styleObject: CSSStyleDeclaration | null = null;

  matches(selector: string): boolean {
    return matches(this as unknown as HostElement, selector, context);
  }
  closest(selector: string): XmlElement | null {
    for (let e: XmlElement | null = this; e !== null; e = e.parentElement) if (e.matches(selector)) return e;
    return null;
  }
}

export class XmlDocument extends XmlParent {
  doctype: { name: string; publicId: string; systemId: string; nodeType: number } | null = null;
  readonly characterSet = 'UTF-8';
  readonly head = null;
  readonly body = null;
  private ids: Map<string, XmlElement> | null = null;

  constructor(readonly contentType: string) {
    super();
  }
  get nodeType(): number {
    return 9;
  }
  get nodeName(): string {
    return '#document';
  }
  get textContent(): null {
    return null;
  }
  override get ownerDocument(): null {
    return null;
  }
  get documentElement(): XmlElement | null {
    return this.firstElementChild;
  }
  getElementById(id: string): XmlElement | null {
    if (this.ids === null) {
      this.ids = new Map();
      for (const element of this.descendantElements()) {
        const value = element.getAttribute('id');
        if (value !== null && !this.ids.has(value)) this.ids.set(value, element);
      }
    }
    return this.ids.get(String(id)) ?? null;
  }
}

// Selectors read the tree through these: an XML element stands in for the host element the matcher is written for
// (`type` is what a type selector tests; the XML name keeps its case, the matcher compares without it).
Object.defineProperty(XmlElement.prototype, 'type', { get(this: XmlElement) { return this.tagName; } });
const context: SelectorContext = {
  parent: (h) => ((h as unknown as XmlElement).parentElement as unknown as HostElement | null),
  children: (h) => ((h as unknown as XmlElement).children as unknown as HostElement[]),
  attribute: (h, name) => (h as unknown as XmlElement).getAttribute(name),
};

// ---- element.style ----

const withoutPriority = (value: string): string => value.replace(/\s*!important\s*$/i, '');

function inlineStyleOf(element: XmlElement): CSSStyleDeclaration {
  const items = (): [string, string][] => declarations(element.getAttribute('style') ?? '');
  const write = (next: [string, string][]): void => {
    const text = next.map(([n, v]) => `${n}: ${v};`).join(' ');
    if (text === '') element.removeAttribute('style');
    else element.setAttribute('style', text);
  };
  const target = {
    getPropertyValue: (name: string): string => withoutPriority(items().findLast(([n]) => n.toLowerCase() === name.toLowerCase())?.[1] ?? ''),
    setProperty(name: string, value: string | null): void {
      const all = items();
      const at = all.findIndex(([n]) => n.toLowerCase() === name.toLowerCase());
      if (value === null || value === '') write(all.filter(([n]) => n.toLowerCase() !== name.toLowerCase()));
      else if (at < 0) write([...all, [name, String(value)]]);
      else write(all.map((d, i): [string, string] => (i === at ? [d[0], String(value)] : d)));
    },
    removeProperty(name: string): string {
      const old = target.getPropertyValue(name);
      write(items().filter(([n]) => n.toLowerCase() !== name.toLowerCase()));
      return old;
    },
    item: (index: number): string => items()[index]?.[0] ?? '',
    get length(): number {
      return items().length;
    },
    get cssText(): string {
      return element.getAttribute('style') ?? '';
    },
    set cssText(text: string) {
      write(declarations(String(text)));
    },
  };
  // `style.fill`, `style.strokeWidth` and `style['stroke-width']` all read the declaration.
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, receiver);
      return isKnownCssProperty(prop) ? t.getPropertyValue(cssPropertyName(prop)) : undefined;
    },
    set(t, prop, value, receiver) {
      if (typeof prop === 'symbol' || prop === 'cssText') return Reflect.set(t, prop, value, receiver);
      t.setProperty(cssPropertyName(prop), value == null ? '' : String(value));
      return true;
    },
    has: (t, prop) => prop in t || (typeof prop === 'string' && isKnownCssProperty(prop)),
  }) as unknown as CSSStyleDeclaration;
}

// ---- the parser ----

class XmlSyntaxError extends Error {
  constructor(message: string, readonly at: number) {
    super(message);
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const NAME_START = 'A-Za-z_:\\u00C0-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
const NAME = new RegExp(`[${NAME_START}][${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*`, 'y');

/** The text with `&amp;`, `&#10;` and `&#x20;` replaced; an entity no DTD defines is an error, as in a browser. */
function decode(text: string, at: number): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[^&;\s]*);?/g, (match, body: string) => {
    if (!match.endsWith(';')) throw new XmlSyntaxError("EntityRef: expecting ';'", at);
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!(code > 0 && code <= 0x10ffff)) throw new XmlSyntaxError(`xmlParseCharRef: invalid xmlChar value ${code}`, at);
      return String.fromCodePoint(code);
    }
    const value = ENTITIES[body];
    if (value === undefined) throw new XmlSyntaxError(`Entity '${body}' not defined`, at);
    return value;
  });
}

interface Scope {
  element: XmlElement;
  /** The prefixes declared on this element (`''` is the default namespace). */
  declared: Map<string, string | null>;
}

function parseInto(doc: XmlDocument, source: string): void {
  let pos = 0;
  const stack: Scope[] = [];
  let sawRoot = false;
  const name = (what: string): string => {
    NAME.lastIndex = pos;
    const found = NAME.exec(source);
    if (found === null) throw new XmlSyntaxError(`${what} expected`, pos);
    pos += found[0].length;
    return found[0];
  };
  const space = (): boolean => {
    const start = pos;
    while (pos < source.length && /[ \t\n\r]/.test(source[pos]!)) pos++;
    return pos > start;
  };
  const lookup = (prefix: string): string | null | undefined => {
    if (prefix === 'xml') return XML_NS;
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.declared.has(prefix)) return stack[i]!.declared.get(prefix) ?? null;
    return prefix === '' ? null : undefined;
  };
  const parent = (): XmlParent => stack.at(-1)?.element ?? doc;
  const until = (end: string, what: string): string => {
    const stop = source.indexOf(end, pos);
    if (stop === -1) throw new XmlSyntaxError(`${what} not finished`, pos);
    const text = source.slice(pos, stop);
    pos = stop + end.length;
    return text;
  };

  while (pos < source.length) {
    if (source[pos] !== '<') {
      const stop = source.indexOf('<', pos);
      const raw = source.slice(pos, stop === -1 ? source.length : stop);
      if (stack.length === 0) {
        if (raw.trim() !== '') throw new XmlSyntaxError(sawRoot ? 'Extra content at the end of the document' : "Start tag expected, '<' not found", pos);
      } else {
        const text = new XmlText(decode(raw, pos));
        parent().add(text);
      }
      pos += raw.length;
      continue;
    }
    if (source.startsWith('<!--', pos)) {
      pos += 4;
      parent().add(new XmlComment(until('-->', 'Comment')));
    } else if (source.startsWith('<![CDATA[', pos)) {
      if (stack.length === 0) throw new XmlSyntaxError('Start tag expected, \'<\' not found', pos);
      pos += 9;
      parent().add(new XmlCDATASection(until(']]>', 'CData section')));
    } else if (source.startsWith('<!DOCTYPE', pos)) {
      if (sawRoot || doc.doctype !== null) throw new XmlSyntaxError('StartTag: invalid element name', pos);
      pos += 9;
      space();
      const type = name('Name');
      let depth = 0;
      let quote = '';
      for (; pos < source.length; pos++) {
        const c = source[pos]!;
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (pos >= source.length) throw new XmlSyntaxError('DOCTYPE improperly terminated', pos);
      pos++;
      doc.doctype = { name: type, publicId: '', systemId: '', nodeType: 10 };
    } else if (source.startsWith('<?', pos)) {
      const start = pos;
      pos += 2;
      const target = name('PI target');
      const data = until('?>', 'PI').replace(/^[ \t\n\r]+/, '');
      // The XML declaration is not a node, and may only open the document.
      if (target.toLowerCase() !== 'xml') parent().add(new XmlProcessingInstruction(target, data));
      else if (target !== 'xml' || start !== 0) throw new XmlSyntaxError('XML declaration allowed only at the start of the document', start);
    } else if (source[pos + 1] === '/') {
      const at = pos;
      pos += 2;
      const end = name('Name');
      space();
      if (source[pos] !== '>') throw new XmlSyntaxError("expected '>'", pos);
      pos++;
      const open = stack.pop();
      if (open === undefined) throw new XmlSyntaxError('Extra content at the end of the document', at);
      if (open.element.tagName !== end) throw new XmlSyntaxError(`Opening and ending tag mismatch: ${open.element.tagName} and ${end}`, at);
    } else {
      if (stack.length === 0 && sawRoot) throw new XmlSyntaxError('Extra content at the end of the document', pos);
      pos++;
      const tag = name('StartTag: invalid element name');
      const raw: { name: string; value: string }[] = [];
      let selfClosing = false;
      for (;;) {
        const separated = space();
        if (source[pos] === '>') {
          pos++;
          break;
        }
        if (source[pos] === '/' && source[pos + 1] === '>') {
          pos += 2;
          selfClosing = true;
          break;
        }
        if (pos >= source.length) throw new XmlSyntaxError(`Couldn't find end of Start Tag ${tag}`, pos);
        if (!separated) throw new XmlSyntaxError('attributes construct error', pos);
        const key = name('Specification mandates value for attribute');
        space();
        if (source[pos] !== '=') throw new XmlSyntaxError(`Specification mandates value for attribute ${key}`, pos);
        pos++;
        space();
        const quote = source[pos];
        if (quote !== '"' && quote !== "'") throw new XmlSyntaxError('AttValue: " or \' expected', pos);
        pos++;
        const stop = source.indexOf(quote, pos);
        if (stop === -1) throw new XmlSyntaxError('AttValue: \' expected', pos);
        const value = source.slice(pos, stop);
        if (value.includes('<')) throw new XmlSyntaxError('Unescaped \'<\' not allowed in attributes values', pos);
        if (raw.some((a) => a.name === key)) throw new XmlSyntaxError(`Attribute ${key} redefined`, pos);
        raw.push({ name: key, value: decode(value.replace(/[\t\n\r]/g, ' '), pos) });
        pos = stop + 1;
      }
      // Namespaces: what this element declares applies to it and its attributes.
      const declared = new Map<string, string | null>();
      for (const a of raw) {
        if (a.name === 'xmlns') declared.set('', a.value === '' ? null : a.value);
        else if (a.name.startsWith('xmlns:')) declared.set(a.name.slice(6), a.value);
      }
      const holder = parent();
      const scope: Scope = { element: null as unknown as XmlElement, declared };
      stack.push(scope);
      const colon = tag.indexOf(':');
      const prefix = colon < 0 ? null : tag.slice(0, colon);
      const uri = lookup(prefix ?? '');
      if (uri === undefined) throw new XmlSyntaxError(`Namespace prefix ${prefix} on ${tag} is not defined`, pos);
      const attrs: XmlAttribute[] = raw.map((a) => {
        const c = a.name.indexOf(':');
        const p = c < 0 ? null : a.name.slice(0, c);
        let ns: string | null = null;
        if (a.name === 'xmlns' || p === 'xmlns') ns = XMLNS_NS;
        else if (p !== null) {
          const found = lookup(p);
          if (found === undefined) throw new XmlSyntaxError(`Namespace prefix ${p} for ${a.name.slice(c + 1)} on ${tag} is not defined`, pos);
          ns = found;
        }
        return { name: a.name, prefix: p, localName: c < 0 ? a.name : a.name.slice(c + 1), namespaceURI: ns, value: a.value };
      });
      const element = new XmlElement(tag, prefix, colon < 0 ? tag : tag.slice(colon + 1), uri, attrs);
      holder.add(element);
      sawRoot = true;
      scope.element = element;
      if (selfClosing) stack.pop();
    }
  }
  if (stack.length > 0) throw new XmlSyntaxError(`Premature end of data in tag ${stack.at(-1)!.element.tagName}`, pos);
  if (!sawRoot) throw new XmlSyntaxError('Document is empty', pos);
}

/** The document `text` makes as `type`; markup that is not well formed makes the `parsererror` document a browser makes. */
export function parseXmlDocument(text: string, type: string): XmlDocument {
  const source = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const doc = new XmlDocument(type);
  try {
    parseInto(doc, source);
    return doc;
  } catch (error) {
    if (!(error instanceof XmlSyntaxError)) throw error;
    const before = source.slice(0, error.at);
    const line = before.split('\n').length;
    const column = error.at - (before.lastIndexOf('\n') + 1) + 1;
    const failed = new XmlDocument(type);
    const root = new XmlElement('parsererror', null, 'parsererror', XHTML_NS, [{ name: 'xmlns', prefix: null, localName: 'xmlns', namespaceURI: XMLNS_NS, value: XHTML_NS }]);
    failed.add(root);
    for (const [tag, content] of [['h3', 'This page contains the following errors:'], ['div', `error on line ${line} at column ${column}: ${error.message}`]] as const) {
      const child = new XmlElement(tag, null, tag, XHTML_NS, []);
      root.add(child);
      child.add(new XmlText(content));
    }
    return failed;
  }
}
