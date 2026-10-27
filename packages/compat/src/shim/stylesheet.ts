// A constructable `CSSStyleSheet` (`new CSSStyleSheet()`, `insertRule`, `replaceSync`, `cssRules`) as a script holds it to build
// CSS text: Mermaid assembles its diagram styles this way. It is a store of rules a script reads back as text; the engine's own
// cascade reads the stylesheets of the page (`registerStylesheet`), not these. A rule keeps its source text; a style rule's
// declarations can be read and set (`rule.style`).

/** Splits `css` into top-level rules, each `prelude { body }` (at-rules without a body, `@import x;`, end at the `;`). */
function splitRules(css: string): string[] {
  const rules: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  let start = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        rules.push(text.slice(start, i + 1).trim());
        start = i + 1;
      }
    } else if (c === ';' && depth === 0) {
      const rule = text.slice(start, i + 1).trim();
      if (rule.startsWith('@')) rules.push(rule);
      start = i + 1;
    }
  }
  return rules.filter((r) => r !== '');
}

/** `a: b; c: d` as pairs (a `;` inside parentheses or quotes does not split). */
function declarations(body: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let quote = '';
  let from = 0;
  const flush = (to: number): void => {
    const part = body.slice(from, to);
    const colon = part.indexOf(':');
    if (colon > 0) out.push([part.slice(0, colon).trim(), part.slice(colon + 1).trim()]);
    from = to + 1;
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth === 0) flush(i);
  }
  flush(body.length);
  return out;
}

export class CSSStyleDeclarationShim {
  private items: [string, string][];
  constructor(items: [string, string][] = []) {
    this.items = items;
  }
  get length(): number {
    return this.items.length;
  }
  item(index: number): string {
    return this.items[index]?.[0] ?? '';
  }
  getPropertyValue(name: string): string {
    return this.items.find(([n]) => n === name)?.[1] ?? '';
  }
  setProperty(name: string, value: string | number | null): void {
    if (value === null || value === '') {
      this.removeProperty(name);
      return;
    }
    const existing = this.items.find(([n]) => n === name);
    if (existing) existing[1] = String(value);
    else this.items.push([name, String(value)]);
  }
  removeProperty(name: string): string {
    const old = this.getPropertyValue(name);
    this.items = this.items.filter(([n]) => n !== name);
    return old;
  }
  get cssText(): string {
    return this.items.map(([n, v]) => `${n}: ${v};`).join(' ');
  }
}

export class CSSRuleShim {
  readonly selectorText: string;
  readonly style: CSSStyleDeclarationShim;
  private readonly prelude: string;
  private readonly body: string | null;
  constructor(text: string) {
    const open = text.indexOf('{');
    this.body = open < 0 ? null : text.slice(open + 1, text.lastIndexOf('}')).trim();
    this.prelude = (open < 0 ? text : text.slice(0, open)).trim();
    const plain = !this.prelude.startsWith('@') && this.body !== null;
    this.selectorText = plain ? this.prelude : '';
    this.style = new CSSStyleDeclarationShim(plain ? declarations(this.body!) : []);
  }
  get cssText(): string {
    if (this.body === null) return this.prelude;
    if (this.selectorText === '') return `${this.prelude} { ${this.body} }`;
    return this.style.length === 0 ? `${this.selectorText} {}` : `${this.selectorText} { ${this.style.cssText} }`;
  }
}

export class CSSStyleSheetShim {
  readonly cssRules: CSSRuleShim[] = [];
  readonly disabled = false;
  constructor(_options?: unknown) {}
  get rules(): CSSRuleShim[] {
    return this.cssRules;
  }
  insertRule(rule: string, index = 0): number {
    const parsed = splitRules(String(rule));
    if (parsed.length !== 1) throw new SyntaxError(`Failed to execute 'insertRule' on 'CSSStyleSheet': Failed to parse the rule '${rule}'.`);
    if (index < 0 || index > this.cssRules.length) throw new RangeError("Failed to execute 'insertRule' on 'CSSStyleSheet': The index provided is larger than the maximum index.");
    this.cssRules.splice(index, 0, new CSSRuleShim(parsed[0]!));
    return index;
  }
  deleteRule(index: number): void {
    if (index < 0 || index >= this.cssRules.length) throw new RangeError("Failed to execute 'deleteRule' on 'CSSStyleSheet': The index provided is larger than the maximum index.");
    this.cssRules.splice(index, 1);
  }
  replaceSync(text: string): void {
    this.cssRules.splice(0, this.cssRules.length, ...splitRules(String(text)).map((r) => new CSSRuleShim(r)));
  }
  replace(text: string): Promise<CSSStyleSheetShim> {
    this.replaceSync(text);
    return Promise.resolve(this);
  }
}
