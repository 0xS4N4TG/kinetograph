// A React element's props as the attributes the DOM would have (docs/ENGINE.md §2, `DomNode::Element::attrs`).
// React DOM's rules: `className` → `class`, `htmlFor` → `for`, SVG presentation props camelCase → kebab-case
// (`strokeWidth` → `stroke-width`) while the SVG attributes that are camelCase in the DOM keep their case
// (`viewBox`, `gradientUnits`, `stdDeviation`, …), HTML attribute names in lower case, booleans, numbers as text.

import { styleToCss } from './style.js';

/** Props that are SVG attributes with a hyphen or a namespace (React's `possibleStandardNames` for SVG). */
const SVG_ATTRIBUTE_NAMES: Record<string, string> = {};
for (const name of [
  'accentHeight', 'alignmentBaseline', 'arabicForm', 'baselineShift', 'capHeight', 'clipPath', 'clipRule',
  'colorInterpolation', 'colorInterpolationFilters', 'colorProfile', 'colorRendering', 'dominantBaseline',
  'enableBackground', 'fillOpacity', 'fillRule', 'floodColor', 'floodOpacity', 'fontFamily', 'fontSize',
  'fontSizeAdjust', 'fontStretch', 'fontStyle', 'fontVariant', 'fontWeight', 'glyphName', 'glyphOrientationHorizontal',
  'glyphOrientationVertical', 'horizAdvX', 'horizOriginX', 'imageRendering', 'letterSpacing', 'lightingColor',
  'markerEnd', 'markerMid', 'markerStart', 'overlinePosition', 'overlineThickness', 'paintOrder', 'pointerEvents',
  'renderingIntent', 'shapeRendering', 'stopColor', 'stopOpacity', 'strikethroughPosition', 'strikethroughThickness',
  'strokeDasharray', 'strokeDashoffset', 'strokeLinecap', 'strokeLinejoin', 'strokeMiterlimit', 'strokeOpacity',
  'strokeWidth', 'textAnchor', 'textDecoration', 'textRendering', 'underlinePosition', 'underlineThickness',
  'unicodeBidi', 'unicodeRange', 'unitsPerEm', 'vAlphabetic', 'vHanging', 'vIdeographic', 'vMathematical',
  'vectorEffect', 'vertAdvY', 'vertOriginX', 'vertOriginY', 'wordSpacing', 'writingMode', 'xHeight',
]) {
  SVG_ATTRIBUTE_NAMES[name] = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
// `panose1` has a digit, and vendor-style `xlink`/`xml` names carry a namespace.
Object.assign(SVG_ATTRIBUTE_NAMES, {
  panose1: 'panose-1',
  xlinkActuate: 'xlink:actuate',
  xlinkArcrole: 'xlink:arcrole',
  xlinkHref: 'xlink:href',
  xlinkRole: 'xlink:role',
  xlinkShow: 'xlink:show',
  xlinkTitle: 'xlink:title',
  xlinkType: 'xlink:type',
  xmlBase: 'xml:base',
  xmlLang: 'xml:lang',
  xmlSpace: 'xml:space',
  xmlnsXlink: 'xmlns:xlink',
  xmlns: 'xmlns',
});

/** Props whose DOM attribute has another name, on any element. */
const RENAMED: Record<string, string> = {
  className: 'class',
  htmlFor: 'for',
  acceptCharset: 'accept-charset',
  httpEquiv: 'http-equiv',
  defaultValue: 'value',
  defaultChecked: 'checked',
};

/** HTML attributes that are present or absent: `true` is the empty string, `false` leaves it out. */
const BOOLEAN_ATTRIBUTES = new Set([
  'allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled', 'disablepictureinpicture',
  'disableremoteplayback', 'formnovalidate', 'hidden', 'inert', 'itemscope', 'loop', 'multiple', 'muted', 'nomodule',
  'novalidate', 'open', 'playsinline', 'readonly', 'required', 'reversed', 'scoped', 'seamless', 'selected',
]);

/** Enumerated attributes that take `"true"` / `"false"` as text, so a boolean is written out. */
const ENUMERATED = new Set(['contenteditable', 'draggable', 'spellcheck', 'translate', 'autocorrect']);

/** Props that never become attributes. */
const SKIPPED = new Set([
  'children', 'key', 'ref', 'style', 'dangerouslySetInnerHTML', 'suppressContentEditableWarning', 'suppressHydrationWarning',
  'innerHTML', 'innerText', 'textContent',
]);

/** The attribute name for a prop, or null when it is not an attribute. */
export function attributeName(prop: string, insideSvg: boolean): string | null {
  if (SKIPPED.has(prop)) return null;
  // Event handlers (`onClick`, `onLoad`) are not attributes React writes.
  if (/^on[A-Z]/.test(prop)) return null;
  const renamed = RENAMED[prop];
  if (renamed !== undefined) return renamed;
  const svg = SVG_ATTRIBUTE_NAMES[prop];
  if (svg !== undefined) return svg;
  if (insideSvg) return prop;
  // `aria-*`, `data-*` and custom attributes are written as given; HTML names are case-insensitive, so lower case.
  if (prop.startsWith('aria-') || prop.startsWith('data-') || prop.includes('-') || prop.includes(':')) return prop;
  return prop.toLowerCase();
}

/** The attribute value for a prop value, or null to leave the attribute out. */
export function attributeValue(name: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'function':
    case 'symbol':
      return null;
    case 'boolean':
      if (name.startsWith('aria-') || name.startsWith('data-') || ENUMERATED.has(name)) return String(value);
      if (BOOLEAN_ATTRIBUTES.has(name)) return value ? '' : null;
      // React writes nothing for a boolean on any other attribute.
      return null;
    case 'number':
      return Number.isFinite(value) ? String(value) : null;
    case 'string':
      return value;
    case 'object':
      return Array.isArray(value) ? value.join(' ') : String(value);
    default:
      return String(value);
  }
}

/** All the attributes of an element's props (without `style`, which is its own field). */
export function attributesOf(props: Record<string, unknown>, insideSvg: boolean): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [prop, raw] of Object.entries(props)) {
    const name = attributeName(prop, insideSvg);
    if (name === null) continue;
    const value = attributeValue(name, raw);
    if (value !== null) attrs[name] = value;
  }
  return attrs;
}

/** The `style` prop as CSS declaration text. */
export function styleOf(props: Record<string, unknown>): string {
  return styleToCss(props.style);
}
