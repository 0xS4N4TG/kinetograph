// `@remotion/rive` (packages/cli/skills/kinetograph/references/AUTHORING.md §7.6): `<RemotionRiveCanvas>`. Remotion plays the file with Rive's WebAssembly
// runtime in a `<canvas>`; this plays it with Rive's own C++ runtime inside the addon (packages/cli/skills/kinetograph/references/AUTHORING.md §7.6) and
// draws what it asks for on the same `<canvas>`, so the element is laid out and styled as the DOM element it is in
// Remotion. A frame is played from the file's start to the frame's time, never from what was played before, with the
// state machine inputs given for each frame up to it.

import { statSync } from 'node:fs';
import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, type ForwardedRef, type ReactNode } from 'react';
import { addonFunction, getDomEnvironment, hasAddonFunction, resolveProjectFile } from '@kinetographdev/compat/dom';
import type { CanvasCommand } from '@kinetographdev/scene';
import { continueRender, delayRender } from './assets.js';
import { EffectsBox, hasEffects, type EffectsOutputSize, type EffectsProp } from './effects.js';
import { reportUnsupported } from './unsupported.js';
import { Sequence, useCurrentFrame, useVideoConfig } from './timeline.js';

export type RemotionRiveCanvasFit = 'contain' | 'cover' | 'fill' | 'fit-height' | 'fit-width' | 'none' | 'scale-down';

export type RemotionRiveCanvasAlignment =
  | 'center'
  | 'bottom-center'
  | 'bottom-left'
  | 'bottom-right'
  | 'center-left'
  | 'center-right'
  | 'top-center'
  | 'top-left'
  | 'top-right';

/** A state machine input's value: a boolean, a number, or `'fire'` (or `true`) for a trigger. */
export type RiveInputValue = boolean | number | 'fire';
export type RiveInputs = Record<string, RiveInputValue>;

export interface RemotionRiveCanvasProps {
  /** A `.riv` file: a path, or `staticFile(...)`. A URL cannot be fetched; download the file. */
  src: string;
  fit?: RemotionRiveCanvasFit;
  alignment?: RemotionRiveCanvasAlignment;
  /** By name or position; the file's default artboard when left out. */
  artboard?: string | number;
  /** A linear animation, by name or position; the artboard's first when left out. */
  animation?: string | number;
  /** Plays a state machine instead of an animation (not in Remotion's props), from its start. */
  stateMachine?: string | number;
  /**
   * The state machine's inputs (not in Remotion's props): an object holds from the start; a function of the frame gives
   * the inputs at each frame, and the machine meets each change at that frame's time. A trigger fires at each frame
   * whose value is `true` or `'fire'`.
   */
  stateMachineInputs?: RiveInputs | ((frame: number) => RiveInputs);
  className?: string;
  style?: Record<string, string | number | undefined>;
  /** Called with the file (its artboards, animations and state machines) when the canvas renders. */
  onLoad?: (file: RiveFile) => void;
  /**
   * Called once per file for each asset: decode bytes into it (`asset.decode(bytes)`) and answer true, or answer false.
   * One that answers true and decodes later holds the frame until it does.
   */
  assetLoader?: (asset: RiveFileAsset, bytes: Uint8Array) => boolean;
  effects?: EffectsProp;
  effectsOutputSize?: EffectsOutputSize | null;
  /** Accepted: the file's embedded pictures are used; one on Rive's CDN is not fetched (give it with `assetLoader`). */
  enableRiveAssetCdn?: boolean;
  /** As `<Sequence>`'s. */
  from?: number;
  durationInFrames?: number;
  name?: string;
}

// ---- what the addon says about a file ----

interface AnimationInfo {
  name: string;
  fps: number;
  duration: number;
  speed: number;
  loop: number;
  workStart: number;
  workEnd: number;
  enableWorkArea: boolean;
}
interface InputInfo {
  name: string;
  type: 'bool' | 'number' | 'trigger';
  value?: boolean | number;
}
interface ArtboardInfo {
  name: string;
  width: number;
  height: number;
  animations: AnimationInfo[];
  stateMachines: { name: string; inputs: InputInfo[] }[];
}
interface AssetInfo {
  type: 'image' | 'font' | 'audio' | 'other';
  name: string;
  uniqueFilename: string;
  fileExtension: string;
  cdnUuid: string;
  embedded: boolean;
  supplied: boolean;
}
interface FileInfo {
  artboards: ArtboardInfo[];
  assets: AssetInfo[];
}

// ---- the runtime's objects, as far as they describe the file ----

export interface RiveLinearAnimation {
  name: string;
  fps: number;
  /** In frames of the animation. */
  duration: number;
  speed: number;
  loopValue: number;
  workStart: number;
  workEnd: number;
  enableWorkArea: boolean;
}

export interface RiveStateMachineInput {
  name: string;
  /** Rive's `SMIInput` types: 56 is a number, 59 a boolean, 58 a trigger. */
  type: number;
}

export interface RiveStateMachine {
  name: string;
  inputCount(): number;
  input(index: number): RiveStateMachineInput | null;
}

export interface RiveArtboard {
  name: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  width: number;
  height: number;
  animationCount(): number;
  animationByIndex(index: number): RiveLinearAnimation | null;
  animationByName(name: string): RiveLinearAnimation | null;
  stateMachineCount(): number;
  stateMachineByIndex(index: number): RiveStateMachine | null;
  stateMachineByName(name: string): RiveStateMachine | null;
}

export interface RiveFile {
  artboardCount(): number;
  artboardByIndex(index: number): RiveArtboard | null;
  artboardByName(name: string): RiveArtboard | null;
  defaultArtboard(): RiveArtboard | null;
}

/** What `getAnimationInstance()` gives: the animation played and its time at the frame. */
export interface RiveAnimationInstance {
  animation: RiveLinearAnimation;
  /** Seconds into the animation. */
  time: number;
  /** True for a state machine. */
  stateMachine: RiveStateMachine | null;
}

/** An asset of the file, as `assetLoader` is given it. */
export interface RiveFileAsset {
  name: string;
  fileExtension: string;
  uniqueFilename: string;
  cdnUuid: string;
  isImage: boolean;
  isFont: boolean;
  isAudio: boolean;
  /** Uses `bytes` (a PNG, JPEG or WebP picture, or a font file) for the asset. */
  decode(bytes: Uint8Array): void;
  /** Rive's setters, for what `decodeImage` and `decodeFont` made. */
  setRenderImage(image: RiveDecoded): void;
  setFont(font: RiveDecoded): void;
  setAudioSource(audio: RiveDecoded): void;
}

/** What `decodeImage` and `decodeFont` make: the bytes, for `setRenderImage` and `setFont`. */
export interface RiveDecoded {
  readonly bytes: Uint8Array;
  unref(): void;
}

/** Rive's `decodeImage`: the picture, for `asset.setRenderImage`. */
export function decodeImage(bytes: Uint8Array): Promise<RiveDecoded> {
  return Promise.resolve({ bytes: Uint8Array.from(bytes), unref: () => {} });
}

/** Rive's `decodeFont`: the font, for `asset.setFont`. */
export function decodeFont(bytes: Uint8Array): Promise<RiveDecoded> {
  return Promise.resolve({ bytes: Uint8Array.from(bytes), unref: () => {} });
}

/**
 * What Remotion's `ref` gives. The runtime is in the addon, so these describe what it plays: the canvas element, the
 * artboard and the animation (or state machine) at the frame's time. `getRenderer` answers null: the drawing is the
 * canvas's commands, not a renderer object.
 */
export interface RiveCanvasRef {
  getAnimationInstance: () => RiveAnimationInstance | null;
  getArtboard: () => RiveArtboard | null;
  getRenderer: () => null;
  getCanvas: () => unknown;
}

/** What the `<canvas>` element's ref is: the DOM shim's element, whose 2D context records its commands. */
interface CanvasHost {
  getContext(type: '2d'): { reset(): void; commands: CanvasCommand[] } | null;
}

const INPUT_TYPES = { number: 56, trigger: 58, bool: 59 } as const;

function animationOf(info: AnimationInfo): RiveLinearAnimation {
  const { loop, ...rest } = info;
  return { ...rest, loopValue: loop };
}

function stateMachineOf(info: { name: string; inputs: InputInfo[] }): RiveStateMachine {
  return {
    name: info.name,
    inputCount: () => info.inputs.length,
    input: (i) => {
      const input = info.inputs[i];
      return input ? { name: input.name, type: INPUT_TYPES[input.type] } : null;
    },
  };
}

function artboardOf(info: ArtboardInfo): RiveArtboard {
  const pick = <T, R>(list: T[], by: (item: T) => string, make: (item: T) => R) => ({
    index: (i: number) => (list[i] ? make(list[i]!) : null),
    name: (name: string) => {
      const found = list.find((item) => by(item) === name);
      return found ? make(found) : null;
    },
  });
  const animations = pick(info.animations, (a) => a.name, animationOf);
  const machines = pick(info.stateMachines, (m) => m.name, stateMachineOf);
  return {
    name: info.name,
    width: info.width,
    height: info.height,
    bounds: { minX: 0, minY: 0, maxX: info.width, maxY: info.height },
    animationCount: () => info.animations.length,
    animationByIndex: animations.index,
    animationByName: animations.name,
    stateMachineCount: () => info.stateMachines.length,
    stateMachineByIndex: machines.index,
    stateMachineByName: machines.name,
  };
}

function fileOf(info: FileInfo): RiveFile {
  return {
    artboardCount: () => info.artboards.length,
    artboardByIndex: (i) => (info.artboards[i] ? artboardOf(info.artboards[i]!) : null),
    artboardByName: (name) => {
      const found = info.artboards.find((a) => a.name === name);
      return found ? artboardOf(found) : null;
    },
    defaultArtboard: () => (info.artboards[0] ? artboardOf(info.artboards[0]) : null),
  };
}

/** The artboard, animation or state machine a prop names, by name or position. */
function chosen<T extends { name: string }>(list: T[], select: string | number | undefined): T | undefined {
  if (select === undefined) return list[0];
  return typeof select === 'number' ? list[select] : list.find((item) => item.name === select);
}

// ---- assets given by `assetLoader` ----

interface LoadedAssets {
  /** By file name, base64; replaced by a new object when the loader's later work settles, so memos see it. */
  assets: Record<string, string>;
  /** Settles when every asset the loader answered true for has been decoded (or its decode promise failed). */
  pending: Promise<void> | null;
}

/**
 * What `assetLoader` gave a file's assets, kept by the file (path and modification time) and the loader's source text:
 * an inline arrow is a new function every render, and the same code for the same file gives the same assets.
 */
const given = new Map<string, LoadedAssets>();

function runLoader(src: string, info: FileInfo, loader: NonNullable<RemotionRiveCanvasProps['assetLoader']>): LoadedAssets {
  let stamp = '';
  try {
    stamp = String(statSync(src).mtimeMs);
  } catch {
    // A missing file fails in the addon, with its name.
  }
  const key = `${src}\u0000${stamp}\u0000${String(loader)}`;
  const known = given.get(key);
  if (known) return known;
  const assets: Record<string, string> = {};
  const waits: Promise<void>[] = [];
  for (const asset of info.assets) {
    // Settles when the asset gets its bytes: a loader that answers true and decodes later (after a fetch, or a
    // `decodeImage` promise) is waited for by that call itself, never by a timer (a render's timers are the frame's).
    let decoded!: () => void;
    const done = new Promise<void>((resolve) => (decoded = resolve));
    const use = (bytes: Uint8Array) => {
      assets[asset.uniqueFilename] = Buffer.from(bytes).toString('base64');
      decoded();
    };
    const proxy: RiveFileAsset = {
      name: asset.name,
      fileExtension: asset.fileExtension,
      uniqueFilename: asset.uniqueFilename,
      cdnUuid: asset.cdnUuid,
      isImage: asset.type === 'image',
      isFont: asset.type === 'font',
      isAudio: asset.type === 'audio',
      decode: use,
      setRenderImage: (image) => use(image.bytes),
      setFont: (font) => use(font.bytes),
      setAudioSource: (audio) => use(audio.bytes),
    };
    const answer = loader(proxy, new Uint8Array(0));
    if (answer && assets[asset.uniqueFilename] === undefined) waits.push(done);
  }
  const entry: LoadedAssets = { assets: { ...assets }, pending: null };
  if (waits.length > 0) {
    entry.pending = Promise.all(waits).then(() => {
      entry.assets = { ...assets };
      entry.pending = null;
    });
  }
  given.set(key, entry);
  return entry;
}

// ---- inputs ----

/** The inputs as the addon takes them: each change with the time of the frame it is given at. */
function inputChanges(inputs: RemotionRiveCanvasProps['stateMachineInputs'], frame: number, fps: number) {
  if (inputs === undefined) return [];
  const out: { time: number; name: string; value: boolean | number | 'fire' }[] = [];
  const add = (time: number, values: RiveInputs, previous: RiveInputs | null) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === 'fire') out.push({ time, name, value: 'fire' });
      else if (previous === null || !Object.is(previous[name], value)) out.push({ time, name, value });
    }
  };
  if (typeof inputs !== 'function') {
    add(0, inputs, null);
    return out;
  }
  let previous: RiveInputs | null = null;
  for (let f = 0; f <= Math.floor(frame); f += 1) {
    const values = inputs(f);
    add(f / fps, values, previous);
    previous = values;
  }
  return out;
}

/** A trigger's `true` is a fire: the addon is told the input's type. */
function typedChanges(changes: ReturnType<typeof inputChanges>, machine: { inputs: InputInfo[] } | undefined) {
  return changes.flatMap((change) => {
    const type = machine?.inputs.find((i) => i.name === change.name)?.type;
    if (type === 'trigger') return change.value === true || change.value === 'fire' ? [{ ...change, value: 'fire' as const }] : [];
    return [change];
  });
}

function Content(props: RemotionRiveCanvasProps, ref: ForwardedRef<RiveCanvasRef>): ReactNode {
  const { src, fit = 'contain', alignment = 'center', artboard, animation, stateMachine, stateMachineInputs, className, style, onLoad, assetLoader, effects, effectsOutputSize } = props;
  const { width, height, fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const canvas = useRef<CanvasHost | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) {
    throw new Error(`<RemotionRiveCanvas src="${src}">: a URL cannot be fetched while rendering; download the file and use staticFile()`);
  }
  const file = resolveProjectFile(src) ?? src;
  const baseDir = getDomEnvironment().baseDir;
  const describe = (assets?: Record<string, string>): FileInfo | null =>
    hasAddonFunction('riveInfo') ? (JSON.parse(addonFunction('riveInfo')(JSON.stringify({ src: file, baseDir, assets }))) as FileInfo) : null;

  // The assets `assetLoader` gives, once its promises settled; the frame waits for them.
  const bare = useMemo(() => describe(), [file, baseDir]);
  const loaded = assetLoader && bare ? runLoader(file, bare, assetLoader) : null;
  useLayoutEffect(() => {
    if (!loaded?.pending) return;
    const handle = delayRender(`<RemotionRiveCanvas> assetLoader of ${src}: waiting for it to decode the assets it answered true for`);
    void loaded.pending.then(() => {
      rerender();
      continueRender(handle);
    });
  }, [loaded, loaded?.pending]);
  const assets = loaded && !loaded.pending ? loaded.assets : undefined;
  const info = useMemo(() => (assets ? describe(assets) : bare), [bare, assets]);

  const board = info ? chosen(info.artboards, artboard) : undefined;
  const machineInfo = board && stateMachine !== undefined ? chosen(board.stateMachines, stateMachine) : undefined;
  const changes = typedChanges(inputChanges(stateMachineInputs, frame, fps), machineInfo ?? board?.stateMachines[0]);
  const changesKey = JSON.stringify(changes);

  for (const asset of info?.assets ?? []) {
    if (!asset.embedded && !asset.supplied) {
      reportUnsupported(
        'RemotionRiveCanvas',
        'assets',
        asset.uniqueFilename,
        asset.cdnUuid
          ? `the ${asset.type} "${asset.name}" is on Rive's CDN, which a render does not fetch: put ${asset.uniqueFilename} beside the .riv file or give it with assetLoader; what uses it is drawn without it`
          : `the ${asset.type} "${asset.name}" is not in the file: put ${asset.uniqueFilename} beside the .riv file or give it with assetLoader; what uses it is drawn without it`,
      );
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      getAnimationInstance: () => {
        if (!board) return null;
        const played = stateMachine === undefined ? chosen(board.animations, animation) : undefined;
        const machine = stateMachine !== undefined ? chosen(board.stateMachines, stateMachine) : undefined;
        if (!played && !machine) return null;
        return {
          animation: played ? animationOf(played) : { name: machine!.name, fps, duration: 0, speed: 1, loopValue: 0, workStart: 0, workEnd: 0, enableWorkArea: false },
          time: frame / fps,
          stateMachine: machine ? stateMachineOf(machine) : null,
        };
      },
      getArtboard: () => (board ? artboardOf(board) : null),
      getRenderer: () => null,
      getCanvas: () => canvas.current,
    }),
    [board, animation, stateMachine, frame, fps],
  );

  useLayoutEffect(() => {
    if (onLoad && info) onLoad(fileOf(info));
  }, [onLoad, info]);

  const commands = useMemo(() => {
    const request = {
      src: file,
      baseDir,
      artboard,
      animation,
      stateMachine,
      inputs: changes,
      assets,
      time: frame / fps,
      width,
      height,
      fit,
      alignment,
    };
    return JSON.parse(addonFunction('riveFrame')(JSON.stringify(request))) as CanvasCommand[];
  }, [file, baseDir, artboard, animation, stateMachine, changesKey, assets, frame, fps, width, height, fit, alignment]);

  useLayoutEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    context.reset();
    context.commands.push(...commands);
  }, [commands]);

  if (hasEffects(effects)) {
    return (
      <EffectsBox
        component="<RemotionRiveCanvas>"
        effects={effects}
        effectsOutputSize={effectsOutputSize}
        width={width}
        height={height}
        pixelDensity={undefined}
        className={className}
        style={style as never}
        source={(size) => <canvas ref={canvas as never} width={size.width} height={size.height} style={{ width: size.width, height: size.height }} />}
      />
    );
  }
  return <canvas ref={canvas as never} width={width} height={height} className={className} style={{ height, width, ...style }} />;
}

const Canvas = forwardRef<RiveCanvasRef, RemotionRiveCanvasProps>(Content);

/** Plays a Rive file in a `<canvas>` as large as the composition, as Remotion's does. */
export const RemotionRiveCanvas = forwardRef<RiveCanvasRef, RemotionRiveCanvasProps>(function RemotionRiveCanvas(props, ref) {
  const { from, durationInFrames, name } = props;
  return (
    <Sequence layout="none" from={from} durationInFrames={durationInFrames} name={name ?? '<RemotionRiveCanvas>'}>
      <Canvas ref={ref} {...props} />
    </Sequence>
  );
});
RemotionRiveCanvas.displayName = 'RemotionRiveCanvas';
