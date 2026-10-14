import { fileURLToPath } from 'node:url';
import type { LayerJson, Num, SceneJson } from '@kinetograph/scene';

const halve = (n: Num): Num =>
  typeof n === 'number' ? n / 2 : n.map((k) => ({ ...k, value: k.value / 2 }));

/** The largest even number not above half of `n`, at least 2: H.264 in 4:2:0 needs even sizes. */
export const halfSize = (n: number): number => Math.max(2, Math.floor(n / 4) * 2);

/**
 * The scene at half size for `render --draft`: the layers wrapped in a group at scale 0.5 on a canvas of half the
 * size. An explicit camera centre is in canvas pixels, so it is halved too; the perspective distance is not, because
 * `z` is not scaled by the group's matrix. (3D scenes may therefore differ a little from the full-size render.)
 */
export function draftScene(scene: SceneJson): SceneJson {
  const draft: SceneJson = {
    ...scene,
    width: halfSize(scene.width),
    height: halfSize(scene.height),
    layers: [{ id: 'kinetograph-draft', type: 'group', transform: { scale: 0.5 }, children: scene.layers }],
  };
  if (scene.camera) {
    draft.camera = { ...scene.camera };
    if (scene.camera.x !== undefined) draft.camera.x = halve(scene.camera.x);
    if (scene.camera.y !== undefined) draft.camera.y = halve(scene.camera.y);
  }
  return draft;
}

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
