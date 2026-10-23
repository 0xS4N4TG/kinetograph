// The one module that talks to the studio server (packages/cli/skills/kinetograph/references/AUTHORING.md §11.5): the HTTP routes and the `/ws` WebSocket.
// Everything else in the UI depends on the `StudioApi` interface, so tests swap in a mock server.

import { decodeFrameMessage } from '../../src/protocol.ts';
import type {
  ClientMessage,
  CompositionInfo,
  FrameHeader,
  FrameRequest,
  InspectResult,
  ProjectInfo,
  RenderJob,
  RenderRequest,
  ServerMessage,
  StudioError,
  TimelineData,
} from '../../src/protocol.ts';

export type {
  CompositionInfo,
  FrameHeader,
  InspectResult,
  ProjectInfo,
  RenderJob,
  RenderRequest,
  ServerMessage,
  StudioError,
  TimelineData,
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
  close(): void;
}

export interface StudioApi {
  project(): Promise<ProjectInfo>;
  compositions(): Promise<CompositionInfo[]>;
  inspect(comp: string, frame: number, props?: Record<string, unknown>): Promise<InspectResult>;
  timeline(comp: string, props?: Record<string, unknown>): Promise<TimelineData>;
  renders(): Promise<RenderJob[]>;
  startRender(request: RenderRequest): Promise<RenderJob>;
  cancelRender(id: string): Promise<RenderJob>;
  /** Opens `/ws` and keeps it open: it reconnects after a drop. */
  connect(handlers: SocketHandlers): StudioSocket;
}

export interface ApiOptions {
  /** Origin of the server, e.g. `http://127.0.0.1:3000`; default the page's own origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** Delay before reconnecting, ms. */
  reconnectDelay?: number;
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
    if (baseUrl !== '') return `${baseUrl.replace(/^http/, 'ws')}/ws`;
    const { protocol, host } = window.location;
    return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/ws`;
  }

  return {
    project: () => request<ProjectInfo>('/api/project'),
    compositions: () => request<CompositionInfo[]>('/api/compositions'),
    inspect: (comp, frame, props) =>
      request<InspectResult>(`/api/inspect${query({ comp, frame, props: propsParam(props) })}`),
    timeline: (comp, props) => request<TimelineData>(`/api/timeline${query({ comp, props: propsParam(props) })}`),
    renders: () => request<RenderJob[]>('/api/renders'),
    startRender: (body) =>
      request<RenderJob>('/api/renders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    cancelRender: (id) => request<RenderJob>(`/api/renders/${encodeURIComponent(id)}`, { method: 'DELETE' }),

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
        close() {
          closed = true;
          if (timer !== null) clearTimeout(timer);
          socket?.close();
        },
      };
    },
  };
}
