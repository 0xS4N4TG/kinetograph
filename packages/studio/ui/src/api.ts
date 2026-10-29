// The one module that talks to the studio server (packages/cli/skills/kinetograph/references/AUTHORING.md §11.5): the HTTP routes and the `/ws` WebSocket.
// Everything else in the UI depends on the `StudioApi` interface, so tests swap in a mock server.

import { decodeFrameMessage } from '../../src/protocol.ts';
import type {
  AgentClientMessage,
  AgentEvent,
  AgentInfo,
  AgentPermissionOption,
  AgentStatus,
  ChatRecord,
  ClientMessage,
  CompositionInfo,
  FrameHeader,
  FrameRequest,
  InspectResult,
  PluginSummary,
  PresetInfo,
  ProjectInfo,
  RenderJob,
  RenderRequest,
  ServerMessage,
  StudioError,
  TimelineData,
  TimelineProgress,
} from '../../src/protocol.ts';

export type {
  AgentClientMessage,
  AgentEvent,
  AgentInfo,
  AgentPermissionOption,
  AgentStatus,
  ChatRecord,
  CompositionInfo,
  FrameHeader,
  InspectResult,
  PluginSummary,
  PresetInfo,
  ProjectInfo,
  RenderJob,
  RenderRequest,
  ServerMessage,
  StudioError,
  TimelineData,
  TimelineProgress,
};
export type { SequenceJson } from '../../src/protocol.ts';
export type { RenderStatus, TimelineLayer } from '../../src/protocol.ts';

/** A failed request: the server's `StudioError`, plus the HTTP status when there was one. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** The arguments of a frame request; the socket adds `type` and picks the `requestId`. */
export type FrameArgs = Omit<FrameRequest, 'type' | 'requestId'>;

export interface ReceivedFrame {
  header: FrameHeader;
  image: Uint8Array;
}

export interface SocketHandlers {
  onMessage(message: ServerMessage): void;
  onFrame(frame: ReceivedFrame): void;
  /** Called with true each time the socket opens and false each time it closes. */
  onConnection(open: boolean): void;
}

export interface StudioSocket {
  /** Sends a frame request and returns its `requestId`; -1 when the socket is not open (nothing was sent). */
  requestFrame(args: FrameArgs): number;
  /** Sends a message for the coding agent; false when the socket is not open. */
  sendAgent(message: AgentClientMessage): boolean;
  /** Tells the server what this window previews; false when the socket is not open. */
  sendProps(comp: string, props: Record<string, unknown>): boolean;
  close(): void;
}

export interface StudioApi {
  project(): Promise<ProjectInfo>;
  compositions(): Promise<CompositionInfo[]>;
  inspect(comp: string, frame: number, props?: Record<string, unknown>): Promise<InspectResult>;
  timeline(comp: string, props?: Record<string, unknown>): Promise<TimelineData>;
  /** How far the sweep that `timeline` waits for has got. */
  timelineProgress(comp: string, props?: Record<string, unknown>): Promise<TimelineProgress>;
  /** The saved presets of a composition. */
  presets(comp: string): Promise<PresetInfo[]>;
  /** Writes `presets/<comp>/<name>.json` beside the entry. */
  savePreset(comp: string, name: string, props: Record<string, unknown>): Promise<void>;
  /** The installed Kinetograph plugins. */
  plugins(): Promise<PluginSummary[]>;
  /** The coding agents on offer. */
  agentInfo(): Promise<AgentInfo>;
  renders(): Promise<RenderJob[]>;
  startRender(request: RenderRequest): Promise<RenderJob>;
  cancelRender(id: string): Promise<RenderJob>;
  /** Opens `/ws` and keeps it open: it reconnects after a drop. */
  connect(handlers: SocketHandlers): StudioSocket;
  /**
   * The address of a small picture of frame `frame`, `height` px tall, for a clip of the timeline. The server draws it
   * only while no preview frame is being asked for; `build` makes the address change when the project is rebuilt.
   */
  thumbnailUrl(comp: string, frame: number, height: number, build: number, props?: Record<string, unknown>): string;
}

export interface ApiOptions {
  /** Origin of the server, e.g. `http://127.0.0.1:3000`; default the page's own origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** Delay before reconnecting, ms. */
  reconnectDelay?: number;
  /** The secret from the address the studio opened (`?token=`); default read from the page's address. */
  token?: string;
}

/** The token in the page's address, kept for the tab so that a reload without it still works. */
function pageToken(): string | null {
  try {
    const found = new URLSearchParams(window.location.search).get('token');
    if (found) {
      sessionStorage.setItem('studio-token', found);
      return found;
    }
    return sessionStorage.getItem('studio-token');
  } catch {
    return null;
  }
}

function query(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

function propsParam(props: Record<string, unknown> | undefined): string | undefined {
  return props === undefined ? undefined : JSON.stringify(props);
}

export function createApi(options: ApiOptions = {}): StudioApi {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const reconnectDelay = options.reconnectDelay ?? 1000;
  const token = options.token ?? pageToken();

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, init);
    } catch (cause) {
      throw new ApiError('IO', cause instanceof Error ? cause.message : String(cause));
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // not JSON: handled below
    }
    if (!response.ok) {
      const error = (body as { error?: StudioError } | null)?.error;
      throw new ApiError(error?.code ?? 'IO', error?.message ?? `${response.status} ${response.statusText}`, response.status);
    }
    return body as T;
  }

  function webSocketUrl(): string {
    const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
    if (baseUrl !== '') return `${baseUrl.replace(/^http/, 'ws')}/ws${suffix}`;
    const { protocol, host } = window.location;
    return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/ws${suffix}`;
  }

  return {
    project: () => request<ProjectInfo>('/api/project'),
    compositions: () => request<CompositionInfo[]>('/api/compositions'),
    inspect: (comp, frame, props) =>
      request<InspectResult>(`/api/inspect${query({ comp, frame, props: propsParam(props) })}`),
    timeline: (comp, props) => request<TimelineData>(`/api/timeline${query({ comp, props: propsParam(props) })}`),
    timelineProgress: (comp, props) =>
      request<TimelineProgress>(`/api/timeline/progress${query({ comp, props: propsParam(props) })}`),
    presets: async (comp) => (await request<{ presets: PresetInfo[] }>(`/api/presets${query({ comp })}`)).presets,
    savePreset: async (comp, name, props) => {
      await request(`/api/presets/${encodeURIComponent(comp)}/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(props),
      });
    },
    plugins: async () => (await request<{ plugins: PluginSummary[] }>('/api/plugins')).plugins,
    agentInfo: () => request<AgentInfo>('/api/agent', { headers: token ? { 'X-Studio-Token': token } : {} }),
    renders: () => request<RenderJob[]>('/api/renders'),
    startRender: (body) =>
      request<RenderJob>('/api/renders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    cancelRender: (id) => request<RenderJob>(`/api/renders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    thumbnailUrl: (comp, frame, height, build, props) =>
      `${baseUrl}/api/thumbnail${query({ comp, frame, height, build, props: propsParam(props) })}`,

    connect(handlers) {
      const Socket = options.WebSocket ?? WebSocket;
      let socket: WebSocket | null = null;
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let nextRequestId = 1;

      const open = () => {
        const ws = new Socket(webSocketUrl());
        ws.binaryType = 'arraybuffer';
        socket = ws;
        ws.onopen = () => handlers.onConnection(true);
        ws.onmessage = (event: MessageEvent) => {
          if (typeof event.data === 'string') {
            handlers.onMessage(JSON.parse(event.data) as ServerMessage);
          } else {
            handlers.onFrame(decodeFrameMessage(event.data as ArrayBuffer));
          }
        };
        ws.onclose = () => {
          if (socket === ws) socket = null;
          handlers.onConnection(false);
          if (!closed) timer = setTimeout(open, reconnectDelay);
        };
      };
      open();

      return {
        requestFrame(args) {
          if (socket === null || socket.readyState !== 1) return -1;
          const requestId = nextRequestId++;
          const message: ClientMessage = { type: 'frame', requestId, ...args };
          socket.send(JSON.stringify(message));
          return requestId;
        },
        sendAgent(message) {
          if (socket === null || socket.readyState !== 1) return false;
          socket.send(JSON.stringify(message));
          return true;
        },
        sendProps(comp, props) {
          if (socket === null || socket.readyState !== 1) return false;
          const message: ClientMessage = { type: 'props', comp, props };
          socket.send(JSON.stringify(message));
          return true;
        },
        close() {
          closed = true;
          if (timer !== null) clearTimeout(timer);
          socket?.close();
        },
      };
    },
  };
}
