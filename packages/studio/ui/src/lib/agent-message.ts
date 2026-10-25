// The message the studio writes for a coding agent: which layer to change, where it is, and what it looks like now. The
// user edits it before copying. The engine does not know the source line of an element, so none is given.

import type { CompositionInfo, SequenceJson, TimelineLayer } from '@/api';
import { formatNumber, formatTimecode } from '@/lib/format';
import type { InspectLayer } from '@/lib/inspect';

export interface AgentMessageInput {
  /** The entry file, absolute, and the directory the studio was started in. */
  entry: string;
  cwd: string;
  comp: Pick<CompositionInfo, 'id' | 'fps'>;
  frame: number;
  layer: InspectLayer;
  /** What the timeline knows, to name the Sequence the layer is in; null while it is not read. */
  timeline: { sequences: SequenceJson[]; layers: TimelineLayer[] } | null;
}

/** `entry` relative to `cwd`, or as it is when it is somewhere else. */
export function relativePath(entry: string, cwd: string): string {
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return entry.startsWith(base) ? entry.slice(base.length) : entry;
}

/** The innermost Sequence showing at `frame` whose group holds the layer (or is the layer), or null. */
export function sequenceOf(
  layerId: string,
  frame: number,
  timeline: AgentMessageInput['timeline'],
): SequenceJson | null {
  if (!timeline) return null;
  const parents = new Map(timeline.layers.map((l) => [l.id, l.parent]));
  // The layer and the groups above it, innermost first.
  const chain: string[] = [];
  for (let id: string | null | undefined = layerId; id != null && !chain.includes(id); id = parents.get(id)) chain.push(id);
  let best: SequenceJson | null = null;
  let bestDepth = Infinity;
  for (const sequence of timeline.sequences) {
    if (sequence.layer === null || frame < sequence.from || frame >= sequence.from + sequence.durationInFrames) continue;
    const depth = chain.indexOf(sequence.layer);
    if (depth >= 0 && depth < bestDepth) {
      best = sequence;
      bestDepth = depth;
    }
  }
  return best;
}

function currentValues(layer: InspectLayer): string[] {
  const t = layer.transform;
  const out: string[] = [];
  if (layer.text?.font) out.push(`font ${layer.text.font} ${formatNumber(layer.text.size)}`);
  if (layer.opacity !== 1) out.push(`opacity ${formatNumber(layer.opacity)}`);
  if (t.scale !== 1) out.push(`scale ${formatNumber(t.scale)}`);
  if (t.rotation !== 0) out.push(`rotation ${formatNumber(t.rotation)}`);
  if (layer.blendMode !== 'normal') out.push(`blend mode ${layer.blendMode}`);
  if (layer.effects.length > 0) out.push(`effects ${layer.effects.join(', ')}`);
  if (layer.src !== undefined) out.push(`source ${layer.src}`);
  return out;
}

const quoted = (text: string) => JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);

/** The request, ending in `Change: ` for the user to finish. */
export function buildAgentMessage({ entry, cwd, comp, frame, layer, timeline }: AgentMessageInput): string {
  const lines = [`In ${relativePath(entry, cwd)}, composition \`${comp.id}\`, frame ${frame} (${formatTimecode(frame, comp.fps)}):`];

  let what = `change the ${layer.type} layer \`${layer.id}\``;
  if (layer.text?.text) what += `, text ${quoted(layer.text.text)}`;
  const sequence = sequenceOf(layer.id, frame, timeline);
  if (sequence) {
    what += `, inside Sequence ${quoted(sequence.name ?? 'Sequence')} (frames ${sequence.from} to ${sequence.from + sequence.durationInFrames - 1})`;
  }
  const rect = layer.bounds ?? layer.box;
  if (rect) {
    what += `, at ${formatNumber(rect.x, 0)},${formatNumber(rect.y, 0)}, ${formatNumber(rect.width, 0)}×${formatNumber(rect.height, 0)}`;
  }
  lines.push(`${what}.`);

  const values = currentValues(layer);
  if (values.length > 0) lines.push(`It looks like this now: ${values.join(', ')}.`);
  if (layer.id.startsWith('$')) {
    lines.push('The layer id comes from its place in the tree, so find it by its text, size and position.');
  }
  lines.push('', 'Change: ');
  return lines.join('\n');
}
