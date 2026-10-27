// A small forgiving HTML fragment parser, for `dangerouslySetInnerHTML` (an SVG snippet, a paragraph of markup).
// It makes the same `DomNode`s the reconciler does, with the attributes as props (strings). It is not the HTML5
// tree builder: no implied `tbody`, no adoption agency; unclosed tags close at the end of their parent.

import type { DomNode } from '../types.js';

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
  // SVG elements that are written self-closed and never hold children here.
  'stop', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
]);
const RAW_TEXT = new Set(['style', 'script', 'textarea', 'title']);

/** SVG element names with a capital: HTML parsing lower-cases tag names, SVG restores them. */
const SVG_CASE: Record<string, string> = Object.fromEntries(
  [
    'linearGradient', 'radialGradient', 'clipPath', 'textPath', 'foreignObject', 'feBlend', 'feColorMatrix',
    'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap',
    'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur',
    'feImage', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
    'feSpotLight', 'feTile', 'feTurbulence', 'animateMotion', 'animateTransform',
  ].map((name) => [name.toLowerCase(), name]),
);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

interface Open {
  type: string;
  node: Extract<DomNode, { kind: 'element' }>;
  inSvg: boolean;
}

/** The nodes `html` makes, as if set as the `innerHTML` of an element (inside an `svg` when `inSvg`). */
export function parseHtmlFragment(html: string, inSvg = false): DomNode[] {
  const roots: DomNode[] = [];
  const stack: Open[] = [];
  const add = (node: DomNode): void => {
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else roots.push(node);
  };
  const svgNow = (): boolean => (stack.length > 0 ? stack[stack.length - 1]!.inSvg : inSvg);

  let at = 0;
  while (at < html.length) {
    const lt = html.indexOf('<', at);
    if (lt === -1) {
      const text = decode(html.slice(at));
      if (text !== '') add({ kind: 'text', text });
      break;
    }
    if (lt > at) add({ kind: 'text', text: decode(html.slice(at, lt)) });
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      at = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      at = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html[lt + 1] === '/') {
      const end = html.indexOf('>', lt);
      const name = html.slice(lt + 2, end === -1 ? html.length : end).trim();
      const lower = name.toLowerCase();
      const found = stack.findLastIndex((open) => open.type.toLowerCase() === lower);
      if (found !== -1) stack.length = found;
      at = end === -1 ? html.length : end + 1;
      continue;
    }
    const tag = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(lt, lt + 80));
    if (!tag) {
      add({ kind: 'text', text: '<' });
      at = lt + 1;
      continue;
    }
    // Attributes, up to the `>` that is not inside quotes.
    let cursor = lt + tag[0].length;
    const props: Record<string, any> = {};
    let selfClosing = false;
    for (;;) {
      while (cursor < html.length && /\s/.test(html[cursor]!)) cursor++;
      if (cursor >= html.length) break;
      if (html[cursor] === '>') {
        cursor++;
        break;
      }
      if (html[cursor] === '/' && html[cursor + 1] === '>') {
        selfClosing = true;
        cursor += 2;
        break;
      }
      if (html[cursor] === '/') {
        cursor++;
        continue;
      }
      const name = /^[^\s=/>]+/.exec(html.slice(cursor))![0];
      cursor += name.length;
      while (cursor < html.length && /\s/.test(html[cursor]!)) cursor++;
      let value = '';
      if (html[cursor] === '=') {
        cursor++;
        while (cursor < html.length && /\s/.test(html[cursor]!)) cursor++;
        const quote = html[cursor];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, cursor + 1);
          value = html.slice(cursor + 1, end === -1 ? html.length : end);
          cursor = end === -1 ? html.length : end + 1;
        } else {
          const bare = /^[^\s>]*/.exec(html.slice(cursor))![0];
          value = bare;
          cursor += bare.length;
        }
      }
      props[name] = decode(value);
    }
    const lower = tag[1]!.toLowerCase();
    const inside = lower === 'svg' || svgNow();
    const type = inside ? (SVG_CASE[lower] ?? lower) : lower;
    const node: Extract<DomNode, { kind: 'element' }> = { kind: 'element', type, props, children: [] };
    add(node);
    at = cursor;
    if (selfClosing || (!inside && VOID.has(lower))) continue;
    if (RAW_TEXT.has(lower)) {
      const close = html.toLowerCase().indexOf(`</${lower}`, at);
      const body = html.slice(at, close === -1 ? html.length : close);
      if (body !== '') node.children.push({ kind: 'text', text: lower === 'textarea' || lower === 'title' ? decode(body) : body });
      const end = close === -1 ? -1 : html.indexOf('>', close);
      at = end === -1 ? html.length : end + 1;
      continue;
    }
    // `foreignObject` is an HTML integration point: what is written inside it is HTML, not SVG.
    stack.push({ type, node, inSvg: inside && lower !== 'foreignobject' });
  }
  return roots;
}
