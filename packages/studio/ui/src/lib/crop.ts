// A picture of the selected part of the frame the preview shows, to send to an agent that can look at pictures.

import type { ReceivedFrame } from '@/api';
import type { Rect } from '@/lib/selection';

const MAX_SIDE = 1280;

/** The part `rect` (composition pixels) of `frame` as a PNG in base64, or null when it cannot be made. */
export async function cropToPng(frame: ReceivedFrame, compWidth: number, rect: Rect): Promise<{ data: string; mimeType: string } | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([frame.image as Uint8Array<ArrayBuffer>], { type: frame.header.mime }));
    // The frame may be smaller than the composition (a preview-quality frame while scrubbing).
    const k = compWidth > 0 ? frame.header.width / compWidth : 1;
    const sx = Math.round(rect.x * k);
    const sy = Math.round(rect.y * k);
    const sw = Math.max(1, Math.round(rect.width * k));
    const sh = Math.max(1, Math.round(rect.height * k));
    const down = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * down));
    canvas.height = Math.max(1, Math.round(sh * down));
    canvas.getContext('2d')?.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const url = canvas.toDataURL('image/png');
    const data = url.slice(url.indexOf(',') + 1);
    return data === '' ? null : { data, mimeType: 'image/png' };
  } catch {
    return null;
  }
}
