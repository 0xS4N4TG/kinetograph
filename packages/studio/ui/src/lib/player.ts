// Playback and frame requests, without React. The wall clock is fine here: this is the UI deciding which frame to ask
// for, never part of a render.
//
// - While playing or scrubbing it asks for scale 0.5 JPEG; paused, for scale 1 PNG.
// - Playing is paced at the composition's fps from the clock; one request is outstanding at a time, so a server that
//   cannot keep up has frames skipped rather than queued.
// - A frame is shown only if its request is newer than the last one shown (request ids only grow), and never if it
//   was asked for before the composition, props or build changed.

import type { CompositionInfo, FrameArgs, ReceivedFrame, StudioError } from '@/api';

export interface PlayerState {
  comp: CompositionInfo | null;
  /** The playhead. */
  frame: number;
  playing: boolean;
  loop: boolean;
  scrubbing: boolean;
  /** Frames per second actually shown, measured over about a second of playback or scrubbing; null before any. */
  fps: number | null;
  /** The last frame request that failed, until a frame arrives. */
  error: StudioError | null;
}

export interface PlayerOptions {
  /** Sends a frame request and returns its id, or -1 when it could not be sent. */
  requestFrame: (args: FrameArgs) => number;
  /** Receives each frame to show, in the order they are to be shown. */
  onImage: (frame: ReceivedFrame) => void;
  now?: () => number;
  schedule?: (callback: () => void) => number;
  cancelSchedule?: (handle: number) => void;
}

export const PREVIEW_SCALE = 0.5;
const FPS_WINDOW_MS = 1000;
const FPS_UPDATE_MS = 250;

export class Player {
  private state: PlayerState = {
    comp: null,
    frame: 0,
    playing: false,
    loop: false,
    scrubbing: false,
    fps: null,
    error: null,
  };
  private props: Record<string, unknown> | undefined;
  private propsKey = 'null';
  private readonly listeners = new Set<() => void>();
  private readonly options: PlayerOptions;

  /** Highest request id sent, shown, and answered (a reply for id n also settles every older one). */
  private lastSent = 0;
  private lastShown = 0;
  private answered = 0;
  /** Replies to requests below this were asked for before the last invalidation. */
  private minId = 0;
  private lastRequestedFrame = -1;

  private anchorTime = 0;
  private anchorFrame = 0;
  private raf: number | null = null;
  private shownTimes: number[] = [];
  private lastFpsUpdate = 0;

  constructor(options: PlayerOptions) {
    this.options = options;
  }

  // ---- store ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): PlayerState => this.state;

  private set(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private now(): number {
    return (this.options.now ?? (() => performance.now()))();
  }

  // ---- inputs ----

  /** Selects the composition (or none) and the props that override its defaults; a change of either re-requests. */
  setComposition(comp: CompositionInfo | null, props?: Record<string, unknown>): void {
    const previous = this.state.comp;
    const propsKey = JSON.stringify(props ?? null);
    const propsChanged = propsKey !== this.propsKey;
    this.props = props;
    this.propsKey = propsKey;
    if (comp === null) {
      this.stop();
      this.set({ comp: null, frame: 0, playing: false, scrubbing: false, error: null });
      return;
    }
    const same =
      previous !== null &&
      previous.id === comp.id &&
      previous.width === comp.width &&
      previous.height === comp.height &&
      previous.fps === comp.fps &&
      previous.durationInFrames === comp.durationInFrames;
    if (same) {
      this.state = { ...this.state, comp };
      if (propsChanged) this.reload();
      return;
    }
    const frame = previous?.id === comp.id ? this.clamp(this.state.frame, comp) : 0;
    this.invalidate();
    if (previous?.id !== comp.id) this.stop();
    this.set({ comp, frame, playing: previous?.id === comp.id && this.state.playing, error: null });
    if (this.state.playing) this.anchor();
    this.request();
  }

  /** The build changed: ask again for the current frame. */
  reload(): void {
    if (this.state.comp === null) return;
    this.invalidate();
    this.request();
  }

  play(): void {
    const { comp, playing } = this.state;
    if (comp === null || playing) return;
    const last = comp.durationInFrames - 1;
    const frame = this.state.frame >= last && !this.state.loop ? 0 : this.state.frame;
    this.shownTimes = [];
    this.set({ playing: true, frame, fps: null });
    this.anchor();
    this.lastRequestedFrame = -1;
    this.advance();
    this.startLoop();
  }

  pause(): void {
    if (!this.state.playing) return;
    this.stop();
    this.set({ playing: false });
    this.request();
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }

  setLoop(loop: boolean): void {
    this.set({ loop });
  }

  /** Moves the playhead; asks for the frame at preview quality while scrubbing or playing, else at full quality. */
  seek(frame: number): void {
    const { comp } = this.state;
    if (comp === null) return;
    const next = this.clamp(Math.round(frame), comp);
    if (next === this.state.frame && this.lastRequestedFrame === next) return;
    this.set({ frame: next });
    if (this.state.playing) this.anchor();
    this.request();
  }

  /** Moves the playhead by `delta` frames. */
  step(delta: number): void {
    this.seek(this.state.frame + delta);
  }

  beginScrub(): void {
    if (!this.state.scrubbing) this.set({ scrubbing: true });
  }

  endScrub(): void {
    if (!this.state.scrubbing) return;
    this.set({ scrubbing: false });
    if (!this.state.playing) this.request();
  }

  // ---- replies ----

  handleFrame(received: ReceivedFrame): void {
    const id = received.header.requestId;
    this.answered = Math.max(this.answered, id);
    if (id < this.minId || id <= this.lastShown) return;
    this.lastShown = id;
    this.options.onImage(received);
    if (this.state.error !== null) this.set({ error: null });
    if (this.state.playing || this.state.scrubbing) this.measure();
    if (this.state.playing) this.advance();
  }

  /** An `error` message for a frame request (`requestId` null for errors not tied to one). */
  handleError(requestId: number | null, error: StudioError): void {
    if (requestId !== null) {
      this.answered = Math.max(this.answered, requestId);
      if (requestId < this.minId) return;
    }
    this.set({ error });
    if (this.state.playing) this.advance();
  }

  /** The socket opened again: anything in flight was lost. */
  handleConnection(open: boolean): void {
    if (open) this.reload();
  }

  // ---- internals ----

  private clamp(frame: number, comp: CompositionInfo): number {
    return Math.max(0, Math.min(comp.durationInFrames - 1, frame));
  }

  /** Forgets every reply to a request sent so far. */
  private invalidate(): void {
    this.minId = this.lastSent + 1;
    this.lastRequestedFrame = -1;
  }

  private request(): void {
    const { comp, frame, playing, scrubbing } = this.state;
    if (comp === null) return;
    const preview = playing || scrubbing;
    const args: FrameArgs = {
      comp: comp.id,
      frame,
      scale: preview ? PREVIEW_SCALE : 1,
      format: preview ? 'jpeg' : 'png',
    };
    if (this.props !== undefined) args.props = this.props;
    const id = this.options.requestFrame(args);
    this.lastRequestedFrame = frame;
    if (id >= 0) {
      this.lastSent = Math.max(this.lastSent, id);
    }
  }

  private get pending(): boolean {
    return this.lastSent > this.answered;
  }

  private anchor(): void {
    this.anchorTime = this.now();
    this.anchorFrame = this.state.frame;
  }

  /** Moves the playhead to where the clock says it is and asks for that frame if nothing is outstanding. */
  private advance(): void {
    const { comp, loop } = this.state;
    if (comp === null || !this.state.playing) return;
    const frames = ((this.now() - this.anchorTime) * comp.fps) / 1000;
    let target = this.anchorFrame + Math.floor(frames);
    const duration = comp.durationInFrames;
    if (target >= duration) {
      if (loop) {
        target %= duration;
        this.anchorFrame = target;
        this.anchorTime = this.now() - ((frames - Math.floor(frames)) * 1000) / comp.fps;
      } else {
        this.stop();
        this.set({ playing: false, frame: duration - 1 });
        this.request();
        return;
      }
    }
    if (target !== this.state.frame) this.set({ frame: target });
    if (!this.pending && target !== this.lastRequestedFrame) this.request();
  }

  private startLoop(): void {
    if (this.raf !== null) return;
    const schedule = this.options.schedule ?? ((cb: () => void) => requestAnimationFrame(cb));
    const tick = () => {
      this.raf = null;
      if (!this.state.playing) return;
      this.advance();
      if (this.state.playing) this.raf = schedule(tick);
    };
    this.raf = schedule(tick);
  }

  private stop(): void {
    if (this.raf !== null) {
      (this.options.cancelSchedule ?? ((h: number) => cancelAnimationFrame(h)))(this.raf);
      this.raf = null;
    }
  }

  /** Counts a shown frame and refreshes the measured fps. */
  private measure(): void {
    const now = this.now();
    this.shownTimes.push(now);
    while (this.shownTimes.length > 0 && now - this.shownTimes[0]! > FPS_WINDOW_MS) this.shownTimes.shift();
    if (now - this.lastFpsUpdate < FPS_UPDATE_MS || this.shownTimes.length < 2) return;
    const span = now - this.shownTimes[0]!;
    if (span <= 0) return;
    this.lastFpsUpdate = now;
    this.set({ fps: ((this.shownTimes.length - 1) * 1000) / span });
  }
}
