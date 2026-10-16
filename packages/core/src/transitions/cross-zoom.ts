// `@remotion/transitions/cross-zoom`: both scenes are smeared toward a point that travels across the frame while they
// cross-fade, so the cut looks like a fast zoom. After the gl-transitions shader "CrossZoom" by rectalogic (MIT).

import { makeHtmlInCanvasPresentation } from './html-in-canvas.js';
import { transitionShader } from './transition-shader.js';

const DEFAULT_STRENGTH = 0.4;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_prev;
uniform sampler2D u_next;
uniform float u_time;
uniform float u_strength;

in vec2 v_uv;
out vec4 outColor;

const float PI = 3.141592653589793;
const int TAPS = 40;

float linearEase(float begin, float change, float duration, float time) {
  return change * time / duration + begin;
}

float exponentialEaseInOut(float begin, float change, float duration, float time) {
  if (time == 0.0) return begin;
  if (time == duration) return begin + change;
  float t = time / (duration / 2.0);
  if (t < 1.0) return change / 2.0 * pow(2.0, 10.0 * (t - 1.0)) + begin;
  return change / 2.0 * (-pow(2.0, -10.0 * (t - 1.0)) + 2.0) + begin;
}

float sinusoidalEaseInOut(float begin, float change, float duration, float time) {
  return -change / 2.0 * (cos(PI * time / duration) - 1.0) + begin;
}

// A different offset for every pixel, so the smear is grain and not bands.
float random(vec2 co) {
  return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

vec4 crossFade(vec2 uv, float dissolve) {
  return mix(texture(u_prev, uv), texture(u_next, uv), dissolve);
}

void main() {
  float progress = u_time;
  vec2 center = vec2(linearEase(0.25, 0.5, 1.0, progress), 0.5);
  float dissolve = exponentialEaseInOut(0.0, 1.0, 1.0, progress);
  float strength = sinusoidalEaseInOut(0.0, u_strength, 0.5, progress);

  vec4 color = vec4(0.0);
  float total = 0.0;
  vec2 toCenter = center - v_uv;
  float offset = random(v_uv);
  for (int i = 0; i <= TAPS; i++) {
    float percent = (float(i) + offset) / float(TAPS);
    float weight = 4.0 * (percent - percent * percent);
    color += crossFade(v_uv + toCenter * percent * strength, dissolve) * weight;
    total += weight;
  }
  outColor = color / total;
}`;

export interface CrossZoomProps extends Record<string, unknown> {
  /** How far the smear reaches toward the travelling centre, as a fraction of the distance to it. Default 0.4. */
  strength?: number;
}

export const crossZoomShader = transitionShader<CrossZoomProps>({
  fragment: FRAGMENT_SHADER,
  uniforms: ({ strength = DEFAULT_STRENGTH }) => ({ u_strength: strength }),
});

export const crossZoom = makeHtmlInCanvasPresentation(crossZoomShader);
