// One console warning per kind of thing, for the Remotion props and components that Kinetograph accepts so a project
// bundles and renders but cannot honour (a Studio-only control, an effect that needs a browser's canvas). The CLI shows
// stderr as is; the render goes on without the item, as it does for unsupported DOM content (kinetograph site, /docs/compat/).

const warned = new Set<string>();

/** Prints `message` the first time `key` is seen. */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** Forgets what was warned about (for tests). */
export function resetWarnings(): void {
  warned.clear();
}
