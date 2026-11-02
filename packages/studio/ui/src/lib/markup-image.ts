// The picture of a frame with its notes drawn on it, for the agent: the frame the preview draws, then each mark in its
// colour with the number it has in the message. Made in the browser on a canvas, from the frame the server already draws.

import type { Note } from '@/lib/markup';

/** The longest side of the picture, px. */
export const PICTURE_SIDE = 1280;

export interface Numbered {
  note: Note;
  no: number;
}

/** The subset of a canvas 2D context the marks need (so a test can record the calls). */
export type Ctx = Pick<
  CanvasRenderingContext2D,
  'beginPath' | 'moveTo' | 'lineTo' | 'arc' | 'stroke' | 'fill' | 'strokeRect' | 'fillRect' | 'fillText' | 'measureText' | 'save' | 'restore'
> & { strokeStyle: unknown; fillStyle: unknown; lineWidth: number; lineJoin: unknown; lineCap: unknown; font: string; textAlign: unknown; textBaseline: unknown };

/** A number in a coloured disc, centred on (x, y). */
function badge(ctx: Ctx, x: number, y: number, no: number, color: string, radius: number): void {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, radius / 7);
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `700 ${Math.round(radius * 1.15)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(no), x, y + radius * 0.06);
}

/**
 * Draws the marks of one frame. `k` is the picture's scale from composition pixels. A pin is a numbered disc, a box an
 * outline with its number on the top left corner, a stroke its line with the number at its start, a range a banner.
 */
export function drawMarks(ctx: Ctx, marks: Numbered[], k: number): void {
  const radius = Math.max(11, Math.round(14 * Math.min(1, k * 1.4)));
  const line = Math.max(2, Math.round(3 * Math.min(1, k * 1.4)));
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  let banner = 0;
  for (const { note, no } of marks) {
    const g = note.geom;
    ctx.lineWidth = line;
    ctx.strokeStyle = note.color;
    if (g.type === 'pin') {
      badge(ctx, g.x * k, g.y * k, no, note.color, radius);
    } else if (g.type === 'box') {
      ctx.strokeRect(g.x * k, g.y * k, g.width * k, g.height * k);
      badge(ctx, g.x * k, g.y * k, no, note.color, radius);
    } else if (g.type === 'pen') {
      ctx.beginPath();
      g.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * k, y * k) : ctx.lineTo(x * k, y * k)));
      // a single point still shows
      if (g.points.length === 1) ctx.lineTo(g.points[0]![0] * k + 0.01, g.points[0]![1] * k);
      ctx.stroke();
      const start = g.points[0]!;
      badge(ctx, start[0] * k, start[1] * k, no, note.color, radius);
    } else {
      // A range has no place on the picture: a label across the top says which notes cover this frame.
      const text = `${no}  frames ${note.frame}-${note.endFrame}`;
      ctx.font = `600 ${Math.round(radius * 1.1)}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(text).width + 16;
      const y = 8 + banner * (radius * 1.2 + 10);
      ctx.fillStyle = note.color;
      ctx.fillRect(8, y, w, radius * 1.2 + 6);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, 16, y + (radius * 1.2 + 6) / 2);
      banner++;
    }
  }
  ctx.restore();
}

function loadImage(url: string): Promise<CanvasImageSource | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

export interface PictureOptions {
  frame: number;
  marks: Numbered[];
  compWidth: number;
  compHeight: number;
  /** The address of the frame drawn at a scale of the composition (`Studio.frameUrl`). */
  urlFor(frame: number, scale: number): string | null;
  /** Fetches the frame; replaceable so a test need not decode anything. */
  load?(url: string): Promise<CanvasImageSource | null>;
}

/** The scale the picture is made at: the composition, down to `PICTURE_SIDE` on its long side. */
export const pictureScale = (compWidth: number, compHeight: number): number => Math.min(1, PICTURE_SIDE / Math.max(compWidth, compHeight, 1));

/** The frame with its marks as a PNG file named `name`, or null when the frame cannot be fetched or drawn. */
export async function annotatedFrame(name: string, options: PictureOptions): Promise<File | null> {
  try {
    const k = pictureScale(options.compWidth, options.compHeight);
    const url = options.urlFor(options.frame, k);
    if (url === null) return null;
    const image = await (options.load ?? loadImage)(url);
    if (!image) return null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(options.compWidth * k));
    canvas.height = Math.max(1, Math.round(options.compHeight * k));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    drawMarks(ctx as unknown as Ctx, options.marks, k);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
    return blob ? new File([blob], name, { type: 'image/png' }) : null;
  } catch {
    return null;
  }
}
