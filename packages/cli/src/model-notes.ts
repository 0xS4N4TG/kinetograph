// What the glTF models of a scene use that the engine does not read (docs/SCENE.md, "scene3d"). The addon reads each
// file once (`modelUnsupported`); every frame that draws the model then holds these as unsupported content
// (kinetograph site, /docs/compat/), so the warning, `--strict`, `doctor` and the studio treat them as they do anything else the
// engine leaves out.

import type { Unsupported } from '@kinetograph/scene';
import { native } from './native.js';

interface ModelUse {
  layer: string;
  src: string;
}

/** The `model` objects in a 3D layer's `objects`, groups included. */
function modelsIn(layer: string, objects: unknown, out: ModelUse[]): void {
  if (!Array.isArray(objects)) return;
  for (const object of objects as { type?: unknown; src?: unknown; children?: unknown }[]) {
    if (object.type === 'model' && typeof object.src === 'string') out.push({ layer, src: object.src });
    else if (object.type === 'group') modelsIn(layer, object.children, out);
  }
}

function layersIn(layers: unknown, out: ModelUse[]): void {
  if (!Array.isArray(layers)) return;
  for (const layer of layers as { id?: unknown; type?: unknown; objects?: unknown; children?: unknown }[]) {
    if (layer.type === 'scene3d') modelsIn(String(layer.id), layer.objects, out);
    layersIn(layer.children, out);
  }
}

/**
 * Lists the unsupported content of the models in a frame's scene JSON. Models are resolved against `baseDir`, as the
 * addon does, and each file is read once. A file that cannot be read says nothing here: the render fails on it.
 */
export function modelNotes(baseDir: string): (sceneJson: string) => Unsupported[] {
  const files = new Map<string, { feature: string; reason: string }[]>();
  const read = (src: string) => {
    let notes = files.get(src);
    if (notes === undefined) {
      try {
        notes = native().modelUnsupported(src, baseDir);
      } catch {
        notes = [];
      }
      files.set(src, notes);
    }
    return notes;
  };
  return (sceneJson) => {
    // Most scenes draw no model: do not parse them.
    if (!sceneJson.includes('"model"')) return [];
    const uses: ModelUse[] = [];
    layersIn((JSON.parse(sceneJson) as { layers?: unknown }).layers, uses);
    return uses.flatMap(({ layer, src }) =>
      read(src).map((note) => ({ path: `${layer} <Model>`, element: 'Model', property: note.feature, value: src, reason: note.reason })),
    );
  };
}
