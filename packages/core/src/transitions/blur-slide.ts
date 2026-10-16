// `@remotion/transitions/blur-slide`: both scenes slide across the frame together and are blurred along the slide, most
// at the middle, the scene coming in taking over in a cross-fade there. The slide wraps round the frame's edges.

import { makeHtmlInCanvasPresentation } from './html-in-canvas.js';
import type { SlideDirection } from './slide.js';
import { transitionShader } from './transition-shader.js';

const DEFAULT_DIRECTION: BlurSlideDirection = 'from-left';
const DEFAULT_BLUR = 0.5;
const DIRECTIONS: readonly BlurSlideDirection[] = ['from-left', 'from-right', 'from-top', 'from-bottom'];

export type BlurSlideDirection = SlideDirection;

export interface BlurSlideProps extends Record<string, unknown> {
  /** The side the slide comes from. Default `from-left`. */
  direction?: BlurSlideDirection;
  /** How long the blur is at its longest, as a fraction of the frame. Default 0.5. */
  blur?: number;
}

// The blur is a box kernel along the slide, TAPS squared taps long: the published package draws it in two passes, the
// first with TAPS coarse taps across its whole length and the second with TAPS fine ones across one coarse spacing,
// which together are TAPS * TAPS evenly spaced taps (a single pass of that many widely spaced taps shows moiré on
// detailed pictures). A recorded context draws one pass to the frame, so the taps of both are taken here at once.
const TAPS = 32;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_prev;
uniform sampler2D u_next;
uniform float u_progress;
uniform vec2 u_direction;
uniform float u_blur_length;

in vec2 v_uv;
out vec4 outColor;

const int TAPS = ${TAPS};

void main() {
  // Both scenes travel together; the one going out wraps round the edges (the textures repeat) and the one coming in
  // takes over in a cross-fade in the middle.
  vec2 slid = v_uv - u_direction * u_progress;
  float mixFactor = smoothstep(0.3, 0.7, u_progress);
  float coarse = u_blur_length / float(TAPS - 1);

  vec4 prevSum = vec4(0.0);
  vec4 nextSum = vec4(0.0);
  for (int j = 0; j < TAPS; j++) {
    float fine = ((float(j) + 0.5) / float(TAPS) - 0.5) * coarse;
    for (int i = 0; i < TAPS; i++) {
      float t = (float(i) / float(TAPS - 1) - 0.5) * u_blur_length;
      vec2 uv = slid + u_direction * (t + fine);
      if (mixFactor < 1.0) prevSum += texture(u_prev, uv);
      if (mixFactor > 0.0) nextSum += texture(u_next, uv);
    }
  }
  // The mix is the same at every tap, so it is taken once, of the sums.
  outColor = mix(prevSum, nextSum, mixFactor) / float(TAPS * TAPS);
}`;

const VECTORS: Record<BlurSlideDirection, [number, number]> = {
  'from-left': [1, 0],
  'from-right': [-1, 0],
  // The frame's y counts down.
  'from-top': [0, 1],
  'from-bottom': [0, -1],
};

/** The slide eases to rest at both ends with a quintic curve; the blur is longest half way. */
export function blurSlideMotion(time: number, blur: number): { progress: number; blurLength: number } {
  // At time 0 the shader shows the scene going out, which is the slide at its far end.
  const p = 1 - time;
  const progress = p * p * p * (p * (p * 6 - 15) + 10);
  return { progress, blurLength: blur * 2 * Math.min(progress, 1 - progress) };
}

export const blurSlideShader = transitionShader<BlurSlideProps>({
  fragment: FRAGMENT_SHADER,
  wrap: 'repeat',
  uniforms: ({ direction = DEFAULT_DIRECTION, blur = DEFAULT_BLUR }, { time }) => {
    const { progress, blurLength } = blurSlideMotion(time, blur);
    return { u_progress: progress, u_direction: VECTORS[direction], u_blur_length: blurLength };
  },
});

function validateProps(props: BlurSlideProps): void {
  const { direction = DEFAULT_DIRECTION, blur = DEFAULT_BLUR } = props;
  if (!DIRECTIONS.includes(direction)) {
    throw new TypeError(`direction passed to blurSlide() must be one of ${DIRECTIONS.map((d) => `"${d}"`).join(', ')}, received ${JSON.stringify(direction)}`);
  }
  if (typeof blur !== 'number' || !Number.isFinite(blur)) {
    throw new TypeError(`blur passed to blurSlide() must be a finite number, received ${blur}`);
  }
  if (blur < 0) {
    throw new TypeError(`blur passed to blurSlide() must be greater than or equal to 0, received ${blur}`);
  }
}

const makeBlurSlide = makeHtmlInCanvasPresentation(blurSlideShader);

export const blurSlide = (props: BlurSlideProps = {}) => {
  validateProps(props);
  return makeBlurSlide(props);
};
