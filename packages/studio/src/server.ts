// The studio server (packages/cli/skills/kinetograph/references/AUTHORING.md §11.5): HTTP routes, the WebSocket, and the pieces they sit on. The project and
// the renderer live in worker threads (`project.ts`, `render-queue.ts`); this thread only routes.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, resolve } from 'node:path';
import { cliVersion, CliError } from 'kinetograph';
import { WebSocketServer, type WebSocket } from 'ws';
import { REAL_ENGINE_FILE } from './worker-client.js';
import { AgentBridge } from './agent-bridge.js';
import { isInside } from './agent-fs.js';
import { availableAgents } from './agent-presets.js';
import { openBrowser } from './open-browser.js';
import { Project } from './project.js';
import {
  encodeFrameMessage,
  type AgentClientMessage,
  type AgentInfo,
  type ClientMessage,
  type CompositionInfo,
  type FrameHeader,
  type FrameRequest,
  type ProjectInfo,
  type RenderJob,
  type RenderRequest,
  type ServerMessage,
} from './protocol.js';
import { RenderQueue } from './render-queue.js';
import { serveStatic } from './static.js';
import { StudioFailure, httpError } from './util.js';
import type { PreviewReply } from './engine.js';
import type { StudioOptions, StudioServer } from './index.js';

/** The least time between two progress messages for a job (at most 10 a second). */
const PROGRESS_INTERVAL_MS = 100;
const MAX_BODY_BYTES = 1 << 20;

interface FrameParams {
  comp: string;
  frame: number;
  scale: number;
  format: 'jpeg' | 'png';
  props: Record<string, unknown>;
}

function invalid(message: string): StudioFailure {
  return new StudioFailure('INVALID_ARG', message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Frame parameters from values of any origin (query strings are parsed by the caller). */
function frameParams(input: { comp?: unknown; frame?: unknown; scale?: unknown; format?: unknown; props?: unknown }): FrameParams {
  const { comp, frame, scale = 1, format = 'jpeg', props = {} } = input;
  if (typeof comp !== 'string' || comp === '') throw invalid('comp is required');
  if (typeof frame !== 'number' || !Number.isInteger(frame) || frame < 0) {
    throw invalid(`frame must be a whole number from 0, got ${JSON.stringify(frame)}`);
  }
  if (typeof scale !== 'number' || !(scale > 0 && scale <= 1)) {
    throw invalid(`scale must be a number above 0 and at most 1, got ${JSON.stringify(scale)}`);
  }
  if (format !== 'jpeg' && format !== 'png') throw invalid(`format must be "jpeg" or "png", got ${JSON.stringify(format)}`);
  if (!isObject(props)) throw invalid('props must be a JSON object');
  return { comp, frame, scale, format, props };
}

function number(text: string | null): number | undefined {
  if (text === null) return undefined;
  return text.trim() === '' ? NaN : Number(text);
}

function queryProps(text: string | null): Record<string, unknown> | undefined {
  if (text === null || text === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw invalid(`props is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(value)) throw invalid('props must be a JSON object');
  return value;
}

function displayHost(host: string): string {
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return shown.includes(':') ? `[${shown}]` : shown;
}

export async function startStudio(options: StudioOptions): Promise<StudioServer> {
  const entry = resolve(options.entry);
  if (!existsSync(entry)) throw new CliError('ENTRY_NOT_FOUND', `no such file: ${options.entry}`);
  const host = options.host ?? '127.0.0.1';
  const baseProps = options.props ?? {};
  const log = options.log ?? (() => undefined);
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  const project = new Project({ entry, engine: options.engine ?? REAL_ENGINE_FILE, log });
  const queue = new RenderQueue({ spawn: (cancel) => project.spawn('render', project.bundleFile, cancel) });
  const sockets = new Set<WebSocket>();
  const frameState = new WeakMap<WebSocket, { busy: boolean; queued?: FrameRequest }>();

  // ---- what the routes share ----

  const send = (ws: WebSocket, message: ServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };
  const broadcast = (message: ServerMessage): void => {
    for (const ws of sockets) send(ws, message);
  };

  // The coding agent works in the directory the studio was started in, or the entry's own when that is somewhere else.
  const agentCwd = options.agentCwd ?? (isInside(process.cwd(), entry) ? process.cwd() : dirname(entry));
  const agents = availableAgents(options.agent);
  // Whoever reaches the agent can have it edit files and run tools, so: a secret in the URL the studio opens, the same
  // origin, one window that owns the conversation, and no agent at all on an address other computers can reach.
  const token = randomBytes(32).toString('hex');
  const agentOff =
    !loopback && options.allowRemoteAgent !== true
      ? 'The coding agent is off because the studio can be reached from other computers. Start it with --allow-remote-agent if you really want it on.'
      : null;
  let owner: WebSocket | null = null;
  const bridge = new AgentBridge({
    cwd: agentCwd,
    allowed: agents.map((a) => a.command),
    command: options.agent ?? agents[0]?.command ?? null,
    // The state of the agent goes to every window; what it says and asks goes to the window that owns the conversation.
    emit: (event) => {
      if (event.kind === 'status') broadcast({ type: 'agent', event });
      else if (owner) send(owner, { type: 'agent', event });
    },
    hasViewer: () => owner !== null && owner.readyState === owner.OPEN,
    version: cliVersion(),
  });
  const tokenOk = (given: string | null | undefined): boolean => {
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /** The composition `comp`, or `BUILD` before any good build and `NOT_FOUND` for an unknown id. */
  function known(comp: string): CompositionInfo {
    if (project.buildId === 0) {
      throw new StudioFailure('BUILD', project.buildError ? `no good build yet: ${project.buildError.message}` : 'no good build yet');
    }
    const found = project.compositions.find((c) => c.id === comp);
    if (!found) {
      throw new StudioFailure('NOT_FOUND', `no composition "${comp}"; the project has: ${project.compositions.map((c) => c.id).join(', ') || '(none)'}`);
    }
    return found;
  }

  async function renderFrame(params: FrameParams): Promise<{ header: Omit<FrameHeader, 'requestId'>; image: Uint8Array }> {
    known(params.comp);
    const { result, buildId } = await project.call<PreviewReply>({
      op: 'preview',
      comp: params.comp,
      props: { ...baseProps, ...params.props },
      frame: params.frame,
      scale: params.scale,
      format: params.format,
    });
    return {
      header: {
        type: 'frame',
        comp: params.comp,
        frame: params.frame,
        buildId,
        width: result.width,
        height: result.height,
        mime: result.mime,
        ms: result.ms,
      },
      image: result.data,
    };
  }

  // ---- HTTP ----

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    });
    res.end(text);
  };
  const fail = (res: ServerResponse, error: unknown): void => {
    const { status, error: body } = httpError(error);
    json(res, status, { error: body });
  };

  async function readBody(req: IncomingMessage): Promise<unknown> {
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      throw invalid('the body must be JSON with Content-Type: application/json');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw invalid('the body is too large');
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      throw invalid(`the body is not valid JSON: ${(error as Error).message}`);
    }
  }

  async function createRender(body: unknown): Promise<RenderJob> {
    if (!isObject(body)) throw invalid('the body must be a RenderRequest object');
    const request = body as unknown as RenderRequest;
    if (typeof request.comp !== 'string' || request.comp === '') throw invalid('comp is required');
    if (request.output !== undefined && (typeof request.output !== 'string' || request.output === '')) throw invalid('output must be a path');
    if (request.range !== undefined && typeof request.range !== 'string') throw invalid('range must be a string such as "10..40"');
    if (request.encoder !== undefined && typeof request.encoder !== 'string') throw invalid('encoder must be a string');
    if (request.draft !== undefined && typeof request.draft !== 'boolean') throw invalid('draft must be true or false');
    if (request.props !== undefined && !isObject(request.props)) throw invalid('props must be a JSON object');
    known(request.comp);

    const output = resolve(dirname(entry), request.output ?? join('out', `${request.comp}.mp4`));
    const extension = extname(output).toLowerCase();
    if (extension !== '.mp4' && extension !== '.mov') throw invalid(`output must be a .mp4 or .mov file, got "${output}"`);

    const props = { ...baseProps, ...request.props };
    const { result: plan } = await project.call<{ range: [number, number] }>({ op: 'plan', comp: request.comp, props, range: request.range });
    return queue.add(
      { comp: request.comp, props, output, range: plan.range, encoder: request.encoder, draft: request.draft },
      { props },
    );
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    const q = url.searchParams;

    if (method === 'GET' && path === '/api/project') {
      const info: ProjectInfo = { entry, cwd: process.cwd(), version: cliVersion(), buildId: project.buildId, buildError: project.buildError };
      return json(res, 200, info);
    }
    if (method === 'GET' && path === '/api/agent') {
      if (!tokenOk(req.headers['x-studio-token'] as string | undefined)) {
        throw new StudioFailure('FORBIDDEN', 'the agent needs the studio token from the address the studio opened');
      }
      const info: AgentInfo = agentOff
        ? { presets: [], command: null, cwd: agentCwd, disabled: agentOff }
        : { presets: agents, command: bridge.currentCommand, cwd: agentCwd };
      return json(res, 200, info);
    }
    if (method === 'GET' && path === '/api/compositions') {
      if (project.buildId === 0) known('');
      return json(res, 200, project.compositions);
    }
    if (method === 'GET' && path === '/api/frame') {
      const params = frameParams({
        comp: q.get('comp') ?? undefined,
        frame: number(q.get('frame')),
        scale: number(q.get('scale')),
        format: q.get('format') ?? undefined,
        props: queryProps(q.get('props')),
      });
      const { header, image } = await renderFrame(params);
      res.writeHead(200, {
        'Content-Type': header.mime,
        'Content-Length': image.length,
        'Cache-Control': 'no-store',
        'X-Build': String(header.buildId),
        'X-Frame': String(header.frame),
      });
      return void res.end(Buffer.from(image.buffer, image.byteOffset, image.byteLength));
    }
    if (method === 'GET' && path === '/api/inspect') {
      const comp = q.get('comp') ?? '';
      const frame = number(q.get('frame')) ?? 0;
      if (comp === '') throw invalid('comp is required');
      if (!Number.isInteger(frame) || frame < 0) throw invalid(`frame must be a whole number from 0, got "${q.get('frame')}"`);
      known(comp);
      const { result } = await project.call({ op: 'inspect', comp, props: { ...baseProps, ...queryProps(q.get('props')) }, frame });
      return json(res, 200, result);
    }
    if (method === 'GET' && path === '/api/timeline') {
      const comp = q.get('comp') ?? '';
      if (comp === '') throw invalid('comp is required');
      known(comp);
      return json(res, 200, await project.timeline(comp, { ...baseProps, ...queryProps(q.get('props')) }));
    }
    if (method === 'GET' && path === '/api/timeline/progress') {
      const comp = q.get('comp') ?? '';
      if (comp === '') throw invalid('comp is required');
      known(comp);
      return json(res, 200, project.timelineProgressOf(comp, { ...baseProps, ...queryProps(q.get('props')) }));
    }
    if (method === 'GET' && path === '/api/renders') return json(res, 200, queue.list());
    if (method === 'POST' && path === '/api/renders') return json(res, 201, await createRender(await readBody(req)));
    const cancel = /^\/api\/renders\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && cancel) {
      const job = queue.cancel(decodeURIComponent(cancel[1]!));
      if (!job) throw new StudioFailure('NOT_FOUND', `no render job "${cancel[1]}"`);
      return json(res, 200, job);
    }
    throw new StudioFailure('NOT_FOUND', `no route ${method} ${path}`);
  }

  /** Requests from other sites (a page that points at localhost) and DNS-rebinding are refused. */
  function allowed(req: IncomingMessage): boolean {
    const hostHeader = req.headers.host ?? '';
    if (loopback) {
      const name = hostHeader.replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(name)) return false;
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      try {
        if (new URL(origin).host !== hostHeader) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://studio.invalid');
      try {
        if (url.pathname.startsWith('/api/')) {
          if (!allowed(req)) {
            return json(res, 403, { error: { code: 'FORBIDDEN', message: 'this request does not come from the studio page' } });
          }
          return await route(req, res, url);
        }
        if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(url.pathname, res, req.method === 'HEAD');
        throw new StudioFailure('NOT_FOUND', `no route ${req.method} ${url.pathname}`);
      } catch (error) {
        if (!res.headersSent) fail(res, error);
        else res.destroy();
      }
    })();
  });

  // ---- WebSocket ----

  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://studio.invalid');
    if (url.pathname !== '/ws' || !allowed(req) || !tokenOk(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  /** Renders `request` and answers on `ws`; then starts the request that arrived meanwhile, if any. */
  async function serveFrame(ws: WebSocket, request: FrameRequest): Promise<void> {
    const state = frameState.get(ws)!;
    state.busy = true;
    try {
      const params = frameParams(request);
      const { header, image } = await renderFrame(params);
      if (ws.readyState === ws.OPEN) ws.send(encodeFrameMessage({ ...header, requestId: request.requestId }, image), { binary: true });
    } catch (error) {
      send(ws, { type: 'error', requestId: request.requestId, error: httpError(error).error });
    } finally {
      state.busy = false;
      const next = state.queued;
      state.queued = undefined;
      if (next && ws.readyState === ws.OPEN) void serveFrame(ws, next);
    }
  }

  /** A message for the coding agent; a malformed one is answered with an error the panel shows. */
  function agentMessage(ws: WebSocket, message: AgentClientMessage): void {
    const bad = (text: string): void => send(ws, { type: 'agent', event: { kind: 'error', message: text } });
    if (agentOff) return bad(agentOff);
    const mine = owner === ws;
    if (owner && owner.readyState === owner.OPEN && !mine) {
      return bad('Another studio window is using the agent. Close it first, or use that window.');
    }
    // The first prompt or choice claims the conversation; answers and cancels need an owner, and it must be this window.
    if (message.type === 'agent.prompt' || message.type === 'agent.select') owner = ws;
    else if (!mine) return;
    switch (message.type) {
      case 'agent.prompt':
        if (typeof message.text !== 'string' || message.text.trim() === '') return bad('Write a message for the agent first.');
        if (message.image !== undefined && (typeof message.image.data !== 'string' || typeof message.image.mimeType !== 'string')) {
          return bad('The picture is not valid.');
        }
        void bridge.prompt(message.text, typeof message.context === 'string' ? message.context : '', message.image);
        return;
      case 'agent.cancel':
        void bridge.cancel();
        return;
      case 'agent.permission':
        bridge.answerPermission(String(message.id), typeof message.optionId === 'string' ? message.optionId : null);
        return;
      case 'agent.select':
        void bridge.select(typeof message.command === 'string' ? message.command : null);
        return;
      case 'agent.reset':
        void bridge.reset();
        return;
      default:
        return bad('unknown agent message');
    }
  }

  wss.on('connection', (ws) => {
    sockets.add(ws);
    frameState.set(ws, { busy: false });
    ws.on('close', () => {
      sockets.delete(ws);
      // The conversation belongs to the window that began it: when that goes, the agent stops.
      if (owner === ws) {
        owner = null;
        void bridge.reset();
      }
    });
    ws.on('error', () => ws.terminate());
    ws.on('message', (data, isBinary) => {
      let message: ClientMessage | undefined;
      try {
        if (isBinary) throw invalid('messages are JSON text');
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          throw invalid('the message is not valid JSON');
        }
        if (isObject(parsed) && typeof parsed.type === 'string' && parsed.type.startsWith('agent.')) {
          return agentMessage(ws, parsed as unknown as AgentClientMessage);
        }
        if (!isObject(parsed) || parsed.type !== 'frame') throw invalid('unknown message: only { "type": "frame", … } and "agent.…" messages are understood');
        if (typeof parsed.requestId !== 'number') throw invalid('requestId must be a number');
        message = parsed as unknown as FrameRequest;
      } catch (error) {
        return send(ws, { type: 'error', requestId: null, error: httpError(error).error });
      }
      const state = frameState.get(ws)!;
      // Latest wins: a request that has not started is dropped, without a reply, when a newer one arrives.
      if (state.busy) state.queued = message;
      else void serveFrame(ws, message);
    });
    send(ws, { type: 'hello', version: cliVersion(), buildId: project.buildId, buildError: project.buildError });
    bridge.announce();
  });

  project.on('reload', (buildId) => broadcast({ type: 'reload', buildId }));
  project.on('buildError', (error) => broadcast({ type: 'buildError', error }));

  // Progress goes out at most every PROGRESS_INTERVAL_MS per job, always the newest state of the job.
  const throttle = new Map<string, { last: number; timer: NodeJS.Timeout | null; latest: RenderJob }>();
  queue.on('update', (job) => {
    let state = throttle.get(job.id);
    if (!state) throttle.set(job.id, (state = { last: 0, timer: null, latest: job }));
    state.latest = job;
    if (state.timer) return;
    const wait = state.last + PROGRESS_INTERVAL_MS - Date.now();
    const flush = (): void => {
      state.timer = null;
      state.last = Date.now();
      broadcast({ type: 'render', job: state.latest });
    };
    if (wait <= 0) flush();
    else {
      state.timer = setTimeout(flush, wait);
      state.timer.unref();
    }
  });

  // ---- start ----

  await new Promise<void>((resolveListening, reject) => {
    http.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new CliError('INVALID_ARG', `port ${options.port ?? 3000} is already in use on ${host}; pick another with --port`)
          : new CliError('INVALID_ARG', `cannot listen on ${host}:${options.port ?? 3000}: ${error.message}`),
      );
    });
    http.listen(options.port ?? 3000, host, resolveListening);
  });
  const url = `http://${displayHost(host)}:${(http.address() as AddressInfo).port}/?token=${token}`;

  try {
    await project.start();
  } catch (error) {
    http.close();
    await project.close();
    throw error;
  }
  if (project.buildError) log(`build failed: ${project.buildError.message}`);
  if (options.open !== false) openBrowser(url);

  let closing: Promise<void> | undefined;
  return {
    url,
    close() {
      closing ??= (async () => {
        for (const state of throttle.values()) if (state.timer) clearTimeout(state.timer);
        await queue.close();
        await bridge.close();
        for (const ws of sockets) ws.terminate();
        wss.close();
        await new Promise<void>((done) => {
          http.close(() => done());
          http.closeAllConnections();
        });
        await project.close();
      })();
      return closing;
    },
  };
}
