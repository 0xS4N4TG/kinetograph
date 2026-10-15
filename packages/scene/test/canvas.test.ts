import { describe, expect, it } from 'vitest';
import {
  CANVAS_SOURCE,
  canvasLayer,
  createCanvasContext,
  ImageData,
  parseCssColor,
  Path2D,
  toSceneColor,
  type CanvasCommand,
  type CanvasContext2D,
} from '../src/index.js';

const FONTS = { 'DM Sans': '/f/dm.ttf', 'DM Sans:700': '/f/dm-bold.ttf', 'DM Sans:400i': '/f/dm-italic.ttf', Inter: '/f/inter.ttf' };

function make(size = { width: 100, height: 50 }, extra = {}): CanvasContext2D {
  return createCanvasContext({ size: () => size, fonts: () => FONTS, ...extra });
}

const only = (ctx: CanvasContext2D): CanvasCommand => {
  expect(ctx.commands).toHaveLength(1);
  return ctx.commands[0]!;
};

describe('colours', () => {
  it('reads what a canvas is given and writes the scene spelling', () => {
    const hex = (css: string): string | null => {
      const c = parseCssColor(css);
      return c === null ? null : toSceneColor(c);
    };
    expect(hex('red')).toBe('#ff0000');
    expect(hex('RebeccaPurple')).toBe('#663399');
    expect(hex('#0af')).toBe('#00aaff');
    expect(hex('#0af8')).toBe('#00aaff88');
    expect(hex('rgb(255, 128, 0)')).toBe('#ff8000');
    expect(hex('rgba(0 0 255 / 50%)')).toBe('#0000ff80');
    expect(hex('rgb(100%, 0%, 0%)')).toBe('#ff0000');
    expect(hex('hsl(120, 100%, 50%)')).toBe('#00ff00');
    expect(hex('hsla(240deg 100% 25% / 0.5)')).toBe('#00008080');
    expect(hex('transparent')).toBe('#00000000');
    expect(hex('not a colour')).toBeNull();
    expect(hex('#12')).toBeNull();
    expect(hex('rgb(1, 2)')).toBeNull();
  });

  it('reads fillStyle back as a browser serialises it, and ignores what it cannot parse', () => {
    const ctx = make();
    expect(ctx.fillStyle).toBe('#000000');
    ctx.fillStyle = 'tomato';
    expect(ctx.fillStyle).toBe('#ff6347');
    ctx.fillStyle = 'rgba(10, 20, 30, 0.5)';
    expect(ctx.fillStyle).toBe('rgba(10, 20, 30, 0.5)');
    ctx.fillStyle = 'nonsense';
    expect(ctx.fillStyle).toBe('rgba(10, 20, 30, 0.5)');
  });
});

describe('state', () => {
  it('keeps the transform, alpha and composite operation on each command', () => {
    const ctx = make();
    ctx.fillStyle = '#336699';
    ctx.translate(10, 20);
    ctx.scale(2, 2);
    ctx.globalAlpha = 0.5;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillRect(1, 2, 3, 4);
    expect(only(ctx)).toEqual({
      op: 'fill',
      path: 'M1 2L4 2L4 6L1 6Z',
      paint: { type: 'color', color: '#336699' },
      m: [2, 0, 0, 2, 10, 20],
      a: 0.5,
      blend: 'multiply',
    });
  });

  it('save and restore bring the whole state back, and close the clips opened since', () => {
    const ctx = make();
    ctx.save();
    ctx.fillStyle = 'red';
    ctx.lineWidth = 7;
    ctx.translate(5, 5);
    ctx.rect(0, 0, 10, 10);
    ctx.clip();
    ctx.restore();
    expect(ctx.fillStyle).toBe('#000000');
    expect(ctx.lineWidth).toBe(1);
    expect(ctx.getTransform().e).toBe(0);
    expect(ctx.commands.map((c) => c.op)).toEqual(['clip', 'unclip']);
    // A restore with nothing saved does nothing.
    ctx.restore();
    expect(ctx.commands).toHaveLength(2);
  });

  it('ignores invalid assignments, as a canvas does', () => {
    const ctx = make();
    ctx.globalAlpha = 2;
    ctx.lineWidth = -1;
    ctx.lineCap = 'pointy';
    ctx.globalCompositeOperation = 'nope';
    ctx.font = 'whatever';
    expect([ctx.globalAlpha, ctx.lineWidth, ctx.lineCap, ctx.globalCompositeOperation, ctx.font]).toEqual([1, 1, 'butt', 'source-over', '10px sans-serif']);
  });

  it('writes the line style only where it differs from the default', () => {
    const ctx = make();
    ctx.setLineDash([4, 2, 1]);
    ctx.lineDashOffset = 3;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'bevel';
    ctx.miterLimit = 2;
    ctx.strokeRect(0, 0, 10, 10);
    expect(only(ctx)).toMatchObject({ op: 'stroke', width: 5, cap: 'round', join: 'bevel', miterLimit: 2, dash: [4, 2, 1, 4, 2, 1], dashOffset: 3 });
    const plain = make();
    plain.beginPath();
    plain.moveTo(0, 0);
    plain.lineTo(5, 5);
    plain.stroke();
    expect(Object.keys(only(plain)).sort()).toEqual(['op', 'paint', 'path']);
  });

  it('keeps shadows and filters for reading back and draws nothing for them', () => {
    const ctx = make();
    ctx.shadowBlur = 8;
    ctx.shadowColor = 'red';
    ctx.filter = 'blur(2px)';
    expect([ctx.shadowBlur, ctx.shadowColor, ctx.filter]).toEqual([8, '#ff0000', 'blur(2px)']);
    ctx.fillRect(0, 0, 5, 5);
    expect(ctx.commands).toHaveLength(1);
  });
});

describe('paths', () => {
  it('draws the current path back through the transform it is filled under', () => {
    const ctx = make();
    ctx.translate(10, 10);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(5, 0);
    ctx.lineTo(5, 5);
    ctx.closePath();
    ctx.fill();
    expect(only(ctx)).toMatchObject({ op: 'fill', path: 'M0 0L5 0L5 5Z', m: [1, 0, 0, 1, 10, 10] });
  });

  it('takes each point through the transform in force when it was added, as the spec has it', () => {
    const ctx = make();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.scale(2, 2);
    ctx.lineTo(10, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.stroke();
    expect(only(ctx)).toMatchObject({ path: 'M0 0L20 0' });
  });

  it('does not draw an empty path, or under a transform that flattens it', () => {
    const ctx = make();
    ctx.fill();
    ctx.stroke();
    ctx.scale(0, 1);
    ctx.fillRect(0, 0, 5, 5);
    ctx.beginPath();
    ctx.rect(0, 0, 5, 5);
    ctx.fill();
    // fillRect is a command with the flat transform; only the path is skipped, which cannot be put back through it.
    expect(ctx.commands.map((c) => c.op)).toEqual(['fill']);
  });

  it('builds an arc from curves that end on the circle', () => {
    const ctx = make();
    ctx.beginPath();
    ctx.arc(50, 25, 10, 0, Math.PI);
    ctx.fill();
    const { path } = only(ctx) as { path: string };
    expect(path.startsWith('M60 25C')).toBe(true);
    expect(path).toMatch(/40 25$/);
    expect(path.match(/C/g)).toHaveLength(2);
  });

  it('draws a full circle for a sweep of a turn or more, and the short way round counterclockwise', () => {
    const ctx = make();
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, 10);
    ctx.stroke();
    expect((only(ctx) as { path: string }).path.match(/C/g)).toHaveLength(4);
    const back = make();
    back.beginPath();
    back.arc(0, 0, 1, 0, Math.PI / 2, true);
    back.stroke();
    // Counterclockwise from 0 to a quarter turn is three quarters of the circle.
    expect((only(back) as { path: string }).path.match(/C/g)).toHaveLength(3);
  });

  it('rejects a negative radius with an IndexSizeError', () => {
    const ctx = make();
    expect(() => ctx.arc(0, 0, -1, 0, 1)).toThrow(/negative/);
    expect(() => ctx.arcTo(0, 0, 1, 1, -1)).toThrow(/negative/);
  });

  it('arcTo rounds a right angle with a curve that touches both sides', () => {
    const ctx = make();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arcTo(10, 0, 10, 10, 4);
    ctx.stroke();
    const { path } = only(ctx) as { path: string };
    // A line to the first tangent point (6, 0), then a curve ending at (10, 4).
    expect(path).toMatch(/^M0 0L6 0C/);
    expect(path).toMatch(/10 4$/);
  });

  it('draws round rectangles with their corners cut to fit', () => {
    const ctx = make();
    ctx.beginPath();
    ctx.roundRect(0, 0, 20, 10, 100);
    ctx.fill();
    const { path } = only(ctx) as { path: string };
    // The radii shrink to half the short side: 5.
    expect(path.startsWith('M5 0L15 0C')).toBe(true);
    expect(path.endsWith('Z')).toBe(true);
  });

  it('keeps a Path2D apart from the context and draws it under the current transform', () => {
    const ctx = make();
    const path = new Path2D('M0 0 L10 0 L10 10 Z');
    path.rect(20, 20, 5, 5);
    ctx.translate(3, 4);
    ctx.fill(path, 'evenodd');
    expect(only(ctx)).toMatchObject({ op: 'fill', rule: 'evenodd', m: [1, 0, 0, 1, 3, 4] });
    expect((only(ctx) as { path: string }).path).toBe('M0 0L10 0L10 10ZM20 20L25 20L25 25L20 25Z');
  });

  it('reads relative SVG path data, arcs and smooth curves into absolute segments', () => {
    const path = new Path2D('m10 10 h5 v5 H10 z m5 5 a5 5 0 0 1 10 0 s 2 3 4 4');
    const ctx = make();
    ctx.fill(path);
    const { path: d } = only(ctx) as { path: string };
    expect(d.startsWith('M10 10L15 10L15 15L10 15ZM15 15')).toBe(true);
    expect(d).toMatch(/C[^C]*$/);
  });

  it('adds a Path2D to another through a matrix', () => {
    const a = new Path2D();
    a.moveTo(1, 1);
    a.lineTo(2, 2);
    const b = new Path2D();
    b.addPath(a, { a: 2, d: 2, e: 10, f: 0 });
    const ctx = make();
    ctx.stroke(b);
    expect((only(ctx) as { path: string }).path).toBe('M12 2L14 4');
  });

  it('clips with the path under the transform and closes the clip on restore', () => {
    const ctx = make();
    ctx.save();
    ctx.translate(2, 3);
    ctx.beginPath();
    ctx.rect(0, 0, 5, 5);
    ctx.clip('evenodd');
    ctx.fillRect(0, 0, 9, 9);
    ctx.restore();
    expect(ctx.commands.map((c) => c.op)).toEqual(['clip', 'fill', 'unclip']);
    expect(ctx.commands[0]).toEqual({ op: 'clip', path: 'M0 0L5 0L5 5L0 5Z', rule: 'evenodd', m: [1, 0, 0, 1, 2, 3] });
  });
});

describe('rectangles', () => {
  it('drops what is under an opaque fill of the whole canvas, and under a clear of it', () => {
    const ctx = make();
    ctx.fillRect(0, 0, 5, 5);
    ctx.fillStyle = '#123456';
    ctx.fillRect(0, 0, 100, 50);
    expect(ctx.commands).toHaveLength(1);
    ctx.fillRect(10, 10, 5, 5);
    ctx.clearRect(0, 0, 100, 50);
    expect(ctx.commands).toHaveLength(0);
  });

  it('keeps what is under a fill that is translucent, partial, clipped or composited', () => {
    const ctx = make();
    ctx.fillRect(0, 0, 5, 5);
    ctx.globalAlpha = 0.5;
    ctx.fillRect(0, 0, 100, 50);
    ctx.globalAlpha = 1;
    ctx.fillRect(0, 0, 99, 50);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillRect(0, 0, 100, 50);
    expect(ctx.commands).toHaveLength(4);
    const clipped = make();
    clipped.fillRect(0, 0, 5, 5);
    clipped.rect(0, 0, 10, 10);
    clipped.clip();
    clipped.clearRect(0, 0, 100, 50);
    expect(clipped.commands.map((c) => c.op)).toEqual(['fill', 'clip', 'fill']);
    expect(clipped.commands[2]).toMatchObject({ blend: 'clear' });
  });

  it('draws nothing for a rectangle with no width or height', () => {
    const ctx = make();
    ctx.fillRect(0, 0, 0, 5);
    ctx.clearRect(0, 0, 5, 0);
    ctx.fillRect(NaN, 0, 5, 5);
    expect(ctx.commands).toHaveLength(0);
  });
});

describe('gradients and patterns', () => {
  it('paints with a gradient whose stops are in order, at the transform of the fill', () => {
    const ctx = make();
    const g = ctx.createLinearGradient(0, 0, 100, 0);
    g.addColorStop(1, 'blue');
    g.addColorStop(0, 'red');
    g.addColorStop(0.5, 'rgba(0, 255, 0, 0.5)');
    ctx.fillStyle = g;
    expect(ctx.fillStyle).toBe(g);
    ctx.fillRect(0, 0, 10, 10);
    expect(only(ctx)).toMatchObject({
      paint: { type: 'linear', x0: 0, y0: 0, x1: 100, y1: 0, stops: [[0, '#ff0000'], [0.5, '#00ff0080'], [1, '#0000ff']] },
    });
  });

  it('keeps the stops of one offset in the order they were added', () => {
    const ctx = make();
    const g = ctx.createRadialGradient(1, 2, 3, 4, 5, 6);
    g.addColorStop(0.5, '#111');
    g.addColorStop(0.5, '#222');
    expect(g.paint()).toEqual({ type: 'radial', x0: 1, y0: 2, r0: 3, x1: 4, y1: 5, r1: 6, stops: [[0.5, '#111111'], [0.5, '#222222']] });
  });

  it('refuses a stop outside 0 to 1 or a colour that is not one', () => {
    const g = make().createConicGradient(0, 5, 5);
    expect(() => g.addColorStop(1.5, 'red')).toThrow(/outside/);
    expect(() => g.addColorStop(0.5, 'blorp')).toThrow(/parsed/);
    expect(() => make().createRadialGradient(0, 0, -1, 0, 0, 1)).toThrow(/negative/);
  });

  it('makes a pattern of an image-like object', () => {
    const ctx = make();
    const image = { [CANVAS_SOURCE]: () => ({ source: { kind: 'src' as const, src: 'a.png' }, width: 8, height: 8 }) };
    const pattern = ctx.createPattern(image, 'repeat-x')!;
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, 5, 5);
    expect(only(ctx)).toMatchObject({ paint: { type: 'pattern', source: { kind: 'src', src: 'a.png' }, repeatX: true, repeatY: false } });
    expect(() => ctx.createPattern(image, 'sideways')).toThrow(/not valid/);
    expect(() => ctx.createPattern({}, 'repeat')).toThrow(/picture/);
  });
});

describe('text', () => {
  it('matches the font to a registered key, by family, weight and style', () => {
    const ctx = make();
    const font = (css: string): string => {
      ctx.font = css;
      ctx.fillText('Hi', 0, 0);
      return (ctx.commands.at(-1) as { font: string }).font;
    };
    expect(font('16px "DM Sans"')).toBe('DM Sans');
    expect(font('bold 16px "DM Sans", sans-serif')).toBe('DM Sans:700');
    expect(font('italic 16px DM Sans')).toBe('DM Sans:400i');
    expect(font('600 12px Missing, Inter')).toBe('Inter');
    // Nothing registered under that family: the key a text layer would use.
    expect(font('700 12px Unknown')).toBe('Unknown:700');
    expect(font('1.5em Inter')).toBe('Inter');
    expect((ctx.commands.at(-1) as { size: number }).size).toBe(24);
  });

  it('writes alignment, baseline, maxWidth and a line style for strokeText', () => {
    const ctx = make();
    ctx.font = '20px Inter';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.strokeText('a\nb', 50, 25, 40);
    expect(only(ctx)).toEqual({
      op: 'text',
      text: 'a b',
      font: 'Inter',
      size: 20,
      x: 50,
      y: 25,
      paint: { type: 'color', color: '#ffffff' },
      align: 'center',
      baseline: 'middle',
      maxWidth: 40,
      line: { width: 2 },
    });
  });

  it('measures with the text engine it is given', () => {
    const asked: unknown[] = [];
    const ctx = make(undefined, { measure: (text: string, font: string, size: number) => (asked.push([text, font, size]), { width: 42, ascent: 8, descent: 2 }) });
    ctx.font = '10px Inter';
    ctx.textAlign = 'right';
    const m = ctx.measureText('hello');
    expect(asked).toEqual([['hello', 'Inter', 10]]);
    expect(m.width).toBe(42);
    expect(m.actualBoundingBoxLeft).toBe(42);
    expect(m.actualBoundingBoxRight).toBe(0);
    expect(m.fontBoundingBoxAscent).toBe(8);
  });
});

describe('pictures', () => {
  const picture = (width: number, height: number, src = 'a.png') => ({ [CANVAS_SOURCE]: () => ({ source: { kind: 'src' as const, src }, width, height }) });

  it('takes the three forms of drawImage, each at the picture size when it gives none', () => {
    const ctx = make();
    ctx.drawImage(picture(8, 6), 1, 2);
    ctx.drawImage(picture(8, 6), 1, 2, 4, 3);
    ctx.drawImage(picture(8, 6), 1, 1, 4, 4, 10, 20, 8, 8);
    expect(ctx.commands).toMatchObject([
      { op: 'image', dx: 1, dy: 2, dw: 8, dh: 6 },
      { op: 'image', dx: 1, dy: 2, dw: 4, dh: 3 },
      { op: 'image', sx: 1, sy: 1, sw: 4, sh: 4, dx: 10, dy: 20, dw: 8, dh: 8 },
    ]);
    expect(() => ctx.drawImage(picture(1, 1), 1, 2, 3)).toThrow(/arguments/);
    expect(() => ctx.drawImage({}, 0, 0)).toThrow(/picture/);
  });

  it('turns smoothing off on the command when it is off', () => {
    const ctx = make();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(picture(2, 2), 0, 0);
    expect(only(ctx)).toMatchObject({ smooth: false });
  });

  it('draws another canvas as the commands it holds', () => {
    const inner = make({ width: 10, height: 10 });
    inner.fillRect(0, 0, 4, 4);
    const outer = make();
    outer.drawImage({ [CANVAS_SOURCE]: () => ({ source: { kind: 'canvas' as const, width: 10, height: 10, commands: [...inner.commands] }, width: 10, height: 10 }) }, 5, 5);
    const command = only(outer) as { source: { kind: string; commands: unknown[] } };
    expect(command.source.kind).toBe('canvas');
    expect(command.source.commands).toHaveLength(1);
  });

  it('puts ImageData down by clearing what is under it and drawing its pixels', () => {
    const ctx = make();
    const data = ctx.createImageData(2, 1);
    data.data.set([255, 0, 0, 255, 0, 0, 255, 255]);
    ctx.globalAlpha = 0.5;
    ctx.putImageData(data, 4, 6);
    expect(ctx.commands).toMatchObject([
      { op: 'fill', blend: 'clear', path: 'M4 6L6 6L6 7L4 7Z' },
      { op: 'image', source: { kind: 'pixels', width: 2, height: 1, data: '/wAA/wAA//8=' }, dx: 4, dy: 6, dw: 2, dh: 1, smooth: false },
    ]);
    expect(ctx.commands[1]).not.toHaveProperty('a');
  });

  it('reads pixels through the function it is given, and says so when there is none', () => {
    const ctx = make(undefined, {
      readPixels: (commands: CanvasCommand[], size: { width: number }, rect: { x: number; width: number; height: number }) => {
        expect(commands).toHaveLength(1);
        expect(size.width).toBe(100);
        return new Uint8ClampedArray(rect.width * rect.height * 4).fill(rect.x);
      },
    });
    ctx.fillRect(0, 0, 3, 3);
    const got = ctx.getImageData(7, 1, 2, 2);
    expect([got.width, got.height, got.data[0]]).toEqual([2, 2, 7]);
    expect(() => make().getImageData(0, 0, 1, 1)).toThrow(/not available/);
  });

  it('checks ImageData on the way in', () => {
    expect(() => new ImageData(0, 1)).toThrow();
    expect(() => new ImageData(new Uint8ClampedArray(7), 1)).toThrow(/multiple of 4/);
    expect(new ImageData(new Uint8ClampedArray(16), 2).height).toBe(2);
  });
});

describe('a canvas layer', () => {
  it('is the commands in a box', () => {
    const ctx = make();
    ctx.fillRect(1, 1, 2, 2);
    expect(canvasLayer(ctx, { id: 'c', width: 100, height: 50 })).toEqual({
      id: 'c',
      type: 'canvas',
      width: 100,
      height: 50,
      commands: ctx.commands,
    });
  });

  it('reset empties the commands and the state', () => {
    const ctx = make();
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 2, 2);
    ctx.reset();
    expect(ctx.commands).toEqual([]);
    expect(ctx.fillStyle).toBe('#000000');
  });
});
