// `@remotion/transitions/book-flip`: the scene going out is turned over like the page of a book, and the scene coming in
// is under it. After the gl-transitions shader "BookFlip" by hong (MIT).

import { makeHtmlInCanvasPresentation } from './html-in-canvas.js';
import { transitionShader } from './transition-shader.js';

export type BookFlipDirection = 'from-left' | 'from-right' | 'from-top' | 'from-bottom';

export interface BookFlipProps extends Record<string, unknown> {
  /** The side the new page turns in from. Default `from-right`. */
  direction?: BookFlipDirection;
}

const DIRECTIONS: Record<BookFlipDirection, number> = { 'from-left': 0, 'from-right': 1, 'from-top': 2, 'from-bottom': 3 };

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_prev;
uniform sampler2D u_next;
uniform float u_time;
uniform float u_direction;

in vec2 v_uv;
out vec4 outColor;

const float EPSILON = 0.0001;

float avoidZero(float value) {
  if (abs(value) < EPSILON) return value < 0.0 ? -EPSILON : EPSILON;
  return value;
}

vec2 skewRight(vec2 p, float progress) {
  float skewX = (p.x - progress) / avoidZero(0.5 - progress) * 0.5;
  float skewY = (p.y - 0.5) / avoidZero(0.5 + progress * (p.x - 0.5) / 0.5) * 0.5 + 0.5;
  return vec2(skewX, skewY);
}

vec2 skewLeft(vec2 p, float progress) {
  float skewX = (p.x - 0.5) / avoidZero(progress - 0.5) * 0.5 + 0.5;
  float skewY = (p.y - 0.5) / avoidZero(0.5 + (1.0 - progress) * (0.5 - p.x) / 0.5) * 0.5 + 0.5;
  return vec2(skewX, skewY);
}

vec4 addShade(float progress) {
  float shade = max(0.7, abs(progress - 0.5) * 2.0);
  return vec4(vec3(shade), 1.0);
}

// The shader turns the page in from the left; the other sides are that, turned.
vec2 toCanonicalUv(vec2 p) {
  if (u_direction < 0.5) return p;
  if (u_direction < 1.5) return vec2(1.0 - p.x, p.y);
  if (u_direction < 2.5) return vec2(p.y, 1.0 - p.x);
  return vec2(1.0 - p.y, p.x);
}

vec2 fromCanonicalUv(vec2 p) {
  if (u_direction < 0.5) return p;
  if (u_direction < 1.5) return vec2(1.0 - p.x, p.y);
  if (u_direction < 2.5) return vec2(1.0 - p.y, p.x);
  return vec2(p.y, 1.0 - p.x);
}

vec4 samplePrev(vec2 p) {
  return texture(u_prev, fromCanonicalUv(p));
}

vec4 sampleNext(vec2 p) {
  return texture(u_next, fromCanonicalUv(p));
}

void main() {
  vec2 p = toCanonicalUv(v_uv);
  float progress = 1.0 - u_time;
  float turned = step(1.0 - progress, p.x);
  if (p.x < 0.5) {
    outColor = mix(samplePrev(p), sampleNext(skewLeft(p, progress)) * addShade(progress), turned);
  } else {
    outColor = mix(samplePrev(skewRight(p, progress)) * addShade(progress), sampleNext(p), turned);
  }
}`;

export const bookFlipShader = transitionShader<BookFlipProps>({
  fragment: FRAGMENT_SHADER,
  uniforms: ({ direction = 'from-right' }) => ({ u_direction: DIRECTIONS[direction] ?? DIRECTIONS['from-right'] }),
});

export const bookFlip = makeHtmlInCanvasPresentation(bookFlipShader);
