// The chips above the prompt box. A few layers get a chip each; many are cut to the first three plus "+N more", and runs
// of the same kind fold into one chip ("28 shapes in showcase"), so the box never grows past a line or two. The popover
// behind "+N more" lists every layer.

import type { InspectLayer } from '@/lib/inspect';
import { chipText } from '@/lib/selection';

/** At most this many chips are drawn before "+N more". */
export const MAX_CHIPS = 3;
/** This many layers of one kind fold into a group chip. */
export const GROUP_MIN = 4;

export interface LayerEntry {
  id: string;
  text: string;
}

export type Chip =
  | { kind: 'layer'; key: string; text: string; ids: string[]; entries: LayerEntry[] }
  | { kind: 'group'; key: string; text: string; ids: string[]; entries: LayerEntry[] };

export const plural = (type: string, n: number): string => (n === 1 ? type : `${type}${/(s|x|ch|sh)$/.test(type) ? 'es' : 's'}`);

/**
 * The chips for the selected layers: with up to `MAX_CHIPS` layers one chip each; with more, kinds that have `GROUP_MIN`
 * or more layers become one group chip, in the order the kinds first appear.
 */
export function selectionChips(layers: InspectLayer[], texts: string[], compId: string, tail: string): Chip[] {
  const entries = layers.map((layer, i) => ({ id: layer.id, text: texts[i]! }));
  const single = (e: LayerEntry): Chip => ({ kind: 'layer', key: e.id, text: e.text, ids: [e.id], entries: [e] });
  if (layers.length <= MAX_CHIPS) return entries.map(single);
  const byType = new Map<string, LayerEntry[]>();
  layers.forEach((layer, i) => byType.set(layer.type, [...(byType.get(layer.type) ?? []), entries[i]!]));
  const chips: Chip[] = [];
  const done = new Set<string>();
  layers.forEach((layer, i) => {
    const group = byType.get(layer.type)!;
    if (group.length < GROUP_MIN) return void chips.push(single(entries[i]!));
    if (done.has(layer.type)) return;
    done.add(layer.type);
    chips.push({ kind: 'group', key: `group:${layer.type}`, text: `${group.length} ${plural(layer.type, group.length)} in ${compId}${tail}`, ids: group.map((e) => e.id), entries: group });
  });
  return chips;
}
