// `@kinetograph/compat/browser` (docs/COMPAT.md §6.2): the native elements as
// React DOM components, for the Chrome bundle, where `@kinetograph/react` is
// aliased here; and `installBrowserRuntime`, which sets up
// `window.__kinetograph`. Stream 3 fills this in and exports the same element
// names as `@kinetograph/react`.

export function installBrowserRuntime(): void {
  throw new Error('not implemented: installBrowserRuntime (docs/COMPAT.md §6.2)');
}
