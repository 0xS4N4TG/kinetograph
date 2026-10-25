// What the agent is told about the selection, sent with every message: the file, the composition and frame, and for each
// selected layer its name, kind, where it comes from in the source, where it is drawn and what it looks like now. It
// builds on the "Copy for agent" message (same wording for the layer, its Sequence and its current values).

import { currentValues, quoted, relativePath, sequenceOf, type AgentMessageInput } from '@/lib/agent-message';
import { formatNumber, formatTimecode } from '@/lib/format';
import type { InspectLayer } from '@/lib/inspect';
import { layerComponent, layerName, layerRect, layerSource } from '@/lib/selection';

export type ChatContextInput = Omit<AgentMessageInput, 'layer'> & { layers: InspectLayer[] };

function describe(layer: InspectLayer, index: number, { comp, frame, timeline }: ChatContextInput): string {
  const parts = [`${index + 1}. ${quoted(layerName(layer))}, a ${layer.type} layer`];
  const component = layerComponent(layer);
  if (component) parts.push(`drawn by the component ${component}`);
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
  const { entry, cwd, comp, frame, layers } = input;
  const header = `Project entry ${relativePath(entry, cwd)}, composition \`${comp.id}\`, frame ${frame} (${formatTimecode(frame, comp.fps)}).`;
  if (layers.length === 0) return header;
  return [header, `${layers.length === 1 ? 'Selected layer' : `Selected layers (${layers.length})`}:`, ...layers.map((l, i) => describe(l, i, input))].join('\n');
}
