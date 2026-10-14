// Small helpers shared by the scene package.

/** A copy of `fields` without the keys whose value is `undefined`, so emitted JSON has no holes and snapshots stay
 *  readable. */
export function compact<T extends object>(fields: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/** Whether `value` is a plain object, as opposed to a number or a keyframe list. */
export function isFields(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
