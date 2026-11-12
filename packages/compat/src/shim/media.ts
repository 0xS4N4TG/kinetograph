// `<video>` and `<audio>` as a page sees them (HTMLMediaElement) on the virtual clock. Nothing here reads the wall clock:
// `currentTime` is a closed form of where the element was last placed (a seek, `play()`), the virtual time then, the
// playback rate, `loop` and the file's duration, so the frame a texture or a `drawImage` takes is a function of the
// frame number alone, the same for a still, a sequence and any number of workers. The file is local and probed at once;
// what a browser does over the network (loadstart, loadedmetadata, loadeddata, canplay, ...) is queued as microtasks and
// counted as a load in flight, so the page-load hold waits for metadata as it waits for images.

/** What the element hands the player: how to read its attributes and children, find files and fire events. */
export interface MediaIO {
  kind: 'video' | 'audio';
  /** Fires the event at the element: its `on<type>` property, then its listeners. */
  dispatch(type: string): void;
  /** The `src` attribute, else the `<source>` children, in order. */
  candidates(): { src: string; type: string }[];
  /** The project file a `src` names, null when it is remote or missing. */
  resolve(src: string): string | null;
  /** The file's header, null when it cannot be read as media. */
  probe(file: string): { width: number; height: number; durationInSeconds: number } | null;
  /** Whether the `loop` / `autoplay` content attribute is present. */
  attribute(name: 'loop' | 'autoplay' | 'muted'): boolean;
}

let clock: () => number = () => 0;
/** Sets where media reads the time, in ms: the virtual clock the frame loop gives. */
export function setMediaClock(now: () => number): void {
  clock = now;
}

const players = new Set<MediaPlayer>();
let pendingLoads = 0;
let loadsDone = 0;
const issues = new Set<string>();

/** Media loads that have started and not reached `canplaythrough` or `error`: the page-load hold waits for them. */
export function pendingMediaLoads(): number {
  return pendingLoads;
}
/** Media loads that finished since the start (moves when a load settles, as image loads do). */
export function mediaLoadsSettled(): number {
  return loadsDone;
}
/** What a page asked of media that is not supported, since the last call, each once. */
export function takeMediaIssues(): string[] {
  const out = [...issues];
  issues.clear();
  return out;
}
/** Reports a media feature that is not supported (it warns once per frame set; `--strict` makes it an error). */
export function reportMediaIssue(message: string): void {
  issues.add(message);
}

/** Forgets every element (a new page). */
export function resetMedia(): void {
  players.clear();
}

/** Whether a playing element has events or frame callbacks that a jump must replay frame by frame to deliver in order. */
export function mediaPending(): boolean {
  for (const p of players) if (p.needsTicks()) return true;
  return false;
}

/** Called once per frame by the clock, before the animation-frame callbacks: `ended`, `timeupdate`, video frame callbacks. */
export function tickMedia(): void {
  for (const p of [...players]) p.tick();
}

/** Starts the load of each element in `list` that has not started one (what a parser does for markup). */
export function startMediaLoads(list: Iterable<MediaPlayer>): void {
  for (const p of list) p.start();
}

export const HAVE_NOTHING = 0;
export const HAVE_METADATA = 1;
export const HAVE_CURRENT_DATA = 2;
export const HAVE_FUTURE_DATA = 3;
export const HAVE_ENOUGH_DATA = 4;

class MediaError {
  static readonly MEDIA_ERR_ABORTED = 1;
  static readonly MEDIA_ERR_NETWORK = 2;
  static readonly MEDIA_ERR_DECODE = 3;
  static readonly MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
  constructor(
    readonly code: number,
    readonly message: string,
  ) {}
}

export function domError(message: string, name: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** What Chrome answers for a MIME type: '' (no), 'maybe' or 'probably'. Theora is gone from Chrome, so a page falls to its next `<source>`. */
export function canPlayType(type: string): '' | 'maybe' | 'probably' {
  const match = /^\s*([a-z]+\/[a-z0-9.+-]+)\s*(?:;\s*codecs\s*=\s*"?([^"]*)"?)?/i.exec(type);
  if (match === null) return '';
  const mime = match[1]!.toLowerCase();
  const codecs = (match[2] ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== '');
  const known = (ok: RegExp): '' | 'maybe' | 'probably' => {
    if (codecs.length === 0) return 'maybe';
    return codecs.every((c) => ok.test(c)) ? 'probably' : '';
  };
  switch (mime) {
    case 'video/mp4':
    case 'audio/mp4':
    case 'video/x-m4v':
      return known(/^(avc1|avc3|hvc1|hev1|av01|vp09|mp4a|flac|opus)/);
    case 'video/webm':
    case 'audio/webm':
      return known(/^(vp8|vp9|vp09|av01|vorbis|opus)/);
    case 'video/ogg':
    case 'application/ogg':
      return codecs.length === 0 ? '' : known(/^(vorbis|opus|flac)/);
    case 'audio/ogg':
      return known(/^(vorbis|opus|flac)/);
    case 'audio/mpeg':
    case 'audio/mp3':
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
    case 'audio/flac':
    case 'audio/aac':
    case 'video/quicktime':
      return codecs.length === 0 ? 'maybe' : 'probably';
    default:
      return '';
  }
}

type Task = () => void;

/** One media element's state and clock. */
export class MediaPlayer {
  private started = false;
  private loading = false;
  private loadId = 0;
  private file: string | null = null;
  private info: { width: number; height: number; durationInSeconds: number } | null = null;
  private currentSource = '';
  private ready = HAVE_NOTHING;
  private network = 0; // NETWORK_EMPTY
  private errorValue: MediaError | null = null;
  private isPaused = true;
  private isEnded = false;
  private isSeeking = false;
  /** Where the element was placed (seconds), and the virtual ms it was placed at. */
  private base = 0;
  private anchor = 0;
  private startAt: number | null = null; // a seek before metadata: the default playback start position
  private rate = 1;
  private defaultRate = 1;
  private mutedValue: boolean | null = null;
  private volumeValue = 1;
  private loopValue: boolean | null = null;
  private autoplayValue: boolean | null = null;
  private waiting: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  private frameCallbacks = new Map<number, (now: number, metadata: Record<string, number>) => void>();
  private nextCallbackId = 1;
  private presented: number | null = null;
  private presentedFrames = 0;
  private lastTimeUpdate = -Infinity;

  constructor(private readonly io: MediaIO) {
    players.add(this);
  }

  // ---- loading ----

  /** Starts loading what `src` / `<source>` name, once; a later change of either calls `load()`. */
  start(): void {
    if (!this.started) this.load();
  }

  /** The resource selection algorithm, for local files: the first candidate a browser could play and that can be read. */
  load(): void {
    this.started = true;
    this.settle();
    const id = ++this.loadId;
    this.file = null;
    this.info = null;
    this.currentSource = '';
    this.ready = HAVE_NOTHING;
    this.errorValue = null;
    this.isEnded = false;
    this.isSeeking = false;
    if (this.presented !== null) this.presented = null;
    const wasPaused = this.isPaused;
    this.isPaused = true;
    if (!wasPaused) this.queue(id, () => this.io.dispatch('pause'));
    this.base = this.startAt ?? 0;
    this.startAt = null;
    if (this.io.candidates().length === 0) {
      this.network = 3; // NETWORK_NO_SOURCE
      return;
    }
    this.network = 2; // NETWORK_LOADING
    pendingLoads++;
    this.loading = true;
    this.queue(id, () => this.io.dispatch('loadstart'));
    this.queue(id, () => {
      // The sources a script adds before the data is read count: the list is read now.
      const candidates = this.io.candidates();
      let message = '';
      for (const c of candidates) {
        if (c.type !== '' && canPlayType(c.type) === '') {
          message = `<${this.io.kind}> source type ${c.type} is not one a browser plays`;
          continue;
        }
        const file = this.io.resolve(c.src);
        if (file === null) {
          message = `<${this.io.kind} src="${c.src}">: no such file in the project (looked beside the entry and in public/), or it is remote`;
          continue;
        }
        const info = this.io.probe(file);
        if (info === null) {
          message = `<${this.io.kind} src="${c.src}">: not media Kinetograph can read`;
          continue;
        }
        this.file = file;
        this.info = info;
        this.currentSource = c.src;
        message = '';
        break;
      }
      if (this.file === null) {
        this.network = 3;
        this.errorValue = new MediaError(MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED, message);
        this.settle();
        reportMediaIssue(message);
        this.io.dispatch('error');
        this.failWaiting();
        return;
      }
      this.network = 1; // NETWORK_IDLE
      this.ready = HAVE_METADATA;
      if (this.base > 0) this.base = Math.min(this.base, this.duration);
      this.io.dispatch('durationchange');
      this.queue(id, () => {
        this.io.dispatch('loadedmetadata');
        this.queue(id, () => {
          this.ready = HAVE_ENOUGH_DATA;
          this.io.dispatch('loadeddata');
          this.io.dispatch('canplay');
          this.queue(id, () => {
            this.io.dispatch('canplaythrough');
            this.settle();
            if (this.isPaused && this.autoplay) this.play().catch(() => undefined);
            else if (!this.isPaused) this.begin(id);
          });
        });
      });
    });
  }

  /** The load in flight is over (done, failed or replaced by another). */
  private settle(): void {
    if (!this.loading) return;
    this.loading = false;
    pendingLoads--;
    loadsDone++;
  }

  /** `loadId` tasks: a microtask that does nothing when the element loaded something else in between. */
  private queue(id: number, task: Task): void {
    queueMicrotask(() => {
      if (id === this.loadId) task();
    });
  }

  /** Playback begins (the data is there for a `play()` that came before it). */
  private begin(id: number): void {
    this.anchor = clock();
    this.queue(id, () => {
      this.io.dispatch('playing');
      for (const w of this.waiting.splice(0)) w.resolve();
    });
  }

  private failWaiting(): void {
    const error = domError(this.errorValue?.message ?? 'The media could not be loaded', 'NotSupportedError');
    for (const w of this.waiting.splice(0)) w.reject(error);
  }

  // ---- state ----

  get readyState(): number {
    this.start();
    return this.ready;
  }
  get networkState(): number {
    return this.network;
  }
  get error(): MediaError | null {
    return this.errorValue;
  }
  get currentSrc(): string {
    return this.currentSource;
  }
  get duration(): number {
    this.start();
    return this.info === null || this.ready < HAVE_METADATA ? NaN : this.info.durationInSeconds;
  }
  get videoWidth(): number {
    this.start();
    return this.ready < HAVE_METADATA ? 0 : (this.info?.width ?? 0);
  }
  get videoHeight(): number {
    this.start();
    return this.ready < HAVE_METADATA ? 0 : (this.info?.height ?? 0);
  }
  /** The file a frame is read from, when metadata is known (what a texture or `drawImage` records). */
  get source(): { file: string; width: number; height: number } | null {
    this.start();
    return this.info === null || this.file === null || this.ready < HAVE_METADATA ? null : { file: this.file, width: this.info.width, height: this.info.height };
  }
  get paused(): boolean {
    return this.isPaused;
  }
  get ended(): boolean {
    return this.isEnded || (this.ready >= HAVE_METADATA && !this.isPaused && !this.loop && this.position() >= this.duration);
  }
  get seeking(): boolean {
    return this.isSeeking;
  }
  get loop(): boolean {
    return this.loopValue ?? this.io.attribute('loop');
  }
  set loop(value: boolean) {
    this.loopValue = Boolean(value);
  }
  get autoplay(): boolean {
    return this.autoplayValue ?? this.io.attribute('autoplay');
  }
  set autoplay(value: boolean) {
    this.autoplayValue = Boolean(value);
  }
  get muted(): boolean {
    return this.mutedValue ?? this.io.attribute('muted');
  }
  set muted(value: boolean) {
    this.mutedValue = Boolean(value);
  }
  get volume(): number {
    return this.volumeValue;
  }
  set volume(value: number) {
    if (!(value >= 0 && value <= 1)) throw domError('The volume provided is outside the range [0, 1].', 'IndexSizeError');
    this.volumeValue = value;
  }
  get playbackRate(): number {
    return this.rate;
  }
  set playbackRate(value: number) {
    const rate = Number(value);
    if (!Number.isFinite(rate)) return;
    if (rate < 0) {
      reportMediaIssue(`<${this.io.kind}>.playbackRate = ${rate}: playing backwards is not supported (it plays at 0)`);
    }
    if (!this.isPaused && this.ready >= HAVE_FUTURE_DATA) {
      this.base = this.position();
      this.anchor = clock();
    }
    this.rate = rate;
    this.io.dispatch('ratechange');
  }
  get defaultPlaybackRate(): number {
    return this.defaultRate;
  }
  set defaultPlaybackRate(value: number) {
    this.defaultRate = Number(value) || 1;
  }

  /** Where playback is now, seconds, wrapped or clamped into the file. */
  private position(): number {
    if (this.isPaused || this.ready < HAVE_FUTURE_DATA) return this.base;
    const duration = this.duration;
    const t = this.base + (Math.max(0, clock() - this.anchor) / 1000) * Math.max(0, this.rate);
    if (!(t >= duration)) return t;
    return this.loop && duration > 0 ? t % duration : duration;
  }

  get currentTime(): number {
    this.start();
    return this.position();
  }
  set currentTime(value: number) {
    this.start();
    const t = Number(value);
    if (!Number.isFinite(t)) throw new TypeError("Failed to set the 'currentTime' property on 'HTMLMediaElement': The provided double value is non-finite.");
    if (this.ready < HAVE_METADATA) {
      this.startAt = Math.max(0, t);
      this.base = this.startAt;
      return;
    }
    const to = Math.min(Math.max(0, t), this.duration);
    const id = this.loadId;
    this.base = to;
    this.anchor = clock();
    this.isEnded = false;
    this.isSeeking = true;
    this.queue(id, () => {
      this.io.dispatch('seeking');
      this.queue(id, () => {
        this.isSeeking = false;
        this.io.dispatch('timeupdate');
        this.io.dispatch('seeked');
      });
    });
  }

  // ---- play and pause ----

  play(): Promise<void> {
    this.start();
    if (this.errorValue !== null) return Promise.reject(domError(this.errorValue.message, 'NotSupportedError'));
    const id = this.loadId;
    if (this.network === 3 && this.file === null) return Promise.reject(domError('The element has no supported sources.', 'NotSupportedError'));
    return new Promise<void>((resolve, reject) => {
      if (this.ready >= HAVE_FUTURE_DATA && this.isEnded && !this.loop) {
        this.base = 0;
        this.isEnded = false;
      }
      if (this.isPaused) {
        this.isPaused = false;
        this.queue(id, () => this.io.dispatch('play'));
        if (this.ready >= HAVE_FUTURE_DATA) {
          this.waiting.push({ resolve, reject });
          this.begin(id);
        } else {
          this.waiting.push({ resolve, reject });
        }
      } else if (this.ready >= HAVE_FUTURE_DATA) {
        resolve();
      } else {
        this.waiting.push({ resolve, reject });
      }
    });
  }

  pause(): void {
    this.start();
    if (this.isPaused) return;
    this.base = this.position();
    this.isPaused = true;
    const id = this.loadId;
    this.queue(id, () => {
      this.io.dispatch('timeupdate');
      this.io.dispatch('pause');
    });
    for (const w of this.waiting.splice(0)) w.reject(domError('The play() request was interrupted by a call to pause().', 'AbortError'));
  }

  // ---- frame callbacks and the clock ----

  requestVideoFrameCallback(callback: (now: number, metadata: Record<string, number>) => void): number {
    this.start();
    const id = this.nextCallbackId++;
    this.frameCallbacks.set(id, callback);
    return id;
  }
  cancelVideoFrameCallback(id: number): void {
    this.frameCallbacks.delete(id);
  }

  /** Whether a jump has to step frames for this element: it is playing and something listens, or a frame callback waits. */
  needsTicks(): boolean {
    return !this.isPaused || this.frameCallbacks.size > 0;
  }

  /** One frame of the clock: ends playback, `timeupdate`, and the frame callbacks for a picture that changed. */
  tick(): void {
    if (this.ready < HAVE_METADATA || this.file === null) return;
    const now = clock();
    const playing = !this.isPaused && this.ready >= HAVE_FUTURE_DATA;
    if (playing && !this.loop && this.position() >= this.duration) {
      this.base = this.duration;
      this.isPaused = true;
      this.isEnded = true;
      this.io.dispatch('timeupdate');
      this.io.dispatch('pause');
      this.io.dispatch('ended');
    } else if (playing && now - this.lastTimeUpdate >= 250) {
      this.lastTimeUpdate = now;
      this.io.dispatch('timeupdate');
    }
    if (this.frameCallbacks.size === 0) return;
    const t = this.position();
    if (this.presented !== null && t === this.presented) return;
    this.presented = t;
    this.presentedFrames++;
    const due = [...this.frameCallbacks];
    this.frameCallbacks.clear();
    const metadata = {
      presentationTime: now,
      expectedDisplayTime: now,
      width: this.info?.width ?? 0,
      height: this.info?.height ?? 0,
      mediaTime: t,
      presentedFrames: this.presentedFrames,
      processingDuration: 0,
    };
    for (const [, callback] of due) callback(now, metadata);
  }
}
