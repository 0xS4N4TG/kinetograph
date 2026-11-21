// The frame loop (packages/cli/skills/kinetograph-markup/references/AUTHORING.md §7.3): one composition, one `SceneRoot`
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
import { createDawnScope, dawnDependsOnHistory, dawnInUse, enterDawnScope, flushDawnCanvases, noteDawnRewind, releaseDawn, takeDawnReports, glDependsOnHistory, glHoldsTargets, loadsSettled, pendingFetches, pendingImageLoads, pendingReadbacks, resetCanvasStates, setNetFrame, snapshotGlStates, takeGlReports, takeLoadFailures, takeMediaIssues } from '@kinetographdev/compat/shim';
import { setDefaultStylesheet } from '@kinetographdev/compat/dom';
import { createSceneRoot, finishIslands, TimelineContext, type LayerNames, type RenderedTree, type SceneRoot, type VideoConfig } from '@kinetographdev/react';
import {
  attachMotionChanges,
  collectMotionLayers,
  collectMotionTimes,
  type AudioClipJson,
  type PageAudioOp,
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
import { DELAY_RENDER_TIMEOUT, onlyPageLoadOpen, rejectRenderWaits, renderFailure, renderHandlesMade, whenRenderIdle, openRenderHandles } from './assets.js';
import { isRemotionPage, resolveComposition, setInputProps, type ResolvedComposition } from './compositions.js';
import { animationFramesQueued, fireHoldTimer, realTimers, resetVirtualClock, runAnimationFrames, setHoldProbe, setVirtualFrame, stepAnimationFrames, virtualNow } from './determinism.js';
import { getFonts, pendingFontLoads, waitForFonts } from './font-registry.js';
import { endGsapSamples, gsapIsLoaded, sampleGsapAt, setGsapTime } from './gsap-clock.js';
import { pageAudioNotes, takePageAudioOps } from './page-audio.js';
import { takePageErrors } from './page-errors.js';
import { frameReplay, type FrameReplay } from './frame-replay.js';
import { drawSettled } from './canvas-draws.js';
import { clearReportedUnsupported, reportedUnsupported, reportUnsupported, setReportIsRead } from './unsupported.js';

export interface FrameResult {
  scene: SceneJson;
  audio: AudioClipJson[];
  /** What the page did with its `AudioContext` since the last frame returned (the calls of the frames it played on the way too). */
  pageAudio: PageAudioOp[];
  /** Every `<Sequence>` in the frame's tree, showing or not (packages/cli/skills/kinetograph-markup/references/AUTHORING.md §11.4). */
  sequences: SequenceJson[];
  /** Layer id to name and source; studio builds only. */
  names?: LayerNames;
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

/** Whether something the frame waits for is open: a delayRender handle, a font or an image still loading. */
const heldOpen = (): boolean => openRenderHandles() > 0 || pendingFontLoads() > 0 || pendingImageLoads() > 0 || loadsSettled() !== seenLoads;
setHoldProbe(heldOpen);

/**
 * The loads the frame has run what they set going for. While a load has finished that has not been (`loadsSettled` is
 * ahead), the frame is held: a Suspense whose texture or model has arrived reveals after React's throttle, a timeout
 * made once nothing is loading any more, and it is a hold timer then, fired at once (`runAfterLoads`).
 */
let seenLoads = 0;

/** Lets React reveal what the loads that finished since `seenLoads` were for. */
async function runAfterLoads(): Promise<void> {
  for (let quiet = 0; quiet < 2; ) {
    await tick();
    quiet = pendingFetches() === 0 && pendingImageLoads() === 0 && pendingFontLoads() === 0 ? quiet + 1 : 0;
    if (quiet >= 2 && fireHoldTimer()) quiet = 0;
  }
  seenLoads = loadsSettled();
}

/**
 * Resolves when no delayRender handle is open; rejects with the recorded failure.
 *
 * The clock only moves between frames, so a handle whose release waits on a timeout (React holds a revealed Suspense
 * boundary back for 300 ms with `setTimeout`) would wait for ever. The rule: a `setTimeout` made while the frame is held
 * open (`heldOpen`) is a hold timer. When the frame is still held and nothing else is moving (no fetch, image or font is
 * loading, for two turns of the event loop), the earliest hold timer fires at once, in (due time, creation order), without
 * the clock moving. Timeouts made while the frame is not held, and every interval, follow the frame clock as before.
 */
async function whenReleased(animationFrames = false): Promise<void> {
  let quiet = 0;
  while (openRenderHandles() > 0) {
    // A waiter for the release; a new one once that has been released and a handle was opened again.
    const idle = whenRenderIdle();
    let released = false;
    idle.then(() => (released = true), () => (released = true));
    while (!released && openRenderHandles() > 0) {
      // While a handle is open the animation-frame callbacks run as they are asked for, as in a browser, where a page
      // waiting for its map's `idle` (which a repaint in a frame callback brings) is not stuck. That is not quiet.
      // While only the page's scripts are loading, the callbacks wait: how many turns of the event loop a read of a file
      // takes is not the page's clock, and a callback that ran in each of them would move a page that counts them (an
      // animation that adds to a rotation) by that many frames. A script that waits for a frame itself gets one once
      // nothing is loading any more (no fetch, image or font, for two turns: the state, not a time), or it would never finish.
      if (animationFrames && animationFramesQueued() && (!onlyPageLoadOpen() || quiet >= 2)) {
        runAnimationFrames();
        await tick();
        quiet = 0;
        continue;
      }
      await Promise.race([idle, tick()]);
      if (released) break;
      quiet = pendingFetches() === 0 && pendingImageLoads() === 0 && pendingFontLoads() === 0 ? quiet + 1 : 0;
      if (quiet >= 2 && fireHoldTimer()) quiet = 0;
    }
    await idle;
  }
  await whenRenderIdle();
}

class Renderer implements FrameRenderer {
  private resolved: ResolvedComposition | null;
  private readonly readyPromise: Promise<ResolvedComposition>;
  private scene: SceneRoot | null = null;
  private lastFrame = -1;
  /** The frames whose islands' states are kept, for CSS transitions (compat's history): a continuous run. */
  private trailFrom = -1;
  private trailTo = -1;
  /** A frame that followed a jump depends on the frames before it through a WebGL render target (`glDependsOnHistory`): a jump renders the frames it skips. */
  private historyDependent = false;
  /** The frame a jump landed on without the frames before it drawn, until a frame says the page's GPU state carries (a Dawn page, `dawnDependsOnHistory`): -1 when none. */
  private unreplayedJump = -1;
  private disposed = false;
  /** What this renderer's WebGPU pages made (devices, canvases, pictures) and what their frames read of each other: its own on a thread that holds several renderers. */
  private readonly dawn = createDawnScope();
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
    releaseDawn(this.dawn);
  }

  async renderFrame(frame: number): Promise<FrameResult> {
    this.calls += 1;
    this.target = frame;
    setNetFrame(frame);
    const leaveDawn = enterDawnScope(this.dawn);
    try {
      return await this.drawFrame(frame);
    } finally {
      leaveDawn();
      this.closePass();
      this.subFrameLayers = null;
    }
  }

  private async drawFrame(frame: number): Promise<FrameResult> {
    if (this.disposed) throw new Error('This FrameRenderer was disposed');
    const { config, component, margin, background, blendSpace } = await this.readyPromise;
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
    const replays = !sequential && frame > 0 && transitionWindowSeconds() > 0 && !animationFramesQueued();
    // React state and virtual timers only move forward. Going back means starting the composition over.
    if (frame < this.lastFrame) noteDawnRewind();
    if (!replays && (frame < this.lastFrame || this.scene === null)) this.startScene(config);
    if (!sequential) {
      clearHistory();
      this.trailFrom = this.trailTo = -1;
    }
    const fresh = this.lastFrame < 0;
    // The frame the clock stood at before this one (frame 0 for a scene that has just started).
    const was = fresh ? 0 : this.lastFrame;
    this.lastFrame = frame;

    await waitForFonts();
    // A handle the project opened as it loaded (a WASM module's init) holds the first frame, as it holds every other.
    if (fresh) await whenReleased();
    let main!: RenderedTree;
    if (!replays) {
      const scene = this.scene!;
      if (fresh && frame > 0) {
        // Whatever the composition sets up when it mounts (an interval, a fetch) starts at frame 0, so a
        // frame looks the same whether the render began there or somewhere later.
        await this.replayFrame(scene, config, component, 0, true);
        // A page that animates and holds render targets may make them from what they held (a trail), which only the frames
        // rendered one after the other give. The page's own state (a rotation its callback adds to) cannot be put back,
        // so a render that found this out after stepping the callbacks, and started over, would run them twice.
        if (animationFramesQueued() && glHoldsTargets()) this.historyDependent = true;
      }
      if (gsapIsLoaded() || this.historyDependent) {
        // GSAP's tweens are made by effects, which a frame's render runs: an effect that starts a tween at frame 30 has
        // to run at 30 for a frame after it to show the tween where a render of every frame has it. So a jump renders
        // the frames it skips, with the clock on each, and reads nothing from them.
        // A WebGL render target a frame makes from what it held before (a trail) is the same, once a frame has shown it
        // (below): a draw made by a render or an animation-frame callback of a skipped frame is not made unless that
        // frame is rendered.
        const play = frameReplay();
        for (let at = was + 1; at < frame; at++) {
          if (play === null) {
            await this.replayFrame(scene, config, component, at);
            continue;
          }
          setVirtualFrame(at, config.fps, { deferAnimationFrames: true });
          // A source that says what its scripts see of a frame is played through that, without rendering the composition.
          await this.settle(scene, () => this.replay(play, at, config), true, false);
        }
      } else if (frame - was > 1 && glHoldsTargets()) {
        // A WebGL render target a frame reads that the frame before wrote is what that frame drew (a ping-pong that swaps
        // its targets each frame), so the frame before this one is rendered too; the frames before that are stepped.
        stepAnimationFrames(was + 1, frame - 1, config.fps);
        setVirtualFrame(frame - 1, config.fps, { deferAnimationFrames: true });
        await this.settle(scene, () => this.update(scene, this.element(component, config, frame - 1)), true, false);
      } else if (frame - was > 1 && dawnInUse() && animationFramesQueued()) {
        // A Dawn page's loop draws what the tree shows (a react-three-fiber `useFrame`: positions from `useCurrentFrame` through a ref the
        // render sets), and stepping its callbacks alone would run each skipped frame's with the props of the frame before the jump. So each
        // skipped frame is rendered, and its callbacks run with its own props, as in a render of every frame (nothing is read from it).
        for (let at = was + 1; at < frame; at++) await this.replayFrame(scene, config, component, at);
      } else {
        // A jump forward gives the animation-frame callbacks the frames it skipped (not rendered), so what is advanced
        // by their time (Motion) shows the same as in a render of every frame.
        stepAnimationFrames(was + 1, frame, config.fps);
      }
      setVirtualFrame(frame, config.fps, { deferAnimationFrames: true });
      setHistoryMode({ record: true });
      main = await this.settle(scene, () => this.update(scene, this.element(component, config, frame)));
      // A Dawn page whose state carries can show it a frame later than the one a jump landed on (it reads a resource the page made in a frame
      // the jump skipped, in the frame after): then the frame the jump landed on was drawn without the frames before it, which is said.
      const late = this.unreplayedJump >= 0 && frame > this.unreplayedJump && dawnDependsOnHistory();
      if ((frame - was > 1 ? glDependsOnHistory() : late) && !gsapIsLoaded() && !this.historyDependent) {
        const saidAt = late ? this.unreplayedJump : -1;
        // The frame makes a target from what it held before, and the frames it skipped were not rendered. A frame can
        // only be seen to do that by rendering it, so the composition starts over and renders the frames before it
        // (once: a later jump renders what it skips). A target that no frame writes after frame 0 (an environment map
        // drawn at mount) never gets here, and the skipped frames of a chunk are not rendered.
        this.historyDependent = true;
        this.startScene(config);
        clearHistory();
        setHistoryMode({ record: false });
        const again = this.scene!;
        for (let at = 0; at < frame; at++) await this.replayFrame(again, config, component, at, at === 0);
        setVirtualFrame(frame, config.fps, { deferAnimationFrames: true });
        setHistoryMode({ record: true });
        main = await this.settle(again, () => this.update(again, this.element(component, config, frame)));
        this.lastFrame = frame;
        // Said after the replay, whose renders start each from what a render says.
        if (saidAt >= 0) {
          reportUnsupported('canvas', 'webgpu', 'device', `the page's GPU state carries from frame to frame, and the jump to frame ${saidAt} drew it without the frames before it: frames ${saidAt} to ${frame - 1} are not what a render of every frame draws`);
        }
      }
      if (this.historyDependent || gsapIsLoaded()) this.unreplayedJump = -1;
      else if (frame - was > 1 && this.unreplayedJump < 0) this.unreplayedJump = frame;
    }
    // CSS transitions need the states of the islands before this frame (packages/cli/skills/kinetograph-markup/references/ENGINE.md §7.12). A frame has the
    // same history whichever frames were rendered before it: a sequential render keeps what it has seen, anything
    // else renders the frames of the window again, with the addon off, to see them.
    const window = Math.ceil(transitionWindowSeconds() * config.fps);
    if (window > 0) {
      if (!sequential) this.trailFrom = frame;
      this.trailTo = frame;
      const start = Math.max(0, frame - window);
      // A page whose animation-frame callbacks keep state (a rotation they add to) cannot be taken back to the start of the
      // window: the replay would run them again on top of what they already did, moving the page by the window's frames.
      if (frame > 0 && this.trailFrom > start && !animationFramesQueued()) {
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
        // The frames between 0 and the window were not rendered, so a target the frame makes from what it held before
        // is not what the page drew. Said in every such frame, as the render of every frame would draw it right.
        if (start > 1 && (this.historyDependent || glDependsOnHistory())) {
          reportUnsupported('canvas', 'webgl', 'render target', 'a render target is made from what it held before the frame (a trail) on a page with CSS transitions, whose frames that do not follow the one before are drawn from a replay of the transition window only, so it is not what the page drew');
        }
      }
    }
    setHistoryMode({ record: false });
    // What components that draw through a canvas left out, as the frame's own render reported it.
    for (const what of takeDawnReports()) reportUnsupported('canvas', 'webgpu', 'device', what);
    // A video or audio element the engine cannot play as asked (an unreadable file, a rate below 0) or a capture it refuses.
    for (const what of takeMediaIssues()) reportUnsupported('page', 'media', what, 'the page asked for something media elements cannot do here; it is drawn without');
    // What the page's audio used that the mix cannot do (page-audio.ts), said on every frame.
    for (const item of pageAudioNotes()) reportUnsupported('audio', item.property, item.value, item.reason);
    for (const what of takeGlReports()) reportUnsupported('canvas', 'webgl', 'render target', what);
    for (const what of takeLoadFailures()) reportUnsupported('page', 'load', what, `a load the page started failed; what needed it is drawn without`);
    let reported = reportedUnsupported();
    // The motion-blur sub-frames render the composition again; fonts or data they ask for are awaited too.
    const times = collectMotionTimes(main.layers, frame);
    let layers = main.layers;
    if (times.length > 0) {
      const treesAt = new Map<number, LayerJson[]>();
      // The samples share the islands' documents with the frame's own render (compat/dom), and only their blurred
      // layers are read: the rest of each sub-frame's tree is left out.
      this.openPass();
      // What a sub-frame draws into a WebGL render target is its own: the frame after this one starts from what the
      // frame's own render left, as it does when the frames before it were rendered without sub-frames.
      const restoreGl = snapshotGlStates();
      this.subFrameLayers = collectMotionLayers(main.layers, frame);
      for (const time of times) {
        if (time === frame) {
          treesAt.set(time, main.layers);
          continue;
        }
        // The clock sits on the sub-frame, but timers and Math.random() stay with the frame.
        setVirtualFrame(time, config.fps, { seedFrame: frame, fireTimers: false });
        // GSAP's root clock at the sub-frame, before the render (a component may read a tweened value as it renders)
        // and again after it (over what the render wrote), as a frame moves it before and after its own render.
        sampleGsapAt(time / config.fps);
        const live = this.scene!;
        const tree = await this.settle(live, () => this.update(live, this.element(component, config, time)), false);
        treesAt.set(time, tree.layers);
      }
      this.subFrameLayers = null;
      // What the sub-frames' recordings left out is said too, each once.
      for (const what of takeGlReports()) reportUnsupported('canvas', 'webgl', 'render target', what);
      // A sub-frame runs the page's GPU calls again: what they got wrong is this frame's, not the next one's.
      for (const what of takeDawnReports()) reportUnsupported('canvas', 'webgpu', 'device', what);
      const had = new Set(reported.map((item) => JSON.stringify(item)));
      reported = [...reported, ...reportedUnsupported().filter((item) => !had.has(JSON.stringify(item)))];
      restoreGl();
      // GSAP goes back to the frame's own time, as the frames after this one expect to find it.
      endGsapSamples();
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
    // Layers blend in sRGB unless the composition asks for linear light.
    if (blendSpace === 'linear') sceneJson.blendSpace = 'linear';
    // The scene's margin is the largest of the composition's and what the DOM islands' blurs need.
    const needed = Math.max(margin ?? 0, main.margin ?? 0);
    if (margin !== undefined || needed > 0) sceneJson.margin = needed;
    return { scene: sceneJson, audio: main.audio, pageAudio: takePageAudioOps(), sequences: main.sequences, ...(main.names !== undefined ? { names: main.names } : {}), unsupported: [...main.unsupported, ...reported, ...takePageErrors()] };
  }

  /** Renders `element`; a canvas redrawn by it starts from a new canvas's state (see `resetCanvasStates`). */
  private update(scene: SceneRoot, element: ReactNode): void {
    // The pass starts with the frame's own render (not the renders of earlier frames a fresh start or a replay makes).
    if (this.rendering === this.target) this.openPass();
    resetCanvasStates();
    clearReportedUnsupported();
    setReportIsRead(this.rendering === this.target);
    scene.update(element);
  }

  /**
   * Renders a frame the loop does not read (one of those a jump skips, or the frame a new scene starts with) so that the page's state is
   * what a render of every frame has made of it. With a Dawn page that is also its motion-blur sub-frames: in a render of every frame
   * each frame's sub-frames run the page's effects at their times, and what the effects draw into the GPU state the page keeps (a
   * feedback texture) is not undone, as a WebGL render target's is (`snapshotGlStates`). `read` draws the frame's tree, for a frame whose
   * tree the caller has no use for but whose canvases are read back (the frame a scene starts with, as the loop always has).
   */
  private async replayFrame(scene: SceneRoot, config: VideoConfig, component: ResolvedComposition['component'], at: number, read = false): Promise<void> {
    setVirtualFrame(at, config.fps, { deferAnimationFrames: true });
    const render = () => this.update(scene, this.element(component, config, at));
    const tree = read ? await this.settle(scene, render) : await this.settle(scene, render, true, false);
    if (!dawnInUse()) return;
    // The sub-frame times come from the layers' `motionBlur`, so the tree is read (a pass of the islands' documents is open for it, as it is for a frame's own).
    this.openPass();
    const layers = (tree ?? scene.snapshot()).layers;
    const times = collectMotionTimes(layers, at).filter((time) => time !== at);
    if (times.length === 0) return;
    const restoreGl = snapshotGlStates();
    this.subFrameLayers = collectMotionLayers(layers, at);
    try {
      for (const time of times) {
        setVirtualFrame(time, config.fps, { seedFrame: at, fireTimers: false });
        sampleGsapAt(time / config.fps);
        await this.settle(scene, () => this.update(scene, this.element(component, config, time)), false, false);
      }
    } finally {
      this.subFrameLayers = null;
      restoreGl();
      endGsapSamples();
      setVirtualFrame(at, config.fps, { fireTimers: false });
    }
  }

  /** `update` for a frame that is played through and not drawn, by what its source says its scripts see (`frame-replay.ts`). */
  private replay(play: FrameReplay, frame: number, config: VideoConfig): void {
    this.rendering = frame;
    resetCanvasStates();
    clearReportedUnsupported();
    setReportIsRead(false);
    play(frame, config.fps, config.durationInFrames);
  }

  private startScene(config: VideoConfig): void {
    // Remotion's page gives every element `box-sizing: border-box`: a `width: 100%` with padding does not overflow.
    setDefaultStylesheet(isRemotionPage() ? REMOTION_DEFAULT_CSS : null);
    breakSamplePasses();
    this.scene?.unmount();
    // `time` is the virtual clock in seconds (frame / fps, also on a motion-blur sub-frame): the clock CSS animations read.
    this.scene = createSceneRoot({
      viewport: { width: config.width, height: config.height },
      fonts: getFonts,
      time: () => virtualNow() / 1000,
      subFrameLayers: () => this.subFrameLayers,
      // A render that fails while a delayRender is open would otherwise wait for that handle's timeout.
      onError: (error) => rejectRenderWaits(error instanceof Error ? error : new Error(String(error))),
    });
    this.lastFrame = -1;
    this.unreplayedJump = -1;
    resetVirtualClock({ keepAnimationFrames: true });
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

  /**
   * A frame that gave up waiting for a `delayRender` handle never reaches its tree, and what stopped it may be what
   * the engine cannot draw (an `<iframe>` whose `onLoad` never fires). The error carries the unsupported items the
   * tree held when it gave up, as `unsupported`, for `doctor` to list.
   */
  private withLeftOut(error: unknown, scene: SceneRoot): unknown {
    if (!(error instanceof Error) || (error as { code?: unknown }).code !== DELAY_RENDER_TIMEOUT) return error;
    try {
      const held = [...scene.snapshot().unsupported, ...reportedUnsupported()];
      Object.assign(error, { unsupported: held });
    } catch {
      // The tree could not be read: the timeout is still the error.
    }
    return error;
  }

  /** Renders, then waits until nothing is pending and returns the tree as it stands (`read` false: no tree, a frame that is only played through). */
  private async settle(scene: SceneRoot, render: () => void, animationFrames: boolean, read: false): Promise<null>;
  private async settle(scene: SceneRoot, render: () => void, animationFrames?: boolean): Promise<RenderedTree>;
  private async settle(scene: SceneRoot, render: () => void, animationFrames = true, read = true): Promise<RenderedTree | null> {
    try {
      render();
    } catch (error) {
      // `cancelRender` is the better explanation when the code after it went on to fail.
      throw renderFailure() ?? error;
    }
    seenLoads = loadsSettled();
    // The callbacks have run for this tick and only the end of GPU reads is left to wait for: they are not run again for it.
    let ranForReadbacks = false;
    for (;;) {
      await waitForFonts();
      try {
        await whenReleased(animationFrames);
      } catch (error) {
        throw this.withLeftOut(error, scene);
      }
      // Let the state updates that continueRender's callers made reach the reconciler.
      await tick();
      // A script's `<img>` or `new Image()` that has not fired `load` yet holds the frame like a font that is still loading.
      if (openRenderHandles() > 0 || pendingFontLoads() > 0 || pendingImageLoads() > 0 || pendingFetches() > 0) {
        if (pendingFetches() > pendingReadbacks() || openRenderHandles() > 0 || pendingFontLoads() > 0 || pendingImageLoads() > 0) ranForReadbacks = false;
        continue;
      }
      // A load finished in this frame: what it was for (a Suspense of the page's own) reveals before the frame is read.
      if (loadsSettled() !== seenLoads) {
        ranForReadbacks = false;
        await runAfterLoads();
        continue;
      }
      if (!animationFrames) {
        // The 3D canvases draw now that the loads are done; what the draw starts is waited for in turn.
        if (drawSettled()) continue;
        break;
      }
      // requestAnimationFrame callbacks run once the frame has rendered, as a browser runs them before it paints:
      // a library that draws in one after being told what to show (Motion's render step) shows this frame, not the one before.
      if (ranForReadbacks) {
        ranForReadbacks = false;
        if (drawSettled()) continue;
        break;
      }
      const made = renderHandlesMade();
      runAnimationFrames();
      // GSAP renders what the frame's own render made (a `from()` is drawn lazily, on the next tick) at the frame's time.
      setGsapTime(virtualNow() / 1000);
      await tick();
      // A callback that started work (a map asking its workers for tiles, a fetch) holds the frame as a handle does: wait
      // for it, and run the callbacks its end asked for, until a pass leaves nothing pending.
      if (renderHandlesMade() === made && pendingFontLoads() === 0 && pendingImageLoads() === 0 && pendingFetches() === pendingReadbacks()) {
        // A read of the GPU's results (a timestamp query, a readback) that the callbacks started is waited for, as a browser's frame is
        // whatever the page awaits, and does not ask for the callbacks again.
        ranForReadbacks = pendingReadbacks() > 0;
        if (drawSettled()) continue;
        if (ranForReadbacks) continue;
        break;
      }
    }
    if (!animationFrames && read) {
      // A motion-blur sub-frame: what plays on GSAP's root clock is shown at the sub-frame's time (undone after the
      // last one, by `endGsapSamples`).
      sampleGsapAt(virtualNow() / 1000);
    }
    // A Dawn canvas is read back to pixels once the page has drawn: only a frame that is read pays for it.
    if (read) await flushDawnCanvases();
    const tree = read ? scene.snapshot() : null;
    const failure = renderFailure();
    if (failure) throw failure;
    return tree;
  }
}

const REMOTION_DEFAULT_CSS = '* { box-sizing: border-box; }';

export function createFrameRenderer(
  compositionId: string,
  options?: { inputProps?: Record<string, unknown> },
): FrameRenderer {
  return new Renderer(compositionId, options?.inputProps);
}
