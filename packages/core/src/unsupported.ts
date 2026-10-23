// What a component of this package cannot draw (kinetograph site, /docs/compat/). A DOM element's unsupported items come from the
// painter in the addon; a component that draws through a canvas (`<RemotionRiveCanvas>`, `<SkiaCanvas>`) has no
// painter to ask, so it reports what it knows it left out while it renders, and the frame loop adds the report to the
// frame's. A report is read right after the frame's tree is settled and forgotten when the next render starts, so it
// holds what the last render of the frame reported, each item once.
//
// The error an exported-but-unsupported API of a Remotion package throws. The packages that need a browser's media
// stack (`@remotion/webcodecs`, `@remotion/media-parser`'s readers, `@remotion/timeline-utils`' frame decoding,
// `@remotion/canvas`) export every name Remotion's does, so a project bundles; a call that needs what a render does
// not have fails with this, saying which call and why, rather than doing something else.

import type { Unsupported } from '@kinetographdev/scene';

const reported = new Map<string, Unsupported>();

/** Records that `component` leaves out `property` (null: the whole component) for `reason`. */
export function reportUnsupported(component: string, property: string | null, value: string | null, reason: string): void {
  const item: Unsupported = { path: `<${component}>`, element: component, property, value, reason };
  reported.set(JSON.stringify(item), item);
}

/** Forgets what was reported (the frame loop does, before each render). */
export function clearReportedUnsupported(): void {
  reported.clear();
}

/** What has been reported since the last `clearReportedUnsupported`. */
export function reportedUnsupported(): Unsupported[] {
  return [...reported.values()];
}

export class UnsupportedApiError extends Error {
  constructor(
    readonly pkg: string,
    readonly api: string,
    reason: string,
  ) {
    super(`${pkg}: ${api} is not supported by Kinetograph, ${reason}`);
    this.name = 'UnsupportedApiError';
  }
}
