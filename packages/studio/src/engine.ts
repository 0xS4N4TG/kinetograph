// The boundary between the studio server and the project (packages/cli/skills/kinetograph/references/AUTHORING.md §11.5). The server never runs the
// project: a worker thread loads an *engine module* that exports `createEngine`, and everything the server needs of the
// project, the renderer and the addon goes through this interface. The default engine (`real-engine.ts`) drives the
// CLI's source and the addon; tests name a stub module in `StudioOptions.engine`, which opens no GPU.

import type { CompositionInfo, InspectResult, SequenceJson } from './protocol.js';

export interface EngineOptions {
  /** The project entry, absolute: a project file or a `.json` scene. */
  entry: string;
  /** The built bundle of the project; null for a `.json` scene. */
  bundleFile: string | null;
}

/** One frame after the JS stage: what the preview, `inspect` and the timeline are made from. */
export interface FrameScene {
  /** The scene as the addon takes it. */
  sceneJson: string;
  frame: number;
  /** Asset paths in the scene resolve against this. */
  baseDir: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /** Every `<Sequence>` in the frame's tree (packages/cli/skills/kinetograph/references/AUTHORING.md §11.4). */
  sequences: SequenceJson[];
  /** A `.json` scene: every frame is the same scene. */
  constant: boolean;
  /** ms spent in the JS stage. */
  jsMs: number;
}

export interface PreviewRequest {
  scale: number;
  format: 'jpeg' | 'png';
}

export interface PreviewResult {
  width: number;
  height: number;
  mime: 'image/jpeg' | 'image/png';
  data: Uint8Array;
}

export interface RenderSpec {
  comp: string;
  props: Record<string, unknown>;
  /** Absolute. */
  output: string;
  /** Inclusive frames. */
  range: [first: number, last: number];
  encoder?: string;
  draft?: boolean;
}

export interface RenderHooks {
  /** After each frame is handed to the encoder. */
  onFrame(done: number, total: number): void;
  /** True once the job is to stop; the engine then throws an error with code `CANCELLED`. */
  shouldCancel(): boolean;
}

export interface Engine {
  /** The compositions the project registers. Throws when the project fails while loading. */
  compositions(): Promise<CompositionInfo[]>;
  /** The composition as it resolves with `props` (metadata calculated), and the frames `range` spells (default all). */
  plan(request: {
    comp: string;
    props: Record<string, unknown>;
    range?: string;
  }): Promise<{ composition: CompositionInfo; range: [number, number] }>;
  /** The JS stage for one frame. */
  frame(request: { comp: string; props: Record<string, unknown>; frame: number }): Promise<FrameScene>;
  /** The GPU stage: the frame rendered, scaled and encoded. The only call that opens a GPU device. */
  preview(scene: FrameScene, request: PreviewRequest): Promise<PreviewResult>;
  inspect(scene: FrameScene): Promise<InspectResult>;
  /** A whole render job; resolves with the addon's `RenderSummary`. */
  render(spec: RenderSpec, hooks: RenderHooks): Promise<Record<string, unknown>>;
  dispose(): void;
}

/** What an engine module exports. */
export type CreateEngine = (options: EngineOptions) => Engine | Promise<Engine>;

/** What a worker is for: the roles differ in which calls the server makes, not in the code. */
export type WorkerRole = 'project' | 'timeline' | 'render';

/** What a worker thread is started with. */
export interface WorkerInit {
  role: WorkerRole;
  /** Path of the engine module. */
  engine: string;
  options: EngineOptions;
  /** A render worker: slot 0 becomes 1 when the job is to stop. */
  cancel?: SharedArrayBuffer;
}

// ---- messages between the server and a worker ----

export type WorkerRequest =
  | { id: number; op: 'compositions' }
  | { id: number; op: 'plan'; comp: string; props: Record<string, unknown>; range?: string }
  | { id: number; op: 'preview'; comp: string; props: Record<string, unknown>; frame: number; scale: number; format: 'jpeg' | 'png' }
  | { id: number; op: 'inspect'; comp: string; props: Record<string, unknown>; frame: number }
  | { id: number; op: 'timeline'; comp: string; props: Record<string, unknown> }
  | { id: number; op: 'render'; spec: RenderSpec };

export type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }
  | { event: 'progress'; id: number; done: number; total: number };

/** What `preview` replies with: the image and the time the worker spent on it. */
export interface PreviewReply extends PreviewResult {
  /** JS stage + addon, ms. */
  ms: number;
}
