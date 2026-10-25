// Effects and `<HtmlInCanvas>` programs run on recording canvases: what a chain emits (a group per effect, with a GLSL or
// canvas pass over the layer before it), what the effect and `onPaint` are handed, and what is left out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasCommand, GroupLayer, LayerJson } from '@kinetographdev/scene';
import { CanvasImage, createEffect, HtmlInCanvas, Solid } from '../src/index.js';
import { clearReportedUnsupported, reportedUnsupported } from '../src/unsupported.js';
import { resetWarnings } from '../src/warn.js';
import { renderDom, useFakeDom } from './dom-harness.js';
import { bindQuad, useProgram } from '../src/gl-recording.js';
import { GPUDeviceShim } from '@kinetographdev/scene';
import { filtered, gpu, gpuCompute, shaded, tinted } from './effect-fixtures.js';
import { renderAt } from './scene-harness.js';

useFakeDom();

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetWarnings();
  clearReportedUnsupported();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

/** The first layer of the tree that is a group with this pass, and its children, through nested groups. */
function groupsOf(layers: LayerJson[], out: GroupLayer[] = []): GroupLayer[] {
  for (const layer of layers) {
    if (layer.type === 'group') {
      out.push(layer);
      groupsOf(layer.children, out);
    }
  }
  return out;
}

/** The pass groups of a tree, outermost first. */
function chainOf(layers: LayerJson[]): GroupLayer[] {
  return groupsOf(layers).filter((g) => g.glsl !== undefined || g.canvas !== undefined);
}

function source(group: GroupLayer): string {
  return group.children.find((c) => c.id.endsWith('-src'))!.id;
}

describe('a 2D effect', () => {
  it('is a canvas pass over the picture, which the effect drew with drawImage', () => {
    const tree = renderDom(<Solid width={64} height={48} color="#f00" effects={[filtered({ filter: 'invert(1)' })]} />);
    const [pass, ...rest] = chainOf(tree.layers);
    expect(rest).toEqual([]);
    expect(pass!.canvas).toMatchObject({ width: 64, height: 48 });
    const commands = pass!.canvas!.commands as CanvasCommand[];
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      op: 'image',
      source: { kind: 'layer', width: 64, height: 48 },
      dx: 0,
      dy: 0,
      dw: 64,
      dh: 48,
      filter: [{ type: 'invert', amount: 1 }],
    });
    const layer = (commands[0] as Extract<CanvasCommand, { op: 'image' }>).source;
    expect(layer.kind === 'layer' && layer.id).toBe(pass!.children[0]!.id);
  });

  it('can draw over the picture (a tint)', () => {
    const tree = renderDom(<Solid width={8} height={8} color="#00f" effects={[tinted({ color: '#ff0', amount: 0.5 })]} />);
    const commands = chainOf(tree.layers)[0]!.canvas!.commands as CanvasCommand[];
    expect(commands.map((c) => c.op)).toEqual(['image', 'fill']);
    expect(commands[1]).toMatchObject({ blend: 'source-atop', a: 0.5 });
  });

  it('is asked for its setup, apply and cleanup in that order, with the params and the size, for every frame', () => {
    const calls: string[] = [];
    const probe = createEffect<{ n: number }, { made: number }>({
      type: 'test/probe',
      label: 'Probe',
      documentationLink: null,
      backend: '2d',
      calculateKey: ({ n }) => `probe-${n}`,
      setup: () => {
        calls.push('setup');
        return { made: 7 };
      },
      apply: ({ state, params, width, height, flipSourceY, gpuDevice, source: picture, target }) => {
        calls.push(`apply ${state.made} ${params.n} ${width}x${height} flip=${flipSourceY} gpu=${gpuDevice} source=${picture.width}x${picture.height} target=${target.width}x${target.height}`);
      },
      cleanup: (state) => calls.push(`cleanup ${state.made}`),
      schema: {},
      validateParams: () => undefined,
    });
    renderDom(<Solid width={30} height={20} effects={[probe({ n: 3 })]} />, 0);
    renderDom(<Solid width={30} height={20} effects={[probe({ n: 3 })]} />, 5);
    expect(calls).toEqual([
      'setup',
      'apply 7 3 30x20 flip=true gpu=null source=30x20 target=30x20',
      'cleanup 7',
      'setup',
      'apply 7 3 30x20 flip=true gpu=null source=30x20 target=30x20',
      'cleanup 7',
    ]);
  });
});

describe('a WebGL 2 effect', () => {
  it('is a GLSL pass that samples the picture, uploaded flipped and premultiplied as the pool of Remotion sets it', () => {
    const tree = renderAt(<CanvasImage src="/p/cat.png" width={200} height={100} effects={[shaded({ mult: [1, 0, 0] })]} />);
    const [pass] = chainOf(tree.layers);
    expect(pass!.glsl).toMatchObject({ width: 200, height: 100, premultipliedAlpha: true, alpha: true });
    const [texture] = Object.values(pass!.glsl!.textures!);
    expect(texture).toEqual({ layer: source(pass!), flipY: true, premultiply: true });
    expect(Object.values(pass!.glsl!.programs!)[0]!.fragment).toContain('uniform vec3 mult');
    // The picture is the image drawn at the size of the canvas, in the group the pass samples.
    const picture = pass!.children[0]! as GroupLayer;
    expect(picture.children[0]).toMatchObject({ type: 'image', src: '/p/cat.png', width: 200, height: 100, fit: 'fill' });
  });

  it('keeps the image fit', () => {
    const tree = renderAt(<CanvasImage src="/p/cat.png" width={20} height={10} fit="cover" effects={[shaded()]} />);
    expect(groupsOf(tree.layers).flatMap((g) => g.children).find((c) => c.type === 'image')).toMatchObject({ fit: 'cover' });
  });

  it('is skipped when disabled, and then nothing is wrapped', () => {
    const tree = renderAt(<CanvasImage src="/p/cat.png" width={20} height={10} effects={[shaded({ disabled: true } as never)]} />);
    expect(chainOf(tree.layers)).toEqual([]);
    expect(tree.layers[0]).toMatchObject({ type: 'image' });
  });
});

describe('a chain', () => {
  it('runs each effect over the picture the one before made, the last one outermost', () => {
    const tree = renderDom(<Solid width={64} height={48} color="#0f0" effects={[shaded({ mult: [0.5, 1, 1] }), filtered({ filter: 'invert(1)' }), shaded({ invert: true })]} />);
    const [last, middle, first] = chainOf(tree.layers);
    expect(first!.glsl).toBeDefined();
    expect(middle!.canvas).toBeDefined();
    expect(last!.glsl).toBeDefined();
    expect(first!.children[0]!.id).toMatch(/-src$/);
    expect(middle!.children[0]!.id).toBe(first!.id);
    expect(last!.children[0]!.id).toBe(middle!.id);
    const sampled = (g: GroupLayer) => Object.values(g.glsl!.textures!)[0]!.layer;
    expect(sampled(first!)).toBe(first!.children[0]!.id);
    expect(sampled(last!)).toBe(middle!.id);
    const drawn = (middle!.canvas!.commands![0] as Extract<CanvasCommand, { op: 'image' }>).source;
    expect(drawn.kind === 'layer' && drawn.id).toBe(first!.id);
  });

  it('skips a disabled effect in the middle and passes the picture on', () => {
    const tree = renderDom(<Solid width={8} height={8} effects={[shaded(), filtered({ filter: 'blur(2px)', disabled: true } as never), tinted({ color: '#fff' })]} />);
    const [last, first] = chainOf(tree.layers);
    expect(last!.children[0]!.id).toBe(first!.id);
  });

  it('makes the canvases of effectsOutputSize, and shows them in the size of the element', () => {
    const tree = renderDom(<Solid width={64} height={48} effects={[shaded()]} effectsOutputSize={{ width: 128, height: 96 }} />);
    expect(chainOf(tree.layers)[0]!.glsl).toMatchObject({ width: 128, height: 96 });
  });

  it('makes them pixelDensity times the size', () => {
    const tree = renderDom(<Solid width={64} height={48} pixelDensity={2} effects={[shaded()]} />);
    expect(chainOf(tree.layers)[0]!.glsl).toMatchObject({ width: 128, height: 96 });
  });

  it('is a pure function of the frame: the same props give the same tree', () => {
    const element = <Solid width={16} height={16} color="#123" effects={[shaded({ mult: [1, 0.5, 0.25] }), tinted({ color: '#f0f' })]} />;
    const strip = (layers: LayerJson[]): string => JSON.stringify(layers).replace(/fx_kgr_\w+_/g, 'fx_ID_').replace(/\bt[0-9a-f]{16}\b/g, 'tHASH');
    expect(strip(renderDom(element, 3).layers)).toBe(strip(renderDom(element, 3).layers));
    expect(strip(renderDom(element, 3).layers)).toBe(strip(renderDom(element, 9).layers));
  });
});

describe('params and sizes', () => {
  it('are refused when an effect says so, before anything draws', () => {
    expect(() => filtered({ filter: '' })).toThrow('`filter` is required');
    expect(() => tinted({ color: '#fff', amount: 2 })).toThrow('`amount` must be a number from 0 to 1');
    expect(() => shaded({ mult: [1, 2] as never })).toThrow('`mult` must be three numbers');
  });

  it('are refused for an output size that is not a positive whole number', () => {
    expect(() => renderDom(<Solid width={4} height={4} effects={[shaded()]} effectsOutputSize={{ width: 0, height: 4 }} />)).toThrow('The "effectsOutputSize.width" prop on an effect-capable component must be positive, but got 0.');
    expect(() => renderDom(<Solid width={4} height={4} effects={[shaded()]} effectsOutputSize={{ width: 4, height: 2.5 }} />)).toThrow('must be an integer, but is 2.5.');
  });

  it('are refused for an item of effects that is not an effect', () => {
    expect(() => renderDom(<Solid width={4} height={4} effects={[{ definition: {}, params: {} } as never]} />)).toThrow('is not an effect');
  });
});

describe('<HtmlInCanvas> onPaint and onInit', () => {
  const overlay = ({ canvas, elementImage }: { canvas: any; elementImage: any }) => {
    const ctx = canvas.getContext('2d');
    ctx.reset();
    ctx.drawElementImage(elementImage, 0, 0);
    ctx.fillStyle = '#ff0';
    ctx.fillRect(2, 3, 10, 5);
  };

  it('draws the element picture and an overlay with a 2D context', () => {
    const tree = renderDom(
      <HtmlInCanvas width={100} height={50} onPaint={overlay}>
        <p>hi</p>
      </HtmlInCanvas>,
    );
    const [pass] = chainOf(tree.layers);
    const commands = pass!.canvas!.commands as CanvasCommand[];
    expect(commands.map((c) => c.op)).toEqual(['image', 'fill']);
    expect(commands[0]).toMatchObject({ source: { kind: 'layer', id: pass!.children[0]!.id, width: 100, height: 50 }, dw: 100, dh: 50 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('hands onPaint the canvas, the element, its picture and the pixel density', () => {
    let seen: any;
    renderDom(
      <HtmlInCanvas width={100} height={50} pixelDensity={1} onPaint={(params) => {
          seen = params;
        }}>
        x
      </HtmlInCanvas>,
    );
    expect(seen.canvas).toMatchObject({ width: 100, height: 50 });
    expect(seen.pixelDensity).toBe(1);
    expect(seen.elementImage).toMatchObject({ width: 100, height: 50 });
    expect(seen.element.getBoundingClientRect()).toMatchObject({ width: 100, height: 50 });
    expect(() => seen.elementImage.close()).not.toThrow();
  });

  it('draws the element with a WebGL 2 context and texElementImage2D', () => {
    const paint = ({ canvas, elementImage }: { canvas: any; elementImage: any }) => {
      const gl = canvas.getContext('webgl2');
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texElementImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, elementImage);
      const program = useProgram(gl, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }', 'precision mediump float; uniform sampler2D tex; void main() { gl_FragColor = texture2D(tex, vec2(0.5)); }');
      bindQuad(gl, program, 'p');
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const tree = renderDom(
      <HtmlInCanvas width={10} height={10} onPaint={paint}>
        x
      </HtmlInCanvas>,
    );
    const [pass] = chainOf(tree.layers);
    expect(pass!.glsl).toBeDefined();
    expect(Object.values(pass!.glsl!.textures!)[0]).toMatchObject({ layer: pass!.children[0]!.id });
  });

  it('runs onInit before onPaint and the cleanup it returns after, and the effects over what onPaint drew', () => {
    const order: string[] = [];
    const tree = renderDom(
      <HtmlInCanvas
        width={10}
        height={10}
        onInit={() => {
          order.push('init');
          return () => order.push('cleanup');
        }}
        onPaint={(params) => {
          order.push('paint');
          overlay(params);
        }}
        effects={[shaded()]}
      >
        x
      </HtmlInCanvas>,
    );
    expect(order).toEqual(['init', 'paint', 'cleanup']);
    const [effect, paint] = chainOf(tree.layers);
    expect(effect!.glsl).toBeDefined();
    expect(paint!.canvas).toBeDefined();
    expect(effect!.children[0]!.id).toBe(paint!.id);
  });

  it('needs onInit to return a cleanup function, as Remotion says', () => {
    expect(() => renderDom(<HtmlInCanvas width={4} height={4} onInit={(() => undefined) as never}>x</HtmlInCanvas>)).toThrow('it must return a cleanup function');
  });

  it('draws the picture of the element on a 2D context when only onInit is given', () => {
    const tree = renderDom(
      <HtmlInCanvas width={4} height={4} onInit={() => () => undefined}>
        x
      </HtmlInCanvas>,
    );
    expect(chainOf(tree.layers)[0]!.canvas!.commands).toHaveLength(1);
  });

  it('runs effects alone over the children without an onPaint stage', () => {
    const tree = renderDom(
      <HtmlInCanvas width={4} height={4} effects={[filtered({ filter: 'invert(1)' })]}>
        x
      </HtmlInCanvas>,
    );
    expect(chainOf(tree.layers)).toHaveLength(1);
  });

  it('is supported, and still the plain clipped box with nothing to run', () => {
    expect(HtmlInCanvas.isSupported()).toBe(true);
    const tree = renderDom(<HtmlInCanvas width={4} height={4}>x</HtmlInCanvas>);
    expect(chainOf(tree.layers)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('WebGPU', () => {
  it('runs: the layer before it is an upload from a layer, and the pass is the `webgpu` part of a glsl pass', () => {
    const tree = renderDom(<Solid width={8} height={8} color="#f00" effects={[gpu({})]} />);
    const [group] = chainOf(tree.layers);
    expect(group!.glsl).toMatchObject({ width: 8, height: 8 });
    const webgpu = (group!.glsl as { webgpu?: { passes: { k: string; source?: unknown }[]; textures: object } }).webgpu!;
    expect(webgpu.passes.map((p) => p.k)).toEqual(['upload', 'render']);
    expect(webgpu.passes[0]!.source).toEqual({ layer: expect.stringMatching(/-src$/) });
    expect(Object.keys(webgpu.textures)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(reportedUnsupported()).toEqual([]);
  });

  it('stacks with the other backends in order', () => {
    const tree = renderDom(<Solid width={8} height={8} color="#f00" effects={[shaded(), gpu({})]} />);
    expect(chainOf(tree.layers)).toHaveLength(2);
  });

  it('a WebGPU call that is not drawn is warned about once and reported, and the picture is drawn without the effect', () => {
    const tree = renderDom(<Solid width={8} height={8} color="#f00" effects={[gpuCompute({}), shaded()]} />);
    expect(chainOf(tree.layers)).toHaveLength(1);
    renderDom(<Solid width={8} height={8} effects={[gpuCompute({})]} />);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/draws without a WebGPU effect \(GpuCompute\)/);
    expect(reportedUnsupported()).toEqual([expect.objectContaining({ element: 'Solid', property: 'effects', value: 'GpuCompute' })]);
  });

  it('runs onPaint that asks for a WebGPU context', () => {
    const tree = renderDom(
      <HtmlInCanvas width={4} height={4} onPaint={({ canvas }) => { canvas.getContext('webgpu'); }}>
        x
      </HtmlInCanvas>,
    );
    expect(chainOf(tree.layers)).toHaveLength(1);
    expect(reportedUnsupported()).toEqual([]);
  });

  it('is reported when onPaint makes a WebGPU call that is not drawn, and the children are drawn as they are', () => {
    const tree = renderDom(
      <HtmlInCanvas
        width={4}
        height={4}
        onPaint={({ canvas }) => {
          const ctx = canvas.getContext('webgpu');
          ctx.configure({ device: new GPUDeviceShim(), format: 'rgba8unorm' });
          ctx.getConfiguration().device.createQuerySet();
        }}
      >
        x
      </HtmlInCanvas>,
    );
    expect(chainOf(tree.layers)).toEqual([]);
    expect(reportedUnsupported()).toEqual([expect.objectContaining({ element: 'HtmlInCanvas', property: 'onPaint', value: 'webgpu' })]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('fails --strict: the frame loop hands the report on', async () => {
    const { Composition, registerRoot, resetCompositions } = await import('../src/compositions.js');
    const { createFrameRenderer } = await import('../src/frame-loop.js');
    resetCompositions();
    registerRoot(() => (
      <Composition id="Gpu" component={() => <Solid width={8} height={8} effects={[gpuCompute({})]} />} width={32} height={32} fps={30} durationInFrames={2} />
    ));
    const renderer = createFrameRenderer('Gpu');
    const frame = await renderer.renderFrame(0);
    expect(frame.unsupported).toEqual([expect.objectContaining({ element: 'Solid', property: 'effects' })]);
    renderer.dispose();
  });
});
