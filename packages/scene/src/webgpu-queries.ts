// Query sets of the recording WebGPU device (`webgpu.ts`). A query set is accepted, and nothing it measures is drawn or
// kept: rendering is a pure function of (project, frame), so a timestamp is never a clock and an occlusion count is never
// a count. What `resolveQuerySet` writes is zeros (`GPUCommandEncoderShim.resolveQuerySet`).

/** The most queries a set may hold. */
const MAX_QUERIES = 4096;

export interface QuerySetDescriptor {
  type: 'occlusion' | 'timestamp';
  count: number;
  label?: string;
}

export class GPUQuerySetShim {
  label: string;
  readonly type: 'occlusion' | 'timestamp';
  readonly count: number;
  destroyed = false;
  constructor(descriptor: QuerySetDescriptor, hasTimestamps: boolean) {
    const { type, count } = descriptor;
    if (type !== 'occlusion' && type !== 'timestamp') throw new TypeError(`createQuerySet: the type ${String(type)} is not occlusion or timestamp`);
    if (type === 'timestamp' && !hasTimestamps) throw new TypeError('createQuerySet: a timestamp query set needs the timestamp-query feature');
    if (!Number.isInteger(count) || count < 1 || count > MAX_QUERIES) throw new RangeError(`OperationError: createQuerySet: count ${String(count)} is not a whole number from 1 to ${MAX_QUERIES}`);
    this.label = typeof descriptor.label === 'string' ? descriptor.label : '';
    this.type = type;
    this.count = count;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

/** `index` names a query of `set`, which must be of `type`. */
export function queryIn(call: string, set: unknown, type: GPUQuerySetShim['type'], index: number): GPUQuerySetShim {
  if (!(set instanceof GPUQuerySetShim)) throw new TypeError(`${call}: the query set is not a GPUQuerySet`);
  if (set.type !== type) throw new TypeError(`${call}: the query set is of type ${set.type}, not ${type}`);
  if (set.destroyed) throw new Error(`OperationError: ${call}: the query set was destroyed`);
  if (!Number.isInteger(index) || index < 0 || index >= set.count) throw new RangeError(`OperationError: ${call}: the query index ${String(index)} is not from 0 to ${set.count - 1}`);
  return set;
}

/** A pass's `timestampWrites`: a timestamp set and the indices the pass would write (nothing is written). */
export function checkTimestampWrites(call: string, writes: unknown): void {
  if (writes === undefined || writes === null) return;
  const w = writes as { querySet?: unknown; beginningOfPassWriteIndex?: number; endOfPassWriteIndex?: number };
  const { beginningOfPassWriteIndex: begin, endOfPassWriteIndex: end } = w;
  if (begin === undefined && end === undefined) throw new TypeError(`${call}: timestampWrites names neither a beginning nor an end index`);
  for (const index of [begin, end]) if (index !== undefined) queryIn(call, w.querySet, 'timestamp', index);
  if (begin !== undefined && begin === end) throw new RangeError(`OperationError: ${call}: the beginning and the end of a pass write the same query index ${begin}`);
}

/** The occlusion queries a render pass opens and closes, as the spec says they may be. */
export class OcclusionQueries {
  private open: number | null = null;
  private readonly used = new Set<number>();
  constructor(private readonly set: GPUQuerySetShim | null) {}
  begin(index: number): void {
    if (this.set === null) throw new TypeError('beginOcclusionQuery: the pass was made without an occlusionQuerySet');
    queryIn('beginOcclusionQuery', this.set, 'occlusion', index);
    if (this.open !== null) throw new Error(`OperationError: beginOcclusionQuery: query ${this.open} is already open`);
    if (this.used.has(index)) throw new RangeError(`OperationError: beginOcclusionQuery: query ${index} was already used in this pass`);
    this.open = index;
    this.used.add(index);
  }
  end(): void {
    if (this.open === null) throw new Error('OperationError: endOcclusionQuery: no query is open (beginOcclusionQuery first)');
    this.open = null;
  }
  /** The pass ends. */
  finish(): void {
    if (this.open !== null) throw new Error(`OperationError: end: occlusion query ${this.open} is still open`);
  }
}
