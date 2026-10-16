// `@remotion/transitions/dreamy-zoom`: the scene going out zooms and turns away, washing out to white, and the scene
// coming in turns and zooms back to rest from it. After the gl-transitions shader "DreamyZoom" by Zeh Fernando (MIT).

import { makeHtmlInCanvasPresentation } from './html-in-canvas.js';
import { transitionShader } from './transition-shader.js';

const DEFAULT_ROTATION = 6;
const DEFAULT_SCALE = 1.2;

export interface DreamyZoomProps extends Record<string, unknown> {
  /** How far the scenes turn at the peak, in degrees. Default 6. */
  rotation?: number;
  /** How far the scenes zoom at the peak. Default 1.2. */
  scale?: number;
}

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_prev;
uniform sampler2D u_next;
uniform float u_time;
uniform float u_rotation;
uniform float u_scale;
uniform float u_ratio;

in vec2 v_uv;
out vec4 outColor;

const float DEG2RAD = 0.03926990816987241548078304229099;

void main() {
  float progress = 1.0 - u_time;
  float phase = progress < 0.5 ? progress * 2.0 : (progress - 0.5) * 2.0;
  float angleOffset = progress < 0.5 ? mix(0.0, u_rotation * DEG2RAD, phase) : mix(-u_rotation * DEG2RAD, 0.0, phase);
  float newScale = progress < 0.5 ? mix(1.0, u_scale, phase) : mix(u_scale, 1.0, phase);

  vec2 center = vec2(0.0, 0.0);
  vec2 p = (v_uv.xy - vec2(0.5, 0.5)) / newScale * vec2(u_ratio, 1.0);
  float angle = atan(p.y, p.x) + angleOffset;
  float dist = distance(center, p);

  p.x = cos(angle) * dist / u_ratio + 0.5;
  p.y = sin(angle) * dist + 0.5;

  vec4 c = progress < 0.5 ? texture(u_prev, p) : texture(u_next, p);
  outColor = c + (progress < 0.5 ? mix(0.0, 1.0, phase) : mix(1.0, 0.0, phase));
}`;

export const dreamyZoomShader = transitionShader<DreamyZoomProps>({
  fragment: FRAGMENT_SHADER,
  uniforms: ({ rotation = DEFAULT_ROTATION, scale = DEFAULT_SCALE }, { width, height }) => ({
    u_rotation: rotation,
    u_scale: scale,
    u_ratio: width / height,
  }),
});

export const dreamyZoom = makeHtmlInCanvasPresentation(dreamyZoomShader);
