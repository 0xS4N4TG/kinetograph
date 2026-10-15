// The DOM element types compat mode knows (docs/COMPAT.md §4.1, §4.5) and Chrome's default stylesheet for them.

import type { Length, ParsedStyle } from '../css/types.js';

/** Boxes with `display: block` by default. */
export const BLOCK_TAGS = new Set([
  'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'figure',
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li',
]);

/** Inline content of a text block. `br` is a line break. */
export const INLINE_TAGS = new Set(['span', 'b', 'strong', 'i', 'em', 'small', 'a']);

/** Boxes whose content is a picture. */
export const REPLACED_TAGS = new Set(['img', 'video', 'svg']);

/** Every SVG element name (React's host types are case-sensitive). The ones §4.5 maps are in `svg.ts`. */
export const SVG_TAGS = new Set([
  'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'linearGradient', 'radialGradient',
  'stop', 'text', 'tspan', 'textPath', 'image', 'use', 'symbol', 'clipPath', 'mask', 'pattern', 'filter', 'marker',
  'foreignObject', 'title', 'desc', 'metadata', 'switch', 'a', 'view', 'style', 'script',
  'feBlend', 'feColorMatrix', 'feComposite', 'feFlood', 'feGaussianBlur', 'feOffset', 'feMerge', 'feMergeNode',
  'feDropShadow', 'feMorphology', 'feTurbulence', 'feDisplacementMap', 'feImage', 'feTile',
]);

/** HTML elements that are accepted by the reconciler but have no mapping: they are reported as unsupported. */
const OTHER_HTML = new Set([
  'html', 'head', 'body', 'canvas', 'iframe', 'input', 'button', 'select', 'option', 'textarea', 'label', 'form',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'pre', 'code', 'hr', 'u', 's',
  'mark', 'sub', 'sup', 'abbr', 'time', 'cite', 'q', 'kbd', 'samp', 'var', 'dl', 'dt', 'dd', 'details', 'summary',
  'dialog', 'audio', 'source', 'track', 'picture', 'object', 'embed', 'map', 'area', 'fieldset', 'legend', 'meter',
  'progress', 'output', 'datalist', 'address', 'center', 'font', 'big', 'tt', 'strike', 'del', 'ins', 'wbr', 'bdi',
  'bdo', 'ruby', 'rt', 'rp', 'menu', 'noscript', 'template', 'slot', 'style', 'script', 'link', 'meta', 'title', 'base',
  'hgroup', 'search', 'data', 'dfn',
]);

const MAPPED_HTML = new Set([...BLOCK_TAGS, ...INLINE_TAGS, 'br', ...REPLACED_TAGS]);

/** Whether the reconciler accepts `type` as a host element: HTML, SVG and custom elements, never a `kg-*` one. */
export function isDomElement(type: string): boolean {
  if (type.startsWith('kg-')) return false;
  if (MAPPED_HTML.has(type) || OTHER_HTML.has(type) || SVG_TAGS.has(type)) return true;
  // A custom element has a hyphen in its name.
  return /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/.test(type);
}

/** Elements this mapping draws (as opposed to reporting): used by the tree walk. */
export function isMappedHtml(type: string): boolean {
  return MAPPED_HTML.has(type);
}

const em = (value: number): Length => ({ unit: 'em', value });
const pxLen = (value: number): Length => ({ unit: 'px', value });
const zero = pxLen(0);

/** Chrome's default `margin` (top and bottom) and `font-size` of the headings, in em. */
const HEADINGS: Record<string, { size: number; margin: number }> = {
  h1: { size: 2, margin: 0.67 },
  h2: { size: 1.5, margin: 0.83 },
  h3: { size: 1.17, margin: 1 },
  h4: { size: 1, margin: 1.33 },
  h5: { size: 0.83, margin: 1.67 },
  h6: { size: 0.67, margin: 2.33 },
};

/**
 * Chrome's default stylesheet for the mapped elements (docs/COMPAT.md §4.1). `insideList` is an `ul` or `ol` inside
 * another list, whose vertical margins are 0. The author's style is laid over this property by property.
 */
export function uaStyle(tag: string, insideList: boolean): ParsedStyle {
  const heading = HEADINGS[tag];
  if (heading) {
    const m = em(heading.margin);
    return {
      display: 'block',
      fontSize: heading.size === 1 ? undefined : em(heading.size),
      fontWeight: 700,
      margin: [m, zero, m, zero],
    };
  }
  switch (tag) {
    case 'p':
      return { display: 'block', margin: [em(1), zero, em(1), zero] };
    case 'blockquote':
    case 'figure':
      return { display: 'block', margin: [em(1), pxLen(40), em(1), pxLen(40)] };
    case 'ul':
    case 'ol': {
      const v = insideList ? zero : em(1);
      return { display: 'block', margin: [v, zero, v, zero], padding: [zero, zero, zero, pxLen(40)] };
    }
    case 'b':
    case 'strong':
      return { display: 'inline', fontWeight: 'bolder' };
    case 'i':
    case 'em':
      return { display: 'inline', fontStyle: 'italic' };
    case 'small':
      return { display: 'inline', fontSize: 'smaller' };
    case 'a':
      return { display: 'inline', color: { r: 0, g: 0, b: 238, a: 1 }, textDecoration: 'underline' };
    case 'span':
      return { display: 'inline' };
    case 'img':
    case 'video':
    case 'svg':
      // Laid out as block-level boxes: this mapping has no inline formatting of pictures.
      return { display: 'block' };
    default:
      return BLOCK_TAGS.has(tag) ? { display: 'block' } : {};
  }
}

/** Removes the keys whose value is `undefined`, so a merge does not overwrite with them. */
export function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
