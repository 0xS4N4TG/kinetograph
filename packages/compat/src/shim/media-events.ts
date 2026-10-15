// `onLoad` / `onError` of an `<img>` and `onLoadedMetadata`, `onLoadedData`, `onCanPlay` of a `<video>` or `<audio>`
// (docs/ENGINE.md §10.3). In a browser they fire when the file has loaded; a project that holds the frame with
// `delayRender()` and releases it in such a handler would wait for ever here, because nothing is downloaded. The files
// are local and read at once, so the events are delivered when React's work on the frame is done, once per `src`.

import { existsSync, readFileSync } from 'node:fs';
import { addonFunction, hasAddonFunction } from '../addon.js';
import { domElementFor } from './element.js';
import type { HostElement, Readback } from './host.js';
import { propsWithOverlay } from './host.js';
import { imageSizeOfBytes } from './image-size.js';
import { projectFileOf, remoteMessage } from './web.js';

/** The `src` each element's events were last delivered for. */
const delivered = new WeakMap<HostElement, string>();

const IMAGE_EVENTS = ['onLoad', 'onError'] as const;
const MEDIA_EVENTS = ['onLoadStart', 'onLoadedMetadata', 'onLoadedData', 'onCanPlay', 'onCanPlayThrough', 'onError'] as const;

function srcOf(host: HostElement): string | null {
  const props = propsWithOverlay(host);
  return typeof props.src === 'string' && props.src !== '' ? props.src : null;
}

function event(type: string, target: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type,
    target,
    currentTarget: target,
    nativeEvent: { type },
    bubbles: false,
    defaultPrevented: false,
    preventDefault() {},
    stopPropagation() {},
    persist() {},
    isDefaultPrevented: () => false,
    isPropagationStopped: () => false,
    ...extra,
  };
}

/** Whether `src` names an image the engine can read (and its size is known). */
function imageLoads(src: string): { ok: true } | { ok: false; message: string } {
  if (/^(https?|wss?|ftp):\/\//i.test(src)) return { ok: false, message: remoteMessage('<img src>', src) };
  if (src.startsWith('data:')) return { ok: true };
  if (src.startsWith('blob:')) return { ok: true };
  const file = projectFileOf(src);
  if (file === null || !existsSync(file)) return { ok: false, message: `<img src="${src}">: no such file in the project (looked beside the entry and in public/)` };
  if (imageSizeOfBytes(readFileSync(file)) === null) return { ok: false, message: `<img src="${src}">: not an image Kinetograph can read` };
  return { ok: true };
}

/**
 * Calls the load handlers of the `<img>`, `<video>` and `<audio>` elements that have not had them for their current
 * `src`. Returns true when one ran (it may have set state, so the root renders again).
 */
export function deliverMediaEvents(readback: Readback): boolean {
  let any = false;
  for (const host of readback.descendants()) {
    if (host.type !== 'img' && host.type !== 'video' && host.type !== 'audio') continue;
    const props = propsWithOverlay(host);
    const names = host.type === 'img' ? IMAGE_EVENTS : MEDIA_EVENTS;
    if (!names.some((name) => typeof props[name] === 'function')) continue;
    const src = srcOf(host);
    if (src === null || delivered.get(host) === src) continue;
    delivered.set(host, src);
    const target = domElementFor(host, readback);
    any = true;
    if (host.type === 'img') {
      const result = imageLoads(src);
      if (result.ok) props.onLoad?.(event('load', target));
      else props.onError?.(event('error', target, { message: result.message }));
      continue;
    }
    const file = /^(https?|data|blob):/i.test(src) ? null : projectFileOf(src);
    if (file === null || !existsSync(file)) {
      props.onError?.(event('error', target, { message: `<${host.type} src="${src}">: no such file in the project` }));
      continue;
    }
    if (hasAddonFunction('probeMedia')) {
      try {
        addonFunction('probeMedia')(file);
      } catch (error) {
        props.onError?.(event('error', target, { message: error instanceof Error ? error.message : String(error) }));
        continue;
      }
    }
    for (const name of MEDIA_EVENTS) {
      if (name === 'onError') continue;
      props[name]?.(event(name.slice(2).toLowerCase(), target));
    }
  }
  return any;
}
