// The studio's HTTP and WebSocket API (packages/cli/skills/kinetograph/references/AUTHORING.md §11.5). The server
// (stream 3) answers with these shapes and the UI (stream 4) reads them; both
// import this file, and only the orchestrator changes it: types and the
// binary frame codec, nothing that touches Node or the DOM.

import type { CompositionInfo } from '@kinetographdev/core';
import type { LayerName, SequenceJson, SourceLocation } from '@kinetographdev/scene';
import type { InspectLayer, InspectResult } from 'kinetograph';

export type { CompositionInfo, InspectLayer, InspectResult, LayerName, SequenceJson, SourceLocation };

/** `code` is one of the CLI's error codes (`INVALID_ARG`, `IO`, `RENDER`, …), or `NOT_FOUND` or `BUILD`. */
export interface StudioError {
  code: string;
  message: string;
}

/** `GET /api/project`. */
export interface ProjectInfo {
  /** The entry file, absolute. */
  entry: string;
  /** The directory the studio was started in: paths shown to the user are relative to it. */
  cwd: string;
  /** The `kinetograph` package version. */
  version: string;
  /** The build being served; 0 before the first good build. */
  buildId: number;
  /** The latest build's error, or null when it succeeded. */
  buildError: StudioError | null;
}

/** `GET /api/timeline`: every Sequence and layer of a composition over all its frames. */
export interface TimelineData {
  comp: string;
  fps: number;
  durationInFrames: number;
  /** The union over frames (one entry per key), sorted by `from`, then tree order. `layer` is that of the first frame
   * the Sequence shows on. */
  sequences: SequenceJson[];
  layers: TimelineLayer[];
}

/** `GET /api/timeline/progress`: how far the sweep for the timeline has got; `total` is 0 before it starts. */
export interface TimelineProgress {
  done: number;
  total: number;
}

export interface TimelineLayer {
  id: string;
  type: string;
  /** Id of the group it is in, or null at the top level. */
  parent: string | null;
  /** Inclusive frame ranges in which the layer is in the tree, ascending and disjoint. */
  ranges: [first: number, last: number][];
  /** What a person calls it (`Title · “Rewrote Remotion…”`); the id is a path for the studio's own use. */
  label?: string;
  /** The nearest user component that drew it. */
  component?: string;
  /** The JSX that made it. */
  source?: SourceLocation;
}

/** `POST /api/renders`. */
export interface RenderRequest {
  comp: string;
  /** Default `out/<comp>.mp4` next to the entry; relative paths resolve against the entry's directory. */
  output?: string;
  /** As `--range` (`"10..40"`); default the whole composition. */
  range?: string;
  props?: Record<string, unknown>;
  encoder?: string;
  /** Half size, as `render --draft`. */
  draft?: boolean;
}

export type RenderStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface RenderJob {
  /** `"1"`, `"2"`, … in the order jobs were queued. */
  id: string;
  comp: string;
  /** Absolute. */
  output: string;
  /** Inclusive. */
  range: [first: number, last: number];
  props: Record<string, unknown>;
  status: RenderStatus;
  /** Frames encoded so far, of `range`'s length. */
  framesDone: number;
  framesTotal: number;
  /** Mean ms per frame so far; null before the first frame. */
  msPerFrame: number | null;
  /** The addon's `RenderSummary` (§3) once done. */
  summary: Record<string, unknown> | null;
  error: StudioError | null;
  /** Wall-clock ms since the epoch (the server's own clock; never part of a render). */
  queuedAt: number;
  finishedAt: number | null;
}

// ---- WebSocket `/ws` ----

/** Client → server, JSON text. */
export type ClientMessage = FrameRequest;

export interface FrameRequest {
  type: 'frame';
  /** Chosen by the client, echoed in the reply. */
  requestId: number;
  comp: string;
  frame: number;
  /** 0 < scale <= 1. */
  scale: number;
  format: 'jpeg' | 'png';
  props?: Record<string, unknown>;
}

/** Server → client, JSON text, except frames (below). */
export type ServerMessage =
  | { type: 'hello'; version: string; buildId: number; buildError: StudioError | null }
  | { type: 'reload'; buildId: number }
  | { type: 'buildError'; error: StudioError }
  | { type: 'render'; job: RenderJob }
  | { type: 'error'; requestId: number | null; error: StudioError };

/**
 * A frame is one binary message: a 4-byte little-endian length `n`, then `n` bytes of UTF-8 JSON (`FrameHeader`), then
 * the image bytes.
 */
export interface FrameHeader {
  type: 'frame';
  requestId: number;
  comp: string;
  frame: number;
  buildId: number;
  width: number;
  height: number;
  mime: 'image/jpeg' | 'image/png';
  /** Time the server spent on this frame (JS stage + addon), ms. */
  ms: number;
}

/** Splits a binary frame message into its header and image bytes. */
export function decodeFrameMessage(message: ArrayBuffer | Uint8Array): { header: FrameHeader; image: Uint8Array } {
  const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as FrameHeader;
  return { header, image: bytes.subarray(4 + length) };
}

/** The binary frame message for `header` and `image`. */
export function encodeFrameMessage(header: FrameHeader, image: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + image.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  out.set(image, 4 + json.length);
  return out;
}
