// CSS colour parsing for `interpolateColors`. The accepted syntaxes follow what the published `interpolateColors`
// accepts (probed through its public behaviour): hex of 3, 4, 6 and 8 digits,
// comma-separated `rgb()`/`rgba()`/`hsl()`/`hsla()`, space-separated `hwb()`,
// the CSS named colours and `transparent`.

const NAMED: Record<string, number> = {
  aliceblue: 0xf0f8ffff,
  antiquewhite: 0xfaebd7ff,
  aqua: 0x00ffffff,
  aquamarine: 0x7fffd4ff,
  azure: 0xf0ffffff,
  beige: 0xf5f5dcff,
  bisque: 0xffe4c4ff,
  black: 0x000000ff,
  blanchedalmond: 0xffebcdff,
  blue: 0x0000ffff,
  blueviolet: 0x8a2be2ff,
  brown: 0xa52a2aff,
  burlywood: 0xdeb887ff,
  cadetblue: 0x5f9ea0ff,
  chartreuse: 0x7fff00ff,
  chocolate: 0xd2691eff,
  coral: 0xff7f50ff,
  cornflowerblue: 0x6495edff,
  cornsilk: 0xfff8dcff,
  crimson: 0xdc143cff,
  cyan: 0x00ffffff,
  darkblue: 0x00008bff,
  darkcyan: 0x008b8bff,
  darkgoldenrod: 0xb8860bff,
  darkgray: 0xa9a9a9ff,
  darkgreen: 0x006400ff,
  darkgrey: 0xa9a9a9ff,
  darkkhaki: 0xbdb76bff,
  darkmagenta: 0x8b008bff,
  darkolivegreen: 0x556b2fff,
  darkorange: 0xff8c00ff,
  darkorchid: 0x9932ccff,
  darkred: 0x8b0000ff,
  darksalmon: 0xe9967aff,
  darkseagreen: 0x8fbc8fff,
  darkslateblue: 0x483d8bff,
  darkslategray: 0x2f4f4fff,
  darkslategrey: 0x2f4f4fff,
  darkturquoise: 0x00ced1ff,
  darkviolet: 0x9400d3ff,
  deeppink: 0xff1493ff,
  deepskyblue: 0x00bfffff,
  dimgray: 0x696969ff,
  dimgrey: 0x696969ff,
  dodgerblue: 0x1e90ffff,
  firebrick: 0xb22222ff,
  floralwhite: 0xfffaf0ff,
  forestgreen: 0x228b22ff,
  fuchsia: 0xff00ffff,
  gainsboro: 0xdcdcdcff,
  ghostwhite: 0xf8f8ffff,
  gold: 0xffd700ff,
  goldenrod: 0xdaa520ff,
  gray: 0x808080ff,
  green: 0x008000ff,
  greenyellow: 0xadff2fff,
  grey: 0x808080ff,
  honeydew: 0xf0fff0ff,
  hotpink: 0xff69b4ff,
  indianred: 0xcd5c5cff,
  indigo: 0x4b0082ff,
  ivory: 0xfffff0ff,
  khaki: 0xf0e68cff,
  lavender: 0xe6e6faff,
  lavenderblush: 0xfff0f5ff,
  lawngreen: 0x7cfc00ff,
  lemonchiffon: 0xfffacdff,
  lightblue: 0xadd8e6ff,
  lightcoral: 0xf08080ff,
  lightcyan: 0xe0ffffff,
  lightgoldenrodyellow: 0xfafad2ff,
  lightgray: 0xd3d3d3ff,
  lightgreen: 0x90ee90ff,
  lightgrey: 0xd3d3d3ff,
  lightpink: 0xffb6c1ff,
  lightsalmon: 0xffa07aff,
  lightseagreen: 0x20b2aaff,
  lightskyblue: 0x87cefaff,
  lightslategray: 0x778899ff,
  lightslategrey: 0x778899ff,
  lightsteelblue: 0xb0c4deff,
  lightyellow: 0xffffe0ff,
  lime: 0x00ff00ff,
  limegreen: 0x32cd32ff,
  linen: 0xfaf0e6ff,
  magenta: 0xff00ffff,
  maroon: 0x800000ff,
  mediumaquamarine: 0x66cdaaff,
  mediumblue: 0x0000cdff,
  mediumorchid: 0xba55d3ff,
  mediumpurple: 0x9370dbff,
  mediumseagreen: 0x3cb371ff,
  mediumslateblue: 0x7b68eeff,
  mediumspringgreen: 0x00fa9aff,
  mediumturquoise: 0x48d1ccff,
  mediumvioletred: 0xc71585ff,
  midnightblue: 0x191970ff,
  mintcream: 0xf5fffaff,
  mistyrose: 0xffe4e1ff,
  moccasin: 0xffe4b5ff,
  navajowhite: 0xffdeadff,
  navy: 0x000080ff,
  oldlace: 0xfdf5e6ff,
  olive: 0x808000ff,
  olivedrab: 0x6b8e23ff,
  orange: 0xffa500ff,
  orangered: 0xff4500ff,
  orchid: 0xda70d6ff,
  palegoldenrod: 0xeee8aaff,
  palegreen: 0x98fb98ff,
  paleturquoise: 0xafeeeeff,
  palevioletred: 0xdb7093ff,
  papayawhip: 0xffefd5ff,
  peachpuff: 0xffdab9ff,
  peru: 0xcd853fff,
  pink: 0xffc0cbff,
  plum: 0xdda0ddff,
  powderblue: 0xb0e0e6ff,
  purple: 0x800080ff,
  rebeccapurple: 0x663399ff,
  red: 0xff0000ff,
  rosybrown: 0xbc8f8fff,
  royalblue: 0x4169e1ff,
  saddlebrown: 0x8b4513ff,
  salmon: 0xfa8072ff,
  sandybrown: 0xf4a460ff,
  seagreen: 0x2e8b57ff,
  seashell: 0xfff5eeff,
  sienna: 0xa0522dff,
  silver: 0xc0c0c0ff,
  skyblue: 0x87ceebff,
  slateblue: 0x6a5acdff,
  slategray: 0x708090ff,
  slategrey: 0x708090ff,
  snow: 0xfffafaff,
  springgreen: 0x00ff7fff,
  steelblue: 0x4682b4ff,
  tan: 0xd2b48cff,
  teal: 0x008080ff,
  thistle: 0xd8bfd8ff,
  tomato: 0xff6347ff,
  turquoise: 0x40e0d0ff,
  violet: 0xee82eeff,
  wheat: 0xf5deb3ff,
  white: 0xffffffff,
  whitesmoke: 0xf5f5f5ff,
  yellow: 0xffff00ff,
  yellowgreen: 0x9acd32ff,
  transparent: 0x00000000,
};

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..255, as the byte a CSS colour string stores. */
  a: number;
}

const NUMBER = '[-+]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][-+]?\\d+)?';
const PERCENT = `${NUMBER}%`;
const comma = (...parts: string[]) => new RegExp(`^\\s*\\(\\s*(${parts.join(')\\s*,\\s*(')})\\s*\\)\\s*$`);
const space = (...parts: string[]) => new RegExp(`^\\s*\\(\\s*(${parts.join(')\\s+(')})\\s*\\)\\s*$`);

const RGB = comma(NUMBER, NUMBER, NUMBER);
const RGBA = comma(NUMBER, NUMBER, NUMBER, NUMBER);
const HSL = comma(NUMBER, PERCENT, PERCENT);
const HSLA = comma(NUMBER, PERCENT, PERCENT, NUMBER);
const HWB = space(NUMBER, PERCENT, PERCENT);

const clamp255 = (n: number) => Math.min(255, Math.max(0, Math.round(n)));
const alphaByte = (a: number) => clamp255(Math.min(1, Math.max(0, a)) * 255);

function hueToChannel(p: number, q: number, t: number): number {
  let h = t;
  if (h < 0) h += 1;
  if (h > 1) h -= 1;
  if (h < 1 / 6) return p + (q - p) * 6 * h;
  if (h < 1 / 2) return q;
  if (h < 2 / 3) return p + (q - p) * (2 / 3 - h) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    clamp255(hueToChannel(p, q, h + 1 / 3) * 255),
    clamp255(hueToChannel(p, q, h) * 255),
    clamp255(hueToChannel(p, q, h - 1 / 3) * 255),
  ];
}

const hueFraction = (degrees: number) => (((degrees % 360) + 360) % 360) / 360;
const percent = (text: string) => Math.min(1, Math.max(0, parseFloat(text) / 100));

function hwbToRgb(h: number, w: number, b: number): [number, number, number] {
  if (w + b >= 1) {
    const gray = clamp255((w * 255) / (w + b));
    return [gray, gray, gray];
  }
  const [r, g, bl] = hslToRgb(h, 1, 0.5).map((c) => c / 255) as [number, number, number];
  const scale = 1 - w - b;
  return [clamp255((r * scale + w) * 255), clamp255((g * scale + w) * 255), clamp255((bl * scale + w) * 255)];
}

/** Parses a CSS colour string; `null` when the syntax is not one of those listed above. */
export function parseColor(input: string): Rgba | null {
  if (typeof input !== 'string') return null;
  const text = input.trim().toLowerCase();

  const named = NAMED[text];
  if (named !== undefined) {
    return { r: (named >>> 24) & 255, g: (named >>> 16) & 255, b: (named >>> 8) & 255, a: named & 255 };
  }

  if (text.startsWith('#')) {
    const hex = text.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = [...hex].map((c) => parseInt(c + c, 16));
      return { r: r!, g: g!, b: b!, a: a ?? 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255,
      };
    }
    return null;
  }

  const open = text.indexOf('(');
  if (open < 0) return null;
  const fn = text.slice(0, open);
  const args = text.slice(open);
  let m: RegExpExecArray | null;
  if (fn === 'rgb' && (m = RGB.exec(args))) {
    return { r: clamp255(+m[1]!), g: clamp255(+m[2]!), b: clamp255(+m[3]!), a: 255 };
  }
  if (fn === 'rgba' && (m = RGBA.exec(args))) {
    return { r: clamp255(+m[1]!), g: clamp255(+m[2]!), b: clamp255(+m[3]!), a: alphaByte(+m[4]!) };
  }
  if (fn === 'hsl' && (m = HSL.exec(args))) {
    const [r, g, b] = hslToRgb(hueFraction(+m[1]!), percent(m[2]!), percent(m[3]!));
    return { r, g, b, a: 255 };
  }
  if (fn === 'hsla' && (m = HSLA.exec(args))) {
    const [r, g, b] = hslToRgb(hueFraction(+m[1]!), percent(m[2]!), percent(m[3]!));
    return { r, g, b, a: alphaByte(+m[4]!) };
  }
  if (fn === 'hwb' && (m = HWB.exec(args))) {
    const [r, g, b] = hwbToRgb(hueFraction(+m[1]!), percent(m[2]!), percent(m[3]!));
    return { r, g, b, a: 255 };
  }
  return null;
}
