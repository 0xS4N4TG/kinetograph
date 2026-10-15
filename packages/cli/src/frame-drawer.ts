// Single frames as PNGs: what `still`, `strip` and `onion` draw with.

import type { Renderer } from '@kinetograph/native';
import { LeftOutCollector, describeLeftOut, strictError, type CompatReport } from './compat-report.js';
import type { Source } from './source.js';

export interface FrameDrawerOptions {
  /** The addon's renderer, made when the first frame needs it. */
  renderer(): Renderer;
  progress?(message: string): void;
  /** Throw on a frame holding something unsupported instead of drawing it without. */
  strict?: boolean;
}

export class FrameDrawer {
  private renderer: Renderer | null = null;
  private readonly leftOut = new LeftOutCollector();

  constructor(
    private readonly source: Source,
    private readonly options: FrameDrawerOptions,
  ) {}

  /** Frame `frame` of the source as a PNG. */
  async png(frame: number): Promise<Buffer> {
    const out = await this.source.frame(frame);
    const unsupported = out.unsupported ?? [];
    if (this.options.strict && unsupported.length > 0) throw strictError(frame, unsupported);
    this.leftOut.add(frame, unsupported);
    this.renderer ??= this.options.renderer();
    return this.renderer.still(out.sceneJson, frame, this.source.baseDir);
  }

  /** What the frames drawn so far left out. */
  report(): CompatReport {
    return this.leftOut.report();
  }

  /** What the frames left out, as a warning on the progress channel (stderr). */
  reportLeftOut(): void {
    for (const line of describeLeftOut(this.leftOut.report())) this.options.progress?.(line);
  }
}
