// Reanimated's shared values, as RN-Skia takes them as props. A value lives as long as the render of one frame (every
// frame renders the tree afresh), and a derived value is worked out each time it is read, so a frame is a pure function
// of the frame number: drive values from `useCurrentFrame()`, as a Remotion project does.

import { useRef } from 'react';

const BRAND = Symbol.for('kinetograph.sharedValue');

export interface SharedValue<T = unknown> {
  value: T;
  get(): T;
  set(value: T | ((current: T) => T)): void;
  modify(modifier?: (value: T) => T, forceUpdate?: boolean): void;
  addListener(id: number, listener: (value: T) => void): void;
  removeListener(id: number): void;
}

class Value<T> implements SharedValue<T> {
  readonly [BRAND] = true;
  constructor(
    private current: T,
    private readonly derive?: () => T,
  ) {}
  get value(): T {
    return this.derive ? this.derive() : this.current;
  }
  set value(next: T) {
    if (this.derive) throw new Error('A derived value (useDerivedValue) cannot be set: it is worked out from the values it reads');
    this.current = next;
  }
  get(): T {
    return this.value;
  }
  set(next: T | ((current: T) => T)): void {
    this.value = typeof next === 'function' ? (next as (current: T) => T)(this.value) : next;
  }
  modify(modifier?: (value: T) => T): void {
    if (modifier) this.value = modifier(this.value);
  }
  addListener(): void {}
  removeListener(): void {}
  toJSON(): unknown {
    return this.value;
  }
}

/** A value that can be read and set: Reanimated's `makeMutable`. */
export function makeMutable<T>(initial: T): SharedValue<T> {
  return new Value(initial);
}

/** A value worked out by `derive` whenever it is read. */
export function makeDerived<T>(derive: () => T): SharedValue<T> {
  return new Value<T>(undefined as T, derive);
}

export function isSharedValue<T = unknown>(value: unknown): value is SharedValue<T> {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
}

/** A prop as drawn: a shared value's value, anything else as it is. */
export function unwrap(value: unknown): unknown {
  return isSharedValue(value) ? value.value : value;
}

/** A derived value kept for the render of the component, reading through the latest `derive`. */
export function useDerived<T>(derive: () => T): SharedValue<T> {
  const ref = useRef<{ derive: () => T; value: SharedValue<T> } | null>(null);
  if (ref.current === null) {
    const holder: { derive: () => T; value: SharedValue<T> | null } = { derive, value: null };
    holder.value = makeDerived<T>(() => holder.derive());
    ref.current = holder as { derive: () => T; value: SharedValue<T> };
  }
  ref.current.derive = derive;
  return ref.current.value;
}
