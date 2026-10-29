// What the agent is told about the selection, sent with every message: the file, the composition and frame, and for each
// selected layer its name, kind, where it comes from in the source, where it is drawn and what it looks like now. It
// builds on the "Copy for agent" message (same wording for the layer, its Sequence and its current values).

import { currentValues, quoted, relativePath, sequenceOf, type AgentMessageInput } from '@/lib/agent-message';
import { formatNumber, formatTimecode } from '@/lib/format';
import type { PluginSummary } from '@/api';
import type { InspectLayer } from '@/lib/inspect';
import { pluginOfLayer } from '@/lib/plugins';
import { isGeneric } from '@/lib/timeline-model';
import { layerComponent, layerName, layerRect, layerSource, rangeLabel, touchesRange, type FrameRange } from '@/lib/selection';

export type ChatContextInput = Omit<AgentMessageInput, 'layer'> & { layers: InspectLayer[]; plugins?: PluginSummary[]; range?: FrameRange | null };

const MAX_LISTED = 25;

/** The Sequences the span overlaps and the layers drawn at some point in it, from what the timeline read. */
function describeRange(range: FrameRange, timeline: NonNullable<ChatContextInput['timeline']>): string[] {
  const lines: string[] = [];
  const sequences = timeline.sequences.filter((s) => s.from <= range.end && s.from + s.durationInFrames - 1 >= range.start);
  lines.push(
    sequences.length === 0
      ? 'No Sequence overlaps this span.'
      : `Sequences it overlaps: ${sequences
          .slice(0, MAX_LISTED)
          .map((s) => `${quoted(s.label ?? s.name ?? 'Sequence')} (frames ${s.from} to ${s.from + s.durationInFrames - 1})`)
          .join(', ')}${sequences.length > MAX_LISTED ? `, and ${sequences.length - MAX_LISTED} more` : ''}.`,
  );
  // Identical siblings fold into one entry with a count; bare Groups and Shapes say nothing and are left out.
  const groups = new Map<string, number>();
  for (const layer of timeline.layers) {
    if (isGeneric(layer) || !touchesRange(layer.ranges, range)) continue;
    const name = layer.label ?? layer.component ?? (layer.id.startsWith("$") ? layer.type : layer.id);
    const key = layer.component && layer.component !== name ? `${name} (component ${layer.component})` : name;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const entries = [...groups].map(([name, n]) => (n > 1 ? `${quoted(name)} ×${n}` : quoted(name)));
  if (entries.length > 0) {
    lines.push(`Layers visible at some point in it: ${entries.slice(0, MAX_LISTED).join(', ')}${entries.length > MAX_LISTED ? `, and ${entries.length - MAX_LISTED} more` : ''}.`);
  }
  return lines;
}

function describe(layer: InspectLayer, index: number, input: ChatContextInput): string {
  const { comp, frame, timeline } = input;
  const parts = [`${index + 1}. ${quoted(layerName(layer))}, a ${layer.type} layer`];
  const component = layerComponent(layer);
  if (component) {
    const plugin = pluginOfLayer(input.plugins ?? [], layer);
    parts.push(
      plugin
        ? `drawn by the component ${component} of the plugin ${plugin.title} (${plugin.name}${plugin.skill ? `, guide at ${plugin.skill}` : ''})`
        : `drawn by the component ${component}`,
    );
  }
  const source = layerSource(layer);
  if (source) parts.push(`written at ${source.file}:${source.line}`);
  // An id the author chose is a good handle; a path through the tree is not, and is left out.
  if (!layer.id.startsWith('$')) parts.push(`id "${layer.id}"`);
  const sequence = sequenceOf(layer.id, frame, timeline);
  if (sequence) {
    parts.push(
      `inside Sequence ${quoted((sequence as { label?: string }).label ?? sequence.name ?? 'Sequence')} (frames ${sequence.from} to ${sequence.from + sequence.durationInFrames - 1})`,
    );
  }
  if (layer.text?.text) parts.push(`text ${quoted(layer.text.text)}`);
  const rect = layerRect(layer);
  if (rect) parts.push(`at ${formatNumber(rect.x, 0)},${formatNumber(rect.y, 0)}, ${formatNumber(rect.width, 0)}×${formatNumber(rect.height, 0)} px of the ${comp.id} frame`);
  const values = currentValues(layer);
  if (values.length > 0) parts.push(`it looks like this now: ${values.join(', ')}`);
  return `${parts.join('; ')}.`;
}

/** The context block for the selected layers, or '' when nothing is selected. */
export function buildChatContext(input: ChatContextInput): string {
  const { entry, cwd, comp, layers, range } = input;
  // With a span, a selected layer's Sequence is looked up inside it (at the playhead when that is in it).
  const frame = range ? Math.min(range.end, Math.max(range.start, input.frame)) : input.frame;
  input = { ...input, frame };
  const where = `Project entry ${relativePath(entry, cwd)}, composition \`${comp.id}\``;
  const header = range
    ? `${where}, a span of time: ${rangeLabel(range, comp.fps)}, ${range.end - range.start + 1} frames at ${comp.fps} fps.`
    : `${where}, frame ${frame} (${formatTimecode(frame, comp.fps)}).`;
  const extra = range && input.timeline ? describeRange(range, input.timeline) : [];
  if (layers.length === 0) return [header, ...extra].join('\n');
  return [header, ...extra, `${layers.length === 1 ? 'Selected layer' : `Selected layers (${layers.length})`}:`, ...layers.map((l, i) => describe(l, i, input))].join('\n');
}
