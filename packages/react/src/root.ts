// The react-reconciler host config and `createSceneRoot` (docs/AUTHORING.md
// §6.1). The host tree is plain data: elements keep their props, and `emit`
// reads them out as scene JSON when a tree is asked for. Mutation mode, one
// synchronous render per call, every update at the highest priority so that
// nothing is ever left waiting for a scheduler tick.

import { createContext, type ReactNode } from 'react';
import Reconciler from 'react-reconciler';
import { ConcurrentRoot, DiscreteEventPriority, NoEventPriority } from 'react-reconciler/constants.js';
import { isDomElement } from '@kinetograph/compat/dom';
import {
  deliverObservations,
  domElementFor,
  hasObservers,
  MAX_OBSERVER_DEPTH,
  registerReadbackRoot,
  setWebViewport,
  unregisterReadbackRoot,
} from '@kinetograph/compat/shim';
import { ELEMENT_NAMES, emit, type EmitOptions, type HostElement, type HostNode, type HostText, type RenderedTree } from './emit.js';
import { createReadback, hostMeta, MAX_MEASURE_PASSES, measureLoopError, type Container } from './readback.js';

export type { EmitOptions, RenderedTree } from './emit.js';

export interface SceneRoot {
  /** Renders `element` synchronously (effects flushed) and returns the emitted tree. */
  render(element: ReactNode): RenderedTree;
  /** The tree as it is now, after state updates since the last render. */
  snapshot(): RenderedTree;
  unmount(): void;
}

/** What a child learns about its place: the type of the nearest host parent, or `root`. */
type HostContext = string;
const ROOT_CONTEXT: HostContext = 'root';

/** Elements that take children: `<Layer>` takes elements, `<Text>` takes text. */
function describeParent(type: string): string {
  return type === ROOT_CONTEXT ? 'the root of the tree' : `<${ELEMENT_NAMES[type] ?? type}>`;
}

function checkChild(parentType: string, child: HostNode): void {
  if (parentType === 'kg-text') {
    if (child.kind !== 'text') {
      throw new Error(`<${ELEMENT_NAMES[child.type] ?? child.type}> cannot be inside <Text>: <Text> takes only strings and numbers`);
    }
    return;
  }
  // A DOM element takes text and elements (DOM or native) as children (docs/COMPAT.md §4.1).
  if (isDomElement(parentType)) return;
  if (child.kind === 'text') {
    throw new Error(`Raw text "${child.text}" is not allowed inside ${describeParent(parentType)}; wrap it in <Text>`);
  }
  if (parentType !== 'kg-layer' && parentType !== ROOT_CONTEXT) {
    throw new Error(`<${ELEMENT_NAMES[parentType] ?? parentType}> cannot have children; only <Layer> does`);
  }
}

let updatePriority: number = NoEventPriority;

const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: false,
  warnsIfNotActing: false,
  supportsMicrotasks: true,
  scheduleMicrotask: (fn: () => void) => queueMicrotask(fn),
  scheduleTimeout: (fn: () => void, delay?: number) => setTimeout(fn, delay),
  cancelTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  noTimeout: -1,
  rendererVersion: '0.1.0',
  rendererPackageName: '@kinetograph/react',
  extraDevToolsConfig: null,
  bindToConsole: (method: 'log' | 'warn' | 'error', args: unknown[]) => console[method].bind(console, ...args),

  // ---- creating the tree ----

  getRootHostContext: (): HostContext => ROOT_CONTEXT,
  // A `kg-sequence` is transparent: what is inside it answers to the element it stands in.
  getChildHostContext: (parent: HostContext, type: string): HostContext => (type === 'kg-sequence' ? parent : type),
  createInstance(type: string, props: Record<string, any>, _root: Container, hostContext: HostContext): HostElement {
    if (!(type in ELEMENT_NAMES) && !isDomElement(type)) {
      throw new Error(`Unknown element <${type}>: only the Kinetograph elements (Layer, Rect, Text, ...) and DOM elements (div, span, svg, ...) can be rendered`);
    }
    const element: HostElement = { kind: 'element', type, props, children: [] };
    hostMeta.set(element, { parent: null, container: _root });
    // A <Text> child that is an element is caught here, before it is attached, so the error names the element.
    checkChild(hostContext, element);
    return element;
  },
  createTextInstance(text: string, _root: Container, hostContext: HostContext): HostText {
    const node: HostText = { kind: 'text', text };
    hostMeta.set(node, { parent: null, container: _root });
    checkChild(hostContext, node);
    return node;
  },
  appendInitialChild: (parent: HostElement, child: HostNode) => {
    adopt(parent, child);
    parent.children.push(child);
  },
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  // A ref to a DOM element is an object that answers like one for measurement (docs/ENGINE.md §1, "Readback").
  getPublicInstance: (instance: HostNode) => {
    if (instance.kind !== 'element' || !isDomElement(instance.type)) return instance;
    const container = hostMeta.get(instance)?.container;
    return container?.readback ? domElementFor(instance, container.readback) : instance;
  },
  prepareForCommit: () => null,
  // The tree has changed: readback caches are stale. Layout effects run after this, so they measure the new tree.
  resetAfterCommit: (container: Container) => {
    container.generation++;
  },
  preparePortalMount: () => {},
  detachDeletedInstance: () => {},

  // ---- mutation ----

  // React moves a child to the end by appending it again, as the DOM does.
  appendChild(parent: HostElement, child: HostNode) {
    removeFrom(parent.children, child);
    adopt(parent, child);
    parent.children.push(child);
  },
  appendChildToContainer(container: Container, child: HostNode) {
    removeFrom(container.children, child);
    adopt(null, child);
    container.children.push(child);
  },
  insertBefore(parent: HostElement, child: HostNode, before: HostNode) {
    adopt(parent, child);
    insertInto(parent.children, child, before);
  },
  insertInContainerBefore(container: Container, child: HostNode, before: HostNode) {
    adopt(null, child);
    insertInto(container.children, child, before);
  },
  removeChild(parent: HostElement, child: HostNode) {
    removeFrom(parent.children, child);
    adopt(null, child);
  },
  removeChildFromContainer(container: Container, child: HostNode) {
    removeFrom(container.children, child);
  },
  clearContainer(container: Container) {
    container.children = [];
  },
  commitUpdate(instance: HostElement, _type: string, _prev: unknown, next: Record<string, any>) {
    instance.props = next;
  },
  commitTextUpdate(node: HostText, _old: string, text: string) {
    node.text = text;
  },
  resetTextContent: () => {},
  hideInstance: () => {},
  hideTextInstance: () => {},
  unhideInstance: () => {},
  unhideTextInstance: () => {},

  // ---- scheduling: everything is synchronous, so everything is the highest priority ----

  setCurrentUpdatePriority(priority: number) {
    updatePriority = priority;
  },
  getCurrentUpdatePriority: () => updatePriority,
  // Every update is a sync-lane one, even those made inside passive effects (which React runs at default priority),
  // so `flushSyncWork` is enough to settle a tree.
  resolveUpdatePriority: () => DiscreteEventPriority,
  shouldAttemptEagerTransition: () => false,
  requestPostPaintCallback: () => {},
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  resetFormInstance: () => {},
  NotPendingTransition: null,
  HostTransitionContext: createContext<unknown>(null),

  // ---- nothing here loads or suspends a commit ----

  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => null,
  suspendInstance: () => {},
  suspendOnActiveViewTransition: () => {},
  waitForCommitToBeReady: () => null,
  getSuspendedCommitReason: () => null,

  // ---- inert: no DOM events, focus or scopes ----

  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,
};

/** Records where a node hangs (for readback: parents, paths, connectedness). */
function adopt(parent: HostElement | null, child: HostNode): void {
  const meta = hostMeta.get(child);
  if (meta) meta.parent = parent;
}

function insertInto(list: HostNode[], child: HostNode, before: HostNode): void {
  // React moves an existing child by inserting it again.
  removeFrom(list, child);
  const at = list.indexOf(before);
  if (at === -1) list.push(child);
  else list.splice(at, 0, child);
}

function removeFrom(list: HostNode[], child: HostNode): void {
  const at = list.indexOf(child);
  if (at !== -1) list.splice(at, 1);
}

// The generated types ask for twenty type parameters; this renderer uses few of them.
const reconciler = (Reconciler as unknown as (config: object) => Reconciler.Reconciler<Container, HostElement, HostText, never, never, HostNode>)(
  hostConfig,
);

/** Passes that flush effects and the updates they cause; more than this means an effect keeps updating state. */
const MAX_SETTLE_PASSES = 100;


/**
 * A root that renders into a host tree and emits it as scene JSON. One per composition, kept across frames like a
 * Remotion tab keeps its page, so state, refs and effects live across `render` calls and a `delayRender` that
 * resolves later can update the tree seen by `snapshot`.
 */
export function createSceneRoot(options: EmitOptions = {}): SceneRoot {
  const container: Container = { children: [], generation: 0, readback: null, measuredGenerations: new Set() };
  container.readback = createReadback(container, options);
  registerReadbackRoot(container.readback);
  // `window.innerWidth`, `matchMedia` and `document.documentElement` report the composition's size.
  if (options.viewport) setWebViewport(options.viewport);
  let error: { value: unknown } | undefined;
  const remember = (value: unknown): void => {
    // The first error is the cause; later ones are usually its fallout.
    error ??= { value };
  };
  const root = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    'kg',
    remember,
    remember,
    remember,
    () => {},
    null,
  );
  let unmounted = false;

  function settle(): void {
    container.measuredGenerations.clear();
    let observerRounds = 0;
    for (let pass = 0; ; pass += 1) {
      if (pass >= MAX_SETTLE_PASSES) {
        throw new Error('The tree did not settle: an effect keeps updating state on every render');
      }
      if (pass >= MAX_MEASURE_PASSES && container.measuredGenerations.size > 0) throw measureLoopError();
      // Both calls run, so a sync render and the effects it left are handled together.
      const rendered = reconciler.flushSyncWork();
      const effects = reconciler.flushPassiveEffects();
      if (rendered || effects) continue;
      // Layout is settled: tell the observers what changed (a callback may set state, which renders again).
      if (hasObservers() && observerRounds < MAX_OBSERVER_DEPTH && deliverObservations()) {
        observerRounds += 1;
        continue;
      }
      break;
    }
    if (error !== undefined) {
      const { value } = error;
      error = undefined;
      throw value;
    }
  }

  function tree(): RenderedTree {
    return emit(container.children, options);
  }

  return {
    render(element) {
      if (unmounted) throw new Error('This SceneRoot is unmounted');
      reconciler.updateContainerSync(element, root, null, null);
      settle();
      return tree();
    },
    snapshot() {
      if (unmounted) throw new Error('This SceneRoot is unmounted');
      settle();
      return tree();
    },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      reconciler.updateContainerSync(null, root, null, null);
      try {
        settle();
      } finally {
        container.children = [];
        unregisterReadbackRoot(container.readback!);
      }
    },
  };
}
