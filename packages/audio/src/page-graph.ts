import type { AudioBuffer, AudioNode, AudioParam, AudioBufferSourceNode, OfflineAudioContext } from 'node-web-audio-api';
import type { PageAudioOp, PageAudioValue } from '@kinetographdev/scene';

// Replays what a page did with its `AudioContext` (the `PageAudioOp`s of a render, joined in order) into the mix's
// `OfflineAudioContext`: calls made at time 0 before it renders, every other group of calls when the render reaches
// their time (`suspend`, as a page's own offline code would), so a node made at frame 90 exists from frame 90.

const CREATE: Record<string, string> = {
  gain: 'createGain',
  oscillator: 'createOscillator',
  bufferSource: 'createBufferSource',
  panner: 'createPanner',
  stereoPanner: 'createStereoPanner',
  biquad: 'createBiquadFilter',
  delay: 'createDelay',
  compressor: 'createDynamicsCompressor',
  analyser: 'createAnalyser',
  constant: 'createConstantSource',
  merger: 'createChannelMerger',
  splitter: 'createChannelSplitter',
};

/** Which arguments of a parameter method are times (page time, moved to the mix's by the range's first frame). */
const PARAM_TIMES: Record<string, number[]> = {
  setValueAtTime: [1],
  linearRampToValueAtTime: [1],
  exponentialRampToValueAtTime: [1],
  setTargetAtTime: [1],
  setValueCurveAtTime: [1],
  cancelScheduledValues: [0],
  cancelAndHoldAtTime: [0],
};
const CALL_TIMES: Record<string, number[]> = { start: [0], stop: [0] };

const QUANTUM = 128;

export interface PageGraphOptions {
  fps: number;
  first: number;
  sampleRate: number;
  /** The decoded file at a path (the mix's own decoder). */
  loadFile: (path: string) => Promise<AudioBuffer>;
}

/**
 * Registers the calls with `ctx` (before `startRendering`). The returned promise settles when the last has been
 * applied, with the calls that failed in `problems` (a node the page used that the mix lacks); await it after the render.
 */
export async function scheduleGraph(
  ctx: OfflineAudioContext,
  ops: PageAudioOp[],
  options: PageGraphOptions,
): Promise<{ done: Promise<void>; problems: string[] }> {
  const { fps, first, sampleRate } = options;
  const shift = first / fps;
  const files = new Map<string, AudioBuffer>();
  const wanted = new Set<string>();
  const collect = (v: PageAudioValue | undefined): void => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) wanted.add(v.file);
    else if (Array.isArray(v)) v.forEach(collect);
  };
  for (const op of ops) {
    if (op.op === 'set') collect(op.value);
    else if (op.op === 'media' && op.file !== undefined) wanted.add(op.file);
  }
  for (const file of wanted) files.set(file, await options.loadFile(file));

  const nodes = new Map<string, unknown>([
    ['dest', ctx.destination],
    ['listener', ctx.listener],
  ]);
  /** A media element's gain, and the source playing into it now. */
  const playing = new Map<string, AudioBufferSourceNode>();
  const problems: string[] = [];
  const mixTime = (t: number): number => Math.max(0, t - shift);
  const value = (v: PageAudioValue): unknown => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return files.get(v.file);
    return Array.isArray(v) ? Float32Array.from(v as number[]) : v;
  };
  const times = (table: Record<string, number[]>, method: string, args: PageAudioValue[]): unknown[] =>
    args.map((a, i) => (table[method]?.includes(i) && typeof a === 'number' ? mixTime(a) : value(a)));
  const node = (id: string): any => {
    const n = nodes.get(id);
    if (n === undefined) throw new Error(`no node ${id}`);
    return n;
  };
  const mediaGain = (id: string): any => {
    let gain = nodes.get(id);
    if (gain === undefined) {
      gain = ctx.createGain();
      nodes.set(id, gain);
    }
    return gain;
  };

  const apply = (op: PageAudioOp): void => {
    switch (op.op) {
      case 'new': {
        const make = CREATE[op.kind];
        if (make === undefined) throw new Error(`no ${op.kind} node`);
        nodes.set(op.id, (ctx as any)[make](...(op.args ?? [])));
        break;
      }
      case 'set':
        node(op.id)[op.prop] = value(op.value);
        break;
      case 'param': {
        const param: AudioParam = node(op.id)[op.name];
        (param as any)[op.method](...times(PARAM_TIMES, op.method, op.args));
        break;
      }
      case 'call':
        node(op.id)[op.method](...times(CALL_TIMES, op.method, op.args));
        break;
      case 'connect': {
        const from = op.id.startsWith('m') ? mediaGain(op.id) : node(op.id);
        const to = op.to.startsWith('m') ? mediaGain(op.to) : node(op.to);
        if (op.param !== undefined) (from as AudioNode).connect(to[op.param], op.output ?? 0);
        else (from as AudioNode).connect(to, op.output ?? 0, op.input ?? 0);
        break;
      }
      case 'disconnect': {
        const from = node(op.id) as AudioNode;
        if (op.to === undefined) from.disconnect();
        else from.disconnect(node(op.to));
        break;
      }
      case 'media': {
        const gain = mediaGain(op.id);
        if (op.action === 'play') {
          playing.get(op.id)?.stop();
          const source = ctx.createBufferSource();
          source.buffer = files.get(op.file!)!;
          source.loop = op.loop === true;
          source.playbackRate.value = op.value ?? 1;
          source.connect(gain);
          source.start(0, op.offset ?? 0);
          playing.set(op.id, source);
        } else if (op.action === 'pause') {
          playing.get(op.id)?.stop();
          playing.delete(op.id);
        } else if (op.action === 'volume') {
          gain.gain.setValueAtTime(op.value ?? 1, ctx.currentTime);
        } else {
          const source = playing.get(op.id);
          if (source !== undefined) source.playbackRate.setValueAtTime(op.value ?? 1, ctx.currentTime);
        }
        break;
      }
    }
  };
  const applyAll = (group: PageAudioOp[]): void => {
    for (const op of group) {
      try {
        apply(op);
      } catch (error) {
        problems.push(`${op.op} ${'id' in op ? op.id : ''} at ${op.t.toFixed(3)} s: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  // Groups by the render quantum a call falls in (a suspend lands on a quantum), keeping the order the calls were made in.
  const groups = new Map<number, PageAudioOp[]>();
  for (const op of [...ops].sort((a, b) => a.seq - b.seq)) {
    const quantum = Math.ceil((mixTime(op.t) * sampleRate - 1e-6) / QUANTUM);
    let group = groups.get(quantum);
    if (group === undefined) groups.set(quantum, (group = []));
    group.push(op);
  }
  const total = ctx.length;
  const waits: Promise<void>[] = [];
  for (const [quantum, group] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (quantum === 0) {
      applyAll(group);
      continue;
    }
    if (quantum * QUANTUM >= total) continue;
    waits.push(
      ctx.suspend((quantum * QUANTUM) / sampleRate).then(async () => {
        applyAll(group);
        await ctx.resume();
      }),
    );
  }
  return { done: Promise.all(waits).then(() => undefined), problems };
}
