// The studio's HTTP and WebSocket API (packages/cli/skills/kinetograph/references/AUTHORING.md §11.5). The server
// answers with these shapes and the UI reads them; both import this file:
// types and the binary frame codec, nothing that touches Node or the DOM.

import type { CompositionInfo } from '@kinetographdev/core';
import type { LayerName, SequenceJson, SourceLocation } from '@kinetographdev/scene';
import type { InspectLayer, InspectResult } from 'kinetograph';
import type { OpenPanel, PanelAnswer, PanelKind, PanelStatus } from './panels/types.js';

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
  /** The sounds the composition plays, one per clip id; absent from older servers. */
  audio?: TimelineAudio[];
}

/** One sound of the composition: an `<Audio>`, or the sound of a `<Video>` (`video`). */
export interface TimelineAudio {
  /** Names the sound (its file, start, trims and rate), not its place in the tree; `GET /api/waveform?clip=` takes it. */
  id: string;
  src: string;
  video?: boolean;
  /** Inclusive frame ranges in which it is playing (not muted), ascending and disjoint. */
  ranges: [first: number, last: number][];
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
  /** Key of the innermost Sequence whose group the layer sits in; absent for layers outside every Sequence group (older
   * servers never send it). Path ids repeat between Sequences, so `id` is only unique together with `sequence`. */
  sequence?: string;
}

/** One of `GET /api/presets`. */
export interface PresetInfo {
  name: string;
  props: Record<string, unknown>;
}

/** `GET /api/live-props`, and the body of `PUT /api/live-props`. `comp` is null before any window has said what it previews. */
export interface LiveProps {
  comp: string | null;
  props: Record<string, unknown>;
}

/** One of `GET /api/plugins`. */
export interface PluginSummary {
  name: string;
  version: string;
  /** The name to show (contract section 11). */
  title: string;
  description: string;
  /** The URL of the plugin's icon SVG; null for the generic icon. */
  icon: string | null;
  /** The components the plugin exports that draw layers. */
  components: string[];
  /** The plugin's SKILL.md, absolute. */
  skill: string | null;
  /** The URL of the bundled panel module. */
  panel: string | null;
  /** The names of the plugin's MCP tools (empty when it has none or they do not load). */
  tools: string[];
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
export type ClientMessage = FrameRequest | AgentClientMessage | PropsMessage | PanelClientMessage;

/** Client → server: the person's answer to a panel the agent opened, or closing it without one. */
export type PanelClientMessage =
  | { type: 'panel.submit'; id: string; answer: PanelAnswer[PanelKind] }
  | { type: 'panel.dismiss'; id: string };

/** Client → server: the composition and props the window previews, sent on every props change and composition switch. */
export interface PropsMessage {
  type: 'props';
  comp: string;
  props: Record<string, unknown>;
}

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
  | { type: 'error'; requestId: number | null; error: StudioError }
  | { type: 'agent'; event: AgentEvent }
  /** Props pushed by `PUT /api/live-props`: the window switches to `comp` and replaces its props with these. */
  | { type: 'props'; comp: string; props: Record<string, unknown> }
  /** The conversation so far, sent to a window that takes it over (a reload of the one that began it). */
  | { type: 'agent.history'; items: ChatRecord[] }
  /** A panel the agent opened (or, to a window that connects, one kept: open, or submitted for the stepper). */
  | { type: 'panel'; panel: OpenPanel }
  /** A panel was submitted or dismissed (by the person, or replaced by a newer one of its kind); `panel` is how it ended. */
  | { type: 'panel.closed'; id: string; status: PanelStatus; panel: OpenPanel }
  /** A submitted answer was refused, in plain words; the panel stays open. */
  | { type: 'panel.error'; id: string; message: string };

/**
 * One step of the conversation as the server keeps it, to replay to a window that reconnects: what the agent sent
 * (`status` aside), the user's own messages and the permissions the user answered.
 */
export type ChatRecord =
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'user'; text: string; chips: string[] }
  | { kind: 'answer'; id: string; optionId: string | null };

// ---- the coding agent (ACP) ----

/** `GET /api/agent`. */
export interface AgentInfo {
  /** The agents found on this machine (and the `--agent` command): the ones the panel offers. */
  presets: AgentPreset[];
  /** The command in use, or null when none is chosen. */
  command: string | null;
  /** The directory the agent works in and may read and write. */
  cwd: string;
  /** The home directory, so the chat can write `~` for it. */
  home?: string;
  /** Why the agent is off, in plain words; absent when it is on. */
  disabled?: string;
}

export interface AgentPreset {
  id: string;
  name: string;
  command: string;
}

/** What the user says to the agent. `context` is the studio's description of what is selected. */
export type AgentClientMessage =
  | { type: 'agent.prompt'; text: string; context: string; image?: { data: string; mimeType: string }; chips?: string[] }
  | { type: 'agent.cancel' }
  /** Takes a message out of the queue (a prompt sent while the agent was working). */
  | { type: 'agent.unqueue'; id: string }
  /** The answer to a permission request; a null `optionId` denies it. */
  | { type: 'agent.permission'; id: string; optionId: string | null }
  /** Chooses the agent (one of `AgentInfo.presets`) and starts a new conversation. */
  | { type: 'agent.select'; command: string | null }
  | { type: 'agent.reset' };

export type AgentStatus = 'idle' | 'starting' | 'ready' | 'busy';

export interface AgentPermissionOption {
  id: string;
  name: string;
  kind: string;
}

/** Server → client: what the agent is doing. Text arrives in chunks to append. */
export type AgentEvent =
  | { kind: 'status'; status: AgentStatus; command: string | null; image: boolean }
  | { kind: 'message'; text: string }
  | { kind: 'thought'; text: string }
  /** A tool call or file edit; the same `id` again updates it. `files` are relative to the project. */
  | {
      kind: 'tool';
      id: string;
      title: string;
      toolKind: string;
      status: string;
      files: string[];
      /** What the agent asked the tool to do, in the few fields worth showing; absent from updates that do not repeat it. */
      input?: ToolInput;
      /** What the tool printed, cut to a size the chat can keep. */
      output?: string;
      /** The files it changed. */
      diffs?: ToolDiff[];
      /** How long the call took, once it has ended. */
      ms?: number;
    }
  | { kind: 'permission'; id: string; title: string; files: string[]; options: AgentPermissionOption[] }
  | { kind: 'permission_done'; id: string }
  | { kind: 'done'; stopReason: string }
  /** A problem in plain words. */
  | { kind: 'error'; message: string }
  /** A message the studio sent the agent for the person (a panel's answer), to show in the chat. */
  | { kind: 'user'; text: string; chips?: string[] }
  /** The messages waiting for the agent's turn to end: the whole queue, sent again whenever it changes. */
  | { kind: 'queue'; items: QueuedMessage[] };

/** A message the person sent while the agent was working, waiting for its turn to end. */
export interface QueuedMessage {
  id: string;
  text: string;
  chips: string[];
}

/** The parts of an agent's tool input the chat shows. */
export interface ToolInput {
  command?: string;
  description?: string;
  pattern?: string;
  url?: string;
  path?: string;
}

/** A file changed by a tool call: how many lines, and the changed lines with context, each starting with ' ', '+' or '-'. */
export interface ToolDiff {
  path: string;
  added: number;
  removed: number;
  lines: string[];
}

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
