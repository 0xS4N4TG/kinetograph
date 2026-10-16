// `@remotion/transitions/linear-blur`: both scenes are blurred, most at the middle of the transition, while they
// cross-fade. After the gl-transitions shader "LinearBlur" by gre (MIT).

import { makeHtmlInCanvasPresentation } from './html-in-canvas.js';
import { transitionShader } from './transition-shader.js';

const DEFAULT_INTENSITY = 0.1;

export interface LinearBlurProps extends Record<string, unknown> {
  /** How far the blur reaches at its most, as a fraction of the frame. Default 0.1. */
  intensity?: number;
}

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_prev;
uniform sampler2D u_next;
uniform float u_time;
uniform float u_intensity;

in vec2 v_uv;
out vec4 outColor;

const int PASSES = 20;

void main() {
  float progress = 1.0 - u_time;
  vec4 c1 = vec4(0.0);
  vec4 c2 = vec4(0.0);

  float disp = u_intensity * (0.5 - distance(0.5, progress));
  for (int xi = 0; xi < PASSES; xi++) {
    float x = float(xi) / float(PASSES) - 0.5;
    for (int yi = 0; yi < PASSES; yi++) {
      float y = float(yi) / float(PASSES) - 0.5;
      vec2 v = vec2(x, y);
      c1 += texture(u_prev, v_uv + disp * v);
      c2 += texture(u_next, v_uv + disp * v);
    }
  }

  c1 /= float(PASSES * PASSES);
  c2 /= float(PASSES * PASSES);
  outColor = mix(c1, c2, progress);
}`;

export const linearBlurShader = transitionShader<LinearBlurProps>({
  fragment: FRAGMENT_SHADER,
  uniforms: ({ intensity = DEFAULT_INTENSITY }) => ({ u_intensity: intensity }),
});

export const linearBlur = makeHtmlInCanvasPresentation(linearBlurShader);
