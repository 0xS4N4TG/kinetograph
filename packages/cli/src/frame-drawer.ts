// Single frames as PNGs, native or Chrome by the rule of docs/COMPAT.md §6.1: what `still` and `strip` draw with.

import { pathFor, planRuns, type CompatMode, type RenderPath } from '@kinetograph/compat';
import type { Renderer } from '@kinetograph/native';
import type { Unsupported } from '@kinetograph/scene';
import { LeftOutCollector, describeLeftOut, type CompatReport } from './compat-report.js';
import { openChromeRenderer, type ChromeOptions, type ChromeRenderer } from './fallback/index.js';
import { encodePng } from './fallback/png.js';
import type { Source } from './source.js';

export interface FrameDrawerOptions {
  mode: CompatMode;
  /** The addon's renderer, made when the first native frame needs it (a Chrome-only run never opens the GPU). */
  renderer(): Renderer;
  progress?(message: string): void;
  /** Starts Chrome the first time a frame needs it. Tests pass a stand-in. */
  openChrome?(source: Source, options: ChromeOptions): Promise<ChromeRenderer>;
}

export class FrameDrawer {
  private chrome: ChromeRenderer | null = null;
  private renderer: Renderer | null = null;
  private readonly drawn: { frame: number; unsupported: readonly Unsupported[] }[] = [];
  private readonly leftOut = new LeftOutCollector();

  constructor(
    private readonly source: Source,
    private readonly options: FrameDrawerOptions,
  ) {}

  /** Frame `frame` of the source as a PNG, and the way it was drawn. */
  async png(frame: number): Promise<{ png: Buffer; path: RenderPath }> {
    const { mode } = this.options;
    const out = await this.source.frame(frame);
    const unsupported = out.unsupported ?? [];
    this.drawn.push({ frame, unsupported: mode === 'auto' ? unsupported : [] });
    if (mode === 'native') this.leftOut.add(frame, unsupported);
    if (pathFor(unsupported, mode) === 'native') {
      this.renderer ??= this.options.renderer();
      return { png: this.renderer.still(out.sceneJson, frame, this.source.baseDir), path: 'native' };
    }
    this.chrome ??= await (this.options.openChrome ?? openChromeRenderer)(this.source, { progress: this.options.progress });
    const picture = await this.chrome.frame(frame);
    return { png: encodePng(picture.width, picture.height, picture.data), path: 'chrome' };
  }

  /** How the frames drawn so far went. */
  report(): CompatReport {
    const runs = planRuns(this.drawn, this.options.mode);
    const chromeFrames = runs.filter((r) => r.path === 'chrome').reduce((n, r) => n + (r.last - r.first + 1), 0);
    return { mode: this.options.mode, nativeFrames: this.drawn.length - chromeFrames, chromeFrames, runs, leftOut: this.leftOut.result() };
  }

  /** What `--compat native` left out, on the progress channel (stderr). */
  reportLeftOut(): void {
    for (const line of describeLeftOut(this.leftOut.result())) this.options.progress?.(line);
  }

  async close(): Promise<void> {
    await this.chrome?.close().catch(() => undefined);
    this.chrome = null;
  }
}
