// `@remotion/canvas` (packages/cli/skills/kinetograph/references/AUTHORING.md §7.5). Despite the name this is not a drawing API: it is the interactive canvas of
// Remotion Studio's editor, "experimental primitives for building Remotion authoring interfaces": a `<Canvas>` that
// wraps `@remotion/player` and lets a person hover, select and drag the outlines of sequences, plus the controllers,
// keyframe and easing editing and snapping logic behind it. Everything in it is made of DOM pointer events, React DOM,
// the Player, and the sequence registry and fast-refresh hooks of Remotion Studio; it is never part of a video.
//
// Kinetograph renders video and has none of that (no Player, no Studio registry; its own studio is a separate app,
// packages/cli/skills/kinetograph/references/AUTHORING.md §11.5). So every name the package exports is exported, so that a project which imports it bundles,
// and each one throws `UnsupportedApiError` when it is called or rendered, saying what it is. There is no Canvas 2D
// involved: for drawing, `<Canvas draw>` and `getContext('2d')` are packages/cli/skills/kinetograph/references/AUTHORING.md §6.5.
//
// The published package is at 4.0.532; there is no 4.0.536 of it.

import { UnsupportedApiError } from './unsupported.js';

const PACKAGE = '@remotion/canvas';

const because =
  'it is part of the interactive editor canvas of Remotion Studio (pointer events, the Player, the Studio sequence registry), ' +
  'which is no part of rendering a video';

/** A function that throws `UnsupportedApiError` naming itself when called. */
const editorOnly =
  (name: string): ((...args: any[]) => never) =>
  () => {
    throw new UnsupportedApiError(PACKAGE, `${name}()`, because);
  };

/** The component. Rendering it throws, as calling any of the functions does. */
export const Canvas: (props: CanvasProps) => never = editorOnly('<Canvas>');

export type CanvasProps = Record<string, unknown> & { readonly controller: CanvasController };

export const createCanvasController = editorOnly('createCanvasController');
export const useCanvasController = editorOnly('useCanvasController');
export const createCanvasHoverController = editorOnly('createCanvasHoverController');
export const useCanvasHover = editorOnly('useCanvasHover');
export const useCanvasSequenceHover = editorOnly('useCanvasSequenceHover');
export const createCanvasSelectionController = editorOnly('createCanvasSelectionController');
export const getCanvasSelectionItemKey = editorOnly('getCanvasSelectionItemKey');
export const useCanvasSelection = editorOnly('useCanvasSelection');
export const getCanvasSequenceNodePathInfo = editorOnly('getCanvasSequenceNodePathInfo');
export const getCanvasSequenceSourceLocation = editorOnly('getCanvasSequenceSourceLocation');
export const getCanvasKeyframeDisplayFrame = editorOnly('getCanvasKeyframeDisplayFrame');
export const getCanvasKeyframes = editorOnly('getCanvasKeyframes');
export const getCanvasKeyframeSourceFrame = editorOnly('getCanvasKeyframeSourceFrame');
export const getCanvasKeyframeToggle = editorOnly('getCanvasKeyframeToggle');
export const getCanvasPropValueAtFrame = editorOnly('getCanvasPropValueAtFrame');
export const getCanvasKeyframeEasingChange = editorOnly('getCanvasKeyframeEasingChange');
export const getCanvasKeyframeEasingSegments = editorOnly('getCanvasKeyframeEasingSegments');
export const getCanvasKeyframeSettings = editorOnly('getCanvasKeyframeSettings');
export const getCanvasKeyframeSettingsChange = editorOnly('getCanvasKeyframeSettingsChange');
export const getCanvasKeyframeChangeOverride = editorOnly('getCanvasKeyframeChangeOverride');
export const startCanvasKeyframeDrag = editorOnly('startCanvasKeyframeDrag');

/** The easing presets of Remotion Studio's editor: a list the editor offers, empty here. */
export const canvasKeyframeEasingPresets: readonly never[] = [];

/** The package's internals: any member is a function that throws `UnsupportedApiError`. */
export const CanvasInternals: Record<string, (...args: any[]) => never> = new Proxy(
  {} as Record<string, (...args: any[]) => never>,
  { get: (_target, name) => (typeof name === 'string' ? editorOnly(`CanvasInternals.${name}`) : undefined) },
);

// The types are the shapes the editor passes around; nothing here constructs them.
export type CanvasController = Record<string, unknown>;
export type CanvasOverridesController = Record<string, unknown>;
export type CanvasSequenceNodePathRemapping = Record<string, unknown>;
export type CanvasHover = { readonly key: string; readonly nodePathKey: string; readonly source: 'canvas' | 'timeline' };
export type CanvasHoverController = Record<string, unknown>;
export type CanvasSequenceNodePathResolver = (...args: any[]) => unknown;
export type CanvasSequenceSourceLocation = Record<string, unknown>;
export type CanvasSelectionController = Record<string, unknown>;
export type CanvasSelectionItem = { readonly type: string; readonly [key: string]: unknown };
export type CanvasSelectionInteraction = { readonly shiftKey: boolean; readonly toggleKey: boolean };
export type CanvasSelectionSnapshot = { readonly selectedItems: readonly CanvasSelectionItem[]; readonly anchor: CanvasSelectionItem | null };
export type SequenceNodePathInfo = Record<string, unknown>;
export type TimelineTrackData = Record<string, unknown>;
export type CanvasSequencePropChange = Record<string, unknown>;
export type CanvasSequencePropsChangeHandler = (...args: any[]) => unknown;
export type CanvasSequencePropStatusResolver = (...args: any[]) => unknown;
export type CanvasKeyframe = Record<string, unknown>;
export type CanvasKeyframeChange = Record<string, unknown>;
export type CanvasKeyframeClamping = Record<string, unknown>;
export type CanvasKeyframeEasing = Record<string, unknown>;
export type CanvasKeyframeOperation = Record<string, unknown>;
export type CanvasKeyframeToggle = Record<string, unknown>;
export type CanvasKeyframeTrack = Record<string, unknown>;
export type CanvasKeyframeMove = Record<string, unknown>;
export type CanvasKeyframeEasingPreset = { readonly id: string; readonly label: string; readonly easing: CanvasKeyframeEasing };
export type CanvasKeyframeEasingSegment = Record<string, unknown>;
export type CanvasKeyframeSettings = Record<string, unknown>;
export type CanvasKeyframeDragEnd = Record<string, unknown>;
export type CanvasKeyframeDragTarget = Record<string, unknown>;
