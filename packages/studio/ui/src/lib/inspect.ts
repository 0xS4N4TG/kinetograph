import type { InspectResult } from '@/api';

export type InspectLayer = InspectResult['layers'][number];

/** The layer with this id, at any depth, or null. */
export function findLayer(layers: InspectLayer[], id: string): InspectLayer | null {
  for (const layer of layers) {
    if (layer.id === id) return layer;
    const inside = layer.children ? findLayer(layer.children, id) : null;
    if (inside) return inside;
  }
  return null;
}
