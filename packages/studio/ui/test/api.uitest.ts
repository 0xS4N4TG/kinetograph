import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApi, type ReceivedFrame, type ServerMessage } from '../src/api';
import { encodeFrameMessage } from '../../src/protocol';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createApi HTTP', () => {
  it('calls the routes of AUTHORING.md 11.5 with the props URL-encoded', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({}));
    const api = createApi({ baseUrl: 'http://localhost:3000/', fetch: fetchMock as unknown as typeof fetch });

    await api.project();
    await api.compositions();
    await api.inspect('Intro', 12, { title: 'A&B' });
    await api.timeline('Intro');
    await api.renders();
    await api.startRender({ comp: 'Intro', range: '0..9' });
    await api.cancelRender('7');

    const calls = fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`);
    expect(calls).toEqual([
      'GET http://localhost:3000/api/project',
      'GET http://localhost:3000/api/compositions',
      `GET http://localhost:3000/api/inspect?comp=Intro&frame=12&props=${encodeURIComponent('{"title":"A&B"}')}`,
      'GET http://localhost:3000/api/timeline?comp=Intro',
      'GET http://localhost:3000/api/renders',
      'POST http://localhost:3000/api/renders',
      'DELETE http://localhost:3000/api/renders/7',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[5]![1]!.body as string)).toEqual({ comp: 'Intro', range: '0..9' });
  });

  it('turns an error body into an ApiError with the server code and the status', async () => {
    const fetchMock = vi.fn(async () => json({ error: { code: 'NOT_FOUND', message: 'no composition X' } }, 404));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch });
    const failure = await api.inspect('X', 0).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: 'NOT_FOUND', message: 'no composition X', status: 404 });
  });
});

class FakeSocket {
  static instances: FakeSocket[] = [];
  binaryType = '';
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('createApi WebSocket', () => {
  it('sends numbered frame requests, decodes binary frames and passes JSON messages on', () => {
    FakeSocket.instances = [];
    const api = createApi({ baseUrl: 'http://127.0.0.1:3000', WebSocket: FakeSocket as unknown as typeof WebSocket });
    const frames: ReceivedFrame[] = [];
    const messages: ServerMessage[] = [];
    const connection: boolean[] = [];
    const socket = api.connect({
      onFrame: (f) => frames.push(f),
      onMessage: (m) => messages.push(m),
      onConnection: (open) => connection.push(open),
    });
    const ws = FakeSocket.instances[0]!;
    expect(ws.url).toBe('ws://127.0.0.1:3000/ws');
    expect(ws.binaryType).toBe('arraybuffer');

    expect(socket.requestFrame({ comp: 'Intro', frame: 1, scale: 1, format: 'png' })).toBe(-1);
    ws.open();
    expect(connection).toEqual([true]);

    expect(socket.requestFrame({ comp: 'Intro', frame: 1, scale: 0.5, format: 'jpeg', props: { a: 1 } })).toBe(1);
    expect(socket.requestFrame({ comp: 'Intro', frame: 2, scale: 1, format: 'png' })).toBe(2);
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: 'frame',
      requestId: 1,
      comp: 'Intro',
      frame: 1,
      scale: 0.5,
      format: 'jpeg',
      props: { a: 1 },
    });

    ws.onmessage?.({ data: JSON.stringify({ type: 'reload', buildId: 3 }) });
    expect(messages).toEqual([{ type: 'reload', buildId: 3 }]);

    const bytes = encodeFrameMessage(
      { type: 'frame', requestId: 2, comp: 'Intro', frame: 2, buildId: 3, width: 4, height: 2, mime: 'image/png', ms: 5 },
      new Uint8Array([9, 8, 7]),
    );
    ws.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.header).toMatchObject({ requestId: 2, frame: 2, mime: 'image/png' });
    expect([...frames[0]!.image]).toEqual([9, 8, 7]);
  });

  it('reconnects after a drop, and stops when closed', () => {
    vi.useFakeTimers();
    try {
      FakeSocket.instances = [];
      const api = createApi({
        baseUrl: 'http://127.0.0.1:3000',
        WebSocket: FakeSocket as unknown as typeof WebSocket,
        reconnectDelay: 500,
      });
      const connection: boolean[] = [];
      const socket = api.connect({ onFrame: () => {}, onMessage: () => {}, onConnection: (o) => connection.push(o) });
      FakeSocket.instances[0]!.open();
      FakeSocket.instances[0]!.close();
      expect(connection).toEqual([true, false]);
      expect(FakeSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(500);
      expect(FakeSocket.instances).toHaveLength(2);
      FakeSocket.instances[1]!.open();
      expect(socket.requestFrame({ comp: 'Intro', frame: 0, scale: 1, format: 'png' })).toBe(1);

      socket.close();
      vi.advanceTimersByTime(5000);
      expect(FakeSocket.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
