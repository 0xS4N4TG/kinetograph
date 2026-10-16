// What a component of this package cannot draw (docs/COMPAT.md §6.1). A DOM element's unsupported items come from the
// painter in the addon; a component that draws through a canvas (`<RemotionRiveCanvas>`, `<SkiaCanvas>`) has no
// painter to ask, so it reports what it knows it left out while it renders, and the frame loop adds the report to the
// frame's. A report is read right after the frame's tree is settled and forgotten when the next render starts, so it
// holds what the last render of the frame reported, each item once.

import type { Unsupported } from '@kinetograph/scene';

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
