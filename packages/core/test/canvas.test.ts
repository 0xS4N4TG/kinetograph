import { describe, expect, it } from 'vitest';
import * as canvas from '../src/canvas.js';
import { UnsupportedApiError } from '../src/unsupported.js';

// The names `@remotion/canvas@4.0.532` exports at run time (its `dist/index.d.ts`).
const PUBLISHED = [
  'Canvas',
  'CanvasInternals',
  'canvasKeyframeEasingPresets',
  'createCanvasController',
  'createCanvasHoverController',
  'createCanvasSelectionController',
  'getCanvasKeyframeChangeOverride',
  'getCanvasKeyframeDisplayFrame',
  'getCanvasKeyframeEasingChange',
  'getCanvasKeyframeEasingSegments',
  'getCanvasKeyframes',
  'getCanvasKeyframeSettings',
  'getCanvasKeyframeSettingsChange',
  'getCanvasKeyframeSourceFrame',
  'getCanvasKeyframeToggle',
  'getCanvasPropValueAtFrame',
  'getCanvasSelectionItemKey',
  'getCanvasSequenceNodePathInfo',
  'getCanvasSequenceSourceLocation',
  'startCanvasKeyframeDrag',
  'useCanvasController',
  'useCanvasHover',
  'useCanvasSelection',
  'useCanvasSequenceHover',
];

describe('@remotion/canvas', () => {
  it('exports every name the published package does', () => {
    for (const name of PUBLISHED) expect(canvas, name).toHaveProperty(name);
  });

  it('throws UnsupportedApiError naming the call from the editor-only functions', () => {
    expect(() => canvas.createCanvasController()).toThrow(UnsupportedApiError);
    expect(() => canvas.useCanvasHover()).toThrow('useCanvasHover() is not supported by Kinetograph');
    expect(() => canvas.Canvas({ controller: {} })).toThrow('<Canvas>');
    expect(() => canvas.CanvasInternals.anything()).toThrow('CanvasInternals.anything()');
  });

  it('has an empty list of easing presets', () => {
    expect(canvas.canvasKeyframeEasingPresets).toEqual([]);
  });
});
