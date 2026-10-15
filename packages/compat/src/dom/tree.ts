// Parse: the island's host nodes become styled nodes (docs/COMPAT.md §2). Each element's `style` prop is parsed by
// `css` (`parseStyle`), and what that and the element's other props cannot say is kept as diagnostics, reported
// only if the element turns out to be on screen (a `display: none` subtree is not checked, §6.1).

import type { Unsupported } from '@kinetograph/scene';
import type { Diagnostic } from '../css/index.js';
import type { ParsedStyle } from '../css/types.js';
import type { DomNode } from '../types.js';
import { isDomElement } from './elements.js';

export interface StyledText {
  kind: 'text';
  text: string;
}

/** A native (`kg-*`) element inside the island. */
export interface StyledNative {
  kind: 'native';
  node: Extract<DomNode, { kind: 'element' }>;
  path: string;
}

export interface StyledElement {
  kind: 'element';
  type: string;
  /** The host-tree index path: `$0.2`. */
  path: string;
  /** The layer id: the explicit `id` prop if that is a valid layer id, else the path. */
  id: string;
  props: Record<string, any>;
  /** The `style` prop as written (an svg element's presentation properties are read from it). */
  rawStyle: Record<string, unknown>;
  style: ParsedStyle;
  /** Everything about this element's props that cannot be drawn; reported when the element is on screen. */
  diagnostics: Diagnostic[];
  children: StyledNode[];
}

export type StyledNode = StyledText | StyledNative | StyledElement;

/** The `Unsupported` items of an island, each once. */
export class Report {
  readonly items: Unsupported[] = [];
  private readonly seen = new Set<string>();

  /** `chain` is the element as `Unsupported.element` writes it (`div`, `svg > text`). */
  add(el: { path: string; type: string }, chain: string, property: string | null, value: unknown, reason: string): void {
    const shown = value === undefined || value === null ? null : typeof value === 'string' ? value : safeJson(value);
    const key = `${el.path}\0${chain}\0${property}\0${reason}\0${shown}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push({ path: `${el.path} <${el.type}>`, element: chain, property, value: shown, reason });
  }

  diagnostics(el: StyledElement, chain = el.type): void {
    for (const d of el.diagnostics) this.add(el, chain, d.property, d.value, d.reason);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export type ParseStyle = (style: Record<string, unknown>) => { style: ParsedStyle; unsupported: Diagnostic[] };

export interface ParseOptions {
  parseStyle: ParseStyle;
  /** Claims an explicit id for a layer; false when it is taken or reserved. */
  claimId: (id: string) => boolean;
}

/** The presentation properties an svg mapping reads from a `style` prop. */
const SVG_PRESENTATION = new Set([
  'fill', 'fillOpacity', 'stroke', 'strokeWidth', 'strokeOpacity', 'strokeLinecap', 'strokeLinejoin',
  'strokeDasharray', 'fillRule', 'paintOrder',
]);
const SVG_STYLE = new Set([
  ...SVG_PRESENTATION, 'opacity', 'color', 'display', 'visibility', 'stopColor', 'stopOpacity',
]);

/** Event handlers and the like that mean nothing to a picture (docs/COMPAT.md §4.1). */
function isIgnoredProp(name: string): boolean {
  return (
    /^on[A-Z]/.test(name) ||
    name === 'ref' ||
    name === 'key' ||
    name === 'title' ||
    name === 'alt' ||
    name === 'role' ||
    name === 'tabIndex' ||
    name === 'draggable' ||
    name.startsWith('aria-') ||
    name.startsWith('data-')
  );
}

function propDiagnostics(props: Record<string, any>): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (props.className !== undefined && props.className !== '') {
    out.push({ property: 'className', value: String(props.className), reason: 'classes need a stylesheet, which is not read' });
  }
  if (props.dangerouslySetInnerHTML !== undefined) {
    out.push({ property: 'dangerouslySetInnerHTML', value: '', reason: 'raw HTML is not drawn' });
  }
  return out;
}

/**
 * The styled tree of `node`, which sits at `path`. Children are numbered by their index among the element children
 * (DOM and native alike; text takes no place), as the reconciler numbers host elements.
 */
export function parseTree(node: DomNode, path: string, options: ParseOptions, insideSvg = false): StyledNode {
  if (node.kind === 'text') return { kind: 'text', text: node.text };
  if (!isDomElement(node.type)) return { kind: 'native', node, path };

  const given = node.props.style;
  const rawStyle: Record<string, unknown> = typeof given === 'object' && given !== null ? (given as Record<string, unknown>) : {};
  let parsed: { style: ParsedStyle; unsupported: Diagnostic[] };
  if (insideSvg) {
    // What is inside an svg has no CSS box: its presentation properties are read by the svg mapping, and any other
    // style is reported.
    parsed = { style: {}, unsupported: [] };
    for (const [property, v] of Object.entries(rawStyle)) {
      if (v !== undefined && !SVG_STYLE.has(property)) {
        parsed.unsupported.push({ property, value: String(v), reason: 'not supported on an SVG element' });
      }
    }
  } else {
    parsed =
      node.type === 'svg'
        ? options.parseStyle(Object.fromEntries(Object.entries(rawStyle).filter(([k]) => !SVG_PRESENTATION.has(k))))
        : options.parseStyle(rawStyle);
  }
  const explicit = node.props.id;
  const id =
    typeof explicit === 'string' && explicit !== '' && !explicit.startsWith('$') && options.claimId(explicit) ? explicit : path;

  const props: Record<string, any> = {};
  for (const [name, value] of Object.entries(node.props)) {
    if (name !== 'style' && name !== 'children' && !isIgnoredProp(name)) props[name] = value;
  }

  const children: StyledNode[] = [];
  let index = 0;
  for (const child of node.children) {
    if (child.kind === 'text') children.push({ kind: 'text', text: child.text });
    else children.push(parseTree(child, `${path}.${index++}`, options, insideSvg || node.type === 'svg'));
  }
  return {
    kind: 'element',
    type: node.type,
    path,
    id,
    props,
    rawStyle,
    style: parsed.style,
    diagnostics: [...parsed.unsupported, ...propDiagnostics(node.props)],
    children,
  };
}
