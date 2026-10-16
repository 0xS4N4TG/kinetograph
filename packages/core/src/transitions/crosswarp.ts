// `@remotion/transitions/crosswarp`: the scene going out shrinks to a point in the middle as the scene coming in grows
// out of it, the warp sweeping across the frame from the left. After the gl-transitions shader "crosswarp" by Eke
// Péter (MIT).

import { makeHtmlInCanvasPresentation } from './html-in-canvas.js';
import { transitionShader } from './transition-shader.js';

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_prev;
uniform sampler2D u_next;
uniform float u_time;

in vec2 v_uv;
out vec4 outColor;

void main() {
  float x = smoothstep(0.0, 1.0, u_time * 2.0 + v_uv.x - 1.0);
  outColor = mix(
    texture(u_next, (v_uv - 0.5) * (1.0 - x) + 0.5),
    texture(u_prev, (v_uv - 0.5) * x + 0.5),
    x
  );
}`;

export type CrosswarpProps = Record<string, never>;

export const crosswarpShader = transitionShader<CrosswarpProps>({ fragment: FRAGMENT_SHADER });

export const crosswarp = makeHtmlInCanvasPresentation(crosswarpShader);
