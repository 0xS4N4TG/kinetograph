// `@remotion/transitions/zoom-blur`: both scenes are turned, zoomed just enough to cover the frame, and smeared
// radially, the smear and the turn easing off as each scene takes the frame.

import { makeHtmlInCanvasPresentation } from './html-in-canvas.js';
import { transitionShader } from './transition-shader.js';

export interface ZoomBlurProps extends Record<string, unknown> {
  /** The most the scenes turn, in radians. Default π / 6. */
  rotation?: number;
}

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_prev;
uniform sampler2D u_next;
uniform float u_time;
uniform float u_aspect;
uniform float u_max_angle;

in vec2 v_uv;
out vec4 outColor;

const int SAMPLES = 16;
const float STRENGTH = 0.35;

// The position in a scene turned by \`angle\` and zoomed by \`scale\` about the middle of the frame.
vec2 transformUV(vec2 uv, float angle, float scale) {
  vec2 p = uv - 0.5;
  p.x *= u_aspect;
  p /= scale;
  float c = cos(-angle);
  float s = sin(-angle);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  p.x /= u_aspect;
  return p + 0.5;
}

// The zoom that keeps a scene turned by \`angle\` covering the whole frame.
float coverScale(float angle) {
  float c = abs(cos(angle));
  float s = abs(sin(angle));
  float ar = max(u_aspect, 1.0 / u_aspect);
  return c + ar * s;
}

vec4 zoomBlurPrev(vec2 uv, float strength) {
  vec2 dir = uv - 0.5;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < SAMPLES; i++) {
    float t = float(i) / float(SAMPLES - 1);
    acc += texture(u_prev, 0.5 + dir * (1.0 - strength * t));
  }
  return acc / float(SAMPLES);
}

vec4 zoomBlurNext(vec2 uv, float strength) {
  vec2 dir = uv - 0.5;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < SAMPLES; i++) {
    float t = float(i) / float(SAMPLES - 1);
    acc += texture(u_next, 0.5 + dir * (1.0 - strength * t));
  }
  return acc / float(SAMPLES);
}

void main() {
  float mixT = u_time;

  float nextAngle = u_max_angle * mixT;
  float prevAngle = -u_max_angle * (1.0 - mixT);

  vec2 prevUV = transformUV(v_uv, prevAngle, coverScale(prevAngle));
  vec2 nextUV = transformUV(v_uv, nextAngle, coverScale(nextAngle));

  vec4 prev = zoomBlurPrev(prevUV, STRENGTH * (1.0 - mixT));
  vec4 next = zoomBlurNext(nextUV, STRENGTH * mixT);
  outColor = mix(prev, next, (1.0 - mixT));
}`;

export const zoomBlurShader = transitionShader<ZoomBlurProps>({
  fragment: FRAGMENT_SHADER,
  uniforms: ({ rotation = Math.PI / 6 }, { width, height }) => ({ u_aspect: width / height, u_max_angle: rotation }),
});

export const zoomBlur = makeHtmlInCanvasPresentation(zoomBlurShader);
