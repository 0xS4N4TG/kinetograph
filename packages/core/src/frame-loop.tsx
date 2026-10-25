// The frame loop (packages/cli/skills/kinetograph/references/AUTHORING.md §7.3): one composition, one `SceneRoot`
// kept across frames (as a Remotion tab keeps its page), and for each frame
//
//   1. move the virtual clock to the frame (timers and animation frames run),
//   2. render the composition at that frame,
//   3. wait for open `delayRender` handles and font downloads, then read the
//      tree again (state set by the data that arrived is in it),
//   4. if any layer has motion blur, render the whole composition at each
//      sub-frame time it needs, read the blurred layers out of those trees and
//      attach what each sub-frame changes in them.

import type { ReactNode } from 'react';
import { resetCanvasStates } from '@kinetographdev/compat/shim';
import { createSceneRoot, finishIslands, TimelineContext, type RenderedTree, type SceneRoot, type VideoConfig } from '@kinetographdev/react';
import {
  attachMotionChanges,
  collectMotionLayers,
  collectMotionTimes,
  type AudioClipJson,
  type LayerJson,
  type SceneJson,
  type SequenceJson,
  type Unsupported,
} from '@kinetographdev/scene';
import {
  beginSamplePass,
  breakSamplePasses,
  clearHistory,
  endSamplePass,
  resetTransitionWindow,
  setHistoryMode,
  transitionWindowSeconds,
} from '@kinetographdev/compat/dom';
import { renderFailure, whenRenderIdle, openRenderHandles } from './assets.js';
import { resolveComposition, setInputProps, type ResolvedComposition } from './compositions.js';
import { realTimers, resetVirtualClock, runAnimationFrames, setVirtualFrame, virtualNow } from './determinism.js';
import { getFonts, pendingFontLoads, waitForFonts } from './font-registry.js';
import { clearReportedUnsupported, reportedUnsupported } from './unsupported.js';

export interface FrameResult {
  scene: SceneJson;
  audio: AudioClipJson[];
  /** Every `<Sequence>` in the frame's tree, showing or not (packages/cli/skills/kinetograph/references/AUTHORING.md §11.4). */
  sequences: SequenceJson[];
  /** Empty when the engine draws everything in the frame; otherwise what it leaves out or approximates (kinetograph site, /docs/compat/). */
  unsupported: Unsupported[];
}

export interface FrameRenderer {
  readonly config: VideoConfig;
  /** Resolves when the composition's metadata (`calculateMetadata`, a lazy component) is known. */
  ready(): Promise<VideoConfig>;
  renderFrame(frame: number): Promise<FrameResult>;
  dispose(): void;
}

const tick = () => new Promise<void>((resolve) => realTimers.setImmediate(resolve));

class Renderer implements FrameRenderer {
  private resolved: ResolvedComposition | null;
  private readonly readyPromise: Promise<ResolvedComposition>;
  private scene: SceneRoot | null = null;
  private lastFrame = -1;
  /** The frames whose islands' states are kept, for CSS transitions (compat's history): a continuous run. */
  private trailFrom = -1;
  private trailTo = -1;
  private disposed = false;
  /** The `renderFrame` call in progress, the one whose renders the open island pass holds (-1: none), and the frame
   *  being rendered: the frame's own renders and its sub-frames are one pass of the islands' documents (compat/dom). */
  private calls = 0;
  private passOf = -1;
  private target = -1;
  private rendering = -1;
  /** While sub-frames are rendered: the blurred layers' ids, all a sub-frame's tree is read for. */
  private subFrameLayers: ReadonlySet<string> | null = null;

  constructor(compositionId: string, inputProps: Record<string, unknown> | undefined) {
    // Components that call getInputProps() see the props this render was given.
    if (inputProps) setInputProps(inputProps);
    resetTransitionWindow();
    const { sync, ready } = resolveComposition(compositionId, { inputProps });
    this.resolved = sync;
    this.readyPromise = ready.then((value) => (this.resolved = value));
    // A failure is reported by `ready()`/`renderFrame()`; do not also leave an unhandled rejection behind.
    this.readyPromise.catch(() => undefined);
  }

  get config(): VideoConfig {
    if (!this.resolved) {
      throw new Error(
        'The composition is still resolving its metadata (calculateMetadata or a lazy component): await renderer.ready() first',
      );
    }
    return this.resolved.config;
  }

  async ready(): Promise<VideoConfig> {
    return (await this.readyPromise).config;
  }

  dispose(): void {
    this.disposed = true;
    this.scene?.unmount();
    this.scene = null;
  }

  async renderFrame(frame: number): Promise<FrameResult> {
    this.calls += 1;
    this.target = frame;
    try {
      return await this.drawFrame(frame);
    } finally {
      this.closePass();
      this.subFrameLayers = null;
    }
  }

  private async drawFrame(frame: number): Promise<FrameResult> {
    if (this.disposed) throw new Error('This FrameRenderer was disposed');
    const { config, component, margin, background } = await this.readyPromise;
    if (!Number.isInteger(frame) || frame < 0 || frame >= config.durationInFrames) {
      throw new RangeError(
        `Frame ${frame} is outside composition "${config.id}", which has ${config.durationInFrames} frames (0 to ${config.durationInFrames - 1})`,
      );
    }

    const sequential = this.scene !== null && frame === this.lastFrame + 1 && this.trailTo === this.lastFrame;
    // The addon keeps the islands' documents from a frame to the one after it; any other frame starts from none.
    if (this.scene === null || frame !== this.lastFrame + 1) breakSamplePasses();
    // Once a transition has been seen, a frame that does not follow the one before is drawn by the replay below,
    // which brings a new scene up to it; drawing it here first would be thrown away.
    const replays = !sequential && frame > 0 && transitionWindowSeconds() > 0;
    // React state and virtual timers only move forward. Going back means starting the composition over.
    if (!replays && (frame < this.lastFrame || this.scene === null)) this.startScene(config);
    if (!sequential) {
      clearHistory();
      this.trailFrom = this.trailTo = -1;
    }
    const fresh = this.lastFrame < 0;
    this.lastFrame = frame;

    await waitForFonts();
    let main!: RenderedTree;
    if (!replays) {
      const scene = this.scene!;
      if (fresh && frame > 0) {
        // Whatever the composition sets up when it mounts (an interval, a fetch) starts at frame 0, so a
        // frame looks the same whether the render began there or somewhere later.
        setVirtualFrame(0, config.fps, { deferAnimationFrames: true });
        await this.settle(scene, () => this.update(scene, this.element(component, config, 0)));
      }
      setVirtualFrame(frame, config.fps, { deferAnimationFrames: true });
      setHistoryMode({ record: true });
      main = await this.settle(scene, () => this.update(scene, this.element(component, config, frame)));
    }
    // CSS transitions need the states of the islands before this frame (packages/cli/skills/kinetograph/references/ENGINE.md §7.12). A frame has the
    // same history whichever frames were rendered before it: a sequential render keeps what it has seen, anything
    // else renders the frames of the window again, with the addon off, to see them.
    const window = Math.ceil(transitionWindowSeconds() * config.fps);
    if (window > 0) {
      if (!sequential) this.trailFrom = frame;
      this.trailTo = frame;
      const start = Math.max(0, frame - window);
      if (frame > 0 && this.trailFrom > start) {
        this.startScene(config);
        clearHistory();
        const again = this.scene!;
        if (start > 0) {
          setHistoryMode({ record: false, warm: true });
          setVirtualFrame(0, config.fps, { deferAnimationFrames: true });
          await this.settle(again, () => this.update(again, this.element(component, config, 0)));
        }
        for (let at = start; at < frame; at++) {
          setHistoryMode({ record: true, warm: true });
          setVirtualFrame(at, config.fps, { deferAnimationFrames: true });
          await this.settle(again, () => this.update(again, this.element(component, config, at)));
        }
        setVirtualFrame(frame, config.fps, { deferAnimationFrames: true });
        setHistoryMode({ record: true });
        main = await this.settle(again, () => this.update(again, this.element(component, config, frame)));
        this.lastFrame = frame;
        this.trailFrom = start;
      }
    }
    setHistoryMode({ record: false });
    // What components that draw through a canvas left out, as the frame's own render reported it.
    const reported = reportedUnsupported();
    // The motion-blur sub-frames render the composition again; fonts or data they ask for are awaited too.
    const times = collectMotionTimes(main.layers, frame);
    let layers = main.layers;
    if (times.length > 0) {
      const treesAt = new Map<number, LayerJson[]>();
      // The samples share the islands' documents with the frame's own render (compat/dom), and only their blurred
      // layers are read: the rest of each sub-frame's tree is left out.
      this.openPass();
      this.subFrameLayers = collectMotionLayers(main.layers, frame);
      for (const time of times) {
        if (time === frame) {
          treesAt.set(time, main.layers);
          continue;
        }
        // The clock sits on the sub-frame, but timers and Math.random() stay with the frame.
        setVirtualFrame(time, config.fps, { seedFrame: frame, fireTimers: false });
        const live = this.scene!;
        const tree = await this.settle(live, () => this.update(live, this.element(component, config, time)), false);
        treesAt.set(time, tree.layers);
      }
      this.subFrameLayers = null;
      // The sub-frames' islands were drawn while the next sub-frames rendered.
      for (const [time, tree] of treesAt) if (tree !== main.layers) treesAt.set(time, finishIslands(tree));
      setVirtualFrame(frame, config.fps, { fireTimers: false });
      layers = attachMotionChanges(main.layers, frame, treesAt);
    }

    const sceneJson: SceneJson = {
      width: config.width,
      height: config.height,
      fps: config.fps,
      durationInFrames: config.durationInFrames,
      background: background ?? 'transparent',
      fonts: getFonts(),
      layers,
    };
    if (main.camera !== null) sceneJson.camera = main.camera;
    // DOM islands are painted for CSS's sRGB compositing; the scene that holds them must say so.
    if (main.blendSpace === 'srgb') sceneJson.blendSpace = 'srgb';
    // The scene's margin is the largest of the composition's and what the DOM islands' blurs need.
    const needed = Math.max(margin ?? 0, main.margin ?? 0);
    if (margin !== undefined || needed > 0) sceneJson.margin = needed;
    return { scene: sceneJson, audio: main.audio, sequences: main.sequences, unsupported: [...main.unsupported, ...reported] };
  }

  /** Renders `element`; a canvas redrawn by it starts from a new canvas's state (see `resetCanvasStates`). */
  private update(scene: SceneRoot, element: ReactNode): void {
    // The pass starts with the frame's own render (not the renders of earlier frames a fresh start or a replay makes).
    if (this.rendering === this.target) this.openPass();
    resetCanvasStates();
    clearReportedUnsupported();
    scene.update(element);
  }

  private startScene(config: VideoConfig): void {
    breakSamplePasses();
    this.scene?.unmount();
    // `time` is the virtual clock in seconds (frame / fps, also on a motion-blur sub-frame): the clock CSS animations read.
    this.scene = createSceneRoot({
      viewport: { width: config.width, height: config.height },
      fonts: getFonts,
      time: () => virtualNow() / 1000,
      subFrameLayers: () => this.subFrameLayers,
    });
    this.lastFrame = -1;
    resetVirtualClock();
  }

  private openPass(): void {
    if (this.passOf === this.calls) return;
    beginSamplePass();
    this.passOf = this.calls;
  }

  private closePass(): void {
    if (this.passOf === -1) return;
    endSamplePass();
    this.passOf = -1;
  }

  private element(component: ResolvedComposition['component'], config: VideoConfig, frame: number): ReactNode {
    this.rendering = frame;
    const Component = component;
    return (
      <TimelineContext.Provider
        value={{
          frame,
          absoluteFrame: frame,
          durationInFrames: config.durationInFrames,
          config,
          frozen: false,
        }}
      >
        <Component {...config.props} />
      </TimelineContext.Provider>
    );
  }

  /** Renders, then waits until nothing is pending and returns the tree as it stands. */
  private async settle(scene: SceneRoot, render: () => void, animationFrames = true): Promise<RenderedTree> {
    try {
      render();
    } catch (error) {
      // `cancelRender` is the better explanation when the code after it went on to fail.
      throw renderFailure() ?? error;
    }
    for (;;) {
      await waitForFonts();
      await whenRenderIdle();
      // Let the state updates that continueRender's callers made reach the reconciler.
      await tick();
      if (openRenderHandles() === 0 && pendingFontLoads() === 0) break;
    }
    // requestAnimationFrame callbacks run once the frame has rendered, as a browser runs them before it paints:
    // a library that draws in one after being told what to show (Motion's render step) shows this frame, not the one before.
    if (animationFrames) {
      runAnimationFrames();
      await tick();
    }
    const tree = scene.snapshot();
    const failure = renderFailure();
    if (failure) throw failure;
    return tree;
  }
}

export function createFrameRenderer(
  compositionId: string,
  options?: { inputProps?: Record<string, unknown> },
): FrameRenderer {
  return new Renderer(compositionId, options?.inputProps);
}
