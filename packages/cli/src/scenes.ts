import { fileURLToPath } from 'node:url';
import type { LayerJson, Num, SceneJson } from '@kinetographdev/scene';

/** The largest even number not above `n * scale`, at least 2: YUV 4:2:0 video needs even sizes. */
export const scaledSize = (n: number, scale: number): number => Math.max(2, Math.floor((n * scale + 1e-9) / 2) * 2);

/** `scaledSize` at half: H.264 in 4:2:0 needs even sizes. */
export const halfSize = (n: number): number => scaledSize(n, 0.5);

const times = (n: Num, k: number): Num =>
  typeof n === 'number' ? n * k : n.map((key) => ({ ...key, value: key.value * k }));

/**
 * The scene at `scale` times the size, for `render --scale` (and `--draft`, which is 0.5): the layers wrapped in a group
 * at that scale on a canvas of the scaled size (each side rounded down to an even number), so the compositor draws
 * everything at the output size and nothing is resampled afterwards. An explicit camera centre is in canvas pixels, so
 * it is scaled too; the perspective distance is not, because `z` is not scaled by the group's matrix. (3D scenes may
 * therefore differ a little from the full-size render.)
 */
export function scaleScene(scene: SceneJson, scale: number): SceneJson {
  const scaled: SceneJson = {
    ...scene,
    width: scaledSize(scene.width, scale),
    height: scaledSize(scene.height, scale),
    layers: [{ id: 'kinetograph-draft', type: 'group', transform: { scale }, children: scene.layers }],
  };
  if (scene.camera) {
    scaled.camera = { ...scene.camera };
    if (scene.camera.x !== undefined) scaled.camera.x = times(scene.camera.x, scale);
    if (scene.camera.y !== undefined) scaled.camera.y = times(scene.camera.y, scale);
  }
  return scaled;
}

/** The scene at half size for `render --draft`. */
export const draftScene = (scene: SceneJson): SceneJson => scaleScene(scene, 0.5);

export const LABEL_FONT_KEY = 'DM Sans';
export const LABEL_FONT_PATH = fileURLToPath(new URL('../assets/fonts/DMSans-Medium.ttf', import.meta.url));

export interface SheetFrame {
  /** PNG file name, relative to the scene's base directory. */
  file: string;
  frame: number;
}

const SHEET_BACKGROUND = '#0d0f14';
const GAP = 16;
const LABEL_SIZE = 24;
const LABEL_HEIGHT = 40;
const MAX_SHEET_WIDTH = 1600;

export interface StripLayout {
  cols: number;
  rows: number;
  thumbWidth: number;
  thumbHeight: number;
  width: number;
  height: number;
}

/** The grid of a contact sheet of `count` thumbnails of a `width` x `height` composition. */
export function stripLayout(count: number, width: number, height: number, cols?: number): StripLayout {
  const columns = Math.max(1, Math.min(count, cols ?? (width >= height ? 4 : 6)));
  const thumbWidth = Math.max(16, Math.min(width, Math.floor((MAX_SHEET_WIDTH - GAP * (columns + 1)) / columns)));
  const thumbHeight = Math.max(1, Math.round((thumbWidth * height) / width));
  const rows = Math.ceil(count / columns);
  return {
    cols: columns,
    rows,
    thumbWidth,
    thumbHeight,
    width: columns * thumbWidth + (columns + 1) * GAP,
    height: rows * (thumbHeight + LABEL_HEIGHT) + GAP,
  };
}

/**
 * A scene that lays the frames out as image layers in a grid, each labelled with its frame number and time, for the
 * engine to render as the contact sheet.
 */
export function buildStripScene(
  frames: SheetFrame[],
  source: { width: number; height: number; fps: number },
  cols?: number,
): SceneJson {
  const layout = stripLayout(frames.length, source.width, source.height, cols);
  const layers: LayerJson[] = [];
  frames.forEach((f, i) => {
    const x = GAP + (i % layout.cols) * (layout.thumbWidth + GAP);
    const y = GAP + Math.floor(i / layout.cols) * (layout.thumbHeight + LABEL_HEIGHT);
    layers.push({
      id: `frame-${i}`,
      type: 'image',
      src: f.file,
      width: layout.thumbWidth,
      height: layout.thumbHeight,
      transform: { x, y },
    });
    layers.push({
      id: `label-${i}`,
      type: 'text',
      text: `f${f.frame}  ${(f.frame / source.fps).toFixed(2)}s`,
      font: LABEL_FONT_KEY,
      size: LABEL_SIZE,
      color: '#cfd3dc',
      transform: { x, y: y + layout.thumbHeight + 6 },
    });
  });
  return {
    width: layout.width,
    height: layout.height,
    fps: source.fps,
    durationInFrames: 1,
    background: SHEET_BACKGROUND,
    fonts: { [LABEL_FONT_KEY]: LABEL_FONT_PATH },
    layers,
  };
}

/**
 * The frames blended over one another as a running average: layer k at opacity 1/(k+1), so every frame counts the same
 * and whatever moves shows once per frame, each at 1/n.
 */
export function buildOnionScene(
  frames: SheetFrame[],
  source: { width: number; height: number; fps: number },
): SceneJson {
  return {
    width: source.width,
    height: source.height,
    fps: source.fps,
    durationInFrames: 1,
    background: 'transparent',
    layers: frames.map((f, k) => ({
      id: `onion-${k}`,
      type: 'image' as const,
      src: f.file,
      width: source.width,
      height: source.height,
      opacity: 1 / (k + 1),
    })),
  };
}
