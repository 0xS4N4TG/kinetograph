// One picture of a span of time for an agent that can look at pictures: a few frames evenly across it, side by side in a
// grid, each labelled with its time. Made in the browser from small frames the server already draws.

import { rangeStamp } from '@/lib/selection';

const COLUMNS = 4;
const TILE_WIDTH = 480;
const GAP = 6;
/** The most the picture may weigh, bytes. */
const MAX_BYTES = 1_500_000;

/** Where each of `count` tiles goes, and how big the whole sheet is. */
export function sheetLayout(count: number, tileWidth: number, tileHeight: number): { width: number; height: number; tiles: { x: number; y: number }[] } {
  const columns = Math.min(COLUMNS, Math.max(1, count));
  const rows = Math.max(1, Math.ceil(count / columns));
  return {
    width: columns * tileWidth + (columns - 1) * GAP,
    height: rows * tileHeight + (rows - 1) * GAP,
    tiles: Array.from({ length: count }, (_, i) => ({ x: (i % columns) * (tileWidth + GAP), y: Math.floor(i / columns) * (tileHeight + GAP) })),
  };
}

function load(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/**
 * The contact sheet of `frames` as a JPEG in base64 under 1.5 MB, or null when no frame could be fetched. `urlFor` gives
 * the address of a frame drawn at a given scale of the composition.
 */
export async function contactSheet(
  frames: number[],
  fps: number,
  compWidth: number,
  compHeight: number,
  urlFor: (frame: number, scale: number) => string | null,
): Promise<{ data: string; mimeType: string } | null> {
  try {
    const scale = Math.min(1, TILE_WIDTH / compWidth);
    const tileHeight = Math.round(compHeight * (TILE_WIDTH / compWidth));
    const images = await Promise.all(frames.map((frame) => {
      const url = urlFor(frame, scale);
      return url === null ? Promise.resolve(null) : load(url);
    }));
    if (images.every((image) => image === null)) return null;
    const layout = sheetLayout(frames.length, TILE_WIDTH, tileHeight);
    const canvas = document.createElement('canvas');
    canvas.width = layout.width;
    canvas.height = layout.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, layout.width, layout.height);
    ctx.font = '600 20px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    frames.forEach((frame, i) => {
      const { x, y } = layout.tiles[i]!;
      const image = images[i];
      if (image) ctx.drawImage(image, x, y, TILE_WIDTH, tileHeight);
      const text = `${rangeStamp(frame, fps)} · f${frame}`;
      const w = ctx.measureText(text).width + 16;
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(x + 8, y + 8, w, 28);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x + 16, y + 22);
    });
    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      const data = url.slice(url.indexOf(',') + 1);
      if (data !== '' && (data.length * 3) / 4 <= MAX_BYTES) return { data, mimeType: 'image/jpeg' };
    }
    return null;
  } catch {
    return null;
  }
}
