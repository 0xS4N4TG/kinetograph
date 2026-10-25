import type { SequenceJson, TimelineLayer } from '@/api';
import type { SourceLocation } from '../../../src/protocol.ts';
import { displayName } from '@/lib/names';

export interface SequenceRow {
  key: string;
  label: string;
  component?: string;
  source?: SourceLocation;
  depth: number;
  from: number;
  /** Exclusive. */
  end: number;
  /** The group its children are in on the first frame it shows, if any. */
  layer: string | null;
}

export interface LayerRow {
  id: string;
  /** What a person calls it. */
  label: string;
  component?: string;
  source?: SourceLocation;
  type: string;
  depth: number;
  ranges: [first: number, last: number][];
}

/** Depth-first order of `items` with every child right after its parent; siblings keep (or, with `reverse`, flip) their order. */
function nest<T>(items: T[], id: (item: T) => string, parent: (item: T) => string | null, reverse: boolean) {
  const known = new Set(items.map(id));
  const children = new Map<string | null, T[]>();
  for (const item of items) {
    const p = parent(item);
    const key = p !== null && known.has(p) ? p : null;
    const list = children.get(key);
    if (list) list.push(item);
    else children.set(key, [item]);
  }
  const out: { item: T; depth: number }[] = [];
  const visit = (key: string | null, depth: number) => {
    const list = children.get(key) ?? [];
    for (const item of reverse ? [...list].reverse() : list) {
      out.push({ item, depth });
      visit(id(item), depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

/** One row per Sequence, each nested under its parent, in `from` order as the server sorted them. */
export function sequenceRows(sequences: SequenceJson[]): SequenceRow[] {
  return nest(
    sequences,
    (s) => s.key,
    (s) => s.parent,
    false,
  ).map(({ item, depth }) => ({
    key: item.key,
    label: item.label ?? item.name ?? 'Sequence',
    ...(item.component !== undefined ? { component: item.component } : {}),
    ...(item.source !== undefined ? { source: item.source } : {}),
    depth,
    from: item.from,
    end: item.from + item.durationInFrames,
    layer: item.layer,
  }));
}

/** One row per layer, children under their group, the topmost layer first (the scene lists bottom first). */
export function layerRows(layers: TimelineLayer[]): LayerRow[] {
  return nest(
    layers,
    (l) => l.id,
    (l) => l.parent,
    true,
  ).map(({ item, depth }) => ({
    id: item.id,
    label: displayName(item),
    ...(item.component !== undefined ? { component: item.component } : {}),
    ...(item.source !== undefined ? { source: item.source } : {}),
    type: item.type,
    depth,
    ranges: item.ranges,
  }));
}

/** Tailwind padding classes for nesting depth (written out so the class scanner finds them). */
const INDENT = ['pl-2', 'pl-5', 'pl-8', 'pl-11', 'pl-14', 'pl-[68px]', 'pl-[80px]', 'pl-[92px]'];
export function indent(depth: number): string {
  return INDENT[Math.min(depth, INDENT.length - 1)]!;
}
