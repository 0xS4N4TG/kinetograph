/// <reference lib="dom" />
// `window.__kinetograph` (docs/COMPAT.md §6.2): the one call the driver makes per frame. `setFrame(f)` renders the
// composition at `f` with React DOM, through `@kinetograph/core`'s frame loop (which sets the virtual clock and waits
// for `delayRender` handles and font downloads), then waits for the page's own fonts and pictures, and resolves with
// what the driver needs to take the screenshot.

import { findStage, STAGE_ID } from './scene-root.js';
import { BROWSER_CSS } from './style.js';
import { takeWarnings } from './warn.js';

/** The parts of `@kinetograph/core`'s `FrameRenderer` the runtime drives. */
export interface BrowserFrameRenderer {
  ready(): Promise<{ width: number; height: number; fps: number; durationInFrames: number }>;
  renderFrame(frame: number): Promise<{ scene: { background?: string } }>;
  dispose?(): void;
}

export interface FrameReport {
  frame: number;
  /** The composition's `background`, as the scene would carry it. */
  background: string;
  /** The background is fully transparent, so the screenshot omits the page's own. */
  transparent: boolean;
  /** What this frame left out that earlier ones did not (one message per kind). */
  warnings: string[];
}

export interface BrowserRuntime {
  attach(renderer: BrowserFrameRenderer): void;
  setFrame(frame: number): Promise<FrameReport>;
}

declare global {
  interface Window {
    __kinetograph?: BrowserRuntime;
  }
}

/** Whether a computed `background-color` is fully transparent. */
export function isTransparentColor(computed: string): boolean {
  const value = computed.trim().toLowerCase();
  return value === 'transparent' || /(?:,|\/)\s*0(?:\.0+)?\s*\)$/.test(value);
}

function ensureStage(): HTMLElement {
  let stage = findStage();
  if (!stage) {
    stage = document.createElement('div');
    stage.id = STAGE_ID;
    document.body.append(stage);
  }
  stage.classList.add('kg-layer');
  return stage;
}

function ensureStyleSheet(): void {
  if (document.getElementById('kg-style')) return;
  const style = document.createElement('style');
  style.id = 'kg-style';
  style.textContent = BROWSER_CSS;
  document.head.append(style);
}

/** The camera marker, if the tree has a `<Camera>`, as the stage's perspective (SCENE.md "3D transforms and the camera"). */
function applyCamera(stage: HTMLElement): void {
  const marker = stage.querySelector<HTMLElement>('[data-kg-camera]');
  if (!marker) {
    stage.style.perspective = '';
    stage.style.perspectiveOrigin = '';
    return;
  }
  const perspective = Number(marker.dataset.perspective);
  stage.style.perspective = perspective > 0 ? `${perspective}px` : '';
  const { x, y } = marker.dataset;
  stage.style.perspectiveOrigin = x !== undefined || y !== undefined ? `${x ?? '50%'}${x === undefined ? '' : 'px'} ${y ?? '50%'}${y === undefined ? '' : 'px'}` : '50% 50%';
}

/** Waits for the fonts and pictures the frame uses; a picture that fails to load is reported, not waited for. */
async function settlePage(warnings: string[]): Promise<void> {
  // Reading a layout property makes the browser ask for the fonts the new markup uses.
  void document.body.offsetHeight;
  await document.fonts?.ready;
  await Promise.all(
    Array.from(document.images).map(async (image) => {
      if (!image.complete) {
        await new Promise<void>((resolve) => {
          image.addEventListener('load', () => resolve(), { once: true });
          image.addEventListener('error', () => resolve(), { once: true });
        });
      }
      if (image.naturalWidth === 0) {
        warnings.push(`a picture did not load: ${decodeURIComponent(image.getAttribute('src') ?? '')}`);
        return;
      }
      await image.decode().catch(() => undefined);
    }),
  );
}

/**
 * Defines `window.__kinetograph`. The renderer is `@kinetograph/core`'s `createFrameRenderer(id, { inputProps })`;
 * pass it here or to `attach` later.
 */
export function installBrowserRuntime(renderer?: BrowserFrameRenderer): BrowserRuntime {
  let attached: BrowserFrameRenderer | null = null;
  // Frames are drawn one at a time: the stage, the clock and the handles are shared.
  let queue: Promise<unknown> = Promise.resolve();

  const draw = async (frame: number): Promise<FrameReport> => {
    if (!attached) throw new Error('window.__kinetograph has no composition: call attach() with a frame renderer first');
    ensureStyleSheet();
    const stage = ensureStage();
    const config = await attached.ready();
    stage.style.width = `${config.width}px`;
    stage.style.height = `${config.height}px`;
    stage.style.setProperty('--kg-w', `${config.width}px`);
    stage.style.setProperty('--kg-h', `${config.height}px`);
    const result = await attached.renderFrame(frame);
    const background = result.scene.background ?? 'transparent';
    stage.style.background = background;
    applyCamera(stage);
    const warnings: string[] = [];
    await settlePage(warnings);
    return {
      frame,
      background,
      transparent: isTransparentColor(getComputedStyle(stage).backgroundColor),
      warnings: [...takeWarnings(), ...warnings],
    };
  };

  const runtime: BrowserRuntime = {
    attach(next) {
      attached = next;
    },
    setFrame(frame) {
      const run = queue.then(() => draw(frame));
      queue = run.catch(() => undefined);
      return run;
    },
  };
  if (renderer) runtime.attach(renderer);
  window.__kinetograph = runtime;
  return runtime;
}
