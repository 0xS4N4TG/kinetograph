import { describe, expect, it } from 'vitest';
import type { GlyphRun, ImagePaint, SceneJson, Transform } from '../src/index.js';

// The fields the DOM painter writes (docs/SCENE.md, "Boxes from the DOM painter"). `tsc` checks that they type; the
// round trip checks that they are plain JSON.
describe('the fields of the DOM painter', () => {
  it('type glyph runs, a matrix transform, image paints, gradient matrices and the blend space', () => {
    const run: GlyphRun = {
      src: '/fonts/Inter.ttf',
      index: 0,
      size: 28,
      coords: [],
      skew: 14,
      embolden: 0.5,
      glyphs: [
        [121, 0, 18],
        [133, 10.06, 18],
      ],
    };
    const tile: ImagePaint = { type: 'image', src: 'tex.png', x: 0, y: 0, width: 64, height: 64, repeatX: true, repeatY: true };
    const transform: Transform = {
      x: 100,
      y: 50,
      anchorX: 20,
      anchorY: 10,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      backfaceHidden: true,
    };
    const scene = {
      width: 400,
      height: 300,
      fps: 30,
      durationInFrames: 1,
      blendSpace: 'srgb',
      layers: [
        { id: 'bg', type: 'shape', shape: { kind: 'rect', width: 300, height: 200 }, fill: tile },
        {
          id: 'glow',
          type: 'shape',
          shape: { kind: 'rect', width: 100, height: 50 },
          fill: { type: 'radial', cx: 50, cy: 25, r: 50, transform: [1, 0, 0, 0.5, 0, 12.5], stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] },
        },
        { id: 'words', type: 'text', text: '', font: '', size: 1, color: tile, runs: [run], boxWidth: 176.4, boxHeight: 21, transform },
      ],
    } satisfies SceneJson;
    expect(JSON.parse(JSON.stringify(scene))).toEqual(scene);
  });

  it('rejects a malformed image paint at compile time', () => {
    const bad: SceneJson[] = [
      // @ts-expect-error an image paint needs its size
      { width: 1, height: 1, fps: 30, durationInFrames: 1, layers: [{ id: 'x', type: 'shape', shape: { kind: 'rect', width: 1, height: 1 }, fill: { type: 'image', src: 'a.png' } }] },
    ];
    expect(bad).toHaveLength(1);
  });
});
