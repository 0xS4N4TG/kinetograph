// HyperFrames' audio effects chain, `data-fx-chain` (Apache-2.0, heygen-com/hyperframes; packages/core/src/audioFx.ts):
// the sixteen effects with their parameters, defaults and ranges, and the reader that clamps a chain into them. Ported to
// this package so the offline mix can run the same graph HyperFrames' render runs (see graph.ts). Changed from the
// original: only what the mix needs (no labels, hints or panel steps), and the parameter table is written compactly.

export interface FxNumberParam {
  kind: 'number';
  key: string;
  min: number;
  max: number;
  default: number;
  scale?: 'log';
  /** An AudioParam is behind it, so an `fx.<id>.<key>` lane can drive it. */
  automatable?: boolean;
}
export interface FxEnumParam {
  kind: 'enum';
  key: string;
  options: readonly string[];
  default: string;
}
export type FxParam = FxNumberParam | FxEnumParam;
export type FxParamValues = Record<string, number | string>;

export interface FxDef {
  id: string;
  params: readonly FxParam[];
  /** The graph builder (graph.ts). */
  web: string;
}

const num = (key: string, min: number, max: number, def: number, extra: { log?: boolean; auto?: boolean } = {}): FxNumberParam => ({
  kind: 'number',
  key,
  min,
  max,
  default: def,
  ...(extra.log ? { scale: 'log' as const } : {}),
  ...(extra.auto ? { automatable: true } : {}),
});
const freq = (def: number, min = 20, max = 20000): FxNumberParam => num('frequency', min, max, def, { log: true, auto: true });
const q = (def: number): FxNumberParam => num('q', 0.1, 20, def, { log: true, auto: true });
const gainDb = (min: number, max: number): FxNumberParam => num('gain', min, max, 0, { auto: true });
const poles: FxEnumParam = { kind: 'enum', key: 'poles', options: ['1', '2'], default: '2' };

/** Every effect (audioFx.ts: HF_AUDIO_FX). */
export const FX_DEFS: readonly FxDef[] = [
  { id: 'gain', params: [gainDb(-60, 12)], web: 'gain-node' },
  { id: 'peaking', params: [freq(1000), gainDb(-40, 40), q(1)], web: 'biquad-peaking' },
  { id: 'lowshelf', params: [freq(200, 20, 2000), gainDb(-40, 40)], web: 'biquad-lowshelf' },
  { id: 'highshelf', params: [freq(4000, 500, 20000), gainDb(-40, 40)], web: 'biquad-highshelf' },
  { id: 'highpass', params: [freq(300), q(0.707), poles], web: 'biquad-highpass' },
  { id: 'lowpass', params: [freq(8000, 100, 20000), q(0.707), poles], web: 'biquad-lowpass' },
  {
    id: 'compressor',
    params: [
      num('threshold', -60, 0, -24),
      num('ratio', 1, 20, 4),
      num('attack', 0.01, 2000, 20, { log: true }),
      num('release', 0.01, 9000, 250, { log: true }),
      num('knee', 1, 8, 2.83),
      num('makeup', 0, 36, 0),
      num('mix', 0, 1, 1),
    ],
    web: 'worklet-compressor',
  },
  {
    id: 'limiter',
    params: [num('limit', -24, 0, -1), num('attack', 0.1, 80, 5), num('release', 1, 8000, 50, { log: true }), num('level_out', -24, 24, 0)],
    web: 'worklet-limiter',
  },
  {
    id: 'truepeak',
    params: [num('ceiling', -24, 0, -1), num('lookahead', 0.5, 10, 3), num('release', 10, 2000, 80, { log: true })],
    web: 'worklet-truepeak',
  },
  {
    id: 'gate',
    params: [
      num('threshold', -80, 0, -35),
      num('range', -80, 0, -24),
      num('ratio', 1, 20, 10),
      num('attack', 0.01, 9000, 1, { log: true }),
      num('release', 0.01, 9000, 100, { log: true }),
      num('knee', 1, 8, 2.83),
    ],
    web: 'worklet-gate',
  },
  {
    id: 'saturate',
    params: [
      { kind: 'enum', key: 'type', options: ['tanh', 'atan', 'cubic', 'exp', 'alg', 'quintic', 'sin', 'erf', 'hard'], default: 'tanh' },
      num('threshold', -40, 0, -6),
      num('output', -24, 24, 0, { auto: true }),
      num('oversample', 1, 8, 4),
    ],
    web: 'waveshaper',
  },
  { id: 'bitcrush', params: [num('bits', 1, 32, 8), num('samples', 1, 250, 1), num('mix', 0, 1, 1)], web: 'worklet-bitcrush' },
  { id: 'pitchshift', params: [num('semitones', -12, 12, 0), num('mix', 0, 1, 1)], web: 'worklet-pitchshift' },
  {
    id: 'delay',
    params: [num('time', 1, 5000, 250, { log: true, auto: true }), num('feedback', 0.01, 0.95, 0.35, { auto: true }), num('mix', 0, 1, 0.4, { auto: true })],
    web: 'delay-feedback',
  },
  {
    id: 'chorus',
    params: [
      num('delay', 1, 100, 7, { auto: true }),
      num('depth', 0, 10, 2, { auto: true }),
      num('speed', 0.01, 10, 1, { auto: true }),
      num('mix', 0, 1, 0.5, { auto: true }),
    ],
    web: 'chorus-lfo',
  },
  {
    id: 'phaser',
    params: [
      num('in_gain', 0, 1, 0.4, { auto: true }),
      num('out_gain', 0, 2, 0.74, { auto: true }),
      num('delay', 0.1, 5, 3),
      num('decay', 0, 0.99, 0.4),
      num('speed', 0.1, 2, 0.5, { auto: true }),
      { kind: 'enum', key: 'type', options: ['0', '1'], default: '0' },
    ],
    web: 'allpass-phaser',
  },
  {
    id: 'reverb',
    params: [num('size', 0.05, 1, 0.7), num('damping', 0, 1, 0.5), num('wet', 0, 1, 0.35, { auto: true }), num('dry', 0, 1, 0.7, { auto: true })],
    web: 'convolver',
  },
];

const BY_ID = new Map(FX_DEFS.map((d) => [d.id, d]));

export function fxDef(id: string): FxDef | undefined {
  return BY_ID.get(id);
}

/**
 * A parameter set made renderable: unknown keys dropped, missing or non-numeric ones at their default, numbers clamped,
 * an unknown enum value at its default (audioFx.ts: normalizeAudioFxParams).
 */
export function normalizeFxParams(id: string, values: Readonly<FxParamValues> | undefined): FxParamValues {
  const def = BY_ID.get(id);
  if (!def) return {};
  const out: FxParamValues = {};
  for (const p of def.params) {
    const raw = values?.[p.key];
    if (p.kind === 'enum') {
      out[p.key] = typeof raw === 'string' && p.options.includes(raw) ? raw : p.default;
      continue;
    }
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
    out[p.key] = Number.isFinite(n) ? Math.min(p.max, Math.max(p.min, n)) : p.default;
  }
  return out;
}

export interface FxNode {
  type: string;
  id?: string;
  /** The preset that wrote the node: consecutive nodes of one preset share a wet/dry blend. */
  fromPreset?: string;
  /** How much of the node's preset is applied, 0..1 (read off the first node of a run). */
  presetAmount?: number;
  enabled: boolean;
  params: FxParamValues;
}

export interface FxChain {
  nodes: FxNode[];
}

export class FxChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FxChainError';
  }
}

/** A `data-fx-chain` value. Throws on what HyperFrames' reader refuses: bad JSON, a version other than 1, an unknown effect. */
export function parseFxChain(json: string): FxChain {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new FxChainError(`the chain is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) throw new FxChainError('the chain must be a JSON object');
  const obj = raw as { version?: unknown; nodes?: unknown };
  if (obj.version !== 1) throw new FxChainError(`unsupported chain version: ${String(obj.version)}`);
  if (!Array.isArray(obj.nodes)) throw new FxChainError('the chain has no `nodes` array');
  const nodes = obj.nodes.map((n: unknown, i: number): FxNode => {
    if (typeof n !== 'object' || n === null) throw new FxChainError(`node ${i} is not an object`);
    const node = n as Record<string, unknown>;
    if (typeof node.type !== 'string' || !BY_ID.has(node.type)) throw new FxChainError(`node ${i} has an unknown effect type: ${String(node.type)}`);
    const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
    const amount = typeof node.presetAmount === 'number' && Number.isFinite(node.presetAmount) ? Math.min(1, Math.max(0, node.presetAmount)) : undefined;
    const id = text(node.id);
    const fromPreset = text(node.fromPreset);
    return {
      type: node.type,
      ...(id ? { id } : {}),
      ...(fromPreset ? { fromPreset } : {}),
      ...(amount !== undefined ? { presetAmount: amount } : {}),
      enabled: node.enabled !== false,
      params: normalizeFxParams(node.type, (node.params ?? undefined) as FxParamValues | undefined),
    };
  });
  return { nodes };
}

/** The nodes in the signal path, in order. */
export function enabledNodes(chain: FxChain): FxNode[] {
  return chain.nodes.filter((n) => n.enabled);
}
