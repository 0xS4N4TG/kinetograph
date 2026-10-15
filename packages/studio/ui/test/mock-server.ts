// A stand-in for the studio server behind `StudioApi`: answers the HTTP routes from fields tests set, records every
// call, and speaks the WebSocket protocol (frames go through the real binary codec). Frame replies are automatic, or
// held for the test to release in any order with `respond`.

import {
  ApiError,
  type CompositionInfo,
  type FrameArgs,
  type InspectResult,
  type ProjectInfo,
  type RenderJob,
  type RenderRequest,
  type ServerMessage,
  type SocketHandlers,
  type StudioApi,
  type StudioError,
  type StudioSocket,
  type TimelineData,
} from '../src/api';
import { decodeFrameMessage, encodeFrameMessage } from '../../src/protocol';
import type { FrameRequest } from '../../src/protocol';
import { inspectFor, intro, introTimeline, outro } from './fixtures';

export class MockServer implements StudioApi {
  projectInfo: ProjectInfo = { entry: '/work/scene.tsx', version: '0.1.0', buildId: 1, buildError: null };
  comps: CompositionInfo[] = [intro, outro];
  jobs: RenderJob[] = [];
  /** When set, `compositions()` fails as the server does before the first good build. */
  noGoodBuild = false;
  startRenderError: ApiError | null = null;
  /** Reply to frame requests at once; when false, the test calls `respond`. */
  auto = true;

  frameRequests: FrameRequest[] = [];
  inspectCalls: { comp: string; frame: number; props?: Record<string, unknown> }[] = [];
  timelineCalls: { comp: string; props?: Record<string, unknown> }[] = [];
  startRenderCalls: RenderRequest[] = [];
  cancelCalls: string[] = [];
  connections = 0;
  private handlers: SocketHandlers | null = null;
  private nextRequestId = 1;

  timelineFor(comp: string): TimelineData {
    const c = this.comps.find((x) => x.id === comp)!;
    return comp === 'Intro'
      ? { ...introTimeline, durationInFrames: c.durationInFrames }
      : { comp, fps: c.fps, durationInFrames: c.durationInFrames, sequences: [], layers: [] };
  }

  inspectFor(comp: CompositionInfo, frame: number): InspectResult {
    return inspectFor(comp, frame);
  }

  get lastFrameRequest(): FrameRequest {
    return this.frameRequests[this.frameRequests.length - 1]!;
  }

  // ---- StudioApi ----

  async project(): Promise<ProjectInfo> {
    return this.projectInfo;
  }

  async compositions(): Promise<CompositionInfo[]> {
    if (this.noGoodBuild) throw new ApiError('BUILD', 'no good build yet', 409);
    return this.comps;
  }

  async inspect(comp: string, frame: number, props?: Record<string, unknown>): Promise<InspectResult> {
    this.inspectCalls.push({ comp, frame, props });
    const c = this.comps.find((x) => x.id === comp);
    if (!c) throw new ApiError('NOT_FOUND', `no composition ${comp}`, 404);
    return this.inspectFor(c, frame);
  }

  async timeline(comp: string, props?: Record<string, unknown>): Promise<TimelineData> {
    this.timelineCalls.push({ comp, props });
    return this.timelineFor(comp);
  }

  async renders(): Promise<RenderJob[]> {
    return this.jobs;
  }

  async startRender(request: RenderRequest): Promise<RenderJob> {
    this.startRenderCalls.push(request);
    if (this.startRenderError) throw this.startRenderError;
    const comp = this.comps.find((c) => c.id === request.comp)!;
    const [first, last] = request.range ? request.range.split('..').map(Number) : [0, comp.durationInFrames - 1];
    const job: RenderJob = {
      id: String(this.jobs.length + 1),
      comp: request.comp,
      output: `/work/${request.output ?? `out/${request.comp}.mp4`}`,
      range: [first!, last!],
      props: request.props ?? {},
      status: 'queued',
      framesDone: 0,
      framesTotal: last! - first! + 1,
      msPerFrame: null,
      summary: null,
      error: null,
      queuedAt: 1_000,
      finishedAt: null,
    };
    this.jobs = [...this.jobs, job];
    return job;
  }

  async cancelRender(id: string): Promise<RenderJob> {
    this.cancelCalls.push(id);
    const job = this.jobs.find((j) => j.id === id)!;
    const cancelled = { ...job, status: 'cancelled' as const };
    this.jobs = this.jobs.map((j) => (j.id === id ? cancelled : j));
    return cancelled;
  }

  connect(handlers: SocketHandlers): StudioSocket {
    this.handlers = handlers;
    this.connections++;
    queueMicrotask(() => {
      handlers.onConnection(true);
      handlers.onMessage({
        type: 'hello',
        version: this.projectInfo.version,
        buildId: this.projectInfo.buildId,
        buildError: this.projectInfo.buildError,
      });
    });
    return {
      requestFrame: (args: FrameArgs) => {
        const request: FrameRequest = { type: 'frame', requestId: this.nextRequestId++, ...args };
        this.frameRequests.push(request);
        if (this.auto) queueMicrotask(() => this.respond(request.requestId));
        return request.requestId;
      },
      close: () => {
        if (this.handlers === handlers) this.handlers = null;
      },
    };
  }

  // ---- the server's side ----

  /** Answers a frame request with an image of `requestId` bytes. */
  respond(requestId: number): void {
    const request = this.frameRequests.find((r) => r.requestId === requestId)!;
    const comp = this.comps.find((c) => c.id === request.comp)!;
    const png = request.format === 'png';
    const bytes = encodeFrameMessage(
      {
        type: 'frame',
        requestId,
        comp: request.comp,
        frame: request.frame,
        buildId: this.projectInfo.buildId,
        width: Math.round(comp.width * request.scale),
        height: Math.round(comp.height * request.scale),
        mime: png ? 'image/png' : 'image/jpeg',
        ms: 1,
      },
      new Uint8Array(requestId),
    );
    this.handlers?.onFrame(decodeFrameMessage(bytes));
  }

  send(message: ServerMessage): void {
    this.handlers?.onMessage(message);
  }

  /** A successful rebuild: `comps` changes, the build id moves on, and `reload` goes out. */
  reload(comps?: CompositionInfo[]): void {
    if (comps) this.comps = comps;
    this.projectInfo = { ...this.projectInfo, buildId: this.projectInfo.buildId + 1, buildError: null };
    this.send({ type: 'reload', buildId: this.projectInfo.buildId });
  }

  failBuild(error: StudioError): void {
    this.projectInfo = { ...this.projectInfo, buildError: error };
    this.send({ type: 'buildError', error });
  }

  pushJob(job: RenderJob): void {
    this.jobs = this.jobs.some((j) => j.id === job.id) ? this.jobs.map((j) => (j.id === job.id ? job : j)) : [...this.jobs, job];
    this.send({ type: 'render', job });
  }

  /** The newest frame request matching `predicate`, for waiting on. */
  requestsWhere(predicate: (r: FrameRequest) => boolean): FrameRequest[] {
    return this.frameRequests.filter(predicate);
  }
}
