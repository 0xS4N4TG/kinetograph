// IFrame, Artifact, HtmlInCanvas, createEffect, Solid and CanvasImage (packages/cli/skills/kinetograph/references/AUTHORING.md §7.1). The browser-canvas
// parts are not run; what they draw without them is checked here, and createEffect against the published package.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Artifact,
  CanvasImage,
  clearArtifacts,
  createEffect,
  getArtifacts,
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
  beforeEach(() => clearArtifacts());

  it('draws nothing and records its file for the render to write, by the frame it was rendered in', () => {
    expect(renderAt(<Artifact filename="a.txt" content="hi" />, 7).layers).toEqual([]);
    renderAt(<Artifact filename="b.png" content={Artifact.Thumbnail} />, 12);
    const bytes = new Uint8Array([1, 2, 3]);
    renderAt(<Artifact filename="sub/c.bin" content={bytes} />, 3);
    expect(getArtifacts()).toEqual([
      { filename: 'a.txt', content: 'hi', frame: 7 },
      { filename: 'b.png', content: 'thumbnail', frame: 12 },
      { filename: 'sub/c.bin', content: bytes, frame: 3 },
    ]);
    expect(typeof Artifact.Thumbnail).toBe('symbol');
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the last record of a file', () => {
    renderAt(<Artifact filename="a.txt" content="one" />, 1);
    renderAt(<Artifact filename="a.txt" content="two" />, 2);
    expect(getArtifacts()).toEqual([{ filename: 'a.txt', content: 'two', frame: 2 }]);
  });

  it('refuses a name outside the output folder, and content it cannot write', () => {
    for (const bad of ['', '../x.txt', '/abs.txt', 'a/../b.txt', 'C:\\x.txt', 'a//b']) {
      expect(() => renderAt(<Artifact filename={bad} content="x" />), bad).toThrow(/Artifact/);
    }
    expect(() => renderAt(<Artifact filename="a.txt" content={5 as never} />)).toThrow(/content must be a string/);
    expect(getArtifacts()).toEqual([]);
  });
});

describe('HtmlInCanvas', () => {
  it('is supported (on recording canvases), nested ones are not tried, and the browser message is kept', () => {
    expect(isHtmlInCanvasSupported()).toBe(true);
    expect(HtmlInCanvas.isSupported()).toBe(true);
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

  it('is the plain box when nothing runs: no onPaint, no onInit, only disabled effects', () => {
    renderDom(<HtmlInCanvas width={10} height={10} effects={[never({ disabled: true })]}>x</HtmlInCanvas>);
    expect(summary(sent[0].root)).toMatchObject({ tag: 'div', style: 'width: 10px; height: 10px; overflow: hidden' });
    expect(warn).not.toHaveBeenCalled();
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

  it('is the plain box for a disabled effect, and refuses a bad pixelDensity', () => {
    renderDom(<Solid width={4} height={4} effects={[never({ disabled: true })]} />);
    expect(sent[0].root.style).toBe('width: 4px; height: 4px');
    expect(warn).not.toHaveBeenCalled();
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

  it('needs a src', () => {
    expect(() => renderAt(<CanvasImage src="" />)).toThrow('No "src" prop was passed to <CanvasImage>.');
  });
});
