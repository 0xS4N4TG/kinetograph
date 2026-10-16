// `makeHtmlInCanvasPresentation`: a presentation drawn by a WebGL shader over the two scenes of a transition, the way the
// published package draws its shader presentations (`blurSlide`, `crossZoom`, ...). There, a browser hands each scene to
// the shader as the picture of an element drawn into a canvas. Here the shader is recorded, as any WebGL code is
// (docs/AUTHORING.md §6.7), and the pictures are the two scenes' layers: the renderer draws each scene, uploads it as
// the texture the shader samples, and runs the shader's own GLSL on the GPU (docs/SCENE.md, "Shader groups"). Nothing
// here reads a clock; the picture is a function of the progress.

import { useContext, type ReactNode } from 'react';
import { Layer } from '@kinetograph/react';
import { createWebGLContext, layerPicture, type GL, type GL2, type GlslContent, type WebGLContext } from '@kinetograph/scene';
import { useVideoConfig } from '../timeline.js';
import { TransitionIdContext } from './context.js';
import type { PresentationComponentProps, TransitionPresentation } from './types.js';

/** What a shader is given of a scene: its size. Uploading it with `gl.texImage2D` samples the scene as drawn. */
export interface ShaderImage {
  readonly width: number;
  readonly height: number;
}

/** A WebGL context as a page uses it: the calls, and the constants (`gl.TEXTURE_2D`) on the context itself. */
export type ShaderGL = WebGLContext & typeof GL & typeof GL2;

/**
 * The canvas a shader draws on: a recorder, whose WebGL context the renderer replays on the GPU. The shader asks it for
 * a `webgl2` (or `webgl`) context and draws into it.
 */
export interface ShaderCanvas {
  width: number;
  height: number;
  getContext(type: 'webgl' | 'webgl2', attributes?: Record<string, unknown>): ShaderGL | null;
}

export interface HtmlInCanvasShaderDrawParams<Props> {
  /** The scene coming in. */
  prevImage: ShaderImage | null;
  /** The scene going out. */
  nextImage: ShaderImage | null;
  width: number;
  height: number;
  /** The progress of the transition: 0 shows `nextImage`, 1 shows `prevImage`. */
  time: number;
  passedProps: Props;
}

export type HtmlInCanvasShaderDraw<Props> = (params: HtmlInCanvasShaderDrawParams<Props>) => void;

export type HtmlInCanvasShader<Props> = (canvas: ShaderCanvas) => {
  clear: () => void;
  cleanup: () => void;
  draw: HtmlInCanvasShaderDraw<Props>;
};

/** The props every shader presentation takes besides its own. */
type WithEffects<P> = P & {
  /** Effects of the published package's canvas effect chain; not available here (see `HtmlInCanvasPresentation`). */
  effects?: unknown;
  effectsOutputSize?: unknown;
};

class RecordingCanvas implements ShaderCanvas {
  private gl: ShaderGL | null = null;
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(type: 'webgl' | 'webgl2', attributes?: Record<string, unknown>): ShaderGL | null {
    if (type !== 'webgl' && type !== 'webgl2') return null;
    this.gl ??= createWebGLContext({ size: () => ({ width: this.width, height: this.height }), version: type === 'webgl2' ? 2 : 1, canvas: this, attributes }) as ShaderGL;
    return this.gl;
  }
  /** What the shader drew. */
  content(): GlslContent {
    return this.gl?.content() ?? { programs: {}, buffers: {}, textures: {}, ops: [] };
  }
}

let warnedEffects = false;

/**
 * The presentation of a shader: the scene going out is held back as a texture, and the scene coming in is drawn by the
 * shader over it. `bothEnteringAndExiting` needs nothing special: a scene between two transitions is the texture of
 * the one it leaves, as the picture the other transition's shader has made of it.
 */
function HtmlInCanvasPresentation<Props extends Record<string, unknown>>({
  children,
  presentationProgress,
  presentationDirection,
  shader,
  passedProps,
}: PresentationComponentProps<WithEffects<Props>> & { readonly shader: HtmlInCanvasShader<Props> }): ReactNode {
  const { width, height } = useVideoConfig();
  const transition = useContext(TransitionIdContext);
  if (transition === null) throw new Error('A presentation made by makeHtmlInCanvasPresentation() is drawn by a <TransitionSeries.Transition />');
  const outgoing = `${transition}-out`;
  if (presentationDirection === 'exiting') return <Layer id={outgoing}>{children}</Layer>;

  const { effects, effectsOutputSize: _size, ...props } = passedProps;
  if (effects !== undefined && !warnedEffects) {
    warnedEffects = true;
    console.warn('A shader presentation ignores `effects`: the published package runs them on a canvas in a browser.');
  }
  const incoming = `${transition}-in`;
  const canvas = new RecordingCanvas(width, height);
  const instance = shader(canvas);
  instance.draw({
    prevImage: layerPicture(incoming, width, height),
    nextImage: layerPicture(outgoing, width, height),
    width,
    height,
    time: presentationProgress,
    passedProps: props as unknown as Props,
  });
  instance.cleanup();
  return (
    <Layer glsl={{ width, height, ...canvas.content() }}>
      <Layer id={incoming}>{children}</Layer>
    </Layer>
  );
}

/**
 * A presentation drawn by `shader`: a function of a canvas that returns `draw`, which is called with the two scenes as
 * pictures to upload as textures, the progress as `time`, and the props of the presentation.
 */
export function makeHtmlInCanvasPresentation<Props extends Record<string, unknown>>(
  shader: HtmlInCanvasShader<Props>,
): (props?: WithEffects<Props>) => TransitionPresentation<WithEffects<Props>> {
  function Presentation(props: PresentationComponentProps<WithEffects<Props>>): ReactNode {
    return <HtmlInCanvasPresentation {...props} shader={shader} />;
  }
  return (props = {} as WithEffects<Props>) => ({ component: Presentation, props });
}
