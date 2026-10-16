// `@remotion/transitions/film-burn`: a burst of warm, blurred light, as film shows when it is exposed to light, covers
// the cut between the scenes. After the gl-transitions shader "FilmBurn" by Anastasia Dunbar (MIT).

import { makeHtmlInCanvasPresentation } from './html-in-canvas.js';
import { transitionShader } from './transition-shader.js';

const DEFAULT_SEED = 2.31;

export interface FilmBurnProps extends Record<string, unknown> {
  /** Moves the burn about: another seed is another pattern of light. Default 2.31. */
  seed?: number;
}

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_prev;
uniform sampler2D u_next;
uniform float u_time;
uniform float u_seed;

in vec2 v_uv;
out vec4 outColor;

const float PI = 3.14159265358979323;
const int LIGHTS = 13;
const int BLUR_TAPS = 50;

float clamp01(float x) {
  return clamp(x, 0.0, 1.0);
}

float sigmoid(float x, float a) {
  float b = pow(x * 2.0, a) / 2.0;
  if (x > 0.5) {
    b = 1.0 - pow(2.0 - (x * 2.0), a) / 2.0;
  }
  return b;
}

float randFloat(float co) {
  return fract(sin((co * 24.9898) + u_seed) * 43758.5453);
}

float randVec(vec2 co) {
  return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

float apow(float a, float b) {
  return pow(abs(a), b) * sign(b);
}

vec3 pow3(vec3 a, vec3 b) {
  return vec3(apow(a.r, b.r), apow(a.g, b.g), apow(a.b, b.b));
}

float smoothMix(float a, float b, float c) {
  return mix(a, b, sigmoid(c, 2.0));
}

float random(vec2 co, float shft) {
  co += 10.0;
  return smoothMix(
    fract(sin(dot(co.xy, vec2(12.9898 + (floor(shft) * 0.5), 78.233 + u_seed))) * 43758.5453),
    fract(sin(dot(co.xy, vec2(12.9898 + (floor(shft + 1.0) * 0.5), 78.233 + u_seed))) * 43758.5453),
    fract(shft)
  );
}

float smoothRandom(vec2 co, float shft) {
  return smoothMix(
    smoothMix(random(floor(co), shft), random(floor(co + vec2(1.0, 0.0)), shft), fract(co.x)),
    smoothMix(random(floor(co + vec2(0.0, 1.0)), shft), random(floor(co + vec2(1.0, 1.0)), shft), fract(co.x)),
    fract(co.y)
  );
}

vec4 sampleTexture(vec2 p, float progress) {
  return mix(texture(u_prev, p), texture(u_next, p), sigmoid(progress, 10.0));
}

void main() {
  float progress = 1.0 - u_time;
  vec2 p = v_uv;

  // The light: a few wandering blobs and waves, tinted warm.
  vec3 f = vec3(0.0);
  for (int n = 0; n < LIGHTS; n++) {
    float i = float(n);
    f += sin(((p.x * randFloat(i) * 6.0) + (progress * 8.0)) + randFloat(i + 1.43)) *
      sin(((p.y * randFloat(i + 4.4) * 6.0) + (progress * 6.0)) + randFloat(i + 2.4));
    f += 1.0 - clamp01(
      length(
        p - vec2(
          smoothRandom(vec2(progress * 1.3), i + 1.0),
          smoothRandom(vec2(progress * 0.5), i + 6.25)
        )
      ) * mix(20.0, 70.0, randFloat(i))
    );
  }

  f += 4.0;
  f /= 11.0;
  f = pow3(f * vec3(1.0, 0.7, 0.6), vec3(1.0, 2.0 - sin(progress * PI), 1.3));
  f *= sin(progress * PI);

  // The picture shakes a little and is blurred in a ring of taps.
  p -= 0.5;
  p *= 1.0 + (smoothRandom(vec2(progress * 5.0), 6.3) * sin(progress * PI) * 0.05);
  p += 0.5;

  vec4 blurredImage = vec4(0.0);
  float blurAmount = sin(progress * PI) * 0.03;
  for (int n = 0; n < BLUR_TAPS; n++) {
    float i = float(n);
    float turn = degrees((i / float(BLUR_TAPS)) * 360.0);
    vec2 q = vec2(cos(turn), sin(turn)) * (randVec(vec2(i, p.x + p.y)) + blurAmount);
    blurredImage += sampleTexture(p + (q * blurAmount), progress);
  }

  blurredImage /= float(BLUR_TAPS);
  outColor = blurredImage + vec4(f, 0.0);
}`;

export const filmBurnShader = transitionShader<FilmBurnProps>({
  fragment: FRAGMENT_SHADER,
  uniforms: ({ seed = DEFAULT_SEED }) => ({ u_seed: seed }),
});

export const filmBurn = makeHtmlInCanvasPresentation(filmBurnShader);
