// Renders the children of a Skia `<Canvas>` into a tree of nodes `{ type, props, children }` for the addon, with a
// react-reconciler host of its own: RN-Skia's components are ordinary React components (hooks, context, user
// components in between), so a second React renderer runs them. The tree is built fresh for each frame and thrown
// away, so a frame is a function of the frame number. The timeline is the one context the Skia components need
// (`useCurrentFrame()`), and `Canvas` hands it in.

import type { ReactNode } from 'react';
import Reconciler from 'react-reconciler';
import { ConcurrentRoot, DiscreteEventPriority, NoEventPriority } from 'react-reconciler/constants.js';
import { normalizeProps } from './values.js';

/** What the addon draws: a node and its children. */
export interface SkiaNode {
  type: string;
  props: Record<string, unknown>;
  children: SkiaNode[];
}

interface Container {
  children: SkiaNode[];
}

let updatePriority: number = NoEventPriority;

const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  // The renderer of the composition is the non-primary one: a context it is in the middle of providing (the timeline) is
  // provided again here, in the other slot, so the two never clash.
  isPrimaryRenderer: true,
  warnsIfNotActing: false,
  supportsMicrotasks: true,
  scheduleMicrotask: (fn: () => void) => queueMicrotask(fn),
  scheduleTimeout: (fn: () => void, delay?: number) => setTimeout(fn, delay),
  cancelTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  noTimeout: -1,
  rendererVersion: '0.1.0',
  rendererPackageName: '@kinetographdev/core/skia',
  extraDevToolsConfig: null,
  bindToConsole: (method: 'log' | 'warn' | 'error', args: unknown[]) => console[method].bind(console, ...args),

  // React treats a null host context as missing, so the (unused) context is a string.
  getRootHostContext: () => 'skia',
  getChildHostContext: (parent: string) => parent,
  createInstance(type: string, props: Record<string, unknown>): SkiaNode {
    return { type, props: normalizeProps(props), children: [] };
  },
  createTextInstance(text: string): never {
    throw new Error(`Raw text "${text}" cannot be drawn inside a Skia <Canvas>; use <Text text="…" font={…} />`);
  },
  appendInitialChild: (parent: SkiaNode, child: SkiaNode) => void parent.children.push(child),
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  getPublicInstance: (instance: SkiaNode) => instance,
  prepareForCommit: () => null,
  resetAfterCommit: () => {},
  preparePortalMount: () => {},
  detachDeletedInstance: () => {},

  appendChild: (parent: SkiaNode, child: SkiaNode) => void move(parent.children, child),
  appendChildToContainer: (container: Container, child: SkiaNode) => void move(container.children, child),
  insertBefore: (parent: SkiaNode, child: SkiaNode, before: SkiaNode) => insert(parent.children, child, before),
  insertInContainerBefore: (container: Container, child: SkiaNode, before: SkiaNode) => insert(container.children, child, before),
  removeChild: (parent: SkiaNode, child: SkiaNode) => void remove(parent.children, child),
  removeChildFromContainer: (container: Container, child: SkiaNode) => void remove(container.children, child),
  clearContainer: (container: Container) => void (container.children = []),
  commitUpdate(instance: SkiaNode, _type: string, _prev: unknown, next: Record<string, unknown>) {
    instance.props = normalizeProps(next);
  },
  commitTextUpdate: () => {},
  resetTextContent: () => {},
  hideInstance: () => {},
  hideTextInstance: () => {},
  unhideInstance: () => {},
  unhideTextInstance: () => {},

  // Every update is synchronous, at the highest priority, so nothing waits for a scheduler tick.
  setCurrentUpdatePriority(priority: number) {
    updatePriority = priority;
  },
  getCurrentUpdatePriority: () => updatePriority,
  resolveUpdatePriority: () => DiscreteEventPriority,
  shouldAttemptEagerTransition: () => false,
  requestPostPaintCallback: () => {},
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  resetFormInstance: () => {},
  NotPendingTransition: null,
  HostTransitionContext: null,

  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => null,
  suspendInstance: () => {},
  suspendOnActiveViewTransition: () => {},
  waitForCommitToBeReady: () => null,
  getSuspendedCommitReason: () => null,

  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,
};

function remove(list: SkiaNode[], child: SkiaNode): void {
  const at = list.indexOf(child);
  if (at !== -1) list.splice(at, 1);
}

/** React moves a child to the end by appending it again. */
function move(list: SkiaNode[], child: SkiaNode): void {
  remove(list, child);
  list.push(child);
}

function insert(list: SkiaNode[], child: SkiaNode, before: SkiaNode): void {
  remove(list, child);
  const at = list.indexOf(before);
  if (at === -1) list.push(child);
  else list.splice(at, 0, child);
}

const reconciler = (Reconciler as unknown as (config: object) => Reconciler.Reconciler<Container, SkiaNode, never, never, never, SkiaNode>)(
  hostConfig,
);

/** Passes that flush effects and the updates they cause; more than this means an effect keeps updating state. */
const MAX_SETTLE_PASSES = 100;

/** Renders `element` once, with its effects, and returns the nodes it drew. */
export function renderNodes(element: ReactNode): SkiaNode[] {
  const container: Container = { children: [] };
  let failure: { value: unknown } | undefined;
  const remember = (value: unknown): void => {
    failure ??= { value };
  };
  const root = reconciler.createContainer(container, ConcurrentRoot, null, false, null, 'skia', remember, remember, remember, () => {}, null);
  const settle = (): void => {
    for (let pass = 0; reconciler.flushSyncWork() || reconciler.flushPassiveEffects(); pass += 1) {
      if (pass >= MAX_SETTLE_PASSES) throw new Error('The Skia canvas did not settle: an effect keeps updating state on every render');
    }
  };
  try {
    reconciler.updateContainerSync(element, root, null, null);
    settle();
    if (failure !== undefined) throw failure.value;
    // Unmounting empties the container's list; the nodes themselves stay.
    return [...container.children];
  } finally {
    reconciler.updateContainerSync(null, root, null, null);
    settle();
  }
}
