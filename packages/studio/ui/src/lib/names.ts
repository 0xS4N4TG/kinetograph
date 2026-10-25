// What the UI calls a layer or Sequence. The server sends a `label` (and the component and source line) for projects the
// studio built; a `.json` scene has none, and its generated ids (`$0.1.2`) are a place in the tree, never a name.

import type { SourceLocation } from '../../../src/protocol.ts';

interface Nameable {
  id: string;
  type: string;
  label?: string;
}

const KIND: Record<string, string> = {
  group: 'Group',
  shape: 'Shape',
  text: 'Text',
  image: 'Image',
  video: 'Video',
  gif: 'Gif',
};

/** The label, else the id when a person chose it, else the kind of layer. */
export function displayName(layer: Nameable): string {
  if (layer.label !== undefined && layer.label !== '') return layer.label;
  if (!layer.id.startsWith('$')) return layer.id;
  return KIND[layer.type] ?? layer.type.charAt(0).toUpperCase() + layer.type.slice(1);
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
