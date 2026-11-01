// The studio as an ACP client (https://agentclientprotocol.com): it starts the user's coding agent as a subprocess in the
// project directory, talks to it over stdio with the official SDK, and turns what the agent does into `AgentEvent`s
// for the UI. Nothing is approved on the user's behalf: a permission request waits for the UI's answer.

import { spawn, type ChildProcess } from 'node:child_process';
import { relative } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { ContentBlock, RequestPermissionRequest, RequestPermissionResponse, SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk';
import { readTextFile, writeTextFile } from './agent-fs.js';
import type { AgentEvent, AgentStatus } from './protocol.js';

export interface AgentBridgeOptions {
  /** The project directory: the agent's working directory and the only place it may read or write. */
  cwd: string;
  /** The commands `select` accepts (the presets and `--agent`); anything else is refused. */
  allowed: string[];
  /** The command to use at first, or null. */
  command: string | null;
  /** Receives every event for the UI. */
  emit(event: AgentEvent): void;
  /** Whether a UI is connected to answer permission requests. */
  hasViewer(): boolean;
  version: string;
  /** The MCP servers every new session gets (ACP `session/new`); asked for when the session starts. Default none. */
  mcpServers?(): McpServerConfig[];
  /** Called when a prompt has run its course and the agent is ready for the next (not when it failed to start). */
  idle?(): void;
}

/** A stdio MCP server as ACP names it. */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

/** A failure whose message is already in plain words. */
class Plain extends Error {}

interface Live {
  child: ChildProcess;
  conn: { agent: { request: (method: string, params: unknown) => Promise<unknown>; notify: (method: string, params: unknown) => Promise<void> }; close(): void };
  sessionId: string;
  image: boolean;
  stderr: { text: string };
  exited: boolean;
}

const STDERR_KEEP = 2000;
const SETTLE_MS = 60;
const AUTH = /auth|log ?in|sign ?in|credential|api key|unauthori[sz]ed/i;
const SIGN_IN = 'The agent needs you to sign in first. Open a terminal, run the agent once to log in (for Claude Code: claude), then try again.';

function files(cwd: string, call: ToolCallUpdate): string[] {
  const out = new Set<string>();
  const add = (path: string | undefined) => {
    if (path) out.add(path.startsWith(cwd) ? relative(cwd, path) || '.' : path);
  };
  for (const location of (call as { locations?: { path: string }[] | null }).locations ?? []) add(location.path);
  for (const item of call.content ?? []) if (item.type === 'diff') add(item.path);
  return [...out];
}

/** What a failure means to someone who does not read stack traces. */
export function explain(error: unknown, stderr: string, command: string | null): string {
  if (error instanceof Plain) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown }).code;
  if (code === -32000 || AUTH.test(message + stderr.slice(-400))) return SIGN_IN;
  const tail = stderr.trim().split('\n').pop()?.slice(0, 200);
  return `The agent reported a problem: ${message.split('\n')[0]!.slice(0, 200)}${tail && !message.includes(tail) ? ` (${tail})` : ''}`;
}

export class AgentBridge {
  private command: string | null;
  private live: Promise<Live> | null = null;
  private liveNow: Live | null = null;
  private status: AgentStatus = 'idle';
  private image = false;
  private readonly permissions = new Map<string, (response: RequestPermissionResponse) => void>();
  private nextPermission = 1;
  private closed = false;
  /** A prompt is being sent or has not run its course: the window between asking and the status turning busy. */
  private prompting = false;

  constructor(private readonly options: AgentBridgeOptions) {
    this.command = options.command;
  }

  get currentCommand(): string | null {
    return this.command;
  }

  /** Whether the agent is running and between turns: a prompt sent now starts at once. */
  get ready(): boolean {
    return this.status === 'ready' && !this.prompting;
  }

  /** Tells the UI where things stand (also used for a socket that has just connected). */
  announce(): void {
    this.options.emit({ kind: 'status', status: this.status, command: this.command, image: this.image });
  }

  private setStatus(status: AgentStatus): void {
    this.status = status;
    this.announce();
  }

  /** Chooses the agent and drops the conversation. Only the offered commands are accepted. */
  async select(command: string | null): Promise<void> {
    if (command !== null && !this.options.allowed.includes(command)) {
      this.options.emit({ kind: 'error', message: 'That agent is not one of the choices.' });
      return;
    }
    await this.reset();
    this.command = command;
    this.announce();
  }

  /** Stops the agent; the next prompt starts a fresh conversation. */
  async reset(): Promise<void> {
    this.cancelPermissions();
    const live = this.liveNow;
    this.live = null;
    this.liveNow = null;
    this.image = false;
    if (live) this.kill(live);
    this.setStatus('idle');
  }

  private kill(live: Live): void {
    live.exited = true;
    try {
      live.conn.close();
    } catch {
      // already closed
    }
    // The command runs in a shell (so `npx -y …` works), and the shell's children go with it.
    try {
      if (live.child.pid !== undefined) process.kill(-live.child.pid, 'SIGTERM');
    } catch {
      live.child.kill('SIGTERM');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.reset();
  }

  private cancelPermissions(): void {
    for (const [id, resolve] of this.permissions) {
      resolve({ outcome: { outcome: 'cancelled' } });
      this.options.emit({ kind: 'permission_done', id });
    }
    this.permissions.clear();
  }

  answerPermission(id: string, optionId: string | null): void {
    const resolve = this.permissions.get(id);
    if (!resolve) return;
    this.permissions.delete(id);
    resolve(optionId === null ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId } });
    this.options.emit({ kind: 'permission_done', id });
  }

  private askPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!this.options.hasViewer()) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const id = String(this.nextPermission++);
    return new Promise((resolve) => {
      this.permissions.set(id, resolve);
      this.options.emit({
        kind: 'permission',
        id,
        title: params.toolCall.title ?? 'The agent wants to do something',
        files: files(this.options.cwd, params.toolCall),
        options: params.options.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })),
      });
    });
  }

  private onUpdate(update: SessionUpdate): void {
    const text = (content: ContentBlock): string => (content.type === 'text' ? content.text : '');
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const chunk = text(update.content);
        if (chunk) this.options.emit({ kind: 'message', text: chunk });
        break;
      }
      case 'agent_thought_chunk': {
        const chunk = text(update.content);
        if (chunk) this.options.emit({ kind: 'thought', text: chunk });
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const call = update as ToolCallUpdate & { title?: string | null };
        this.options.emit({
          kind: 'tool',
          id: call.toolCallId,
          title: call.title ?? '',
          toolKind: call.kind ?? 'other',
          status: call.status ?? (update.sessionUpdate === 'tool_call' ? 'pending' : 'in_progress'),
          files: files(this.options.cwd, call),
        });
        break;
      }
      default:
        break;
    }
  }

  private async start(): Promise<Live> {
    const command = this.command;
    if (!command) throw new Plain('No coding agent is chosen. Pick one in the list above, or start the studio with --agent "<command>".');
    this.setStatus('starting');
    const child = spawn(command, { cwd: this.options.cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: process.env });
    const stderr = { text: '' };
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr.text = (stderr.text + chunk.toString('utf8')).slice(-STDERR_KEEP);
    });
    // A rejected promise nobody awaits would be an unhandled rejection, so the exit promise gets a handler up front.
    const exited = new Promise<never>((_, reject) => {
      child.once('error', (error) => reject(new Plain(`The agent could not be started: ${error.message}`)));
      child.once('exit', (code, signal) => {
        const live = this.liveNow;
        // After the session started it is a crash to report; before, `start` reports it.
        if (live && live.child === child && !live.exited && live.sessionId !== '') this.crashed(live, code, signal, stderr.text);
        reject(
          AUTH.test(stderr.text.slice(-400))
            ? new Plain(SIGN_IN)
            : code === 127
            ? new Plain(`The agent is not installed (could not run "${command}"). Install it, or pick another agent.`)
            : new Plain(`The agent stopped${code !== null ? ` (exit code ${code})` : ''}. ${stderr.text.trim().split('\n').pop()?.slice(0, 200) ?? ''}`.trim()),
        );
      });
    });
    exited.catch(() => undefined);

    const stream = ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    const conn = client({ name: 'kinetograph-studio' })
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.askPermission(params))
      .onRequest(methods.client.fs.readTextFile, async ({ params }) => ({
        content: await readTextFile(this.options.cwd, params.path, params.line, params.limit),
      }))
      .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
        await writeTextFile(this.options.cwd, params.path, params.content);
        return {};
      })
      .onNotification(methods.client.session.update, ({ params }) => this.onUpdate(params.update))
      .connect(stream);
    const agent = conn.agent as unknown as Live['conn']['agent'];
    const live: Live = { child, conn, sessionId: '', image: false, stderr, exited: false };
    this.liveNow = live;
    try {
      const init = (await Promise.race([
        agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          clientInfo: { name: 'kinetograph-studio', version: this.options.version },
        }),
        exited,
      ])) as { agentCapabilities?: { promptCapabilities?: { image?: boolean } } };
      live.image = init.agentCapabilities?.promptCapabilities?.image === true;
      const session = (await Promise.race([agent.request(methods.agent.session.new, { cwd: this.options.cwd, mcpServers: this.options.mcpServers?.() ?? [] }), exited])) as {
        sessionId: string;
      };
      live.sessionId = session.sessionId;
    } catch (error) {
      // A closed pipe is only the symptom when the program is missing or stopped: its exit says why.
      const why = await Promise.race([exited.then(() => null, (e: unknown) => e), new Promise<null>((r) => setTimeout(() => r(null), 400))]);
      this.kill(live);
      if (this.liveNow === live) this.liveNow = null;
      throw why instanceof Plain ? why : new Plain(explain(error, stderr.text, command));
    }
    this.image = live.image;
    this.setStatus('ready');
    return live;
  }

  private crashed(live: Live, code: number | null, signal: NodeJS.Signals | null, stderr: string): void {
    live.exited = true;
    if (this.closed) return;
    this.liveNow = null;
    this.live = null;
    this.cancelPermissions();
    const detail = stderr.trim().split('\n').pop()?.slice(0, 200);
    this.options.emit({
      kind: 'error',
      message: `The agent stopped unexpectedly${signal ? ` (${signal})` : code ? ` (exit code ${code})` : ''}.${detail ? ` ${detail}` : ''} Your next message starts a new conversation.`,
    });
    this.setStatus('idle');
  }

  /** Sends the user's words and the context about the selection (and a picture of it, if the agent takes images). */
  async prompt(text: string, context: string, image?: { data: string; mimeType: string }): Promise<void> {
    if (this.status === 'busy') {
      this.options.emit({ kind: 'error', message: 'The agent is still working on the last message. Stop it first, or wait.' });
      return;
    }
    let live: Live;
    this.prompting = true;
    try {
      this.live ??= this.start();
      live = await this.live;
    } catch (error) {
      this.prompting = false;
      this.live = null;
      this.options.emit({ kind: 'error', message: explain(error, '', this.command) });
      this.setStatus('idle');
      return;
    }
    const blocks: ContentBlock[] = [{ type: 'text', text: context ? `${text}\n\n---\nWhat is selected in the studio:\n${context}` : text }];
    if (image && live.image) blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    this.setStatus('busy');
    try {
      const response = (await live.conn.agent.request(methods.agent.session.prompt, { sessionId: live.sessionId, prompt: blocks })) as {
        stopReason: string;
      };
      // The SDK hands notifications to their handlers a little after it reads them, so the last updates of the turn can
      // arrive after this response; let them through first.
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      // A conversation that was stopped meanwhile (reset) says nothing more.
      if (!live.exited) this.options.emit({ kind: 'done', stopReason: response.stopReason });
    } catch (error) {
      // A dead agent closes the pipe before its exit is seen; once it is, `crashed` has told the user.
      if (!live.exited) await new Promise((resolve) => setTimeout(resolve, 250));
      if (!live.exited) this.options.emit({ kind: 'error', message: explain(error, live.stderr.text, this.command) });
    }
    this.prompting = false;
    if (this.liveNow === live) {
      this.setStatus('ready');
      this.options.idle?.();
    }
  }

  /** Asks the agent to stop what it is doing. */
  async cancel(): Promise<void> {
    const live = this.liveNow;
    this.cancelPermissions();
    if (live && this.status === 'busy') await live.conn.agent.notify(methods.agent.session.cancel, { sessionId: live.sessionId }).catch(() => undefined);
  }
}
