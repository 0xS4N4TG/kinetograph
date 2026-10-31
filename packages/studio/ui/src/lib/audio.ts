// The preview's sound. The server mixes the composition's audio once (`GET /api/audio`, a WAV); this plays it with the
// Web Audio clock, which the player follows while it is playing: the picture is the follower, so it drops frames
// rather than drifting. The wall clock is fine here: this is the UI deciding what to play, never part of a render.

import type { PlayerAudio } from '@/lib/player';

const MUTE_KEY = 'kg.audio.muted';
/** A scrub plays this much sound at the playhead, seconds, and no more often than the throttle, ms. */
const SNIPPET_SECONDS = 0.08;
const SNIPPET_THROTTLE_MS = 60;

export interface AudioState {
  /** The composition has sound and it has loaded. */
  available: boolean;
  muted: boolean;
}

export interface PreviewAudioOptions {
  /** Makes the audio context; default the browser's. Returns null where there is none (the preview is then silent). */
  createContext?: () => AudioContext | null;
  now?: () => number;
}

function readMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export class PreviewAudio implements PlayerAudio {
  private state: AudioState = { available: false, muted: readMuted() };
  private readonly listeners = new Set<() => void>();
  private ctx: AudioContext | null | undefined;
  private gain: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private snippetSource: AudioBufferSourceNode | null = null;
  /** The context time the running source began at, and the composition second it began from. */
  private startedAt = 0;
  private offset = 0;
  private loadSeq = 0;
  private lastSnippet = -Infinity;

  constructor(private readonly options: PreviewAudioOptions = {}) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): AudioState => this.state;

  private set(patch: Partial<AudioState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private context(): AudioContext | null {
    if (this.ctx === undefined) {
      try {
        this.ctx = this.options.createContext ? this.options.createContext() : typeof AudioContext === 'undefined' ? null : new AudioContext();
      } catch {
        this.ctx = null;
      }
      if (this.ctx) {
        this.gain = this.ctx.createGain();
        this.gain.gain.value = this.state.muted ? 0 : 1;
        this.gain.connect(this.ctx.destination);
      }
    }
    return this.ctx;
  }

  setMuted(muted: boolean): void {
    try {
      window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      // the choice lasts until reload
    }
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
    this.set({ muted });
  }

  /**
   * Replaces the sound with what `fetchWav` returns (null: the composition has none). The sound that is playing goes on
   * until the new one is decoded. A newer `load` makes an older one that is still waiting give up.
   */
  async load(fetchWav: () => Promise<ArrayBuffer | null>): Promise<boolean> {
    const seq = ++this.loadSeq;
    const ctx = this.context();
    if (!ctx) return false;
    let buffer: AudioBuffer | null = null;
    try {
      const data = await fetchWav();
      if (data && data.byteLength > 44) buffer = await ctx.decodeAudioData(data);
    } catch {
      buffer = null;
    }
    if (seq !== this.loadSeq) return false;
    this.stopSource();
    this.buffer = buffer;
    this.set({ available: buffer !== null });
    return true;
  }

  /** Forgets the sound (another composition is on show). */
  clear(): void {
    this.loadSeq++;
    this.stopSource();
    this.buffer = null;
    if (this.state.available) this.set({ available: false });
  }

  // ---- PlayerAudio ----

  start(seconds: number): void {
    this.stopSource();
    const ctx = this.context();
    if (!ctx || !this.buffer || !this.gain) return;
    void ctx.resume();
    this.offset = Math.max(0, seconds);
    this.startedAt = ctx.currentTime;
    if (this.offset >= this.buffer.duration) {
      this.source = null;
      this.running = true;
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gain);
    source.start(0, this.offset);
    this.source = source;
    this.running = true;
  }

  private running = false;

  stop(): void {
    this.stopSource();
    this.stopSnippet();
    this.running = false;
  }

  /** The composition second the sound is at, or null while it is not playing (or the context is not running yet). */
  time(): number | null {
    const ctx = this.ctx;
    if (!ctx || !this.running || !this.buffer || ctx.state !== 'running') return null;
    // What is heard is what the output played `outputLatency` ago: the picture follows that.
    const latency = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
    return this.offset + Math.max(0, ctx.currentTime - this.startedAt - latency);
  }

  snippet(seconds: number): void {
    const ctx = this.context();
    if (!ctx || !this.buffer || !this.gain || this.state.muted) return;
    const now = (this.options.now ?? (() => performance.now()))();
    if (now - this.lastSnippet < SNIPPET_THROTTLE_MS) return;
    this.lastSnippet = now;
    this.stopSnippet();
    if (seconds >= this.buffer.duration) return;
    void ctx.resume();
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    const fade = ctx.createGain();
    // A short ramp each way, so a cut in the middle of a wave does not click.
    const t = ctx.currentTime;
    fade.gain.setValueAtTime(0, t);
    fade.gain.linearRampToValueAtTime(1, t + 0.008);
    fade.gain.setValueAtTime(1, t + SNIPPET_SECONDS - 0.01);
    fade.gain.linearRampToValueAtTime(0, t + SNIPPET_SECONDS);
    source.connect(fade).connect(this.gain);
    source.start(0, Math.max(0, seconds));
    source.stop(t + SNIPPET_SECONDS);
    this.snippetSource = source;
  }

  private stopSource(): void {
    try {
      this.source?.stop();
    } catch {
      // not started
    }
    this.source?.disconnect();
    this.source = null;
  }

  private stopSnippet(): void {
    try {
      this.snippetSource?.stop();
    } catch {
      // not started
    }
    this.snippetSource = null;
  }
}
