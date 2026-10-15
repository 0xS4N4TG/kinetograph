// @kinetograph/compat: Remotion compat mode (docs/COMPAT.md, docs/ENGINE.md). The DOM islands are `/dom`, the DOM
// shim for refs and browser globals `/shim`, the Chrome-side elements `/browser` and the report `/doctor`; this entry
// has the shared types and the run planner.

export type * from './types.js';
export { pathFor, planRuns } from './runs.js';
