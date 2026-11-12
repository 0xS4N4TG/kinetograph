// A page's `AudioContext` (`new AudioContext()`, `webkitAudioContext`, `new Audio()`, `<audio>.play()`): the context is
// a recorder on the virtual clock. Every call a page makes on a node, a parameter or a media element is kept as a
// `PageAudioOp` stamped with the frame's time; `currentTime` is `frame / fps` and the context is `running` with no
// gesture. The mix replays the calls into its own `OfflineAudioContext` (packages/audio, page-graph.ts), so the sound is
// the same for a render in one thread or many. An `AnalyserNode` is answered from the sound itself: what its inputs play
// in the `fftSize` samples before the frame's time is worked out here (sources, gains; a pass-through for the rest),
// so a spectrum is a function of the frame and the audio alone. What cannot be recorded is said (`pageAudioNotes`),
// never left as silence.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import type { PageAudioOp, PageAudioValue } from '@kinetographdev/scene';
import { projectFileOf } from '@kinetographdev/compat/shim';
import { virtualFps, virtualNow } from './determinism.js';
import { fftInPlace, readAudioData } from './media-utils.js';

type Listener = (event: Event) => void;
type Spec = { op: PageAudioOp['op'] } & Record<string, unknown>;

// ---- the record ----

let ops: PageAudioOp[] = [];
let taken = 0;
let nextSeq = 0;
let nextNode = 1;
let nextMedia = 1;
/** Frames up to this one were played before (a scene started over replays them): their calls are not recorded twice. */
let mutedThrough = -1;
let lastFrame = -1;
const notes = new Map<string, { property: string; value: string | null; reason: string }>();

const now = (): number => virtualNow() / 1000;
const frameNow = (): number => Math.round((virtualNow() / 1000) * virtualFps());

function record(spec: Spec): void {
  const frame = frameNow();
  if (frame <= mutedThrough) return;
  lastFrame = Math.max(lastFrame, frame);
  ops.push({ seq: nextSeq++, t: now(), ...spec } as PageAudioOp);
}

/** The calls made since the last call (a frame's own, and what the frames before it made on the way to it). */
export function takePageAudioOps(): PageAudioOp[] {
  const out = ops.slice(taken);
  taken = ops.length;
  return out;
}

/** The scene starts over on a page that is not rebuilt: the frames it plays again made their calls already. */
export function replayPageAudio(): void {
  mutedThrough = Math.max(mutedThrough, lastFrame);
}

/** Forgets everything (a new render in the same process; tests). */
export function resetPageAudio(): void {
  ops = [];
  taken = 0;
  nextSeq = 0;
  nextNode = 1;
  nextMedia = 1;
  mutedThrough = -1;
  lastFrame = -1;
  notes.clear();
  buffers.clear();
  mediaStates = new WeakMap();
}

/** What the page's audio used that the mix cannot do, said on every frame (`--strict` fails on it). */
export function pageAudioNotes(): { property: string; value: string | null; reason: string }[] {
  return [...notes.values()];
}

function note(property: string, reason: string): void {
  notes.set(property, { property, value: null, reason });
}

// ---- parameters ----

interface ParamEvent {
  type: 'set' | 'linear' | 'exponential' | 'target' | 'curve';
  time: number;
  value: number;
  /** `target`: the time constant. `curve`: the duration. */
  extra?: number;
  curve?: number[];
}

/** An `AudioParam`: its events are kept to read its value at any time, and every call is recorded. */
class RecParam {
  readonly events: ParamEvent[] = [];
  constructor(
    private readonly owner: string,
    private readonly name: string,
    readonly initial: number,
    readonly minValue = -3.4028234663852886e38,
    readonly maxValue = 3.4028234663852886e38,
  ) {}

  private call(method: string, args: PageAudioValue[]): void {
    record({ op: 'param', id: this.owner, name: this.name, method, args });
  }
  /** A ramp with no event before it starts from the value the parameter has when it is asked for. */
  private rampStart(): void {
    if (this.events.length === 0) this.events.push({ type: 'set', time: now(), value: this.initial });
  }
  /** An event in the past would change sound already made: it is taken as now, as the mix applies it. */
  private at(time: number): number {
    return Math.max(Number(time), now());
  }
  get value(): number {
    return valueAt(this, now());
  }
  set value(v: number) {
    this.setValueAtTime(v, now());
  }
  get defaultValue(): number {
    return this.initial;
  }
  setValueAtTime(value: number, time: number): this {
    this.call('setValueAtTime', [value, time]);
    this.events.push({ type: 'set', time: this.at(time), value });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.call('linearRampToValueAtTime', [value, time]);
    this.rampStart();
    this.events.push({ type: 'linear', time: this.at(time), value });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    this.call('exponentialRampToValueAtTime', [value, time]);
    this.rampStart();
    this.events.push({ type: 'exponential', time: this.at(time), value });
    return this;
  }
  setTargetAtTime(target: number, start: number, timeConstant: number): this {
    this.call('setTargetAtTime', [target, start, timeConstant]);
    this.events.push({ type: 'target', time: this.at(start), value: target, extra: timeConstant });
    return this;
  }
  setValueCurveAtTime(values: ArrayLike<number>, start: number, duration: number): this {
    const curve = Array.from(values);
    this.call('setValueCurveAtTime', [curve, start, duration]);
    this.events.push({ type: 'curve', time: this.at(start), value: curve[curve.length - 1] ?? 0, extra: duration, curve });
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.call('cancelScheduledValues', [time]);
    const from = this.at(time);
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]!.time >= from) this.events.splice(i, 1);
    return this;
  }
  cancelAndHoldAtTime(time: number): this {
    const held = valueAt(this, Math.max(Number(time), now()));
    this.cancelScheduledValues(time);
    this.events.push({ type: 'set', time: this.at(time), value: held });
    return this;
  }
}

/** The value of `param` at `t`, as the Web Audio timeline gives it (events kept in time order). */
function valueAt(param: RecParam, t: number): number {
  const events = param.events;
  let value = param.initial;
  let from = -Infinity;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === 'linear' || e.type === 'exponential') {
      if (t < e.time) {
        if (!Number.isFinite(from) || e.time <= from) return value;
        const f = (t - from) / (e.time - from);
        return e.type === 'linear' ? value + (e.value - value) * f : value > 0 && e.value > 0 ? value * (e.value / value) ** f : value;
      }
      value = e.value;
      from = e.time;
    } else if (e.type === 'set') {
      if (t < e.time) return value;
      value = e.value;
      from = e.time;
    } else if (e.type === 'curve') {
      const c = e.curve!;
      if (t < e.time) return value;
      if (t >= e.time + e.extra!) {
        value = e.value;
        from = e.time + e.extra!;
      } else {
        const x = ((t - e.time) / e.extra!) * (c.length - 1);
        const k = Math.min(c.length - 2, Math.floor(x));
        return c.length === 1 ? c[0]! : c[k]! + (c[k + 1]! - c[k]!) * (x - k);
      }
    } else {
      // target: approaches the value from its start until the next event.
      if (t < e.time) return value;
      const next = events[i + 1];
      const end = next !== undefined ? next.time : Infinity;
      const at = Math.min(t, end);
      const v = e.value + (value - e.value) * Math.exp(-(at - e.time) / Math.max(e.extra!, 1e-9));
      if (t < end) return v;
      value = v;
      from = end;
    }
  }
  return value;
}

// ---- nodes ----

interface KindSpec {
  create: string;
  params?: Record<string, number>;
  props?: Record<string, unknown>;
  source?: boolean;
}

const KINDS: Record<string, KindSpec> = {
  gain: { create: 'createGain', params: { gain: 1 } },
  oscillator: { create: 'createOscillator', params: { frequency: 440, detune: 0 }, props: { type: 'sine' }, source: true },
  bufferSource: { create: 'createBufferSource', params: { playbackRate: 1, detune: 0 }, props: { buffer: null, loop: false, loopStart: 0, loopEnd: 0 }, source: true },
  constant: { create: 'createConstantSource', params: { offset: 1 }, source: true },
  panner: {
    create: 'createPanner',
    params: { positionX: 0, positionY: 0, positionZ: 0, orientationX: 1, orientationY: 0, orientationZ: 0 },
    props: { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 1, maxDistance: 10000, rolloffFactor: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 },
  },
  stereoPanner: { create: 'createStereoPanner', params: { pan: 0 } },
  biquad: { create: 'createBiquadFilter', params: { frequency: 350, detune: 0, Q: 1, gain: 0 }, props: { type: 'lowpass' } },
  delay: { create: 'createDelay', params: { delayTime: 0 } },
  compressor: { create: 'createDynamicsCompressor', params: { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 } },
  analyser: { create: 'createAnalyser', props: { fftSize: 2048, smoothingTimeConstant: 0.8, minDecibels: -100, maxDecibels: -30 } },
  merger: { create: 'createChannelMerger' },
  splitter: { create: 'createChannelSplitter' },
};
const COMMON_PROPS: Record<string, unknown> = { channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers' };

type Endpoint = RecNode | RecParam;

class RecNode {
  readonly inputs = new Set<RecNode>();
  /** What a source node was told: when to start, where in its buffer, when to stop. */
  startAt: number | null = null;
  startOffset = 0;
  startDuration: number | null = null;
  stopAt: number | null = null;
  onended: ((event: Event) => void) | null = null;
  readonly state: Record<string, unknown>;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly context: AudioContextShim,
    readonly kind: string,
    readonly id: string,
    args: PageAudioValue[] = [],
    announce = true,
  ) {
    const spec = KINDS[kind];
    this.state = { ...COMMON_PROPS, ...spec?.props };
    if (spec !== undefined) {
      for (const [name, initial] of Object.entries(spec.params ?? {})) {
        (this as unknown as Record<string, unknown>)[name] = new RecParam(id, name, initial);
      }
    }
    for (const name of Object.keys(this.state)) this.defineProp(name);
    if (announce) record({ op: 'new', id, kind, ...(args.length > 0 ? { args } : {}) });
  }

  private defineProp(name: string): void {
    Object.defineProperty(this, name, {
      enumerable: true,
      get: () => this.state[name],
      set: (value: unknown) => {
        this.state[name] = value;
        record({ op: 'set', id: this.id, prop: name, value: valueOf(value) });
      },
    });
  }

  get numberOfInputs(): number {
    return this.kind === 'oscillator' || this.kind === 'bufferSource' || this.kind === 'constant' ? 0 : 1;
  }
  get numberOfOutputs(): number {
    return this.kind === 'destination' ? 0 : 1;
  }

  connect(destination: Endpoint, output = 0, input = 0): Endpoint {
    if (this.kind === 'unsupported') return destination;
    if (destination instanceof RecParam) {
      const owner = this.context.ownerOf(destination);
      record({ op: 'connect', id: this.id, to: owner.node.id, param: owner.name, output });
      note('AudioParam modulation', 'a node connected to an AudioParam changes the mix but not the data of an AnalyserNode');
    } else {
      record({ op: 'connect', id: this.id, to: destination.id, output, input });
      destination.inputs.add(this);
    }
    return destination;
  }
  disconnect(destination?: Endpoint): void {
    if (this.kind === 'unsupported') return;
    record({ op: 'disconnect', id: this.id, ...(destination instanceof RecNode ? { to: destination.id } : {}) });
    if (destination instanceof RecNode) destination.inputs.delete(this);
    else if (destination === undefined) for (const node of this.context.nodes.values()) node.inputs.delete(this);
  }
  addListener(type: string, listener: Listener | null): void {
    if (listener === null) return;
    let set = this.listeners.get(type);
    if (set === undefined) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeListener(type: string, listener: Listener | null): void {
    if (listener !== null) this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event: Event): boolean {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener.call(this, event);
    return true;
  }

  // ---- sources ----

  start(when = 0, offset = 0, duration?: number): void {
    if (this.startAt !== null) throw new DOMException(`Failed to execute 'start' on '${this.kind}': cannot call start more than once.`, 'InvalidStateError');
    this.startAt = Math.max(Number(when), now());
    this.startOffset = Number(offset) || 0;
    this.startDuration = duration === undefined ? null : Number(duration);
    record({ op: 'call', id: this.id, method: 'start', args: duration === undefined ? [when, offset] : [when, offset, duration] });
    this.scheduleEnd();
  }
  stop(when = 0): void {
    if (this.startAt === null) throw new DOMException(`Failed to execute 'stop' on '${this.kind}': cannot call stop without calling start first.`, 'InvalidStateError');
    this.stopAt = Math.max(Number(when), now());
    record({ op: 'call', id: this.id, method: 'stop', args: [when] });
    this.scheduleEnd();
  }
  /** `ended` fires on the virtual clock when the sound has played out (a loop never ends by itself). */
  private scheduleEnd(): void {
    const end = this.endTime();
    if (end === null) return;
    const due = Math.max(1, Math.ceil((end - now()) * 1000));
    setTimeout(() => {
      if (this.endTime() !== end) return;
      const event = new Event('ended');
      this.onended?.call(this, event);
      this.dispatchEvent(event);
    }, due);
  }
  endTime(): number | null {
    if (this.startAt === null) return null;
    let end = this.stopAt;
    if (this.kind === 'bufferSource' && this.state.loop !== true) {
      const buffer = this.state.buffer as AudioBufferShim | null;
      if (buffer !== null) {
        const rate = Math.abs(valueAt((this as unknown as { playbackRate: RecParam }).playbackRate, this.startAt)) || 1;
        const length = (this.startDuration ?? buffer.duration - this.startOffset) / rate;
        end = end === null ? this.startAt + length : Math.min(end, this.startAt + length);
      }
    }
    return end;
  }

  // ---- positions the page sets the old way ----

  setPosition(x: number, y: number, z: number): void {
    record({ op: 'call', id: this.id, method: 'setPosition', args: [x, y, z] });
    const self = this as unknown as Record<string, RecParam>;
    for (const [axis, v] of [['X', x], ['Y', y], ['Z', z]] as const) self[`position${axis}`]?.events.push({ type: 'set', time: now(), value: v });
  }
  setOrientation(x: number, y: number, z: number, ...up: number[]): void {
    record({ op: 'call', id: this.id, method: 'setOrientation', args: [x, y, z, ...up] });
  }

  // ---- analysers ----

  get frequencyBinCount(): number {
    return (this.state.fftSize as number) / 2;
  }
  getFloatTimeDomainData(array: Float32Array): void {
    const data = timeDomain(this, frameNow());
    array.set(data.subarray(0, array.length));
  }
  getByteTimeDomainData(array: Uint8Array): void {
    const data = timeDomain(this, frameNow());
    for (let i = 0; i < array.length && i < data.length; i++) array[i] = Math.max(0, Math.min(255, Math.floor(128 * (1 + data[i]!))));
  }
  getFloatFrequencyData(array: Float32Array): void {
    const data = decibels(this, frameNow());
    array.set(data.subarray(0, array.length));
  }
  getByteFrequencyData(array: Uint8Array): void {
    const data = decibels(this, frameNow());
    const min = this.state.minDecibels as number;
    const max = this.state.maxDecibels as number;
    for (let i = 0; i < array.length && i < data.length; i++) {
      const scaled = Math.floor((255 / (max - min)) * (data[i]! - min));
      array[i] = Number.isNaN(scaled) ? 0 : Math.max(0, Math.min(255, scaled));
    }
  }
}

function valueOf(v: unknown): PageAudioValue {
  if (v instanceof AudioBufferShim) return { file: v.file };
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Float32Array || Array.isArray(v)) return Array.from(v as ArrayLike<number>);
  return null;
}

/** The decoded sound of a file, as a page's `AudioBuffer`. */
class AudioBufferShim {
  constructor(readonly file: string) {}
  private get data() {
    return readAudioData(this.file);
  }
  get sampleRate(): number {
    return this.data.sampleRate;
  }
  get length(): number {
    return this.data.channelWaveforms[0]!.length;
  }
  get duration(): number {
    return this.data.durationInSeconds;
  }
  get numberOfChannels(): number {
    return this.data.numberOfChannels;
  }
  getChannelData(channel: number): Float32Array {
    const data = this.data.channelWaveforms[channel];
    if (data === undefined) throw new DOMException('channel index is out of range', 'IndexSizeError');
    return data;
  }
}
const buffers = new Map<string, AudioBufferShim>();

/** The audio listener: its position and orientation are parameters, as in current browsers. */
class RecListener {
  readonly positionX = new RecParam('listener', 'positionX', 0);
  readonly positionY = new RecParam('listener', 'positionY', 0);
  readonly positionZ = new RecParam('listener', 'positionZ', 0);
  readonly forwardX = new RecParam('listener', 'forwardX', 0);
  readonly forwardY = new RecParam('listener', 'forwardY', 0);
  readonly forwardZ = new RecParam('listener', 'forwardZ', -1);
  readonly upX = new RecParam('listener', 'upX', 0);
  readonly upY = new RecParam('listener', 'upY', 1);
  readonly upZ = new RecParam('listener', 'upZ', 0);
  setPosition(x: number, y: number, z: number): void {
    record({ op: 'call', id: 'listener', method: 'setPosition', args: [x, y, z] });
  }
  setOrientation(x: number, y: number, z: number, ux: number, uy: number, uz: number): void {
    record({ op: 'call', id: 'listener', method: 'setOrientation', args: [x, y, z, ux, uy, uz] });
  }
}

// ---- the context ----

/**
 * Where the bytes a page decodes are kept, as the engine keeps what it downloads: under the user's own cache
 * (`~/.cache/kinetograph`, as `remote-assets.ts`), in a folder only that user can enter, which is checked to be theirs
 * and not a link before it is used.
 */
function savedDir(): string {
  const dir = join(homedir(), '.cache', 'kinetograph', 'page-audio');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error(`${dir} is not a folder of this user's: remove it`);
  }
  return dir;
}

/**
 * The bytes a page decodes, as a file named by their SHA-256, so the mix reads the sound the page decoded and every worker
 * and run has the same bytes. A file already there is used only when it hashes to its name (a planted one is replaced);
 * a new one is written under a name of its own and renamed over the name, so a link at that name is replaced, never written through.
 */
function fileOfBytes(bytes: ArrayBuffer): string {
  const data = Buffer.from(bytes);
  const hash = createHash('sha256').update(data).digest('hex');
  const file = join(savedDir(), `${hash}.bin`);
  try {
    if (lstatSync(file).isFile() && createHash('sha256').update(readFileSync(file)).digest('hex') === hash) return file;
  } catch {
    // Not there yet.
  }
  const own = `${file}.${process.pid}.${threadId}.${randomBytes(6).toString('hex')}`;
  writeFileSync(own, data, { flag: 'wx', mode: 0o600 });
  renameSync(own, file);
  return file;
}

function bufferOf(file: string): AudioBufferShim {
  let buffer = buffers.get(file);
  if (buffer === undefined) buffers.set(file, (buffer = new AudioBufferShim(file)));
  readAudioData(file);
  return buffer;
}

class AudioContextShim extends EventTarget {
  readonly nodes = new Map<string, RecNode>();
  private readonly owners = new Map<RecParam, { node: RecNode; name: string }>();
  readonly destination: RecNode;
  readonly listener = new RecListener();
  readonly sampleRate: number;
  readonly state = 'running';
  readonly baseLatency = 0;
  readonly outputLatency = 0;
  onstatechange: ((event: Event) => void) | null = null;

  constructor(options?: { sampleRate?: number }) {
    super();
    this.sampleRate = options?.sampleRate ?? 48000;
    this.destination = new RecNode(this, 'destination', 'dest', [], false);
    this.nodes.set('dest', this.destination);
  }
  get currentTime(): number {
    return now();
  }
  ownerOf(param: RecParam): { node: RecNode; name: string } {
    const found = this.owners.get(param);
    if (found === undefined) throw new DOMException('the parameter belongs to another context', 'InvalidAccessError');
    return found;
  }
  private make(kind: string, args: PageAudioValue[] = []): RecNode {
    const node = new RecNode(this, kind, `n${nextNode++}`, args);
    this.nodes.set(node.id, node);
    for (const name of Object.keys(KINDS[kind]?.params ?? {})) this.owners.set((node as unknown as Record<string, RecParam>)[name]!, { node, name });
    return node;
  }
  /** A node the mix cannot make: it is there to connect to, and the render says it is not heard. */
  private stub(kind: string, reason: string): RecNode {
    note(kind, reason);
    return new RecNode(this, 'unsupported', `n${nextNode++}`, [], false);
  }
  createGain = (): RecNode => this.make('gain');
  createOscillator = (): RecNode => this.make('oscillator');
  createBufferSource = (): RecNode => this.make('bufferSource');
  createConstantSource = (): RecNode => this.make('constant');
  createPanner = (): RecNode => this.make('panner');
  createStereoPanner = (): RecNode => this.make('stereoPanner');
  createBiquadFilter = (): RecNode => this.make('biquad');
  createDelay = (maxDelayTime = 1): RecNode => this.make('delay', [maxDelayTime]);
  createDynamicsCompressor = (): RecNode => this.make('compressor');
  createAnalyser = (): RecNode => this.make('analyser');
  createChannelMerger = (n = 6): RecNode => this.make('merger', [n]);
  createChannelSplitter = (n = 6): RecNode => this.make('splitter', [n]);
  createBuffer = (): never => {
    note('createBuffer', 'a buffer a page fills with its own samples is not replayed in the mix (only buffers decoded from files are)');
    throw new DOMException('createBuffer is not supported: samples written by the page cannot be replayed in the mix', 'NotSupportedError');
  };
  createWaveShaper = (): RecNode => this.stub('createWaveShaper', 'a WaveShaperNode is not replayed in the mix, so the sound through it is not heard');
  createConvolver = (): RecNode => this.stub('createConvolver', 'a ConvolverNode is not replayed in the mix, so the sound through it is not heard');
  createIIRFilter = (): RecNode => this.stub('createIIRFilter', 'an IIRFilterNode is not replayed in the mix, so the sound through it is not heard');
  createPeriodicWave = (): never => {
    note('createPeriodicWave', 'a custom oscillator wave is not replayed in the mix');
    throw new DOMException('createPeriodicWave is not supported', 'NotSupportedError');
  };
  createScriptProcessor = (): RecNode => this.stub('createScriptProcessor', 'a ScriptProcessorNode runs page code on audio blocks, which the mix does not, so its sound is not heard');
  createMediaStreamSource = (): RecNode => this.stub('createMediaStreamSource', 'there is no microphone or stream in a render');
  createMediaStreamDestination = (): RecNode => this.stub('createMediaStreamDestination', 'there is no stream to record in a render');
  get audioWorklet(): never {
    note('audioWorklet', 'an AudioWorklet runs page code on audio blocks, which the mix does not, so its sound is not heard');
    throw new DOMException('audioWorklet is not supported', 'NotSupportedError');
  }
  createMediaElementSource = (element: MediaElement): RecNode => {
    const state = mediaStateOf(element);
    state.routed = true;
    const node = new RecNode(this, 'media', state.id, [], false);
    this.nodes.set(node.id, node);
    return node;
  };
  decodeAudioData = (data: ArrayBuffer, success?: (b: AudioBufferShim) => void, failure?: (e: unknown) => void): Promise<AudioBufferShim> => {
    return new Promise((resolve, reject) => {
      try {
        const buffer = bufferOf(fileOfBytes(data));
        success?.(buffer);
        resolve(buffer);
      } catch (error) {
        const failed = new DOMException(`Unable to decode audio data: ${error instanceof Error ? error.message : String(error)}`, 'EncodingError');
        failure?.(failed);
        reject(failed);
      }
    });
  };
  resume = (): Promise<void> => Promise.resolve();
  suspend = (): Promise<void> => Promise.resolve();
  close = (): Promise<void> => Promise.resolve();
}

// ---- media elements ----

interface MediaElement {
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null }>;
  dispatchEvent(event: Event): boolean;
  duration: number;
  volume?: number;
  muted?: boolean;
  loop?: boolean;
  playbackRate?: number;
  onended?: ((event: Event) => void) | null;
}

interface MediaState {
  id: string;
  routed: boolean;
  playing: boolean;
  /** Where the file was at `since` (seconds), and the virtual time of that. */
  at: number;
  since: number;
  file: string | null;
}
let mediaStates = new WeakMap<object, MediaState>();

function mediaStateOf(element: MediaElement): MediaState {
  let state = mediaStates.get(element);
  if (state === undefined) {
    state = { id: `m${nextMedia++}`, routed: false, playing: false, at: 0, since: 0, file: null };
    mediaStates.set(element, state);
  }
  return state;
}

const levelOf = (element: MediaElement): number => (element.muted === true ? 0 : Number(element.volume ?? 1));

/** Where in its file the element is now, wrapping a loop and stopping at the end. */
function positionOf(element: MediaElement, state: MediaState): number {
  if (!state.playing) return state.at;
  const position = state.at + (now() - state.since) * Number(element.playbackRate ?? 1);
  const length = element.duration;
  if (!Number.isFinite(length) || length <= 0) return position;
  return element.loop === true ? position % length : Math.min(position, length);
}

/** The element's file: its `src`, else the first `<source>` child whose file is in the project (the decoder reads any format). */
function sourceOf(element: MediaElement): { src: string | null; file: string | null } {
  const candidates = [element.getAttribute('src'), ...Array.from(element.querySelectorAll('source'), (el) => el.getAttribute('src'))];
  for (const src of candidates) {
    const file = src === null || src === '' ? null : projectFileOf(src);
    if (file !== null && existsSync(file)) return { src, file };
  }
  return { src: candidates.find((c) => c !== null && c !== '') ?? null, file: null };
}

/** The host for the DOM shim's `<audio>` and `<video>` elements' `play`, `pause`, `paused` and `currentTime`. */
export const mediaHost = {
  paused: (element: MediaElement): boolean => !(mediaStates.get(element)?.playing ?? false),
  /**
   * `volume`, `muted` or `playbackRate` of an element the page plays is about to change (the element calls this before it
   * does, so the position and level are read from the old values): a change while it plays is heard.
   */
  change(element: MediaElement, name: string, value: unknown): void {
    const state = mediaStates.get(element);
    if (state === undefined || !state.playing) return;
    if (name === 'volume') record({ op: 'media', id: state.id, action: 'volume', value: element.muted === true ? 0 : Number(value) });
    else if (name === 'muted') record({ op: 'media', id: state.id, action: 'volume', value: value === true ? 0 : Number(element.volume ?? 1) });
    else if (name === 'playbackRate') {
      state.at = positionOf(element, state);
      state.since = now();
      record({ op: 'media', id: state.id, action: 'rate', value: Number(value) });
    }
  },
  seek(element: MediaElement, time: number): void {
    const state = mediaStateOf(element);
    state.at = time;
    state.since = now();
    if (state.playing) this.play(element);
  },
  play(element: MediaElement): void {
    const state = mediaStateOf(element);
    const { src, file } = sourceOf(element);
    if (file === null) {
      note(`<audio src="${src ?? ''}">`, 'the file is not in the project, so the element makes no sound');
      throw new DOMException(`The element has no supported sources: ${src ?? '(no src)'}`, 'NotSupportedError');
    }
    bufferOf(file);
    const start = state.playing ? positionOf(element, state) : state.at;
    state.file = file;
    state.playing = true;
    state.at = start;
    state.since = now();
    if (!state.routed) {
      record({ op: 'connect', id: state.id, to: 'dest' });
      state.routed = true;
    }
    record({ op: 'media', id: state.id, action: 'volume', value: levelOf(element) });
    record({ op: 'media', id: state.id, action: 'play', file, offset: start, loop: element.loop === true, value: Number(element.playbackRate ?? 1) });
    const length = bufferOf(file).duration;
    if (element.loop !== true) {
      const due = Math.max(1, Math.ceil(((length - start) / Number(element.playbackRate ?? 1)) * 1000));
      const since = state.since;
      setTimeout(() => {
        if (!state.playing || state.since !== since) return;
        // The element's own player sends `ended` (compat/shim/media.ts); this only stops the sound's bookkeeping.
        state.playing = false;
        state.at = length;
      }, due);
    }
  },
  pause(element: MediaElement): void {
    const state = mediaStates.get(element);
    if (state === undefined || !state.playing) return;
    state.at = positionOf(element, state);
    state.playing = false;
    record({ op: 'media', id: state.id, action: 'pause' });
  },
};

// ---- what an analyser hears ----

type Pcm = { samples: Float32Array; rate: number };

/** A file's sound as mono at the file's rate (a stereo file is averaged, as an analyser mixes its input down). */
const monoCache = new Map<string, Pcm>();
function monoOf(file: string): Pcm {
  let pcm = monoCache.get(file);
  if (pcm === undefined) {
    const data = readAudioData(file);
    const [first, ...rest] = data.channelWaveforms;
    let samples = first!;
    if (rest.length > 0) {
      samples = new Float32Array(first!.length);
      for (let i = 0; i < samples.length; i++) {
        let sum = first![i]!;
        for (const channel of rest) sum += channel[i]!;
        samples[i] = sum / data.channelWaveforms.length;
      }
    }
    pcm = { samples, rate: data.sampleRate };
    monoCache.set(file, pcm);
  }
  return pcm;
}

function lastOf<T>(items: T[], test: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i]!)) return items[i];
  return undefined;
}

const frac = (x: number): number => x - Math.floor(x);

/** Cycles of an oscillator from its start to `t`: the frequency integrated over its events. */
function phaseAt(node: RecNode, t: number): number {
  const self = node as unknown as { frequency: RecParam; detune: RecParam };
  const begin = node.startAt!;
  if (t <= begin) return 0;
  const cuts = new Set<number>([begin, t]);
  for (const p of [self.frequency, self.detune]) for (const e of p.events) if (e.time > begin && e.time < t) cuts.add(e.time);
  const edges = [...cuts].sort((a, b) => a - b);
  let cycles = 0;
  for (let i = 0; i + 1 < edges.length; i++) {
    const steps = Math.max(1, Math.min(64, Math.ceil((edges[i + 1]! - edges[i]!) * 1000)));
    const dt = (edges[i + 1]! - edges[i]!) / steps;
    for (let s = 0; s < steps; s++) {
      const mid = edges[i]! + (s + 0.5) * dt;
      cycles += valueAt(self.frequency, mid) * 2 ** (valueAt(self.detune, mid) / 1200) * dt;
    }
  }
  return cycles;
}

/** What `node` plays at the `count` samples from `first` (at `rate`), mono. */
function signal(node: RecNode, first: number, count: number, rate: number, path: Set<RecNode>): Float32Array {
  const out = new Float32Array(count);
  if (path.has(node)) return out;
  path.add(node);
  const at = (i: number): number => (first + i) / rate;
  const live = (t: number): boolean => node.startAt !== null && t >= node.startAt && (node.stopAt === null || t < node.stopAt);
  const self = node as unknown as Record<string, RecParam>;
  if (node.kind === 'oscillator') {
    const type = node.state.type as string;
    if (type === 'custom') note('oscillator type custom', 'a custom wave is not worked out for an AnalyserNode');
    let cycles = node.startAt === null ? 0 : phaseAt(node, Math.max(at(0), node.startAt));
    for (let i = 0; i < count; i++) {
      const t = at(i);
      if (!live(t)) continue;
      const p = cycles;
      out[i] = type === 'square' ? (frac(p) < 0.5 ? 1 : -1) : type === 'sawtooth' ? 2 * (p - Math.floor(p + 0.5)) : type === 'triangle' ? 1 - 4 * Math.abs(frac(p + 0.25) - 0.5) : Math.sin(2 * Math.PI * p);
      cycles += (valueAt(self.frequency!, t) * 2 ** (valueAt(self.detune!, t) / 1200)) / rate;
    }
  } else if (node.kind === 'constant') {
    for (let i = 0; i < count; i++) if (live(at(i))) out[i] = valueAt(self.offset!, at(i));
  } else if (node.kind === 'bufferSource') {
    const buffer = node.state.buffer as AudioBufferShim | null;
    if (buffer !== null) {
      const pcm = monoOf(buffer.file);
      const loop = node.state.loop === true;
      const length = pcm.samples.length / pcm.rate;
      const loopStart = Number(node.state.loopStart) || 0;
      const loopEnd = Number(node.state.loopEnd) > 0 ? Number(node.state.loopEnd) : length;
      for (let i = 0; i < count; i++) {
        const t = at(i);
        if (!live(t)) continue;
        let pos = node.startOffset + (t - node.startAt!) * valueAt(self.playbackRate!, node.startAt!);
        if (node.startDuration !== null && pos - node.startOffset >= node.startDuration) continue;
        if (loop && loopEnd > loopStart && pos >= loopEnd) pos = loopStart + ((pos - loopStart) % (loopEnd - loopStart));
        if (pos < 0 || pos >= length) continue;
        const x = pos * pcm.rate;
        const k = Math.floor(x);
        const a = pcm.samples[k]!;
        const b = pcm.samples[k + 1] ?? a;
        out[i] = a + (b - a) * (x - k);
      }
    }
  } else if (node.kind === 'media') {
    const play = mediaPlayOf(node.id);
    if (play !== null) {
      const pcm = monoOf(play.file);
      const length = pcm.samples.length / pcm.rate;
      for (let i = 0; i < count; i++) {
        const t = at(i);
        const seg = lastOf(play.segments, (s) => s.from <= t);
        if (seg === undefined || (seg.to !== null && t >= seg.to)) continue;
        let pos = seg.offset + (t - seg.from) * seg.rate;
        if (seg.loop) pos %= length;
        if (pos < 0 || pos >= length) continue;
        const x = pos * pcm.rate;
        const k = Math.floor(x);
        const a = pcm.samples[k]!;
        const b = pcm.samples[k + 1] ?? a;
        out[i] = (a + (b - a) * (x - k)) * seg.volume(t);
      }
    }
  } else {
    if (node.kind === 'panner') {
      note('AnalyserNode behind panner', 'the analysed data of a panner has its distance and cone gain but not its left and right balance, so it can differ a little from the mix');
    } else if (node.kind !== 'gain' && node.kind !== 'analyser' && node.kind !== 'destination') {
      note(`AnalyserNode behind ${node.kind}`, `the data of an AnalyserNode is worked out from the sources and gains ahead of it; the ${node.kind} node is passed through, so it can differ from the mix`);
    }
    for (const input of node.inputs) {
      const heard = signal(input, first, count, rate, path);
      for (let i = 0; i < count; i++) out[i]! += heard[i]!;
    }
    if (node.kind === 'gain') for (let i = 0; i < count; i++) out[i]! *= valueAt(self.gain!, at(i));
    else if (node.kind === 'panner') for (let i = 0; i < count; i++) out[i]! *= pannerGain(node, at(i));
  }
  path.delete(node);
  return out;
}

/** A panner's distance and cone gain at `t` (the Web Audio spec's models), from its and the listener's parameters. */
function pannerGain(node: RecNode, t: number): number {
  const p = node as unknown as Record<string, RecParam>;
  const listener = node.context.listener as unknown as Record<string, RecParam>;
  const v = (param: RecParam | undefined): number => (param === undefined ? 0 : valueAt(param, t));
  const source = [v(p.positionX), v(p.positionY), v(p.positionZ)];
  const ears = [v(listener.positionX), v(listener.positionY), v(listener.positionZ)];
  const toListener = [ears[0]! - source[0]!, ears[1]! - source[1]!, ears[2]! - source[2]!];
  const d = Math.hypot(...toListener);
  const ref = Number(node.state.refDistance);
  const max = Number(node.state.maxDistance);
  const roll = Number(node.state.rolloffFactor);
  let distance: number;
  switch (node.state.distanceModel) {
    case 'linear':
      distance = max === ref ? 1 : 1 - roll * ((Math.min(Math.max(d, ref), max) - ref) / (max - ref));
      break;
    case 'exponential':
      distance = (Math.max(d, ref) / ref) ** -roll;
      break;
    default:
      distance = ref / (ref + roll * (Math.max(d, ref) - ref));
  }
  const inner = Number(node.state.coneInnerAngle);
  const outer = Number(node.state.coneOuterAngle);
  const facing = [v(p.orientationX), v(p.orientationY), v(p.orientationZ)];
  const length = Math.hypot(...facing) * d;
  if ((inner >= 360 && outer >= 360) || length === 0) return distance;
  const angle = (Math.acos(Math.min(1, Math.max(-1, (facing[0]! * toListener[0]! + facing[1]! * toListener[1]! + facing[2]! * toListener[2]!) / length))) * 180) / Math.PI;
  const outerGain = Number(node.state.coneOuterGain);
  if (angle <= inner / 2) return distance;
  if (angle >= outer / 2) return distance * outerGain;
  return distance * (1 - ((angle - inner / 2) / ((outer - inner) / 2)) * (1 - outerGain));
}

interface Segment {
  from: number;
  to: number | null;
  offset: number;
  rate: number;
  loop: boolean;
  volume: (t: number) => number;
}

/** The stretches a media element played, from the calls recorded for it. */
function mediaPlayOf(id: string): { file: string; segments: Segment[] } | null {
  const segments: Segment[] = [];
  let file: string | null = null;
  let level: [number, number][] = [[0, 1]];
  for (const op of ops) {
    if (op.op !== 'media' || op.id !== id) continue;
    const open = segments[segments.length - 1];
    if (op.action === 'play') {
      if (open !== undefined && open.to === null) open.to = op.t;
      file = op.file ?? file;
      segments.push({ from: op.t, to: null, offset: op.offset ?? 0, rate: op.value ?? 1, loop: op.loop === true, volume: (t) => lastOf(level, ([from]) => from <= t)?.[1] ?? 1 });
    } else if (op.action === 'pause') {
      if (open !== undefined && open.to === null) open.to = op.t;
    } else if (op.action === 'volume') level = [...level, [op.t, op.value ?? 1]];
    else if (op.action === 'rate' && open !== undefined && open.to === null) {
      const done = open.offset + (op.t - open.from) * open.rate;
      open.to = op.t;
      segments.push({ from: op.t, to: null, offset: done, rate: op.value ?? 1, loop: open.loop, volume: open.volume });
    }
  }
  return file === null ? null : { file, segments };
}

/** The last `fftSize` samples the analyser's inputs played before frame `frame`'s time. */
function timeDomain(analyser: RecNode, frame: number): Float32Array {
  const size = analyser.state.fftSize as number;
  const rate = analyser.context.sampleRate;
  const end = Math.round((frame / virtualFps()) * rate);
  return signal(analyser, end - size, size, rate, new Set());
}

const spectraOf = new WeakMap<RecNode, Map<string, Float32Array>>();

/** The magnitudes of the blackman-windowed time domain data at `frame`, divided by the size (the spec's X[k]). */
function magnitudes(analyser: RecNode, frame: number): Float32Array {
  const size = analyser.state.fftSize as number;
  let cache = spectraOf.get(analyser);
  if (cache === undefined) spectraOf.set(analyser, (cache = new Map()));
  const key = `${size}:${frame}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  const x = timeDomain(analyser, frame);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const alpha = 0.16;
  for (let n = 0; n < size; n++) {
    const w = (1 - alpha) / 2 - 0.5 * Math.cos((2 * Math.PI * n) / size) + (alpha / 2) * Math.cos((4 * Math.PI * n) / size);
    re[n] = x[n]! * w;
  }
  fftInPlace(re, im);
  const out = new Float32Array(size / 2);
  for (let k = 0; k < out.length; k++) out[k] = Math.hypot(re[k]!, im[k]!) / size;
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}

/**
 * The spectrum in dB at `frame`: the magnitudes smoothed over time with `smoothingTimeConstant` (each is `k` of the one
 * before and `1 - k` of its own), taken over the frames before this one until their share is under 0.2%, so the data
 * is a function of the frame and the audio, not of how often the page asked.
 */
function decibels(analyser: RecNode, frame: number): Float32Array {
  const k = Math.min(1, Math.max(0, Number(analyser.state.smoothingTimeConstant)));
  const depth = k === 0 ? 0 : k >= 1 ? 60 : Math.min(60, Math.ceil(Math.log(0.002) / Math.log(k)));
  const bins = (analyser.state.fftSize as number) / 2;
  const smooth = new Float32Array(bins);
  for (let g = Math.max(0, frame - depth); g <= frame; g++) {
    const x = magnitudes(analyser, g);
    for (let i = 0; i < bins; i++) smooth[i] = k * smooth[i]! + (1 - k) * x[i]!;
  }
  for (let i = 0; i < bins; i++) smooth[i] = 20 * Math.log10(smooth[i]!);
  return smooth;
}

/** `AudioContext`, `webkitAudioContext` and `Audio` on `globalThis`. */
export function installPageAudio(): void {
  const g = globalThis as Record<string, unknown>;
  g.AudioContext = AudioContextShim;
  g.webkitAudioContext = AudioContextShim;
  g.Audio = function Audio(this: unknown, src?: string): unknown {
    const element = (g.document as { createElement(tag: string): { setAttribute(n: string, v: string): void } }).createElement('audio');
    if (src !== undefined) element.setAttribute('src', String(src));
    return element;
  };
}
