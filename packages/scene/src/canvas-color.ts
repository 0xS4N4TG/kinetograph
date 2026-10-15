// CSS colours as a Canvas 2D context reads them (`fillStyle`, `addColorStop`, `shadowColor`): the forms a canvas takes
// every day, and what the scene's colours spell (`#rrggbbaa`). Colour spaces beyond sRGB (`lab()`, `oklch()`,
// `color()`) are not read; a context ignores such an assignment as it does any it cannot parse.

/** The named colours of CSS Color 4, as `name:rrggbb`. */
const NAMED =
  'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 ' +
  'black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 ' +
  'chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff ' +
  'darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 ' +
  'darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 ' +
  'darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f ' +
  'darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 ' +
  'dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ' +
  'ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 ' +
  'honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa ' +
  'lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff ' +
  'lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 ' +
  'lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 ' +
  'lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff ' +
  'maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db ' +
  'mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc ' +
  'mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead ' +
  'navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 ' +
  'palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 ' +
  'peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 ' +
  'red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 ' +
  'seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 ' +
  'snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 ' +
  'turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32';

const named = new Map<string, string>(NAMED.split(' ').map((entry) => entry.split(':') as [string, string]));

export interface Rgba {
  /** 0 to 255, whole. */
  r: number;
  g: number;
  b: number;
  /** 0 to 1. */
  a: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?';
const FUNCTION = /^(rgba?|hsla?)\(\s*(.*?)\s*\)$/i;

/** One channel: a number, or a percentage of `range`. */
function channel(text: string, range: number): number | null {
  const match = new RegExp(`^(${NUMBER})(%?)$`, 'i').exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return match[2] === '%' ? (value / 100) * range : value;
}

function alphaOf(text: string | undefined): number | null {
  if (text === undefined) return 1;
  const value = channel(text, 1);
  return value === null ? null : clamp(value, 0, 1);
}

/** The arguments of a colour function: commas or spaces between channels, and `/` or a last comma before alpha. */
function argumentsOf(body: string): string[] | null {
  const [colour, slash, ...rest] = body.split('/');
  if (rest.length > 0 || colour === undefined) return null;
  const channels = colour.trim().split(/\s*,\s*|\s+/).filter((part) => part !== '');
  if (slash !== undefined) channels.push(slash.trim());
  return channels;
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360;
  const s = clamp(saturation, 0, 1);
  const l = clamp(lightness, 0, 1);
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** A CSS colour as RGBA, or null when it is not one the context reads. `currentcolor` is black, as in a canvas with no style. */
export function parseCssColor(input: string): Rgba | null {
  const text = input.trim().toLowerCase();
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (text === 'currentcolor') return { r: 0, g: 0, b: 0, a: 1 };
  const hex = text.startsWith('#') ? text.slice(1) : named.get(text);
  if (hex !== undefined) {
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    const digits = hex.length <= 4 ? [...hex].map((d) => d + d).join('') : hex;
    if (digits.length !== 6 && digits.length !== 8) return null;
    const byte = (at: number): number => parseInt(digits.slice(at, at + 2), 16);
    return { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? byte(6) / 255 : 1 };
  }
  const call = FUNCTION.exec(text);
  if (!call) return null;
  const parts = argumentsOf(call[2]!);
  if (parts === null || parts.length < 3 || parts.length > 4) return null;
  const alpha = alphaOf(parts[3]);
  if (alpha === null) return null;
  if (call[1]!.startsWith('rgb')) {
    const [r, g, b] = [0, 1, 2].map((i) => channel(parts[i]!, 255));
    if (r === null || g === null || b === null) return null;
    return { r: Math.round(clamp(r!, 0, 255)), g: Math.round(clamp(g!, 0, 255)), b: Math.round(clamp(b!, 0, 255)), a: alpha };
  }
  const hue = new RegExp(`^(${NUMBER})(deg|rad|grad|turn)?$`, 'i').exec(parts[0]!);
  // Saturation and lightness are percentages; modern syntax lets the sign go.
  const s = channel(parts[1]!, 100);
  const l = channel(parts[2]!, 100);
  if (!hue || s === null || l === null) return null;
  const unit = hue[2]?.toLowerCase();
  const turned = Number(hue[1]) * (unit === 'rad' ? 180 / Math.PI : unit === 'grad' ? 0.9 : unit === 'turn' ? 360 : 1);
  const [r, g, b] = hslToRgb(turned, s / 100, l / 100);
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: alpha };
}

const hex2 = (value: number): string => Math.round(value).toString(16).padStart(2, '0');

/** `#rrggbb`, or `#rrggbbaa` when not opaque: the spelling the scene's colours take. */
export function toSceneColor({ r, g, b, a }: Rgba): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}`;
}

/** What `fillStyle` reads back: `#rrggbb` when opaque, else `rgba(r, g, b, a)`, as browsers serialise it. */
export function toCssColor({ r, g, b, a }: Rgba): string {
  if (a >= 1) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  const alpha = Math.round(a * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
