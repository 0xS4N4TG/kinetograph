// `@remotion/transitions/swap`: the two scenes swap places in space, the one going out receding to the right as the one
// coming in approaches from the left, with a faint reflection below. After the gl-transitions shader "swap" by gre
// (MIT).

import { makeHtmlInCanvasPresentation } from './html-in-canvas.js';
import { transitionShader } from './transition-shader.js';

const DEFAULT_REFLECTION = 0.4;
const DEFAULT_PERSPECTIVE = 0.2;
const DEFAULT_DEPTH = 3;

export interface SwapProps extends Record<string, unknown> {
  /** How strong the reflection is. Default 0.4. */
  reflection?: number;
  /** How strong the perspective is. Default 0.2. */
  perspective?: number;
  /** How far the scenes recede at the peak. Default 3. */
  depth?: number;
}

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_prev;
uniform sampler2D u_next;
uniform float u_time;
uniform float u_reflection;
uniform float u_perspective;
uniform float u_depth;

in vec2 v_uv;
out vec4 outColor;

const vec4 black = vec4(0.0, 0.0, 0.0, 1.0);
const vec2 boundMin = vec2(0.0, 0.0);
const vec2 boundMax = vec2(1.0, 1.0);

bool inBounds(vec2 p) {
  return all(lessThan(boundMin, p)) && all(lessThan(p, boundMax));
}

vec2 project(vec2 p) {
  return p * vec2(1.0, -1.2) + vec2(0.0, 2.22);
}

vec4 bgColor(vec2 pfr, vec2 pto) {
  vec4 c = black;
  pfr = project(pfr);
  if (inBounds(pfr)) {
    c += mix(black, texture(u_prev, pfr), u_reflection * mix(1.0, 0.0, pfr.y));
  }
  pto = project(pto);
  if (inBounds(pto)) {
    c += mix(black, texture(u_next, pto), u_reflection * mix(1.0, 0.0, pto.y));
  }
  return c;
}

void main() {
  float progress = 1.0 - u_time;
  vec2 p = v_uv;

  float size = mix(1.0, u_depth, progress);
  float persp = u_perspective * progress;
  vec2 pfr = (p + vec2(-0.0, -0.5)) * vec2(
    size / (1.0 - u_perspective * progress),
    size / (1.0 - size * persp * p.x)
  ) + vec2(0.0, 0.5);

  size = mix(1.0, u_depth, 1.0 - progress);
  persp = u_perspective * (1.0 - progress);
  vec2 pto = (p + vec2(-1.0, -0.5)) * vec2(
    size / (1.0 - u_perspective * (1.0 - progress)),
    size / (1.0 - size * persp * (0.5 - p.x))
  ) + vec2(1.0, 0.5);

  bool inFrom = inBounds(pfr);
  bool inTo = inBounds(pto);
  if (progress < 0.5 && inFrom) {
    outColor = texture(u_prev, pfr);
  } else if (inTo) {
    outColor = texture(u_next, pto);
  } else if (inFrom) {
    outColor = texture(u_prev, pfr);
  } else {
    outColor = bgColor(pfr, pto);
  }
}`;

export const swapShader = transitionShader<SwapProps>({
  fragment: FRAGMENT_SHADER,
  uniforms: ({ reflection = DEFAULT_REFLECTION, perspective = DEFAULT_PERSPECTIVE, depth = DEFAULT_DEPTH }) => ({
    u_reflection: reflection,
    u_perspective: perspective,
    u_depth: depth,
  }),
});

export const swap = makeHtmlInCanvasPresentation(swapShader);
