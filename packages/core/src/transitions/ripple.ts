// `@remotion/transitions/ripple`: the scene going out is rippled outward from the middle of the frame as it gives way
// to the scene coming in. After the gl-transitions shader "ripple" by gre (MIT).

import { makeHtmlInCanvasPresentation } from './html-in-canvas.js';
import { transitionShader } from './transition-shader.js';

const DEFAULT_AMPLITUDE = 100;
const DEFAULT_SPEED = 50;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_prev;
uniform sampler2D u_next;
uniform float u_time;
uniform float u_amplitude;
uniform float u_speed;

in vec2 v_uv;
out vec4 outColor;

void main() {
  float progress = u_time;
  vec2 dir = v_uv - vec2(0.5);
  float dist = length(dir);
  vec2 offset = dir * (sin(progress * dist * u_amplitude - progress * u_speed) + 0.5) / 30.0 * progress;
  outColor = mix(
    texture(u_next, v_uv + offset),
    texture(u_prev, v_uv),
    smoothstep(0.2, 1.0, progress)
  );
}`;

export interface RippleProps extends Record<string, unknown> {
  /** How many ripples there are across the frame. Default 100. */
  amplitude?: number;
  /** How fast the ripples travel. Default 50. */
  speed?: number;
}

export const rippleShader = transitionShader<RippleProps>({
  fragment: FRAGMENT_SHADER,
  uniforms: ({ amplitude = DEFAULT_AMPLITUDE, speed = DEFAULT_SPEED }) => ({ u_amplitude: amplitude, u_speed: speed }),
});

export const ripple = makeHtmlInCanvasPresentation(rippleShader);
