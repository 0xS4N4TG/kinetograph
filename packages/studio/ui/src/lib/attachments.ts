// Pictures dropped or pasted into the agent's prompt box: which files are taken, how they are sent to the server (stored
// in the project's public/refs, packages/studio/src/agent-images.ts) and how a smaller copy is made for an agent that
// looks at pictures. The stored file is always the original.

import type { AgentAttachment } from '@/api';

/** Pictures one message carries. */
export const MAX_ATTACHMENTS = 6;
/** The largest picture taken, bytes. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** The longest side of the copy the agent looks at, px. */
export const AGENT_IMAGE_SIDE = 1568;
/** The most one copy for the agent may weigh, bytes, and all of a message's together. */
const MAX_COPY_BYTES = 1_500_000;
const MAX_COPIES_TOTAL = 6_000_000;

const EXTENSIONS = /\.(png|jpe?g|webp|gif|avif)$/i;
/** Types an agent takes as a picture block; AVIF is stored and named but redrawn as PNG or JPEG for the agent. */
const SENDABLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** One picture waiting in the prompt box. */
export interface Attachment {
  id: number;
  file: File;
  /** An address for the thumbnail (an object URL). */
  preview: string;
  /** The name it was stored under, once uploaded (kept so that a retry does not store it twice). */
  stored?: string;
}

/** What the file picker offers. */
export const ACCEPT_IMAGES = 'image/png,image/jpeg,image/webp,image/gif,image/avif';

/** A PNG, JPEG, WebP, GIF or AVIF, by its type or (when the browser gives none) its name. */
export const isImageFile = (file: File): boolean => (file.type === '' ? EXTENSIONS.test(file.name) : SENDABLE.has(file.type) || file.type === 'image/avif');

export interface Accepted {
  files: File[];
  /** What went wrong with the others, in plain words; null when all were taken. */
  error: string | null;
}

const megabytes = MAX_ATTACHMENT_BYTES / 1024 / 1024;

/** Which of `files` can be added to the `have` already in the box. */
export function acceptImages(files: File[], have: number): Accepted {
  const taken: File[] = [];
  let error: string | null = null;
  for (const file of files) {
    if (!isImageFile(file)) error ??= `${file.name || 'That file'} is not an image. Use a PNG, JPEG, WebP, GIF or AVIF.`;
    else if (file.size > MAX_ATTACHMENT_BYTES) error ??= `${file.name || 'That image'} is over ${megabytes} MB.`;
    else if (have + taken.length >= MAX_ATTACHMENTS) error ??= `At most ${MAX_ATTACHMENTS} images go with one message.`;
    else taken.push(file);
  }
  return { files: taken, error };
}

/** The files a drag or a paste carries. */
export function filesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  return Array.from(data.items ?? []).flatMap((item) => {
    const file = item.kind === 'file' ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

/** Whether a drag carries files (and so is worth an overlay). */
export const dragHasFiles = (data: DataTransfer | null): boolean => !!data && Array.from(data.types ?? []).includes('Files');

/** The secret from the address the studio opened; the api module keeps the same one for the tab. */
function studioToken(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('token') ?? sessionStorage.getItem('studio-token');
  } catch {
    return null;
  }
}

/** The address of a stored picture, for an <img>. */
export function attachmentUrl(name: string): string {
  const token = studioToken();
  return `/api/agent/image?name=${encodeURIComponent(name)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
}

/** Stores `file` in the project's public/refs; resolves to the name it was stored under. */
export async function uploadAttachment(file: File): Promise<string> {
  const token = studioToken();
  let response: Response;
  try {
    response = await fetch(attachmentUrl(file.name || 'image.png'), {
      method: 'PUT',
      headers: token ? { 'X-Studio-Token': token } : {},
      body: file,
    });
  } catch {
    throw new Error(`Could not upload ${file.name}: the studio is not reachable.`);
  }
  const body = (await response.json().catch(() => null)) as { file?: string; error?: { message?: string } } | null;
  if (!response.ok || !body?.file) throw new Error(`Could not store ${file.name}: ${body?.error?.message ?? `${response.status} ${response.statusText}`}.`);
  return body.file;
}

/** `width` by `height` scaled down to fit `side` on the long side (never up). */
export function fitSize(width: number, height: number, side = AGENT_IMAGE_SIDE): { width: number; height: number } {
  const scale = Math.min(1, side / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function rawCopy(file: File): Promise<{ data: string; mimeType: string } | null> {
  if (!SENDABLE.has(file.type) || file.size > MAX_COPY_BYTES) return null;
  return { data: base64Of(new Uint8Array(await file.arrayBuffer())), mimeType: file.type };
}

/**
 * The copy of a picture the agent looks at: at most 1568 px on the long side and 1.5 MB (a GIF is its first frame once it
 * is redrawn). A small picture of a type the agent takes goes as it is. Null when no copy can be made (the agent is still
 * told where the original is).
 */
export async function copyForAgent(file: File): Promise<{ data: string; mimeType: string } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = fitSize(bitmap.width, bitmap.height);
    if (size.width === bitmap.width && size.height === bitmap.height) {
      const same = await rawCopy(file);
      if (same) {
        bitmap.close?.();
        return same;
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close?.();
    // Anything that may be transparent keeps it as a PNG as long as that is small enough; otherwise a JPEG, as small as it takes.
    const tries: [string, number][] = file.type === 'image/jpeg' ? [] : [['image/png', 1]];
    for (const quality of [0.85, 0.7, 0.55, 0.4]) tries.push(['image/jpeg', quality]);
    for (const [mimeType, quality] of tries) {
      const url = canvas.toDataURL(mimeType, quality);
      const data = url.slice(url.indexOf(',') + 1);
      if (data !== '' && (data.length * 3) / 4 <= MAX_COPY_BYTES) return { data, mimeType };
    }
    return null;
  } catch {
    // The page cannot decode it (or has no canvas): a small original still goes as it is.
    return rawCopy(file).catch(() => null);
  }
}

/**
 * Stores each picture and makes the copy for the agent, within a total budget; resolves to what `agent.prompt` carries.
 * `stored` is told each name as soon as it is stored (a failed attempt then does not store it again).
 */
export async function prepareAttachments(items: Attachment[], stored: (id: number, name: string) => void): Promise<AgentAttachment[]> {
  const out: AgentAttachment[] = [];
  let total = 0;
  for (const item of items) {
    const name = item.stored ?? (await uploadAttachment(item.file));
    if (item.stored === undefined) stored(item.id, name);
    const copy = await copyForAgent(item.file);
    if (copy && total + copy.data.length <= MAX_COPIES_TOTAL) {
      total += copy.data.length;
      out.push({ name, data: copy.data, mimeType: copy.mimeType });
    } else {
      out.push({ name });
    }
  }
  return out;
}

/**
 * A picture already stored in the project, back in the prompt box (a queued message taken out to be edited): its bytes are
 * read again so that the agent gets its scaled copy as before; if they cannot be read, the name alone is kept.
 */
export async function restoreAttachment(name: string): Promise<{ file: File; stored: string }> {
  try {
    const response = await fetch(attachmentUrl(name));
    if (response.ok) {
      const blob = await response.blob();
      return { file: new File([blob], name, { type: blob.type || 'image/png' }), stored: name };
    }
  } catch {
    // below
  }
  return { file: new File([], name, { type: 'image/png' }), stored: name };
}
