// The default engine: the CLI's sources for the JS stage and the addon for the GPU stage. Runs inside a worker thread;
// `native().Renderer` (the only call that opens a GPU device) is made on the first preview or render.

import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  frameRange,
  listCompositions,
  native,
  openSource,
  renderSource,
  type Source,
} from 'kinetograph';
import type { Engine, EngineOptions, FrameScene } from './engine.js';
import type { InspectLayer, InspectResult, LayerName, SequenceJson, SourceLocation } from './protocol.js';
import { stableStringify } from './util.js';

/** Project compositions kept ready at once, each with its own frame renderer. */
const MAX_SOURCES = 4;

/** The real path of `path`, or `path` when it does not exist: macOS reports one file as `/var/...` and as `/private/var/...`. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const relativeFiles = new Map<string, string>();

/**
 * `file` as esbuild reported it (relative to the entry's directory, or absolute), relative to `cwd`; absolute when it
 * is outside `cwd`.
 */
export function relativeSource(source: SourceLocation, entryDir: string, cwd: string): SourceLocation {
  const key = `${entryDir}\n${cwd}\n${source.file}`;
  let file = relativeFiles.get(key);
  if (file === undefined) {
    const absolute = real(isAbsolute(source.file) ? source.file : resolve(real(entryDir), source.file));
    const rel = relative(real(cwd), absolute);
    file = rel === '' || rel.startsWith('..') || isAbsolute(rel) ? absolute : rel;
    relativeFiles.set(key, file);
  }
  return { ...source, file };
}

const withSource = <T extends { source?: SourceLocation }>(item: T, entryDir: string): T =>
  item.source === undefined ? item : { ...item, source: relativeSource(item.source, entryDir, process.cwd()) };

/** `layers` and their children with the names of `names` laid over. */
export function nameLayers(layers: InspectLayer[], names: Record<string, LayerName>): InspectLayer[] {
  return layers.map((layer) => {
    const name = names[layer.id];
    return {
      ...layer,
      ...(name !== undefined ? { label: name.label, ...(name.component !== undefined ? { component: name.component } : {}), ...(name.source !== undefined ? { source: name.source } : {}) } : {}),
      ...(layer.children ? { children: nameLayers(layer.children, names) } : {}),
    };
  });
}

export function createEngine({ entry, bundleFile }: EngineOptions): Engine {
  const sources = new Map<string, Promise<Source>>();
  let renderer: InstanceType<ReturnType<typeof native>['Renderer']> | undefined;
  const gpu = () => (renderer ??= new (native().Renderer)());

  /** The source of a composition with these props: one frame renderer per (composition, props). */
  function sourceFor(comp: string, props: Record<string, unknown>): Promise<Source> {
    const key = `${comp}\n${stableStringify(props)}`;
    let source = sources.get(key);
    if (source) {
      // Most recently used last.
      sources.delete(key);
    } else {
      source = openSource(entry, { comp, props: JSON.stringify(props), bundleFile: bundleFile ?? undefined });
      source.catch(() => sources.delete(key));
    }
    sources.set(key, source);
    for (const [oldKey, old] of sources) {
      if (sources.size <= MAX_SOURCES) break;
      sources.delete(oldKey);
      void old.then((s) => s.dispose(), () => undefined);
    }
    return source;
  }

  return {
    compositions: () => listCompositions(entry, { bundleFile: bundleFile ?? undefined }),

    async plan({ comp, props, range }) {
      const { composition } = await sourceFor(comp, props);
      return { composition, range: frameRange(range, composition.durationInFrames) };
    },

    async frame({ comp, props, frame }): Promise<FrameScene> {
      const source = await sourceFor(comp, props);
      const { durationInFrames, width, height, fps } = source.composition;
      if (!Number.isInteger(frame) || frame < 0 || frame >= durationInFrames) {
        throw Object.assign(new Error(`frame ${frame} is out of range: the composition has ${durationInFrames} frames (0..${durationInFrames - 1})`), {
          code: 'FRAME_OUT_OF_RANGE',
        });
      }
      try {
        const out = await source.frame(frame);
        const entryDir = dirname(entry);
        const names = out.names && Object.fromEntries(Object.entries(out.names).map(([id, name]) => [id, withSource(name, entryDir)]));
        return {
          sceneJson: out.sceneJson,
          frame,
          baseDir: source.baseDir,
          width,
          height,
          fps,
          durationInFrames,
          sequences: (out.sequences ?? []).map((s: SequenceJson) => withSource(s, entryDir)),
          ...(names ? { names } : {}),
          constant: source.kind === 'scene',
          jsMs: out.jsMs,
        };
      } catch (error) {
        // A frame renderer that threw may be half-way through a frame: the next request starts a new one.
        sources.delete(`${comp}\n${stableStringify(props)}`);
        source.dispose();
        throw error;
      }
    },

    async preview(scene, { scale, format }) {
      const image = gpu().preview(scene.sceneJson, scene.frame, { scale, format }, scene.baseDir);
      return {
        width: image.width,
        height: image.height,
        mime: image.mime as 'image/jpeg' | 'image/png',
        // A copy with its own buffer: the addon's is not one to hand across threads.
        data: new Uint8Array(image.data),
      };
    },

    async inspect(scene) {
      const result = JSON.parse(native().inspect(scene.sceneJson, scene.frame, scene.baseDir)) as InspectResult;
      return scene.names ? { ...result, layers: nameLayers(result.layers, scene.names) } : result;
    },

    async render(spec, hooks) {
      const source = await openSource(entry, { comp: spec.comp, props: JSON.stringify(spec.props), bundleFile: bundleFile ?? undefined });
      try {
        mkdirSync(dirname(spec.output), { recursive: true });
        const summary = await renderSource(source, new (native().Renderer)(), {
          output: spec.output,
          range: `${spec.range[0]}..=${spec.range[1]}`,
          encoder: spec.encoder,
          draft: spec.draft,
          onFrame: hooks.onFrame,
          shouldCancel: hooks.shouldCancel,
        });
        return { ...summary };
      } finally {
        source.dispose();
      }
    },

    dispose() {
      for (const source of sources.values()) void source.then((s) => s.dispose(), () => undefined);
      sources.clear();
      renderer = undefined;
    },
  };
}
