// What a Chrome frame leaves out is reported once per kind, not once per frame (docs/COMPAT.md §6.2). The runtime
// hands the list to the driver, which prints it.

const seen = new Set<string>();
let pending: string[] = [];

/** Records `message` the first time `key` is seen. */
export function warnOnce(key: string, message: string): void {
  if (seen.has(key)) return;
  seen.add(key);
  pending.push(message);
}

/** The warnings recorded since the last call. */
export function takeWarnings(): string[] {
  const taken = pending;
  pending = [];
  return taken;
}

/** Forgets what was seen (for tests). */
export function resetWarnings(): void {
  seen.clear();
  pending = [];
}
