// The timeline a person reads. The server sends every Sequence and every drawn layer; this turns them into a short tree:
// Sequences (nested as in the code) > the component instances inside them > (on demand) the raw pieces. Identical
// siblings fold into one row ("MeltRim x120"), and each row has a few bars, not one per frame the item flickered on.

import type { SequenceJson, TimelineLayer } from '@/api';
import type { SourceLocation } from '../../../src/protocol.ts';
import { displayName } from './names';

export type Range = [first: number, last: number];

export interface TimelineNode {
  /** Stable across rebuilds of the same payload; the key of the row and of its expanded state. */
  id: string;
  kind: 'sequence' | 'component' | 'piece';
  label: string;
  component?: string;
  source?: SourceLocation;
  /** The layer type of a single layer ('shape', 'group'...); absent for Sequences and folded rows. */
  type?: string;
  /** Several identical instances folded into this row; 1 otherwise. */
  count: number;
  /** The bars: visible ranges with absences up to the gap threshold bridged, inclusive. */
  bars: Range[];
  /** Ids to select when the row is clicked. */
  layerIds: string[];
  children: TimelineNode[];
  /** The raw layers under a single instance, nested; built when asked (power users only). */
  pieces?: () => TimelineNode[];
}

/** Labels that only say what kind of thing a layer is, and the sub-layers the engine adds under an element. */
const GENERIC = /^(Group|Shape|Text|Image|Video|Gif)$/;
const SUBLAYER = / · (shadow\d*|border[\w.]*|svg[\w.]*|inset\w*|outline\w*)$/;

export function isGeneric(layer: TimelineLayer): boolean {
  if (layer.label === undefined) return layer.id.startsWith('$');
  return GENERIC.test(layer.label) || SUBLAYER.test(layer.label);
}

/** Sorted ranges joined wherever the gap between them is at most `gap` frames. */
export function mergeRanges(ranges: Range[], gap: number): Range[] {
  const sorted = ranges.map((r): Range => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] - last[1] - 1 <= gap) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

const sourceKey = (s: SourceLocation | undefined) => (s ? `${s.file}:${s.line}:${s.column}` : '');

interface Built {
  roots: TimelineNode[];
}

/**
 * The tree for one timeline payload. `gap` is how many frames an item may be absent before its bar splits (default one
 * second). Pure and linear in the number of layers, so call it once per payload.
 */
export function buildTimeline(sequences: SequenceJson[], layers: TimelineLayer[], fps: number, gap = fps): Built {
  const keys = new Set(sequences.map((s) => s.key));
  const owned = new Map<string, TimelineLayer[]>();
  const loose: TimelineLayer[] = [];
  /** A server that does not say which Sequence a layer is in (or a layer outside every group): the tightest Sequence on its first frame. */
  const guess = (l: TimelineLayer): string | undefined => {
    const at = l.ranges[0]?.[0];
    if (at === undefined) return undefined;
    let best: SequenceJson | undefined;
    for (const s of sequences) {
      if (at >= s.from && at < s.from + s.durationInFrames && (!best || s.durationInFrames <= best.durationInFrames)) best = s;
    }
    return best?.key;
  };
  for (const l of layers) {
    const key = l.sequence !== undefined && keys.has(l.sequence) ? l.sequence : guess(l);
    if (key !== undefined) {
      const list = owned.get(key);
      if (list) list.push(l);
      else owned.set(key, [l]);
    } else loose.push(l);
  }

  // Instances of the layers one owner holds: a layer is the root of an instance when it is named and its nearest named
  // ancestor belongs to another component. A generic layer of a component with no named root above it stands for it.
  const instancesOf = (own: TimelineLayer[], groupRoot: (l: TimelineLayer) => boolean): TimelineNode[] => {
    const local = new Map(own.map((l) => [l.id, l]));
    const set = { has: (id: string | null) => id !== null && local.has(id) };
    const kids = new Map<string, TimelineLayer[]>();
    for (const l of own) {
      if (l.parent === null || !local.has(l.parent)) continue;
      const list = kids.get(l.parent);
      if (list) list.push(l);
      else kids.set(l.parent, [l]);
    }
    const byId = local;
    const nearestNamed = (l: TimelineLayer): TimelineLayer | null => {
      let p = l.parent !== null && set.has(l.parent) ? byId.get(l.parent)! : null;
      while (p) {
        if (!isGeneric(p) && !groupRoot(p)) return p;
        p = p.parent !== null && set.has(p.parent) ? byId.get(p.parent)! : null;
      }
      return null;
    };
    const rootOf = new Map<string, string | null>(); // layer id -> id of the instance root it belongs to
    const roots: TimelineLayer[] = [];
    for (const l of own) {
      if (groupRoot(l)) {
        rootOf.set(l.id, null);
        continue;
      }
      const above = nearestNamed(l);
      const sameAbove = above !== null && above.component === l.component;
      if (!isGeneric(l)) {
        if (!sameAbove) roots.push(l);
        rootOf.set(l.id, sameAbove ? above!.id : l.id);
      } else if (l.component !== undefined && !sameAbove) {
        roots.push(l);
        rootOf.set(l.id, l.id);
      } else rootOf.set(l.id, sameAbove ? above!.id : null);
    }
    // Resolve a member to the instance root it finally belongs to (a root of its own, or the root above it).
    const finalRoot = (id: string): string | null => {
      let cur: string | null | undefined = rootOf.get(id);
      let guard = 0;
      while (cur != null && rootOf.get(cur) !== cur && guard++ < 1000) cur = rootOf.get(cur);
      return cur ?? null;
    };
    const rootSet = new Set(roots.map((r) => r.id));
    // The instance an instance sits inside: the root of its nearest named ancestor.
    const parentOf = new Map<string, string | null>();
    for (const r of roots) {
      let p = r.parent !== null && set.has(r.parent) ? byId.get(r.parent)! : null;
      let found: string | null = null;
      while (p) {
        const fr = finalRoot(p.id);
        if (fr !== null && rootSet.has(fr) && fr !== r.id) {
          found = fr;
          break;
        }
        p = p.parent !== null && set.has(p.parent) ? byId.get(p.parent)! : null;
      }
      parentOf.set(r.id, found);
    }
    const members = new Map<string, TimelineLayer[]>();
    for (const l of own) {
      const fr = finalRoot(l.id);
      if (fr === null) continue;
      const list = members.get(fr);
      if (list) list.push(l);
      else members.set(fr, [l]);
    }
    const children = new Map<string | null, TimelineLayer[]>();
    for (const r of roots) {
      const k = parentOf.get(r.id) ?? null;
      const list = children.get(k);
      if (list) list.push(r);
      else children.set(k, [r]);
    }

    /** Every layer an instance holds, nested as drawn, generic ones included. */
    const pieceTree = (root: TimelineLayer, members: Set<string>, rootSet: Set<string>): TimelineNode[] => {
      const make = (l: TimelineLayer): TimelineNode => ({
        id: `p:${l.id}`,
        kind: 'piece',
        label: displayName(l),
        ...(l.component !== undefined ? { component: l.component } : {}),
        ...(l.source ? { source: l.source } : {}),
        type: l.type,
        count: 1,
        bars: mergeRanges(l.ranges, gap),
        layerIds: [l.id],
        children: (kids.get(l.id) ?? []).filter((c) => members.has(c.id) && (!rootSet.has(c.id) || c.id === root.id)).map(make),
      });
      return (kids.get(root.id) ?? []).filter((c) => members.has(c.id) && !rootSet.has(c.id)).map(make);
    };

    const single = (r: TimelineLayer): TimelineNode => {
      const name = isGeneric(r) ? (r.component ?? displayName(r)) : displayName(r);
      const node: TimelineNode = {
        id: `i:${r.id}`,
        kind: 'component',
        label: name,
        ...(r.component !== undefined ? { component: r.component } : {}),
        ...(r.source ? { source: r.source } : {}),
        type: r.type,
        count: 1,
        bars: mergeRanges(r.ranges, gap),
        layerIds: [r.id],
        children: fold(children.get(r.id) ?? []),
      };
      const mine = members.get(r.id) ?? [];
      if (mine.length > 1) {
        node.pieces = () => pieceTree(r, new Set(mine.map((m) => m.id)), rootSet);
      }
      return node;
    };
    const fold = (list: TimelineLayer[]): TimelineNode[] => {
      const groups = new Map<string, TimelineLayer[]>();
      const order: string[] = [];
      for (const r of list) {
        const key = `${r.component ?? ''}@${sourceKey(r.source)}@${r.component === undefined ? displayName(r) : ''}`;
        const g = groups.get(key);
        if (g) g.push(r);
        else {
          groups.set(key, [r]);
          order.push(key);
        }
      }
      return order
        .map((key) => {
          const g = groups.get(key)!;
          if (g.length === 1) return single(g[0]!);
          const first = g[0]!;
          const items = g.map(single);
          const label = first.component ?? displayName(first);
          return {
            id: `f:${first.id}`,
            kind: 'component' as const,
            label,
            ...(first.component !== undefined ? { component: first.component } : {}),
            ...(first.source ? { source: first.source } : {}),
            count: g.length,
            bars: mergeRanges(g.flatMap((r) => r.ranges), gap),
            layerIds: g.map((r) => r.id),
            children: items,
          };
        })
        .sort((a, b) => (a.bars[0]?.[0] ?? 0) - (b.bars[0]?.[0] ?? 0));
    };
    return fold(children.get(null) ?? []);
  };

  const seqNodes = new Map<string, TimelineNode>();
  for (const s of sequences) {
    const own = owned.get(s.key) ?? [];
    const groupRoot = (l: TimelineLayer) => l.parent === null || !own.some((o) => o.id === l.parent);
    // The Sequence's own group is the topmost layer it owns; it stands for the Sequence, not a row of its own.
    const topIds = new Set(own.filter(groupRoot).map((l) => l.id));
    const node: TimelineNode = {
      id: `s:${s.key}`,
      kind: 'sequence',
      label: s.label ?? s.name ?? 'Sequence',
      ...(s.component !== undefined ? { component: s.component } : {}),
      ...(s.source ? { source: s.source } : {}),
      count: 1,
      bars: [[s.from, s.from + s.durationInFrames - 1]],
      layerIds: s.layer !== null ? [s.layer] : [],
      children: instancesOf(own, (l) => topIds.has(l.id) && l.label === (s.label ?? s.name)),
    };
    seqNodes.set(s.key, node);
  }
  const roots: TimelineNode[] = [];
  for (const s of sequences) {
    const node = seqNodes.get(s.key)!;
    const parent = s.parent !== null ? seqNodes.get(s.parent) : undefined;
    if (parent) parent.children.unshift(node);
    else roots.push(node);
  }
  // Sequences nest before the components of their parent, each group in time order.
  const sortSeq = (n: TimelineNode) => {
    const seqs = n.children.filter((c) => c.kind === 'sequence').sort((a, b) => a.bars[0]![0] - b.bars[0]![0]);
    const rest = n.children.filter((c) => c.kind !== 'sequence');
    n.children = [...seqs, ...rest];
    seqs.forEach(sortSeq);
  };
  roots.forEach(sortSeq);

  // Layers outside every Sequence group are still reachable: one row for them.
  if (loose.length > 0) {
    const children = instancesOf(loose, () => false);
    if (children.length > 0) {
      roots.push({
        id: 's:/',
        kind: 'sequence',
        label: sequences.length > 0 ? 'Outside Sequences' : 'Scene',
        count: 1,
        bars: mergeRanges(children.flatMap((c) => c.bars), Number.MAX_SAFE_INTEGER),
        layerIds: [],
        children,
      });
    }
  }
  return { roots };
}

/** Rows in display order: a node's children follow it when it is expanded. */
export interface VisibleRow {
  node: TimelineNode;
  depth: number;
  expandable: boolean;
  expanded: boolean;
}

/** The text a search matches a node on. */
function haystack(n: TimelineNode): string {
  return `${n.label} ${n.component ?? ''} ${n.source ? `${n.source.file}:${n.source.line}` : ''}`.toLowerCase();
}

/**
 * The rows to draw. `expanded` holds opened node ids; with a search, every node on the way to a match opens. `details`
 * adds the raw pieces under each single instance.
 */
export function visibleRows(
  roots: TimelineNode[],
  expanded: ReadonlySet<string>,
  query: string,
  details: boolean,
): VisibleRow[] {
  const q = query.trim().toLowerCase();
  const out: VisibleRow[] = [];
  const kidsOf = (n: TimelineNode): TimelineNode[] => (details && n.pieces ? [...n.children, ...n.pieces()] : n.children);
  /** Whether the subtree has a match; fills `out` when so. */
  const visit = (n: TimelineNode, depth: number): boolean => {
    const children = kidsOf(n);
    if (q === '') {
      const open = expanded.has(n.id);
      out.push({ node: n, depth, expandable: children.length > 0, expanded: open });
      if (open) for (const c of children) visit(c, depth + 1);
      return true;
    }
    const at = out.length;
    out.push({ node: n, depth, expandable: children.length > 0, expanded: false });
    let any = false;
    for (const c of children) if (visit(c, depth + 1)) any = true;
    const self = haystack(n).includes(q);
    if (!self && !any) {
      out.length = at;
      return false;
    }
    out[at]!.expanded = any;
    return true;
  };
  for (const r of roots) visit(r, 0);
  return out;
}

/** The frame a click on a row seeks to: its first bar's start, unless the playhead is already inside a bar. */
export function seekTarget(node: TimelineNode, frame: number): number | null {
  if (node.bars.length === 0) return null;
  if (node.bars.some(([a, b]) => frame >= a && frame <= b)) return null;
  return node.bars[0]![0];
}
