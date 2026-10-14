import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SceneJson } from '@kinetograph/scene';
import { LABEL_FONT_PATH, buildOnionScene, buildStripScene, draftScene, halfSize, stripLayout } from '../src/scenes.js';
import { evenFrames } from '../src/source.js';

const base: SceneJson = {
  width: 1080, height: 1920, fps: 30, durationInFrames: 90, background: '#123456',
  fonts: { 'DM Sans': 'a.ttf' },
  layers: [{ id: 'bg', type: 'shape', shape: { kind: 'rect', width: 1080, height: 1920 }, fill: '#fff' }],
};

describe('draftScene', () => {
  it('halves the canvas and wraps the layers in a group at scale 0.5', () => {
    const draft = draftScene(base);
    expect(draft.width).toBe(540);
    expect(draft.height).toBe(960);
    expect(draft.background).toBe('#123456');
    expect(draft.fonts).toEqual(base.fonts);
    expect(draft.layers).toHaveLength(1);
    expect(draft.layers[0]).toMatchObject({ type: 'group', transform: { scale: 0.5 }, children: base.layers });
  });

  it('keeps sizes even for the encoder', () => {
    expect(halfSize(1080)).toBe(540);
    expect(halfSize(1081)).toBe(540);
    expect(halfSize(1)).toBe(2);
    expect(draftScene({ ...base, width: 1001, height: 603 })).toMatchObject({ width: 500, height: 300 });
  });

  it('halves a camera centre but not its perspective, and leaves the input alone', () => {
    const withCamera: SceneJson = { ...base, camera: { perspective: 800, x: 500, y: [{ frame: 0, value: 100 }, { frame: 9, value: 200 }] } };
    const draft = draftScene(withCamera);
    expect(draft.camera).toEqual({ perspective: 800, x: 250, y: [{ frame: 0, value: 50 }, { frame: 9, value: 100 }] });
    expect(withCamera.camera!.x).toBe(500);
    expect(withCamera.layers[0]!.id).toBe('bg');
  });
});

describe('contact sheet scene', () => {
  const frames = [0, 30, 60, 89].map((frame) => ({ file: `frame-${frame}.png`, frame }));

  it('lays frames out in a grid with a label under each', () => {
    const scene = buildStripScene(frames, { width: 1080, height: 1920, fps: 30 }, 2);
    const layout = stripLayout(4, 1080, 1920, 2);
    expect(layout).toMatchObject({ cols: 2, rows: 2 });
    expect(scene.width).toBe(layout.width);
    expect(scene.height).toBe(layout.height);
    expect(scene.durationInFrames).toBe(1);
    const images = scene.layers.filter((l) => l.type === 'image');
    const labels = scene.layers.filter((l) => l.type === 'text');
    expect(images.map((l) => (l as { src: string }).src)).toEqual(frames.map((f) => f.file));
    expect(labels.map((l) => (l as { text: string }).text)).toEqual(['f0  0.00s', 'f30  1.00s', 'f60  2.00s', 'f89  2.97s']);
    // Thumbnails keep the composition's aspect ratio and sit in two columns.
    const first = images[0] as { width: number; height: number; transform: { x: number; y: number } };
    expect(first.width / first.height).toBeCloseTo(1080 / 1920, 2);
    const xs = new Set(images.map((l) => (l.transform as { x: number }).x));
    expect(xs.size).toBe(2);
    // No overlaps: a thumbnail's label is below it and above the next row.
    const label0 = labels[0]!.transform as { y: number };
    const row2 = (images[2]!.transform as { y: number }).y;
    expect(label0.y).toBeGreaterThanOrEqual(first.transform.y + first.height);
    expect(row2).toBeGreaterThan(label0.y);
  });

  it('names the bundled font, which exists, and every layer id is unique', () => {
    const scene = buildStripScene(frames, { width: 640, height: 360, fps: 24 });
    expect(scene.fonts).toEqual({ 'DM Sans': LABEL_FONT_PATH });
    expect(existsSync(LABEL_FONT_PATH)).toBe(true);
    const ids = scene.layers.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of scene.layers) if (l.type === 'text') expect(l.font).toBe('DM Sans');
  });

  it('uses fewer columns than frames when there are few', () => {
    expect(stripLayout(3, 1920, 1080).cols).toBe(3);
    expect(stripLayout(12, 1920, 1080).cols).toBe(4);
    expect(stripLayout(12, 1080, 1920).cols).toBe(6);
  });
});

describe('onion scene', () => {
  it('blends n frames into their average: layer k at opacity 1/(k+1)', () => {
    const frames = [0, 10, 20, 30].map((frame) => ({ file: `f${frame}.png`, frame }));
    const scene = buildOnionScene(frames, { width: 640, height: 360, fps: 30 });
    expect(scene.width).toBe(640);
    expect(scene.layers.map((l) => l.opacity)).toEqual([1, 1 / 2, 1 / 3, 1 / 4]);
    expect(scene.layers.map((l) => (l as { src: string }).src)).toEqual(['f0.png', 'f10.png', 'f20.png', 'f30.png']);
  });
});

describe('evenFrames', () => {
  it('spreads frames over the range with both ends, without repeats', () => {
    expect(evenFrames(0, 89, 4)).toEqual([0, 30, 59, 89]);
    expect(evenFrames(10, 20, 2)).toEqual([10, 20]);
    expect(evenFrames(5, 5, 4)).toEqual([5]);
    expect(evenFrames(0, 2, 12)).toEqual([0, 1, 2]);
    expect(evenFrames(0, 99, 1)).toEqual([0]);
  });
});
