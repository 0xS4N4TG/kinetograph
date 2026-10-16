// IFrame, Artifact, HtmlInCanvas, createEffect, Solid and CanvasImage (docs/AUTHORING.md §7.1). The browser-canvas
// parts are not run; what they draw without them is checked here, and createEffect against the published package.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Artifact,
  CanvasImage,
  createEffect,
  getHtmlInCanvasUnsupportedMessage,
  HTML_IN_CANVAS_UNSUPPORTED_MESSAGE,
  HtmlInCanvas,
  IFrame,
  isHtmlInCanvasSupported,
  Solid,
} from '../src/index.js';
import { resetWarnings } from '../src/warn.js';
import { renderDom, sent, summary, useFakeDom } from './dom-harness.js';
import { fixture } from './helpers.js';
import { renderAt } from './scene-harness.js';

useFakeDom(['iframe']);

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetWarnings();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

const never = createEffect<{ radius?: number }, object>({
  type: 'test/blur',
  label: 'Blur',
  documentationLink: null,
  backend: '2d',
  calculateKey: ({ radius }) => `blur-${radius}`,
  setup: () => ({}),
  apply: () => undefined,
  cleanup: () => undefined,
  schema: {},
  validateParams: () => undefined,
});

describe('createEffect', () => {
  const blur = createEffect<{ radius: number }, object>({
    type: 'test/blur',
    label: 'Blur',
    documentationLink: undefined as never,
    backend: '2d',
    calculateKey: (params) => `blur-${params.radius}`,
    setup: () => ({}),
    apply: () => undefined,
    cleanup: () => undefined,
    schema: { radius: { type: 'number', default: 4, description: 'Radius' } },
    validateParams: (params) => {
      if (typeof params.radius !== 'number') throw new Error('radius is required');
    },
  });
  const tint = createEffect<object, object>({
    type: 'test/tint',
    label: 'Tint',
    documentationLink: 'https://example.com/tint',
    backend: 'webgl2',
    calculateKey: () => 'tint',
    setup: () => ({}),
    apply: () => undefined,
    cleanup: () => undefined,
    schema: {},
    validateParams: () => undefined,
  });

  it('returns descriptors that match the published package: key with the disabled flag, schema with the disabled field', () => {
    const makers: Record<string, () => ReturnType<typeof tint>> = {
      'blur 4': () => blur({ radius: 4 }),
      'blur 4 disabled': () => blur({ radius: 4, disabled: true }),
      'blur 4 not disabled': () => blur({ radius: 4, disabled: false }),
      'blur missing radius': () => blur({} as never),
      'blur no params': () => (blur as unknown as () => ReturnType<typeof tint>)(),
      'tint no params': () => tint(),
      'tint disabled': () => tint({ disabled: true }),
    };
    const { cases } = fixture('effects.json');
    expect(cases).toHaveLength(Object.keys(makers).length);
    for (const c of cases) {
      if (c.error) {
        expect(makers[c.name]!, c.name).toThrow(c.error);
        continue;
      }
      const descriptor = makers[c.name]!();
      expect(
        {
          effectKey: descriptor.effectKey,
          params: descriptor.params,
          memoized: descriptor.memoized,
          type: descriptor.definition.type,
          label: descriptor.definition.label,
          documentationLink: descriptor.definition.documentationLink,
          backend: descriptor.definition.backend,
          schema: descriptor.definition.schema,
          keyOfOtherParams: descriptor.definition.calculateKey({ radius: 99 }),
        },
        c.name,
      ).toEqual(c.result);
    }
  });
});

describe('IFrame', () => {
  it('is an iframe element, with Remotion\'s referrer policy and without its delayRender props', () => {
    const tree = renderDom(<IFrame src="https://example.com" delayRenderRetries={2} delayRenderTimeoutInMilliseconds={9000} title="embed" />);
    expect(sent[0].root.tag).toBe('iframe');
    expect(sent[0].root.attrs).toEqual({ src: 'https://example.com', title: 'embed', referrerpolicy: 'strict-origin-when-cross-origin' });
    // The CSS engine reports an iframe as unsupported, so a frame with one fails `--strict`.
    expect(tree.unsupported).toHaveLength(1);
    expect(tree.unsupported[0]).toMatchObject({ element: 'iframe' });
  });
});

describe('Artifact', () => {
  it('draws nothing and says once that the file is not written', () => {
    expect(renderAt(<Artifact filename="a.txt" content="hi" />).layers).toEqual([]);
    renderAt(<Artifact filename="b.png" content={Artifact.Thumbnail} />);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/not written/);
    expect(typeof Artifact.Thumbnail).toBe('symbol');
  });
});

describe('HtmlInCanvas', () => {
  it('is not supported, and says why', () => {
    expect(isHtmlInCanvasSupported()).toBe(false);
    expect(HtmlInCanvas.isSupported()).toBe(false);
    expect(HtmlInCanvas.isNestingSupported()).toBe(false);
    expect(getHtmlInCanvasUnsupportedMessage()).toBe(HTML_IN_CANVAS_UNSUPPORTED_MESSAGE);
    expect(HTML_IN_CANVAS_UNSUPPORTED_MESSAGE).toMatch(/Canvas Draw Element/);
  });

  it('shows its children in a clipped box of its size, as the canvas shows them', () => {
    renderDom(
      <HtmlInCanvas width={300} height={200}>
        <p>hello</p>
      </HtmlInCanvas>,
    );
    expect(summary(sent[0].root)).toEqual({
      tag: 'div',
      style: 'width: 300px; height: 200px; overflow: hidden',
      children: [{ tag: 'p', children: ['hello'] }],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once when onPaint, onInit or an enabled effect would have changed the picture', () => {
    const noop = () => undefined;
    renderDom(<HtmlInCanvas width={10} height={10} onPaint={noop}>x</HtmlInCanvas>);
    renderDom(<HtmlInCanvas width={10} height={10} onInit={() => noop}>x</HtmlInCanvas>);
    renderDom(<HtmlInCanvas width={10} height={10} effects={[never({ disabled: true })]}>x</HtmlInCanvas>);
    expect(warn).toHaveBeenCalledTimes(1);
    renderDom(<HtmlInCanvas width={10} height={10} effects={[never({ radius: 2 })]}>x</HtmlInCanvas>);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]![0]).toMatch(/without its effects \(Blur\)/);
  });

  it('refuses a size that is not a positive whole number, as Remotion does', () => {
    expect(() => renderDom(<HtmlInCanvas width={0} height={10}>x</HtmlInCanvas>)).toThrow('`width` must be a positive integer. Received: 0.');
    expect(() => renderDom(<HtmlInCanvas width={10} height={2.5}>x</HtmlInCanvas>)).toThrow('`height` must be a positive integer. Received: 2.5.');
    expect(() => renderDom(<HtmlInCanvas width={'10' as never} height={10}>x</HtmlInCanvas>)).toThrow('`width` and `height` must be numbers');
    expect(() => renderDom(<HtmlInCanvas width={10} height={10} pixelDensity={0}>x</HtmlInCanvas>)).toThrow('`pixelDensity` must be a positive finite number. Received: 0.');
  });
});

describe('Solid', () => {
  it('is a box of its size filled with its colour, and crops, styles and times like the other Studio components', () => {
    renderDom(<Solid width={400} height={300} color="#ff0066" className="bg" style={{ borderRadius: 8 }} cropBottom={0.5} />);
    expect(sent[0].root.tag).toBe('div');
    expect(sent[0].root.attrs).toEqual({ class: 'bg' });
    expect(sent[0].root.style).toBe('width: 400px; height: 300px; background-color: #ff0066; border-radius: 8px; clip-path: inset(0% 0% 50% 0% round 8px)');
    expect(renderDom(<Solid width={4} height={4} from={10} />, 5).sequences[0]).toMatchObject({ name: '<Solid>', from: 10 });
  });

  it('is transparent without a colour', () => {
    renderDom(<Solid width={4} height={4} />);
    expect(sent[0].root.style).toBe('width: 4px; height: 4px');
  });

  it('warns about an enabled effect only, and refuses a bad pixelDensity', () => {
    renderDom(<Solid width={4} height={4} effects={[never({ disabled: true })]} />);
    expect(warn).not.toHaveBeenCalled();
    renderDom(<Solid width={4} height={4} effects={[never({ radius: 1 })]} />);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => renderDom(<Solid width={4} height={4} pixelDensity={-1} />)).toThrow('<Solid>: `pixelDensity` must be a positive finite number. Received: -1.');
  });
});

describe('CanvasImage', () => {
  it('is an image layer of its size and fit, when nothing needs CSS', () => {
    const [image] = renderAt(<CanvasImage src="/p/cat.png" width={200} height={100} fit="cover" />).layers as any[];
    expect(image).toMatchObject({ type: 'image', src: '/p/cat.png', width: 200, height: 100, fit: 'cover' });
  });

  it('is fitted by fill unless told otherwise', () => {
    const [image] = renderAt(<CanvasImage src="/p/cat.png" width={20} height={20} />).layers as any[];
    expect(image.fit).toBe('fill');
  });

  it('is an img with the CSS when it has a class, a crop or a style', () => {
    renderDom(<CanvasImage src="/p/cat.png" width={200} className="pic" cropLeft={0.25} />);
    expect(sent[0].root.tag).toBe('img');
    expect(sent[0].root.attrs).toMatchObject({ src: '/p/cat.png', class: 'pic', width: '200' });
    expect(sent[0].root.style).toBe('object-fit: fill; clip-path: inset(0% 0% 0% 25%)');
  });

  it('needs a src, and warns about an enabled effect', () => {
    expect(() => renderAt(<CanvasImage src="" />)).toThrow('No "src" prop was passed to <CanvasImage>.');
    renderAt(<CanvasImage src="/p/cat.png" effects={[never({ radius: 1 })]} />);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
