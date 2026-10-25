// Which host element types are DOM elements (as opposed to the native `kg-*` ones).

const HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'big', 'blockquote', 'body',
  'br', 'button', 'canvas', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del',
  'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'font', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input',
  'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'menu', 'meta', 'meter', 'nav', 'noscript',
  'object', 'ol', 'optgroup', 'option', 'output', 'p', 'param', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby',
  's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small', 'source', 'span', 'strike', 'strong', 'style',
  'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title',
  'tr', 'track', 'tt', 'u', 'ul', 'var', 'video', 'wbr',
]);

/** SVG element names (React's host types are case-sensitive). */
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'linearGradient',
  'radialGradient', 'stop', 'text', 'tspan', 'textPath', 'image', 'use', 'symbol', 'clipPath', 'mask', 'pattern',
  'filter', 'marker', 'foreignObject', 'desc', 'metadata', 'switch', 'view', 'animate', 'animateMotion',
  'animateTransform', 'set', 'mpath', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite',
  'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood',
  'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology',
  'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
]);

/** Whether the reconciler accepts `type` as a DOM host element: HTML, SVG and custom elements, never a `kg-*` one. */
export function isDomElement(type: string): boolean {
  if (type.startsWith('kg-')) return false;
  if (HTML_TAGS.has(type) || SVG_TAGS.has(type)) return true;
  // A custom element has a hyphen in its name.
  return /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/.test(type);
}

/** Whether `type` is an SVG element's name (and no HTML element's). */
export function isSvgTag(type: string): boolean {
  return SVG_TAGS.has(type) && !HTML_TAGS.has(type);
}

/** Whether `type` starts an SVG subtree (its children are SVG elements). */
export function isSvgRoot(type: string): boolean {
  return type === 'svg';
}
