// `@remotion/transitions/zoom-in-out`: the scene going out zooms in and is replaced, half way, by the scene coming in,
// which zooms out to rest. After the gl-transitions shader "zoomInOut" by OllyOllyOlly (MIT).

import { makeHtmlInCanvasPresentation } from './html-in-canvas.js';
import { transitionShader } from './transition-shader.js';

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_prev;
uniform sampler2D u_next;
uniform float u_time;

in vec2 v_uv;
out vec4 outColor;

vec2 zoom(vec2 uv, float amount) {
  return 0.5 + ((uv - 0.5) * (1.0 - amount));
}

void main() {
  float progress = 1.0 - u_time;
  float zoomFrom = smoothstep(0.0, 1.0, progress * 2.0);
  float zoomTo = smoothstep(0.0, 1.0, (1.0 - progress) * 2.0);
  float crossfade = smoothstep(0.4, 0.6, progress);
  outColor = mix(
    texture(u_prev, zoom(v_uv, zoomFrom)),
    texture(u_next, zoom(v_uv, zoomTo)),
    crossfade
  );
}`;

export type ZoomInOutProps = Record<string, never>;

export const zoomInOutShader = transitionShader<ZoomInOutProps>({ fragment: FRAGMENT_SHADER });

export const zoomInOut = makeHtmlInCanvasPresentation(zoomInOutShader);
