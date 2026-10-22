// A `style` prop as CSS declaration text, by React DOM's rules (docs/ENGINE.md §2, `DomNode::Element::style`):
//  - null, undefined, booleans and empty strings leave the property out;
//  - a number gets `px`, except 0, custom properties (`--x`) and the unitless properties below;
//  - camelCase becomes kebab-case (`backgroundColor` → `background-color`), `WebkitX` → `-webkit-x`, `msX` → `-ms-x`,
//    `cssFloat` → `float`;
//  - custom properties keep their name as written.

/** React's `isUnitlessNumber` list (the names a bare number is not given `px` for). */
const UNITLESS_BASE = [
  'animationIterationCount', 'aspectRatio', 'borderImageOutset', 'borderImageSlice', 'borderImageWidth', 'boxFlex',
  'boxFlexGroup', 'boxOrdinalGroup', 'columnCount', 'columns', 'flex', 'flexGrow', 'flexPositive', 'flexShrink',
  'flexNegative', 'flexOrder', 'gridArea', 'gridRow', 'gridRowEnd', 'gridRowSpan', 'gridRowStart', 'gridColumn',
  'gridColumnEnd', 'gridColumnSpan', 'gridColumnStart', 'fontWeight', 'lineClamp', 'lineHeight', 'opacity', 'order',
  'orphans', 'scale', 'tabSize', 'widows', 'zIndex', 'zoom', 'fillOpacity', 'floodOpacity', 'stopOpacity',
  'strokeDasharray', 'strokeDashoffset', 'strokeMiterlimit', 'strokeOpacity', 'strokeWidth',
];
const PREFIXES = ['Webkit', 'ms', 'Moz', 'O'];

const UNITLESS = new Set<string>(UNITLESS_BASE);
for (const name of UNITLESS_BASE) {
  const capital = name.charAt(0).toUpperCase() + name.slice(1);
  for (const prefix of PREFIXES) UNITLESS.add(prefix + capital);
}

/** The names `cssPropertyName` has worked out: a style key is the same few hundred names on every frame. */
const NAMES = new Map<string, string>();

/** The CSS name of a style key: `backgroundColor` → `background-color`. Custom properties are kept as they are. */
export function cssPropertyName(key: string): string {
  const known = NAMES.get(key);
  if (known !== undefined) return known;
  let name: string;
  if (key.startsWith('--')) name = key;
  else if (key === 'cssFloat') name = 'float';
  // React's hyphenateStyleName: every capital becomes `-` + lower case; `ms` is the one prefix without a capital.
  else name = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^ms-/, '-ms-');
  if (NAMES.size < 4096) NAMES.set(key, name);
  return name;
}

/** The CSS text of one value, or null when React leaves the declaration out. */
export function cssValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined || typeof value === 'boolean' || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value === 0 || key.startsWith('--') || UNITLESS.has(key)) return String(value);
    return `${value}px`;
  }
  const text = (typeof value === 'string' ? value : String(value)).trim();
  return text === '' ? null : text;
}

/** `{ width: 10, opacity: 0.5 }` → `width: 10px; opacity: 0.5`. */
export function styleToCss(style: unknown): string {
  if (typeof style === 'string') return style;
  if (typeof style !== 'object' || style === null) return '';
  const declarations: string[] = [];
  for (const [key, raw] of Object.entries(style as Record<string, unknown>)) {
    const value = cssValue(key, raw);
    if (value !== null) declarations.push(`${cssPropertyName(key)}: ${value}`);
  }
  return declarations.join('; ');
}
