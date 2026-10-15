// @vitest-environment jsdom
/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import {
  Audio,
  Camera,
  Ellipse,
  Gif,
  Image,
  Layer,
  Lottie,
  Noise,
  Path,
  Rect,
  Shape,
  Text,
  TimelineContext,
  Video,
  resetWarnings,
  takeWarnings,
  type TimelineState,
} from '../src/browser/index.js';

const config = { id: 'Main', width: 320, height: 180, fps: 30, durationInFrames: 60, defaultProps: {}, props: {} };
const timeline = (frame: number, extra: Partial<TimelineState> = {}): TimelineState => ({
  frame,
  absoluteFrame: frame,
  durationInFrames: 60,
  config,
  frozen: false,
  ...extra,
});

let container: HTMLElement;
let root: Root;
let uncaught: { error: unknown } | null;

beforeEach(() => {
  resetWarnings();
  uncaught = null;
  container = document.createElement('div');
  document.body.append(container);
  // React 19 hands an error no boundary caught to this callback instead of throwing it.
  root = createRoot(container, {
    onUncaughtError: (error) => {
      uncaught = { error };
    },
  });
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

/** Renders `element` at `frame` and returns the container's first element child. */
function draw(element: ReactNode, frame = 0, state: Partial<TimelineState> = {}): HTMLElement {
  uncaught = null;
  flushSync(() => root.render(<TimelineContext.Provider value={timeline(frame, state)}>{element}</TimelineContext.Provider>));
  const failure = uncaught as { error: unknown } | null;
  if (failure) throw failure.error;
  return container.firstElementChild as HTMLElement;
}

describe('Layer', () => {
  it('is a div whose style is the layer transform about the anchor and origin', () => {
    const el = draw(<Layer x={40} y={20} rotation={30} scale={2} anchorX={10} anchorY={5} />);
    expect(el.tagName).toBe('DIV');
    expect(el.className).toBe('kg-el kg-layer kg-box');
    // translate(x - anchor) rotate scale, about the anchor: the matrix of SCENE.md "Layers".
    expect(el.style.transform).toBe('translate(30px, 15px) rotate(30deg) scale(2)');
    expect(el.style.transformOrigin).toBe('10px 5px');
  });

  it('adds the origin as a fraction of the box, only for a group with a layout', () => {
    const boxed = draw(<Layer layout={{ width: 200, height: 100 }} origin="center" rotation={10} />);
    expect(boxed.style.transformOrigin).toBe('50% 50%');
    const free = draw(<Layer origin="center" rotation={10} />);
    // A group without a layout has no box, so the origin is ignored.
    expect(free.style.transformOrigin).toBe('0px 0px');
  });

  it('turns in 3D after the 2D matrix, and a preserve3d group keeps its children in 3D', () => {
    const el = draw(<Layer z={30} rotateX={20} rotateY={10} rotation={5} preserve3d />);
    expect(el.style.transform).toBe('translateZ(30px) rotateY(10deg) rotateX(20deg) rotate(5deg)');
    expect(el.style.transformStyle).toBe('preserve-3d');
    expect(el.style.isolation).toBe('auto');
  });

  it('reads keyframes at the absolute frame', () => {
    const x = [
      { frame: 0, value: 0 },
      { frame: 30, value: 90 },
    ];
    expect(draw(<Layer x={x} />, 15).style.transform).toBe('translate(45px, 0px)');
    // Inside a Sequence the relative frame differs; keyframes are scene frames.
    expect(draw(<Layer x={x} />, 3, { absoluteFrame: 30 }).style.transform).toBe('translate(90px, 0px)');
  });

  it('is a flex container with a layout, and a flex item with a layoutItem', () => {
    const el = draw(
      <Layer
        layout={{ flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start', gap: [4, 8], padding: [1, 2, 3, 4], width: 320, height: 180 }}
        layoutItem={{ flexGrow: 1, margin: 6, alignSelf: 'center', position: 'absolute' }}
      />,
    );
    expect(el.className).toBe('kg-el kg-layer kg-flex kg-abs');
    expect(el.style.display).toBe('flex');
    expect(el.style.flexDirection).toBe('column');
    expect(el.style.justifyContent).toBe('center');
    expect(el.style.gap).toBe('4px 8px');
    expect(el.style.padding).toBe('1px 2px 3px 4px');
    expect(el.style.width).toBe('320px');
    expect(el.style.flexGrow).toBe('1');
    expect(el.style.margin).toBe('6px');
    expect(el.style.alignSelf).toBe('center');
  });

  it('lets a layoutItem size win over the layout one', () => {
    const el = draw(<Layer layout={{ width: 100, height: 100 }} layoutItem={{ width: 40 }} />);
    expect(el.style.width).toBe('40px');
    expect(el.style.height).toBe('100px');
  });

  it('nests: the children are the div\'s children', () => {
    const el = draw(
      <Layer>
        <Rect width={10} height={10} fill="#f00" />
        <Rect width={20} height={10} fill="#0f0" />
      </Layer>,
    );
    expect(el.querySelectorAll('svg')).toHaveLength(2);
  });
});

describe('opacity, blend mode, effects and clips', () => {
  it('maps opacity and blend mode to CSS', () => {
    const el = draw(<Layer opacity={0.5} blendMode="colorDodge" />);
    expect(el.style.opacity).toBe('0.5');
    expect(el.style.mixBlendMode).toBe('color-dodge');
    const plain = draw(<Layer opacity={1} blendMode="normal" />);
    expect(plain.style.opacity).toBe('');
    expect(plain.style.mixBlendMode).toBe('');
  });

  it('maps the effects CSS has onto filter, in order', () => {
    const el = draw(
      <Layer
        effects={[
          { type: 'blur', radius: 6 },
          { type: 'dropShadow', x: 2, y: 8, blur: 12, color: '#00000080' },
          { type: 'saturate', amount: 1.5 },
          { type: 'hueRotate', angle: 90 },
          { type: 'grayscale', amount: 2 },
        ]}
      />,
    );
    expect(el.style.filter).toBe('blur(6px) drop-shadow(2px 8px 12px #00000080) saturate(1.5) hue-rotate(90deg) grayscale(1)');
  });

  it('draws a coloured glow as a zero-offset drop shadow', () => {
    const el = draw(<Layer effects={[{ type: 'glow', radius: 10, color: '#ffcc66', intensity: 2 }]} />);
    expect(el.style.filter).toBe('drop-shadow(0px 0px 10px #ffcc66) drop-shadow(0px 0px 10px #ffcc66)');
  });

  it('leaves out the effects CSS has no form for, with one warning each', () => {
    const effects = [{ type: 'grain', amount: 0.2, seed: 1 } as const, { type: 'insetShadow', y: 4, blur: 5 } as const, { type: 'blur', radius: 2 } as const];
    expect(draw(<Layer effects={effects} />).style.filter).toBe('blur(2px)');
    draw(<Layer effects={effects} />, 1);
    const warnings = takeWarnings();
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toMatch(/grain/);
    expect(warnings.join('\n')).toMatch(/insetShadow/);
    // Once taken, they are not repeated.
    draw(<Layer effects={effects} />, 2);
    expect(takeWarnings()).toEqual([]);
  });

  it('warns once about a mask, a matte and motion blur', () => {
    draw(
      <Layer
        mask={{ gradient: { type: 'linear', x0: 0, y0: 0, x1: 1, y1: 0, stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] } }}
        matte={{ layer: 'x' }}
        motionBlur={{ samples: 4 }}
      />,
    );
    expect(takeWarnings()).toHaveLength(3);
  });

  it('maps the four clip shapes to clip-path', () => {
    expect(draw(<Layer layout={{ width: 100, height: 100 }} clip={{ kind: 'inset', top: 5, left: 10, radius: 4 }} />).style.clipPath).toBe('inset(5px 0px 0px 10px round 4px)');
    expect(draw(<Layer clip={{ kind: 'ellipse', cx: 50, cy: 40, rx: 30, ry: 20 }} />).style.clipPath).toBe('ellipse(30px 20px at 50px 40px)');
    expect(draw(<Layer clip={{ kind: 'polygon', points: [[0, 0], [10, 0], [5, 8]] }} />).style.clipPath).toBe('polygon(0px 0px, 10px 0px, 5px 8px)');
    expect(draw(<Layer clip={{ kind: 'path', d: 'M0 0H10V10Z' }} />).style.clipPath).toBe("path('M0 0H10V10Z')");
  });
});

describe('shapes', () => {
  it('draws a rounded rect as an svg rect in an item box', () => {
    const item = draw(<Rect width={120} height={60} radius={8} fill="#f6c177" stroke={{ color: '#fff', width: 3 }} x={10} y={20} />);
    expect(item.className).toBe('kg-el kg-item');
    const svg = item.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('120');
    expect(svg.getAttribute('height')).toBe('60');
    expect(svg.style.overflow).toBe('visible');
    expect(svg.style.transform).toBe('translate(10px, 20px)');
    const rect = svg.querySelector('rect')!;
    expect(rect.getAttribute('rx')).toBe('8');
    expect(rect.getAttribute('fill')).toBe('#f6c177');
    expect(rect.getAttribute('stroke')).toBe('#fff');
    expect(rect.getAttribute('stroke-width')).toBe('3');
  });

  it('draws an ellipse and a path, and no fill is none', () => {
    const ellipse = draw(<Ellipse width={100} height={50} fill="#00f" />).querySelector('ellipse')!;
    expect([ellipse.getAttribute('cx'), ellipse.getAttribute('cy'), ellipse.getAttribute('rx'), ellipse.getAttribute('ry')]).toEqual(['50', '25', '50', '25']);
    const path = draw(<Path d="M0 0L10 10" stroke={{ color: '#000', width: 2 }} />);
    expect(path.querySelector('path')!.getAttribute('fill')).toBe('none');
    // A path is drawn in its own coordinates, so its svg has no extent.
    expect(path.querySelector('svg')!.getAttribute('width')).toBe('0');
    expect(draw(<Shape kind="rect" width={5} height={5} />).querySelector('rect')!.getAttribute('rx')).toBeNull();
  });

  it('paints a gradient with an svg paint server in the shape\'s units', () => {
    const el = draw(
      <Rect
        width={100}
        height={50}
        fill={{ type: 'linear', units: 'box', x0: 0, y0: 0, x1: 1, y1: 0, extend: 'reflect', stops: [{ offset: 0, color: '#f00' }, { offset: 1, color: '#00f' }] }}
      />,
    );
    const gradient = el.querySelector('linearGradient')!;
    expect(gradient.getAttribute('gradientUnits')).toBe('objectBoundingBox');
    expect(gradient.getAttribute('spreadMethod')).toBe('reflect');
    expect(gradient.getAttribute('x2')).toBe('1');
    expect(gradient.querySelectorAll('stop')).toHaveLength(2);
    expect(el.querySelector('rect')!.getAttribute('fill')).toBe(`url(#${gradient.id})`);
    const radial = draw(<Rect width={10} height={10} fill={{ type: 'radial', cx: 5, cy: 5, r: 5, stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] }} />);
    expect(radial.querySelector('radialGradient')!.getAttribute('gradientUnits')).toBe('userSpaceOnUse');
  });
});

describe('Text', () => {
  it('sets the registered font as a CSS family, weight and style', () => {
    const el = draw(<Text font="DM Sans" weight={700} fontStyle="italic" size={48} color="#fff" lineHeight={1.2}>Hello</Text>);
    const text = el.querySelector('.kg-text') as HTMLElement;
    expect(text.textContent).toBe('Hello');
    expect(text.style.fontFamily).toBe('"DM Sans"');
    expect(text.style.fontWeight).toBe('700');
    expect(text.style.fontStyle).toBe('italic');
    expect(text.style.fontSize).toBe('48px');
    expect(text.style.lineHeight).toBe('1.2');
    expect(text.style.color).toBe('rgb(255, 255, 255)');
    expect(text.style.whiteSpace).toBe('pre');
    expect(text.style.width).toBe('max-content');
  });

  it('wraps at maxWidth, aligns, and joins strings and numbers', () => {
    const text = draw(<Text font="F" size={20} maxWidth={200} align="center">{'Count '}{3}{'\n'}done</Text>).querySelector('.kg-text') as HTMLElement;
    expect(text.textContent).toBe('Count 3\ndone');
    expect(text.style.whiteSpace).toBe('pre-wrap');
    expect(text.style.width).toBe('200px');
    expect(text.style.textAlign).toBe('center');
  });

  it('styles single characters in inline-blocks, offset first and then turned about their centre', () => {
    const text = draw(
      <Text font="F" size={20} chars={(char, i) => (i === 1 ? { y: -4, rotation: 10, scale: 1.5, opacity: 0.5, color: '#f00' } : null)}>
        abc
      </Text>,
    ).querySelector('.kg-text') as HTMLElement;
    expect(text.textContent).toBe('abc');
    const spans = text.querySelectorAll('span');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.textContent).toBe('b');
    expect(spans[0]!.style.display).toBe('inline-block');
    expect(spans[0]!.style.transform).toBe('translate(0px, -4px) rotate(10deg) scale(1.5)');
    expect(spans[0]!.style.opacity).toBe('0.5');
  });

  it('rejects children that are not text', () => {
    expect(() => draw(<Text font="F" size={10}>{<div />}</Text>)).toThrow(/strings and numbers/);
  });
});

describe('pictures', () => {
  it('serves an image through the driver, with the box and fit as CSS', () => {
    const img = draw(<Image src="logo.png" width={256} fit="cover" />).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/@file?path=logo.png');
    expect(img.style.width).toBe('256px');
    // One side left out keeps the aspect ratio.
    expect(img.style.height).toBe('auto');
    expect(img.style.objectFit).toBe('cover');
    expect(draw(<Image src="https://example.com/a.png" />).querySelector('img')!.getAttribute('src')).toBe('https://example.com/a.png');
  });

  it('asks for the video picture by its clip frame, and applies the Video style subset', () => {
    const img = draw(<Video src="clips/city.mp4" trimBefore={15} playbackRate={2} loop style={{ width: 640, height: 360, objectFit: 'scale-down', color: 'red' }} />, 10).querySelector('img')!;
    const url = new URL(img.getAttribute('src')!, 'http://x');
    expect(url.pathname).toBe('/@video');
    expect(url.searchParams.get('src')).toBe('clips/city.mp4');
    // n = frame * playbackRate, relative to the Sequence the Video is in.
    expect(url.searchParams.get('n')).toBe('20');
    expect(url.searchParams.get('fps')).toBe('30');
    expect(url.searchParams.get('trimBefore')).toBe('15');
    expect(url.searchParams.get('trimAfter')).toBeNull();
    expect(url.searchParams.get('loop')).toBe('1');
    expect(img.style.width).toBe('640px');
    expect(img.style.objectFit).toBe('contain');
    const later = new URL(draw(<Video src="a.mp4" />, 3, { frame: 1 }).querySelector('img')!.getAttribute('src')!, 'http://x');
    expect(later.searchParams.get('n')).toBe('1');
  });

  it('checks a Video\'s arguments as the native element does', () => {
    expect(() => draw(<Video src="" />)).toThrow(/needs a src/);
    expect(() => draw(<Video src="a.mp4" playbackRate={0} />)).toThrow(/playbackRate/);
  });

  it('asks for the GIF picture at its time, and unmounts after the end when told to', () => {
    const url = new URL(draw(<Gif src="spin.gif" playbackRate={2} />, 15).querySelector('img')!.getAttribute('src')!, 'http://x');
    expect(url.pathname).toBe('/@gif');
    expect(url.searchParams.get('time')).toBe('1');
    expect(url.searchParams.get('loop')).toBe('1');
    const held = new URL(draw(<Gif src="spin.gif" loopBehavior="pause-after-finish" />, 30).querySelector('img')!.getAttribute('src')!, 'http://x');
    expect(held.searchParams.get('loop')).toBe('0');
    expect(draw(<Gif src="spin.gif" loopBehavior="unmount-after-finish" durationInSeconds={0.5} />, 30)).toBeNull();
  });
});

describe('the elements Chrome frames do not draw', () => {
  it('Lottie fails the frame, naming it', () => {
    expect(() => draw(<Lottie src="a.json" />, 12)).toThrow(/Lottie.*frame 12/s);
  });

  it('leaves out Noise with a warning, and Audio draws nothing', () => {
    const box = draw(<Noise width={40} height={30} turbulence={{ type: 'fractalNoise', baseFrequency: 0.1, seed: 1 }} />);
    expect(box.querySelector('div')!.style.width).toBe('40px');
    expect(takeWarnings().join('\n')).toMatch(/Noise/);
    flushSync(() => root.render(<TimelineContext.Provider value={timeline(0)}><Audio src="a.wav" /></TimelineContext.Provider>));
    expect(container.innerHTML).toBe('');
  });

  it('Camera is a marker the runtime turns into the stage\'s perspective', () => {
    const marker = draw(<Camera perspective={800} x={160} />);
    expect(marker.hasAttribute('data-kg-camera')).toBe(true);
    expect(marker.dataset.perspective).toBe('800');
    expect(marker.dataset.x).toBe('160');
    expect(marker.dataset.y).toBeUndefined();
  });
});

describe('outside a composition', () => {
  it('throws the timeline error, as the native elements do', () => {
    flushSync(() => root.render(<Layer />));
    expect((uncaught as { error: Error } | null)?.error.message).toMatch(/No timeline/);
  });
});
