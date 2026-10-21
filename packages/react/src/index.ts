// @kinetograph/react: the react-reconciler host config that emits scene
// JSON (`createSceneRoot`), the native elements (docs/AUTHORING.md §6) and
// the timeline context every component reads time from.

export { TimelineContext, useTimeline } from './timeline.js';
export type { TimelineState, VideoConfig } from './timeline.js';

export { createSceneRoot } from './root.js';
export { finishIslands } from './emit.js';
export type { RenderedTree, SceneRoot } from './root.js';

export * from './elements.js';
