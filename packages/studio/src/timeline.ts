import type { Engine } from './engine.js';
import type { LayerName, SequenceJson, TimelineData, TimelineLayer } from './protocol.js';
import { lookupName } from './util.js';

interface SceneLayer {
  id: string;
  type: string;
  children?: SceneLayer[];
}

/** What a frame knows of a layer's name that the layers seen on earlier frames did not. */
function nameLayer(layer: TimelineLayer, name: LayerName | undefined): void {
  if (name === undefined) return;
  layer.label ??= name.label;
  if (name.component !== undefined) layer.component ??= name.component;
  if (name.source !== undefined) layer.source ??= name.source;
}

/** How many frames the sweep reads between two progress reports. */
const PROGRESS_EVERY = 20;

/**
 * The timeline of a composition: its JS stage run for every frame (no addon), with the Sequences and the layers the
 * frames show folded into one list each (packages/cli/skills/kinetograph/references/AUTHORING.md §11.5).
 */
export async function sweepTimeline(
  engine: Engine,
  request: { comp: string; props: Record<string, unknown> },
  /** Called every few frames with the frames read so far and the total. */
  onProgress?: (done: number, total: number) => void,
): Promise<TimelineData> {
  const { composition } = await engine.plan(request);
  const { durationInFrames, fps } = composition;

  const sequences = new Map<string, { entry: SequenceJson; order: number }>();
  const layers = new Map<string, TimelineLayer>();

  const walk = (
    list: SceneLayer[],
    parent: string | null,
    frame: number,
    names: Record<string, LayerName> | undefined,
    /** Sequence group ids of this frame -> Sequence key (ids are paths, so they only mean something per frame). */
    groups: ReadonlyMap<string, string>,
    owner: string | undefined,
    /** The Sequence a layer outside every Sequence group is taken to be in: the tightest one showing on this frame. */
    fallback: string | undefined,
  ): void => {
    for (const layer of list) {
      const strong = groups.get(layer.id) ?? owner;
      // A path id (`$0.1.2`) names whatever sits there on a frame, so the same id in two Sequences is two layers.
      // A name the author gave is one layer wherever it is; with no group to go by it stays in the Sequence it began in.
      const sticky = strong === undefined && !layer.id.startsWith('$');
      const slot = sticky ? `\u0001${layer.id}` : `${strong ?? fallback ?? ''}\u0000${layer.id}`;
      const known = layers.get(slot);
      const own = strong ?? (known ? known.sequence : fallback);
      if (!known) {
        const added: TimelineLayer = { id: layer.id, type: layer.type, parent, ranges: [[frame, frame]] };
        nameLayer(added, lookupName(names, layer.id));
        if (own !== undefined) added.sequence = own;
        layers.set(slot, added);
      } else {
        if (known.label === undefined) nameLayer(known, lookupName(names, layer.id));
        const last = known.ranges[known.ranges.length - 1]!;
        if (last[1] >= frame - 1) last[1] = Math.max(last[1], frame);
        else known.ranges.push([frame, frame]);
      }
      if (layer.children) walk(layer.children, layer.id, frame, names, groups, strong, fallback);
    }
  };

  for (let frame = 0; frame < durationInFrames; frame++) {
    const scene = await engine.frame({ ...request, frame });
    for (const entry of scene.sequences) {
      const known = sequences.get(entry.key);
      if (!known) sequences.set(entry.key, { entry: { ...entry }, order: sequences.size });
      // The layer of the first frame the Sequence shows on.
      else {
        if (known.entry.layer === null && entry.layer !== null) known.entry.layer = entry.layer;
        // A Sequence that is not showing has no children to name it by; a later frame may.
        if (entry.label !== undefined && (known.entry.label === undefined || known.entry.label === 'Sequence')) known.entry.label = entry.label;
      }
    }
    // Entries come outer first: a group two Sequences share belongs to the outer one.
    const groups = new Map<string, string>();
    for (const entry of scene.sequences) if (entry.layer !== null && !groups.has(entry.layer)) groups.set(entry.layer, entry.key);
    let fallback: string | undefined;
    let tightest = Infinity;
    for (const entry of scene.sequences) {
      if (frame >= entry.from && frame < entry.from + entry.durationInFrames && entry.durationInFrames <= tightest) {
        tightest = entry.durationInFrames;
        fallback = entry.key;
      }
    }
    walk((JSON.parse(scene.sceneJson) as { layers: SceneLayer[] }).layers, null, frame, scene.names, groups, undefined, fallback);
    if (onProgress && ((frame + 1) % PROGRESS_EVERY === 0 || frame + 1 === durationInFrames)) onProgress(frame + 1, durationInFrames);
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
