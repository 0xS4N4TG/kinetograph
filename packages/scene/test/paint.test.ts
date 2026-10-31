import { describe, expect, it } from 'vitest';
import { conicGradient, fontKey, gradient, linearGradient, radialGradient, type LinearGradient } from '../src/index.js';

const AB = ['#f00', '#00f'];

function line(g: LinearGradient): [number, number, number, number] {
  return [g.x0 as number, g.y0 as number, g.x1 as number, g.y1 as number];
}

describe('linearGradient', () => {
  it('defaults to CSS "to bottom" in box units', () => {
    expect(linearGradient(AB)).toEqual({
      type: 'linear',
      x0: 0.5,
      y0: 0,
      x1: 0.5,
      y1: 1,
      stops: [
        { offset: 0, color: '#f00' },
        { offset: 1, color: '#00f' },
      ],
      units: 'box',
    });
  });

  it('follows the CSS angles: 0 is to the top, 90 to the right, 180 to the bottom, 270 to the left', () => {
    expect(line(linearGradient(AB, { angle: 0 }))).toEqual([0.5, 1, 0.5, 0]);
    expect(line(linearGradient(AB, { angle: 90 }))).toEqual([0, 0.5, 1, 0.5]);
    expect(line(linearGradient(AB, { angle: 180 }))).toEqual([0.5, 0, 0.5, 1]);
    expect(line(linearGradient(AB, { angle: 270 }))).toEqual([1, 0.5, 0, 0.5]);
  });

  it('runs corner to corner at 45 and 135 degrees', () => {
    expect(line(linearGradient(AB, { angle: 45 }))).toEqual([0, 1, 1, 0]);
    expect(line(linearGradient(AB, { angle: 135 }))).toEqual([0, 0, 1, 1]);
    expect(line(linearGradient(AB, { angle: 225 }))).toEqual([1, 0, 0, 1]);
    expect(line(linearGradient(AB, { angle: 315 }))).toEqual([1, 1, 0, 0]);
  });

  it('wraps angles outside 0..360', () => {
    expect(line(linearGradient(AB, { angle: 360 }))).toEqual(line(linearGradient(AB, { angle: 0 })));
    expect(line(linearGradient(AB, { angle: -90 }))).toEqual(line(linearGradient(AB, { angle: 270 })));
  });

  it("makes the corners reach the first and last stop exactly, which is CSS's rule for the gradient line", () => {
    for (const angle of [0, 10, 30, 45, 77, 90, 120, 135, 200, 255, 300, 359]) {
      const [x0, y0, x1, y1] = line(linearGradient(AB, { angle }));
      const dx = x1 - x0;
      const dy = y1 - y0;
      const ts = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([px, py]) => ((px! - x0) * dx + (py! - y0) * dy) / (dx * dx + dy * dy));
      expect(Math.min(...ts)).toBeCloseTo(0, 9);
      expect(Math.max(...ts)).toBeCloseTo(1, 9);
      // The line passes through the box's centre and points the way CSS says.
      expect((x0 + x1) / 2).toBeCloseTo(0.5, 9);
      expect((y0 + y1) / 2).toBeCloseTo(0.5, 9);
      const rad = (angle * Math.PI) / 180;
      const length = Math.hypot(dx, dy);
      expect(dx / length).toBeCloseTo(Math.sin(rad), 9);
      expect(dy / length).toBeCloseTo(-Math.cos(rad), 9);
    }
  });

  it('computes a diagonal that is not a multiple of 45 degrees', () => {
    const [x0, y0, x1, y1] = line(linearGradient(AB, { angle: 30 }));
    expect(x0).toBeCloseTo(0.1585, 4);
    expect(y0).toBeCloseTo(1.0915, 4);
    expect(x1).toBeCloseTo(0.8415, 4);
    expect(y1).toBeCloseTo(-0.0915, 4);
  });

  it('spreads bare colours evenly', () => {
    const g = linearGradient(['#f00', '#0f0', '#00f', '#fff', '#000']);
    expect(g.stops.map((s) => s.offset)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('keeps given offsets and places bare colours between them, as CSS does', () => {
    const g = linearGradient(['#f00', [0.2, '#0f0'], '#00f', '#fff', [0.8, '#000'], '#111']);
    expect(g.stops.map((s) => s.offset)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(g.stops.map((s) => s.color)).toEqual(['#f00', '#0f0', '#00f', '#fff', '#000', '#111']);
    // A first or last stop with its own offset is not moved.
    expect(linearGradient([[0.1, '#f00'], '#0f0', [0.9, '#00f']]).stops.map((s) => s.offset)).toEqual([0.1, 0.5, 0.9]);
  });

  it('takes extend, and leaves it out otherwise', () => {
    expect(linearGradient(AB, { extend: 'repeat' }).extend).toBe('repeat');
    expect('extend' in linearGradient(AB)).toBe(false);
  });

  it('needs two colours', () => {
    expect(() => linearGradient(['#f00'])).toThrow(/at least 2/);
    expect(() => linearGradient([])).toThrow(/at least 2/);
  });
});

describe('radialGradient', () => {
  it('defaults to the centre with a radius to the box sides, in box units', () => {
    expect(radialGradient(AB)).toEqual({
      type: 'radial',
      cx: 0.5,
      cy: 0.5,
      r: 0.5,
      stops: [
        { offset: 0, color: '#f00' },
        { offset: 1, color: '#00f' },
      ],
      units: 'box',
    });
  });

  it('takes a centre, a radius and extend', () => {
    const g = radialGradient(AB, { cx: 0.25, cy: 0.75, r: 1, extend: 'reflect' });
    expect(g).toMatchObject({ cx: 0.25, cy: 0.75, r: 1, extend: 'reflect', units: 'box' });
  });
});

describe('conicGradient', () => {
  it('defaults to the centre, starting at 12 o\'clock', () => {
    const g = conicGradient(AB);
    expect(g).toMatchObject({ type: 'conic', cx: 0.5, cy: 0.5, units: 'box' });
    expect('angle' in g).toBe(false);
  });

  it('takes the start angle in degrees clockwise from 12 o\'clock', () => {
    expect(conicGradient(AB, { angle: 90, cx: 0.3, cy: 0.6, extend: 'repeat' })).toMatchObject({
      angle: 90,
      cx: 0.3,
      cy: 0.6,
      extend: 'repeat',
    });
  });
});

describe('gradient', () => {
  it('returns the raw user-unit object as given', () => {
    const raw = {
      type: 'linear',
      x0: 0,
      y0: 0,
      x1: 400,
      y1: 0,
      stops: [
        { offset: 0, color: '#ff0000' },
        { offset: 1, color: '#0000ff' },
      ],
    } as const;
    expect(gradient({ ...raw, stops: [...raw.stops] })).toEqual(raw);
    expect('units' in gradient({ ...raw, stops: [...raw.stops] })).toBe(false);
  });
});

describe('fontKey', () => {
  it('is the bare family for 400 normal', () => {
    expect(fontKey('Inter')).toBe('Inter');
    expect(fontKey('Inter', 400)).toBe('Inter');
    expect(fontKey('Inter', 400, 'normal')).toBe('Inter');
    expect(fontKey('DM Sans', 'normal')).toBe('DM Sans');
  });

  it('adds the weight, and an i for italic', () => {
    expect(fontKey('Inter', 700)).toBe('Inter:700');
    expect(fontKey('Inter', 400, 'italic')).toBe('Inter:400i');
    expect(fontKey('Inter', 700, 'italic')).toBe('Inter:700i');
    expect(fontKey('Inter', undefined, 'italic')).toBe('Inter:400i');
    expect(fontKey('Inter', 100)).toBe('Inter:100');
  });

  it('names a weight range with the top weight', () => {
    expect(fontKey('Recursive', 300, 'normal', 1000)).toBe('Recursive:300-1000');
    expect(fontKey('Inter', 400, 'italic', 900)).toBe('Inter:400-900i');
    // A range that is no wider than one weight is that weight.
    expect(fontKey('Inter', 700, 'normal', 700)).toBe('Inter:700');
  });

  it('reads string weights', () => {
    expect(fontKey('Inter', 'bold')).toBe('Inter:700');
    expect(fontKey('Inter', 'Bold', 'italic')).toBe('Inter:700i');
    expect(fontKey('Inter', '600')).toBe('Inter:600');
    expect(fontKey('Inter', 'semi-bold')).toBe('Inter:600');
    expect(fontKey('Inter', 'regular')).toBe('Inter');
  });

  it('rejects a weight it cannot read', () => {
    expect(() => fontKey('Inter', 'chunky')).toThrow(/font weight/);
    expect(() => fontKey('Inter', 0)).toThrow(/font weight/);
    expect(() => fontKey('Inter', 450.5)).toThrow(/font weight/);
  });
});
