// `@remotion/transitions/dissolve`: the scene going out burns away to the scene coming in, from its dark parts first,
// leaving a glowing edge. After the gl-transitions shader "dissolve" by hjm1fb (MIT).

import { makeHtmlInCanvasPresentation } from './html-in-canvas.js';
import { transitionShader } from './transition-shader.js';

const DEFAULT_LINE_WIDTH = 0.1;
const DEFAULT_SPREAD_COLOR = '#ff0000';
const DEFAULT_HOT_COLOR = '#e6e633';
const DEFAULT_POW = 5;
const DEFAULT_INTENSITY = 1;

export interface DissolveProps extends Record<string, unknown> {
  /** The width of the glowing edge, in units of the burn level. Default 0.1. */
  lineWidth?: number;
  /** The colour of the edge's outer side, `#rrggbb`. Default `#ff0000`. */
  spreadColor?: string;
  /** The colour of the edge's hot side, `#rrggbb`. Default `#e6e633`. */
  hotColor?: string;
  /** How sharply the edge colours fall off. Default 5. */
  pow?: number;
  /** How bright the edge is. Default 1. */
  intensity?: number;
}

/** `#rrggbb` as 0..1 channels. */
function parseHexColor(hex: string): [number, number, number] {
  const cleaned = hex.startsWith('#') ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    throw new Error(`Invalid color "${hex}" passed to dissolve(). Expected a "#rrggbb" hex string.`);
  }
  return [0, 2, 4].map((at) => parseInt(cleaned.slice(at, at + 2), 16) / 255) as [number, number, number];
}

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_prev;
uniform sampler2D u_next;
uniform float u_time;
uniform float u_line_width;
uniform vec3 u_spread_color;
uniform vec3 u_hot_color;
uniform float u_pow;
uniform float u_intensity;

in vec2 v_uv;
out vec4 outColor;

void main() {
  float progress = u_time;
  vec4 from = texture(u_next, v_uv);
  vec4 to = texture(u_prev, v_uv);
  // The brighter the outgoing scene is, the later it burns.
  float burn = 0.5 + 0.5 * (0.299 * from.r + 0.587 * from.g + 0.114 * from.b);
  float show = burn - progress;
  if (show < 0.001) {
    outColor = to;
    return;
  }
  float factor = 1.0 - smoothstep(0.0, u_line_width, show);
  vec3 burnColor = mix(u_spread_color, u_hot_color, factor);
  burnColor = pow(burnColor, vec3(u_pow)) * u_intensity;
  vec3 rgb = mix(from.rgb, burnColor, factor * step(0.0001, progress));
  outColor = vec4(rgb, from.a);
}`;

export const dissolveShader = transitionShader<DissolveProps>({
  fragment: FRAGMENT_SHADER,
  uniforms: ({ lineWidth = DEFAULT_LINE_WIDTH, spreadColor = DEFAULT_SPREAD_COLOR, hotColor = DEFAULT_HOT_COLOR, pow = DEFAULT_POW, intensity = DEFAULT_INTENSITY }) => ({
    u_line_width: lineWidth,
    u_spread_color: parseHexColor(spreadColor),
    u_hot_color: parseHexColor(hotColor),
    u_pow: pow,
    u_intensity: intensity,
  }),
});

export const dissolve = makeHtmlInCanvasPresentation(dissolveShader);
