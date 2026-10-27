// `element.attributes` (a `NamedNodeMap`) and the `Attr` nodes in it. The host tree keeps attributes as props, so an `Attr`
// is a snapshot of one name and value with a link to its element; the map is live in that it reads the element's attributes
// each time it is asked, and it is one object per element (DOMPurify compares `form.attributes` with what the prototype
// getter returns, to find a form whose attributes a child's `name` has shadowed).

const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/** The element methods the map needs. */
export interface AttributeOwner {
  getAttributeNames(): string[];
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: unknown): void;
  removeAttribute(name: string): void;
}

export class AttrShim {
  readonly nodeType = 2;
  constructor(
    readonly ownerElement: AttributeOwner | null,
    readonly name: string,
    public value: string,
  ) {}
  get nodeName(): string {
    return this.name;
  }
  get nodeValue(): string {
    return this.value;
  }
  get textContent(): string {
    return this.value;
  }
  get specified(): boolean {
    return true;
  }
  get prefix(): string | null {
    const colon = this.name.indexOf(':');
    return colon === -1 ? null : this.name.slice(0, colon);
  }
  get localName(): string {
    const colon = this.name.indexOf(':');
    return colon === -1 ? this.name : this.name.slice(colon + 1);
  }
  get namespaceURI(): string | null {
    switch (this.prefix) {
      case 'xlink': return XLINK_NS;
      case 'xml': return XML_NS;
      case 'xmlns': return XMLNS_NS;
      default: return this.name === 'xmlns' ? XMLNS_NS : null;
    }
  }
}

export class NamedNodeMapShim {
  [index: number]: AttrShim;
  constructor(private readonly owner: AttributeOwner) {}
  private list(): AttrShim[] {
    return this.owner.getAttributeNames().map((name) => new AttrShim(this.owner, name, this.owner.getAttribute(name) ?? ''));
  }
  get length(): number {
    return this.owner.getAttributeNames().length;
  }
  item(index: number): AttrShim | null {
    return this.list()[index] ?? null;
  }
  getNamedItem(name: string): AttrShim | null {
    const value = this.owner.getAttribute(String(name));
    return value === null ? null : new AttrShim(this.owner, String(name), value);
  }
  getNamedItemNS(_ns: string | null, localName: string): AttrShim | null {
    return this.list().find((a) => a.localName === localName) ?? null;
  }
  setNamedItem(attr: AttrShim): AttrShim | null {
    const old = this.getNamedItem(attr.name);
    this.owner.setAttribute(attr.name, attr.value);
    return old;
  }
  removeNamedItem(name: string): AttrShim {
    const old = this.getNamedItem(name);
    if (old === null) throw Object.assign(new Error(`Failed to execute 'removeNamedItem' on 'NamedNodeMap': No item with name '${name}' was found.`), { name: 'NotFoundError', code: 8 });
    this.owner.removeAttribute(old.name);
    return old;
  }
  [Symbol.iterator](): Iterator<AttrShim> {
    return this.list()[Symbol.iterator]();
  }
}

const maps = new WeakMap<object, NamedNodeMapShim>();

/** The element's attribute map: the same object each time, and `map[0]`, `map[1]`… read the current attributes. */
export function attributeMapOf(host: object, owner: AttributeOwner): NamedNodeMapShim {
  let map = maps.get(host);
  if (map === undefined) {
    const target = new NamedNodeMapShim(owner);
    map = new Proxy(target, {
      get(t, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) return t.item(Number(prop)) ?? undefined;
        return Reflect.get(t, prop, receiver === map ? t : receiver);
      },
      has(t, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) return Number(prop) < t.length;
        return Reflect.has(t, prop);
      },
    });
    maps.set(host, map);
  }
  return map;
}
