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

/**
 * The topmost layer under the composition-pixel point (x, y), or null. Later layers draw on top of earlier ones, and a
 * group's children on top of the group, so each layer is checked after its children and before the layers below it.
 */
export function hitTest(layers: InspectLayer[], x: number, y: number): InspectLayer | null {
  for (const layer of [...layers].reverse()) {
    const inside = layer.children ? hitTest(layer.children, x, y) : null;
    if (inside) return inside;
    const rect = layer.bounds ?? layer.box;
    if (rect && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) return layer;
  }
  return null;
}
