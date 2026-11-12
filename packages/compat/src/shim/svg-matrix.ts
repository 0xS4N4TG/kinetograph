// The value objects an SVG script reads and writes: `SVGMatrix` (what `getCTM()` and `getScreenCTM()` give), `SVGPoint`
// (`createSVGPoint()`, `getPointAtLength()`) with `matrixTransform`, and `SVGAnimatedRect` (`svg.viewBox`).

import type { Affine } from './svg-transform.js';

interface MatrixLike {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export class SVGMatrixShim implements MatrixLike {
  constructor(
    public a = 1,
    public b = 0,
    public c = 0,
    public d = 1,
    public e = 0,
    public f = 0,
  ) {}
  static of(m: Affine): SVGMatrixShim {
    return new SVGMatrixShim(m[0], m[1], m[2], m[3], m[4], m[5]);
  }
  /** `this` after `m`: a point goes through `m` first. */
  multiply(m: MatrixLike): SVGMatrixShim {
    return new SVGMatrixShim(
      this.a * m.a + this.c * m.b,
      this.b * m.a + this.d * m.b,
      this.a * m.c + this.c * m.d,
      this.b * m.c + this.d * m.d,
      this.a * m.e + this.c * m.f + this.e,
      this.b * m.e + this.d * m.f + this.f,
    );
  }
  inverse(): SVGMatrixShim {
    const det = this.a * this.d - this.b * this.c;
    if (det === 0) throw new DOMException('The matrix is not invertible.', 'InvalidStateError');
    return new SVGMatrixShim(
      this.d / det,
      -this.b / det,
      -this.c / det,
      this.a / det,
      (this.c * this.f - this.d * this.e) / det,
      (this.b * this.e - this.a * this.f) / det,
    );
  }
  translate(x: number, y: number): SVGMatrixShim {
    return this.multiply(new SVGMatrixShim(1, 0, 0, 1, x, y));
  }
  scale(s: number): SVGMatrixShim {
    return this.multiply(new SVGMatrixShim(s, 0, 0, s, 0, 0));
  }
  scaleNonUniform(x: number, y: number): SVGMatrixShim {
    return this.multiply(new SVGMatrixShim(x, 0, 0, y, 0, 0));
  }
  rotate(degrees: number): SVGMatrixShim {
    const r = (degrees * Math.PI) / 180;
    return this.multiply(new SVGMatrixShim(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0));
  }
}

export class SVGPointShim {
  constructor(
    public x = 0,
    public y = 0,
  ) {}
  /** A new point: this one through `m`. */
  matrixTransform(m: MatrixLike): SVGPointShim {
    return new SVGPointShim(m.a * this.x + m.c * this.y + m.e, m.b * this.x + m.d * this.y + m.f);
  }
}

/** `svg.viewBox`: `baseVal` and `animVal` are the rect of the attribute, all zeros when it is missing or invalid. */
export function animatedRect(view: [number, number, number, number] | null): { baseVal: DOMRect; animVal: DOMRect } {
  const [x, y, width, height] = view ?? [0, 0, 0, 0];
  const rect = { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height } as DOMRect;
  return { baseVal: rect, animVal: rect };
}
