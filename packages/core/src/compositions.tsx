// Compositions (docs/AUTHORING.md §7.2): `registerRoot`, `<Composition>`,
// `<Still>`, `<Folder>`, `getInputProps`, `getCompositions` and
// `calculateMetadata`. A project registers a Root component; the compositions
// are found by rendering that Root once (nothing is drawn), as Remotion's Studio
// does, so a Root can compute its list.

import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import { createSceneRoot, type VideoConfig } from '@kinetograph/react';

export interface CompositionInfo {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  defaultProps: Record<string, unknown>;
}

type Metadata<P> = Partial<Omit<CompositionInfo, 'id'> & { props: P; margin: number }>;

export interface CompositionProps<P extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  component?: ComponentType<P>;
  lazyComponent?: () => Promise<{ default: ComponentType<P> }>;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  defaultProps?: P;
  /**
   * The least margin, in pixels, the engine renders every frame with (SCENE.md "Canvas margin"). Set it to the
   * largest reach of any frame's effects and the textures are built once; a frame that reaches further still gets
   * the room it needs. A whole number, not negative. Default: none, each frame's margin is what its effects reach.
   * `calculateMetadata` may return a `margin` too, which wins over this prop.
   */
  margin?: number;
  /**
   * The scene's background colour (SCENE.md `background`), the same in every frame. Unlike a full-size rect at the
   * bottom, it also fills the margin, which `backdropBlur` at the canvas edge reads. Default: transparent.
   */
  background?: string;
  calculateMetadata?: (options: {
    defaultProps: P;
    props: P;
    abortSignal?: AbortSignal;
    compositionId?: string;
    isRendering?: boolean;
  }) => Metadata<P> | Promise<Metadata<P>>;
  schema?: unknown;
}

export type StillProps<P extends Record<string, unknown> = Record<string, unknown>> = Omit<
  CompositionProps<P>,
  'durationInFrames' | 'fps'
> & { fps?: number };

/** A registered composition, with what is needed to render it. */
export interface CompositionEntry extends CompositionInfo {
  margin?: number;
  background?: string;
  component?: ComponentType<any>;
  lazyComponent?: () => Promise<{ default: ComponentType<any> }>;
  calculateMetadata?: CompositionProps<any>['calculateMetadata'];
  folder: string[];
}

interface Collector {
  entries: CompositionEntry[];
}

const DiscoveryContext = createContext<Collector | null>(null);
const FolderContext = createContext<string[]>([]);

// ---- validation, with Remotion's rules ----

function checkId(id: unknown): string {
  if (typeof id !== 'string' || id === '') {
    throw new TypeError('A <Composition> needs an "id" prop: a non-empty string');
  }
  if (!/^[a-zA-Z0-9\-　-鿿가-힯]+$/.test(id)) {
    throw new Error(
      `Composition id can only contain a-z, A-Z, 0-9, CJK characters and -. You passed ${JSON.stringify(id)}`,
    );
  }
  return id;
}

function checkPositiveInteger(id: string, name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new TypeError(`The "${name}" of composition "${id}" must be a positive integer, but got ${JSON.stringify(value)}`);
  }
  return value;
}

function checkMargin(id: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`The "margin" of composition "${id}" must be a whole number of pixels, not negative, but got ${JSON.stringify(value)}`);
  }
  return value;
}

function checkBackground(id: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`The "background" of composition "${id}" must be a colour string, but got ${JSON.stringify(value)}`);
  }
  return value;
}

function checkFps(id: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`The "fps" of composition "${id}" must be a positive number, but got ${JSON.stringify(value)}`);
  }
  return value;
}

function entryFrom(props: CompositionProps<any>, folder: string[], isStill: boolean): CompositionEntry {
  const id = checkId(props.id);
  if (!props.component && !props.lazyComponent) {
    throw new TypeError(`Composition "${id}" needs a "component" or a "lazyComponent" prop`);
  }
  return {
    id,
    width: checkPositiveInteger(id, 'width', props.width),
    height: checkPositiveInteger(id, 'height', props.height),
    fps: checkFps(id, isStill ? (props.fps ?? 30) : props.fps),
    durationInFrames: isStill ? 1 : checkPositiveInteger(id, 'durationInFrames', props.durationInFrames),
    defaultProps: (props.defaultProps as Record<string, unknown> | undefined) ?? {},
    margin: props.margin === undefined ? undefined : checkMargin(id, props.margin),
    background: props.background === undefined ? undefined : checkBackground(id, props.background),
    component: props.component,
    lazyComponent: props.lazyComponent,
    calculateMetadata: props.calculateMetadata,
    folder,
  };
}

function collect(props: CompositionProps<any>, isStill: boolean, collector: Collector | null, folder: string[]): void {
  if (collector === null) return;
  const entry = entryFrom(props, folder, isStill);
  if (collector.entries.some((existing) => existing.id === entry.id)) {
    throw new Error(`Multiple composition with id "${entry.id}" exist. Composition ids must be unique.`);
  }
  collector.entries.push(entry);
}

/** Declares a composition. It draws nothing; rendering the Root is how compositions are found. */
export function Composition<P extends Record<string, unknown>>(props: CompositionProps<P>): ReactNode {
  collect(props, false, useContext(DiscoveryContext), useContext(FolderContext));
  return null;
}

/** A one-frame composition. */
export function Still<P extends Record<string, unknown>>(props: StillProps<P>): ReactNode {
  collect(props as CompositionProps<any>, true, useContext(DiscoveryContext), useContext(FolderContext));
  return null;
}

/** Groups compositions in a UI; here it only passes its children through. */
export function Folder({ name, children }: { name: string; children?: ReactNode }): ReactNode {
  const parent = useContext(FolderContext);
  return <FolderContext.Provider value={[...parent, name]}>{children}</FolderContext.Provider>;
}

// ---- the root ----

let root: ComponentType | null = null;
let discovered: CompositionEntry[] | null = null;

export function registerRoot(component: ComponentType): void {
  if (typeof component !== 'function' && typeof component !== 'object') {
    throw new TypeError('registerRoot() takes a React component');
  }
  root = component;
  discovered = null;
}

function discover(): CompositionEntry[] {
  if (discovered !== null) return discovered;
  if (root === null) {
    throw new Error('No root is registered: call registerRoot(Root) in the project entry before asking for compositions');
  }
  const Root = root;
  const collector: Collector = { entries: [] };
  // Only the compositions are wanted: whatever DOM the Root renders is not drawn.
  const scene = createSceneRoot({ ignoreDom: true });
  try {
    scene.render(
      <DiscoveryContext.Provider value={collector}>
        <Root />
      </DiscoveryContext.Provider>,
    );
  } finally {
    scene.unmount();
  }
  discovered = collector.entries;
  return discovered;
}

/** The compositions of the registered Root, with their declared (not yet `calculateMetadata`-adjusted) settings. */
export function getCompositions(): CompositionInfo[] {
  return discover().map(({ id, width, height, fps, durationInFrames, defaultProps }) => ({
    id,
    width,
    height,
    fps,
    durationInFrames,
    defaultProps,
  }));
}

export function getCompositionEntry(id: string): CompositionEntry {
  const found = discover().find((entry) => entry.id === id);
  if (!found) {
    const ids = discover().map((entry) => `"${entry.id}"`);
    throw new Error(
      `No composition with the id "${id}". ${ids.length > 0 ? `Available: ${ids.join(', ')}` : 'The Root declares no compositions'}`,
    );
  }
  return found;
}

// ---- input props ----

let inputProps: Record<string, unknown> = {};

/** The props the render was started with (`--props` on the CLI); `{}` when there are none. */
export function getInputProps(): Record<string, unknown> {
  return inputProps;
}

/** Sets what `getInputProps()` returns. The CLI calls it before the project is imported. */
export function setInputProps(props: Record<string, unknown>): void {
  inputProps = props;
}

// ---- resolving one composition for rendering ----

export interface ResolvedComposition {
  config: VideoConfig;
  component: ComponentType<any>;
  /** The `margin` from `calculateMetadata`, else the `margin` prop, if either is set. */
  margin?: number;
  /** The `background` prop, if the composition has one. */
  background?: string;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

function applyMetadata(entry: CompositionEntry, props: Record<string, unknown>, result: Metadata<any>): VideoConfig {
  return {
    id: entry.id,
    width: result.width === undefined ? entry.width : checkPositiveInteger(entry.id, 'width', result.width),
    height: result.height === undefined ? entry.height : checkPositiveInteger(entry.id, 'height', result.height),
    fps: result.fps === undefined ? entry.fps : checkFps(entry.id, result.fps),
    durationInFrames:
      result.durationInFrames === undefined
        ? entry.durationInFrames
        : checkPositiveInteger(entry.id, 'durationInFrames', result.durationInFrames),
    defaultProps: entry.defaultProps,
    props: (result.props as Record<string, unknown> | undefined) ?? props,
  };
}

/**
 * The composition's config and component. `calculateMetadata` may be
 * asynchronous, so the answer is a promise unless nothing asynchronous is
 * involved, in which case `sync` has it already.
 */
export function resolveComposition(
  id: string,
  options: { inputProps?: Record<string, unknown> } = {},
): { sync: ResolvedComposition | null; ready: Promise<ResolvedComposition> } {
  const entry = getCompositionEntry(id);
  const props = { ...entry.defaultProps, ...(options.inputProps ?? inputProps) };

  const finish = (result: Metadata<any>, component: ComponentType<any>): ResolvedComposition => ({
    config: applyMetadata(entry, props, result),
    component,
    margin: result.margin === undefined ? entry.margin : checkMargin(entry.id, result.margin),
    background: entry.background,
  });
  const metadata = entry.calculateMetadata
    ? entry.calculateMetadata({
        defaultProps: entry.defaultProps,
        props,
        abortSignal: new AbortController().signal,
        compositionId: entry.id,
        isRendering: true,
      })
    : {};

  const componentOf = (): ComponentType<any> | Promise<ComponentType<any>> =>
    entry.component ?? entry.lazyComponent!().then((module) => module.default);

  if (!isThenable(metadata) && entry.component) {
    const resolved = finish(metadata, entry.component);
    return { sync: resolved, ready: Promise.resolve(resolved) };
  }
  const ready = (async () => {
    const result = await metadata;
    return finish(result, await componentOf());
  })();
  return { sync: null, ready };
}

/** Forgets the Root and its compositions (tests). */
export function resetCompositions(): void {
  root = null;
  discovered = null;
  inputProps = {};
}
