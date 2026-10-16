// The shader presentations of `@remotion/transitions` (blur-slide, cross-zoom, ...): what a transition between two scenes
// emits (a shader group that samples both scenes), the uniforms each shader is given, and the progress contexts.

import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createSceneRoot, Rect, TimelineContext } from '@kinetograph/react';
import type { GlslDraw, GlslPass, GroupLayer, LayerJson } from '@kinetograph/scene';
import { TransitionSeries, linearTiming, useTransitionProgress, makeHtmlInCanvasPresentation } from '../src/transitions/index.js';
import type { TransitionPresentation } from '../src/transitions/types.js';
import { blurSlide, blurSlideMotion } from '../src/transitions/blur-slide.js';
import { bookFlip } from '../src/transitions/book-flip.js';
import { crossZoom } from '../src/transitions/cross-zoom.js';
import { crosswarp } from '../src/transitions/crosswarp.js';
import { dissolve } from '../src/transitions/dissolve.js';
import { dreamyZoom } from '../src/transitions/dreamy-zoom.js';
import { filmBurn } from '../src/transitions/film-burn.js';
import { linearBlur } from '../src/transitions/linear-blur.js';
import { pushCut } from '../src/transitions/push-cut.js';
import { ripple } from '../src/transitions/ripple.js';
import { swap } from '../src/transitions/swap.js';
import { zoomBlur } from '../src/transitions/zoom-blur.js';
import { zoomInOut } from '../src/transitions/zoom-in-out.js';
import { timeline } from './scene-harness.js';

const W = 1280;
const H = 720;
const config = { id: 'T', width: W, height: H, fps: 30, durationInFrames: 90, defaultProps: {}, props: {} };

function sceneA(): ReactNode {
  return <Rect id="rect-a" width={10} height={10} fill="#f00" />;
}
function sceneB(): ReactNode {
  return <Rect id="rect-b" width={10} height={10} fill="#00f" />;
}

/** Scene A runs from 0 to 60 and B from 30 to 90; the transition is frames 30 to 60. */
function transitionAt(frame: number, presentation: TransitionPresentation<any>, scenes: [ReactNode, ReactNode] = [sceneA(), sceneB()]): LayerJson[] {
  const root = createSceneRoot();
  try {
    return root.render(
      <TimelineContext.Provider value={timeline(frame, { config })}>
        <TransitionSeries>
          <TransitionSeries.Sequence durationInFrames={60}>{scenes[0]}</TransitionSeries.Sequence>
          <TransitionSeries.Transition presentation={presentation} timing={linearTiming({ durationInFrames: 30 })} />
          <TransitionSeries.Sequence durationInFrames={60}>{scenes[1]}</TransitionSeries.Sequence>
        </TransitionSeries>
      </TimelineContext.Provider>,
    ).layers as LayerJson[];
  } finally {
    root.unmount();
  }
}

/** The shader groups of a tree. */
function shaderGroups(layers: LayerJson[]): GroupLayer[] {
  return layers.flatMap((l) => (l.type === 'group' ? [...(l.glsl ? [l] : []), ...shaderGroups(l.children)] : []));
}

function idsIn(layer: LayerJson): string[] {
  return [layer.id, ...(layer.type === 'group' ? layer.children.flatMap(idsIn) : [])];
}

/** The value of a uniform of the pass's only draw. */
function uniform(pass: GlslPass, name: string): number[] {
  const draw = pass.ops!.find((op): op is { op: 'draw' } & GlslDraw => op.op === 'draw')!;
  return draw.uniforms[name]![0]!.value;
}

describe('a shader presentation', () => {
  it('draws nothing but the scenes outside its transition', () => {
    for (const frame of [10, 75]) {
      expect(shaderGroups(transitionAt(frame, crossZoom({})))).toEqual([]);
    }
  });

  it('is a shader group over the scene coming in, which samples the scene going out as well', () => {
    const layers = transitionAt(40, crossZoom({}));
    const [pass] = shaderGroups(layers);
    expect(pass).toBeDefined();
    const textures = Object.values(pass!.glsl!.textures!);
    const [incoming, outgoing] = textures.map((t) => t.layer!);
    expect(textures).toHaveLength(2);
    // Both scenes are inputs of the pass; they are drawn nowhere else.
    expect(pass!.children.map((c) => c.id).sort()).toEqual([incoming, outgoing].sort());
    const everywhere = layers.flatMap(idsIn);
    expect(everywhere.filter((id) => id === 'rect-a')).toHaveLength(1);
    expect(everywhere.filter((id) => id === 'rect-b')).toHaveLength(1);
    const owner = (id: string) => pass!.children.find((c) => c.id === id)!;
    expect(idsIn(owner(incoming!))).toContain('rect-b');
    expect(idsIn(owner(outgoing!))).toContain('rect-a');
    expect(pass!.glsl).toMatchObject({ width: W, height: H });
  });

  it('gives the shader the progress of the transition and its props', () => {
    const pass = shaderGroups(transitionAt(45, crossZoom({ strength: 0.7 })))[0]!.glsl!;
    expect(uniform(pass, 'u_time')).toEqual([0.5]);
    expect(uniform(pass, 'u_strength')).toEqual([0.7]);
    const defaults = shaderGroups(transitionAt(45, crossZoom({})))[0]!.glsl!;
    expect(uniform(defaults, 'u_strength')).toEqual([0.4]);
    const draw = pass.ops!.find((op) => op.op === 'draw') as { op: 'draw' } & GlslDraw;
    expect(draw.mode).toBe('triangleStrip');
    expect(draw.viewport).toEqual([0, 0, W, H]);
  });

  it('uses the shader the published package has for each presentation', () => {
    const cases: [string, TransitionPresentation<any>, string][] = [
      ['blurSlide', blurSlide(), 'u_blur_length'],
      ['bookFlip', bookFlip({ direction: 'from-top' }), 'u_direction'],
      ['crossZoom', crossZoom({}), 'u_strength'],
      ['crosswarp', crosswarp({}), 'u_time'],
      ['dissolve', dissolve({}), 'u_hot_color'],
      ['dreamyZoom', dreamyZoom({}), 'u_ratio'],
      ['filmBurn', filmBurn({}), 'u_seed'],
      ['linearBlur', linearBlur({}), 'u_intensity'],
      ['ripple', ripple({}), 'u_amplitude'],
      ['swap', swap({}), 'u_depth'],
      ['zoomBlur', zoomBlur({}), 'u_max_angle'],
      ['zoomInOut', zoomInOut({}), 'u_time'],
    ];
    for (const [name, presentation, uniformName] of cases) {
      const [pass] = shaderGroups(transitionAt(40, presentation));
      expect(pass, name).toBeDefined();
      expect(uniform(pass!.glsl!, uniformName), `${name} ${uniformName}`).toHaveLength(uniformName === 'u_hot_color' ? 3 : 1);
    }
  });

  it('has the defaults and the values of the published package', () => {
    const at = (presentation: TransitionPresentation<any>, name: string) => uniform(shaderGroups(transitionAt(40, presentation))[0]!.glsl!, name);
    // Frame 40 of a 30 frame transition from frame 30 is a third of the way.
    expect(at(ripple({}), 'u_amplitude')).toEqual([100]);
    expect(at(ripple({ speed: 7 }), 'u_speed')).toEqual([7]);
    expect(at(dreamyZoom({}), 'u_rotation')).toEqual([6]);
    expect(at(dreamyZoom({}), 'u_scale')).toEqual([1.2]);
    expect(at(dreamyZoom({}), 'u_ratio')[0]).toBeCloseTo(W / H, 6);
    expect(at(filmBurn({}), 'u_seed')[0]).toBeCloseTo(2.31, 6);
    expect(at(linearBlur({}), 'u_intensity')[0]).toBeCloseTo(0.1, 6);
    expect(at(swap({}), 'u_reflection')[0]).toBeCloseTo(0.4, 6);
    expect(at(swap({}), 'u_perspective')[0]).toBeCloseTo(0.2, 6);
    expect(at(swap({}), 'u_depth')).toEqual([3]);
    expect(at(zoomBlur({}), 'u_max_angle')[0]).toBeCloseTo(Math.PI / 6, 6);
    expect(at(zoomBlur({}), 'u_aspect')[0]).toBeCloseTo(W / H, 6);
    expect(at(dissolve({}), 'u_spread_color')).toEqual([1, 0, 0]);
    expect(at(dissolve({}), 'u_hot_color').map((c) => Math.round(c * 255))).toEqual([0xe6, 0xe6, 0x33]);
    expect(at(dissolve({ spreadColor: '#00ff80' }), 'u_spread_color').map((c) => Math.round(c * 255))).toEqual([0, 255, 128]);
    expect(at(bookFlip({}), 'u_direction')).toEqual([1]);
    expect(at(bookFlip({ direction: 'from-left' }), 'u_direction')).toEqual([0]);
    expect(at(bookFlip({ direction: 'from-top' }), 'u_direction')).toEqual([2]);
    expect(at(bookFlip({ direction: 'from-bottom' }), 'u_direction')).toEqual([3]);
  });

  it('refuses what the published package refuses', () => {
    expect(() => blurSlide({ direction: 'sideways' as never })).toThrow(/direction passed to blurSlide\(\) must be one of/);
    expect(() => blurSlide({ blur: -1 })).toThrow(/blur passed to blurSlide\(\) must be greater than or equal to 0, received -1/);
    expect(() => blurSlide({ blur: Number.NaN })).toThrow(/must be a finite number/);
    expect(() => pushCut({ cutProgress: 1 })).toThrow(/cutProgress passed to pushCut\(\) must be greater than 0 and less than 1/);
    expect(() => pushCut({ outgoingScale: 0 })).toThrow(/outgoingScale passed to pushCut\(\) must be greater than 0/);
    expect(() => pushCut({ flashOpacity: 2 })).toThrow(/flashOpacity passed to pushCut\(\) must be between 0 and 1/);
    expect(() => pushCut({ flashFrames: -1 })).toThrow(/flashFrames passed to pushCut\(\) must be greater than or equal to 0/);
    const bad = dissolve({ hotColor: 'red' });
    expect(() => transitionAt(40, bad)).toThrow(/Invalid color "red" passed to dissolve\(\)/);
  });
});

describe('blurSlide', () => {
  it('slides with a quintic ease and blurs most half way', () => {
    // At the start the scene going out is at rest, with no blur; the slide has travelled half way at half time.
    expect(blurSlideMotion(0, 0.5)).toEqual({ progress: 1, blurLength: 0 });
    expect(blurSlideMotion(1, 0.5)).toEqual({ progress: 0, blurLength: 0 });
    const half = blurSlideMotion(0.5, 0.5);
    expect(half.progress).toBeCloseTo(0.5, 12);
    expect(half.blurLength).toBeCloseTo(0.5, 12);
    expect(blurSlideMotion(0.25, 0.5).progress).toBeCloseTo(0.896484375, 9);
  });

  it('slides the way it is told to and wraps the scenes round', () => {
    const vector = (direction: string) => uniform(shaderGroups(transitionAt(40, blurSlide({ direction: direction as never })))[0]!.glsl!, 'u_direction');
    expect(vector('from-left')).toEqual([1, 0]);
    expect(vector('from-right')).toEqual([-1, 0]);
    expect(vector('from-top')).toEqual([0, 1]);
    expect(vector('from-bottom')).toEqual([0, -1]);
    const draw = shaderGroups(transitionAt(40, blurSlide()))[0]!.glsl!.ops!.find((op) => op.op === 'draw') as { op: 'draw' } & GlslDraw;
    expect(Object.values(draw.units).map((u) => u.wrapS)).toEqual(['REPEAT', 'REPEAT']);
  });
});

describe('makeHtmlInCanvasPresentation', () => {
  it('runs a shader of the published package\'s shape: both scenes uploaded as textures, drawn with the progress', () => {
    const seen: { time: number; prev: number; next: number; width: number }[] = [];
    const presentation = makeHtmlInCanvasPresentation<{ tint?: number }>((canvas) => {
      const gl = canvas.getContext('webgl2', { premultipliedAlpha: true })!;
      const vs = gl.createShader(gl.VERTEX_SHADER)!;
      gl.shaderSource(vs, '#version 300 es\nin vec2 a_pos;\nvoid main() { gl_Position = vec4(a_pos, 0.0, 1.0); }');
      const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(fs, '#version 300 es\nprecision highp float;\nuniform sampler2D t;\nuniform float k;\nout vec4 o;\nvoid main() { o = texture(t, vec2(0.5)) * k; }');
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(gl.getAttribLocation(program, 'a_pos'));
      gl.vertexAttribPointer(gl.getAttribLocation(program, 'a_pos'), 2, gl.FLOAT, false, 0, 0);
      const texture = gl.createTexture();
      return {
        clear: () => gl.clear(gl.COLOR_BUFFER_BIT),
        cleanup: () => gl.deleteTexture(texture),
        draw({ prevImage, nextImage, time, width, passedProps }) {
          seen.push({ time, prev: prevImage!.width, next: nextImage!.width, width });
          gl.useProgram(program);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, prevImage);
          gl.uniform1i(gl.getUniformLocation(program, 't'), 0);
          gl.uniform1f(gl.getUniformLocation(program, 'k'), passedProps.tint ?? 1);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        },
      };
    });
    const [pass] = shaderGroups(transitionAt(50, presentation({ tint: 0.25 })));
    expect(seen).toEqual([{ time: 20 / 30, prev: W, next: W, width: W }]);
    expect(uniform(pass!.glsl!, 'k')).toEqual([0.25]);
    expect(Object.values(pass!.glsl!.textures!)).toEqual([{ layer: expect.stringMatching(/-in$/) }]);
  });

  it('is drawn by a transition', () => {
    const { component: Presentation, props } = crossZoom({});
    const root = createSceneRoot();
    try {
      expect(() =>
        root.render(
          <TimelineContext.Provider value={timeline(0, { config })}>
            <Presentation presentationProgress={0} presentationDirection="entering" presentationDurationInFrames={10} passedProps={props}>
              <Rect width={1} height={1} fill="#fff" />
            </Presentation>
          </TimelineContext.Provider>,
        ),
      ).toThrow(/drawn by a <TransitionSeries.Transition \/>/);
    } finally {
      root.unmount();
    }
  });

  it('takes a scene that is also leaving into the next transition as the picture of the first', () => {
    // B runs 30..60 and is in a transition at both ends (A to B over 30..45, B to C over 45..60).
    const root = createSceneRoot();
    try {
      const layers = root.render(
        <TimelineContext.Provider value={timeline(50, { config })}>
          <TransitionSeries>
            <TransitionSeries.Sequence durationInFrames={45}>{sceneA()}</TransitionSeries.Sequence>
            <TransitionSeries.Transition presentation={crossZoom({})} timing={linearTiming({ durationInFrames: 15 })} />
            <TransitionSeries.Sequence durationInFrames={30}>{sceneB()}</TransitionSeries.Sequence>
            <TransitionSeries.Transition presentation={ripple({})} timing={linearTiming({ durationInFrames: 15 })} />
            <TransitionSeries.Sequence durationInFrames={45}>
              <Rect id="rect-c" width={10} height={10} fill="#0f0" />
            </TransitionSeries.Sequence>
          </TransitionSeries>
        </TimelineContext.Provider>,
      ).layers as LayerJson[];
      // At frame 50 only B to C runs (A to B ended at frame 45): C's shader group takes B.
      const passes = shaderGroups(layers);
      expect(passes).toHaveLength(1);
      expect(passes[0]!.children.flatMap(idsIn)).toEqual(expect.arrayContaining(['rect-b', 'rect-c']));
    } finally {
      root.unmount();
    }
  });
});

describe('useTransitionProgress', () => {
  function Probe({ log }: { log: ReturnType<typeof useTransitionProgress>[] }): ReactNode {
    log.push(useTransitionProgress());
    return null;
  }
  const progressAt = (frame: number) => {
    const log: ReturnType<typeof useTransitionProgress>[] = [];
    const root = createSceneRoot();
    try {
      root.render(
        <TimelineContext.Provider value={timeline(frame, { config })}>
          <TransitionSeries>
            <TransitionSeries.Sequence durationInFrames={60}>
              <Probe log={log} />
            </TransitionSeries.Sequence>
            <TransitionSeries.Transition presentation={crosswarp({})} timing={linearTiming({ durationInFrames: 30 })} />
            <TransitionSeries.Sequence durationInFrames={60}>
              <Probe log={log} />
            </TransitionSeries.Sequence>
          </TransitionSeries>
        </TimelineContext.Provider>,
      );
    } finally {
      root.unmount();
    }
    return log;
  };

  it('says a scene is not in a transition outside one', () => {
    expect(progressAt(10)).toEqual([{ isInTransitionSeries: false, entering: 1, exiting: 0 }]);
    expect(progressAt(80)).toEqual([{ isInTransitionSeries: false, entering: 1, exiting: 0 }]);
  });

  it('gives the progress of the transition to both scenes in it', () => {
    // Frame 45: halfway through. The scene going out is exiting at 0.5 and the one coming in entering at 0.5.
    const seen = progressAt(45);
    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual({ isInTransitionSeries: true, entering: 1, exiting: 0.5 });
    expect(seen).toContainEqual({ isInTransitionSeries: true, entering: 0.5, exiting: 0 });
  });
});
