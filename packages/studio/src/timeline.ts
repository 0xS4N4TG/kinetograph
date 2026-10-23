import type { Engine } from './engine.js';
import type { SequenceJson, TimelineData, TimelineLayer } from './protocol.js';

interface SceneLayer {
  id: string;
  type: string;
  children?: SceneLayer[];
}

/**
 * The timeline of a composition: its JS stage run for every frame (no addon), with the Sequences and the layers the
 * frames show folded into one list each (packages/cli/skills/kinetograph/references/AUTHORING.md §11.5).
 */
export async function sweepTimeline(
  engine: Engine,
  request: { comp: string; props: Record<string, unknown> },
): Promise<TimelineData> {
  const { composition } = await engine.plan(request);
  const { durationInFrames, fps } = composition;

  const sequences = new Map<string, { entry: SequenceJson; order: number }>();
  const layers = new Map<string, TimelineLayer>();

  const walk = (list: SceneLayer[], parent: string | null, frame: number): void => {
    for (const layer of list) {
      const known = layers.get(layer.id);
      if (!known) {
        layers.set(layer.id, { id: layer.id, type: layer.type, parent, ranges: [[frame, frame]] });
      } else {
        const last = known.ranges[known.ranges.length - 1]!;
        if (last[1] >= frame - 1) last[1] = Math.max(last[1], frame);
        else known.ranges.push([frame, frame]);
      }
      if (layer.children) walk(layer.children, layer.id, frame);
    }
  };

  for (let frame = 0; frame < durationInFrames; frame++) {
    const scene = await engine.frame({ ...request, frame });
    for (const entry of scene.sequences) {
      const known = sequences.get(entry.key);
      if (!known) sequences.set(entry.key, { entry: { ...entry }, order: sequences.size });
      // The layer of the first frame the Sequence shows on.
      else if (known.entry.layer === null && entry.layer !== null) known.entry.layer = entry.layer;
    }
    walk((JSON.parse(scene.sceneJson) as { layers: SceneLayer[] }).layers, null, frame);
    if (scene.constant) {
      // A scene file is one scene: every layer is there for the whole composition.
      for (const layer of layers.values()) layer.ranges = [[0, durationInFrames - 1]];
      break;
    }
  }

  return {
    comp: composition.id,
    fps,
    durationInFrames,
    sequences: [...sequences.values()]
      .sort((a, b) => a.entry.from - b.entry.from || a.order - b.order)
      .map(({ entry }) => entry),
    layers: [...layers.values()],
  };
}
