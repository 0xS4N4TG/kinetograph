// `@kinetographdev/compat/shim`: the DOM a React ref and a project's browser globals see in compat mode (packages/cli/skills/kinetograph/references/ENGINE.md
// §1 "Readback", §10). The reconciler implements `Readback`; core installs the globals.

export { DOMRectShim, DomElement, DomText, domElementFor, domNodeFor, hostOf, isDomElementShim, computedStyleOf, selectorContextOf, affineOf } from './element.js';
export type { CSSStyleDeclarationShim } from './element.js';
export type { BoxInfo, HostElement, Overlay, Readback, Rect } from './host.js';
export { overlayOf, propsWithOverlay, rawParentOf, setRawParent, effectiveParentOf, headHost, bodyHost } from './host.js';
export { recordMutation, isRecordingMutations, setMutationSink } from './tree.js';
export type { HostMutation } from './tree.js';
export { RangeShim } from './range.js';
export {
  deliverObservations,
  hasObservers,
  MAX_OBSERVER_DEPTH,
  registerReadbackRoot,
  unregisterReadbackRoot,
  resetObservers,
  ResizeObserverShim,
  IntersectionObserverShim,
  MutationObserverShim,
} from './observers.js';
export { deliverMediaEvents } from './media-events.js';
export { installDomGlobals, setWebViewport, evaluateMedia, realFetch, remoteMessage, projectFileOf } from './web.js';
export { setPathMeasure } from './geometry.js';
export { canvasEnvironment, canvasCommandsOf, withCanvasCommands, resetCanvasStates, setCanvasFonts, CanvasSurface } from './canvas.js';
export type { PathMeasure } from './geometry.js';
export { imageSizeOfBytes } from './image-size.js';
export { matches, queryAll, parseSelectorList } from './selector.js';
