import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { decodeFrameMessage, startStudio, type FrameHeader, type ServerMessage, type StudioOptions, type StudioServer } from '../src/index.js';

export const STUB_ENGINE = fileURLToPath(new URL('./fixtures/stub-engine.mjs', import.meta.url));

const scratch: string[] = [];

/** A directory that is removed by `cleanup`. */
export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kinetograph-studio-test-')));
  scratch.push(dir);
  return dir;
}

export function cleanup(): void {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The source of a project that the stub engine reads its marker from. */
export const projectSource = (mark: string): string =>
  `import { registerRoot } from 'remotion';\nregisterRoot(() => null);\n(globalThis as any).__mark = 'KG_MARK:${mark}';\n`;

export function writeProject(mark: string): { dir: string; entry: string } {
  const dir = tempDir();
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  const entry = join(dir, 'index.tsx');
  writeFileSync(entry, projectSource(mark));
  return { dir, entry };
}

export function writeScene(id: string): { dir: string; entry: string } {
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'scene.json');
  writeFileSync(entry, JSON.stringify({ id }));
  return { dir, entry };
}

const open: StudioServer[] = [];

/** A studio on a free port, with the stub engine unless `options.engine` says otherwise. */
export async function start(entry: string, options: Partial<StudioOptions> = {}): Promise<StudioServer> {
  const server = await startStudio({ entry, port: 0, open: false, engine: STUB_ENGINE, catalog: { offline: true, cacheFile: join(tempDir(), 'plugin-catalog.json') }, ...options });
  open.push(server);
  return server;
}

export async function stopAll(): Promise<void> {
  await Promise.all(open.splice(0).map((s) => s.close()));
}

export interface ApiResult<T = any> {
  status: number;
  headers: Headers;
  json: T;
  body: Uint8Array;
}

/** A request to the studio; `json` is the parsed body when it is JSON. */
export async function api<T = any>(server: StudioServer, path: string, init: RequestInit & { json?: unknown } = {}): Promise<ApiResult<T>> {
  const { json: payload, ...rest } = init;
  const headers = new Headers(rest.headers);
  let body = rest.body;
  if (payload !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(payload);
  }
  const response = await fetch(new URL(path, server.url), { ...rest, headers, body });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let json: T | undefined;
  if ((response.headers.get('content-type') ?? '').includes('json')) json = JSON.parse(new TextDecoder().decode(bytes)) as T;
  return { status: response.status, headers: response.headers, json: json as T, body: bytes };
}

export type Received = { kind: 'json'; message: ServerMessage; at: number } | { kind: 'frame'; header: FrameHeader; image: Uint8Array; at: number };

/** The secret in the address the studio opened. */
export const tokenOf = (server: StudioServer): string | null => new URL(server.url).searchParams.get('token');

/** A WebSocket to the studio that keeps every message it receives. */
export class Client {
  readonly received: Received[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      const at = Date.now();
      if (isBinary) this.received.push({ kind: 'frame', ...decodeFrameMessage(new Uint8Array(data)), at });
      else this.received.push({ kind: 'json', message: JSON.parse(data.toString()) as ServerMessage, at });
    });
  }

  static async connect(server: StudioServer, options: WebSocket.ClientOptions = {}, token: string | null = tokenOf(server)): Promise<Client> {
    const address = new URL('/ws', server.url);
    if (token !== null) address.searchParams.set('token', token);
    const ws = new WebSocket(address.href.replace(/^http/, 'ws'), options);
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    return client;
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  messages(type?: string): ServerMessage[] {
    return this.received.flatMap((r) => (r.kind === 'json' && (type === undefined || r.message.type === type) ? [r.message] : []));
  }

  frames(): Extract<Received, { kind: 'frame' }>[] {
    return this.received.filter((r): r is Extract<Received, { kind: 'frame' }> => r.kind === 'frame');
  }

  /** Resolves with the first received item (including ones already received) that `match` accepts. */
  async waitFor(match: (r: Received) => boolean, ms = 8000): Promise<Received> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.received.find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out; received ${JSON.stringify(this.received.map((r) => (r.kind === 'json' ? r.message : r.header)))}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  waitForMessage(type: string, where: (m: any) => boolean = () => true, ms?: number): Promise<Received> {
    return this.waitFor((r) => r.kind === 'json' && r.message.type === type && where(r.message), ms);
  }

  close(): void {
    this.ws.terminate();
  }
}

/** Polls `read` until `done` accepts what it returns. */
export async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
