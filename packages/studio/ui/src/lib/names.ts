// What the UI calls a layer or Sequence. The server sends a `label` (and the component and source line) for projects the
// studio built; a `.json` scene has none, and its generated ids (`$0.1.2`) are a place in the tree, never a name.

import type { SourceLocation } from '../../../src/protocol.ts';

interface Nameable {
  id: string;
  type: string;
  label?: string;
  /** Set by `numberSiblings` on the second and later of siblings that share a name: "Card 2", "Card 3". */
  ordinal?: number;
}

const KIND: Record<string, string> = {
  group: 'Group',
  shape: 'Shape',
  text: 'Text',
  image: 'Image',
  video: 'Video',
  gif: 'Gif',
};

/** The label, else the id when a person chose it, else the kind of layer; without the sibling number. */
export function baseName(layer: Nameable): string {
  if (layer.label !== undefined && layer.label !== '') return layer.label;
  if (!layer.id.startsWith('$')) return layer.id;
  return KIND[layer.type] ?? layer.type.charAt(0).toUpperCase() + layer.type.slice(1);
}

/** The name, numbered when an earlier sibling has the same one ("Card", "Card 2"), as editors number duplicates. */
export function displayName(layer: Nameable): string {
  const base = baseName(layer);
  return layer.ordinal !== undefined && layer.ordinal > 1 ? `${base} ${layer.ordinal}` : base;
}

/**
 * Numbers siblings that would show the same name: the first keeps it, the second is "Card 2", the third "Card 3", in
 * the order they come. Sets `ordinal` on each (removed where it is not needed); returns the list.
 */
export function numberSiblings<T extends Nameable>(siblings: T[]): T[] {
  const seen = new Map<string, number>();
  for (const layer of siblings) {
    const base = baseName(layer);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    if (n > 1) layer.ordinal = n;
    else delete layer.ordinal;
  }
  return siblings;
}

/** `numberSiblings` on every list of children of a tree of layers. */
export function numberTree<T extends Nameable & { children?: T[] }>(layers: T[]): T[] {
  numberSiblings(layers);
  for (const layer of layers) if (layer.children) numberTree(layer.children);
  return layers;
}

/** `numberSiblings` on a flat list of layers, each under its `parent` (in its Sequence: ids repeat between them). */
export function numberByParent<T extends Nameable & { parent: string | null; sequence?: string }>(layers: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const layer of layers) {
    const key = `${layer.sequence ?? ''}\u0000${layer.parent ?? ''}`;
    const list = groups.get(key);
    if (list) list.push(layer);
    else groups.set(key, [layer]);
  }
  for (const list of groups.values()) numberSiblings(list);
  return layers;
}

/** `shots-a.tsx:212`: the last path segment, for a line of little room. */
export function shortSource(source: SourceLocation): string {
  return `${source.file.slice(source.file.lastIndexOf('/') + 1)}:${source.line}`;
}

/** `examples/showcase/shots-a.tsx:212:7`. */
export function fullSource(source: SourceLocation): string {
  return `${source.file}:${source.line}:${source.column}`;
}

/** The second line under a name: the component that drew it and where, or nothing. */
export function secondLine(item: { component?: string; source?: SourceLocation }): string | undefined {
  const parts = [item.component, item.source ? shortSource(item.source) : undefined].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** The tooltip of a row: the name, its kind and where it came from. */
export function tooltip(name: string, kind: string, item: { component?: string; source?: SourceLocation }): string {
  const lines = [`${name} (${kind})`];
  if (item.component !== undefined) lines.push(`component ${item.component}`);
  if (item.source) lines.push(fullSource(item.source));
  return lines.join('\n');
}
