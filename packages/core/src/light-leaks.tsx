// `@remotion/light-leaks`: a warm, drifting light leak that grows over a scene and retracts again. `<LightLeak>` is the
// component (a WebGL shader over the composition, run natively as a recorded draw, packages/cli/skills/kinetograph/references/AUTHORING.md §6.7);
// `lightLeak()` is the same leak as an effect of a layer, which paints it over what the layer holds.

import type { ReactNode } from 'react';
import { Layer } from '@kinetographdev/react';
import { shader, type BlendMode, type ShaderEffect } from '@kinetographdev/scene';
import { bindQuad, recordingContext, useProgram } from './gl-recording.js';
import { Sequence, useCurrentFrame, useVideoConfig } from './timeline.js';

const VERTEX_SHADER = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
#ifdef GL_ES
precision mediump float;
#endif

uniform float evolveProgress;
uniform float retractProgress;
uniform float seed;
uniform float retractSeed;
uniform float hueShift;
uniform vec2 resolution;

const float Pi = 3.14159;

// brightness, blend and the value that decides where the leak is
vec3 computePattern(vec2 uv, float s, float t) {
  vec2 p = uv * 0.8;
  p += vec2(sin(s * 1.61803) * 5.0, cos(s * 2.71828) * 5.0);

  for (int i = 1; i < 5; i++) {
    vec2 newp = p;
    float fi = float(i);
    float phase = s * 0.7 * fi;
    newp.x += 0.6 / fi * cos(fi * p.y + t * 0.7 + 0.3 * fi + phase) + 20.0;
    newp.y += 0.6 / fi * cos(fi * p.x + t * 0.7 + 0.3 * float(i + 10) + phase) - 20.0 + 15.0;
    p = newp;
  }

  float v1 = 0.5 * sin(2.0 * p.x) + 0.5;
  float v2 = 0.5 * sin(2.0 * p.y) + 0.5;
  float blend = sin(p.x + p.y) * 0.5 + 0.5;
  float brightness = v1 * 0.5 + v2 * 0.5;
  float patternValue = brightness * 0.6 + blend * 0.4;

  return vec3(brightness, blend, patternValue);
}

void main() {
  float refScale = 1.92;
  vec2 uv = (gl_FragCoord.xy / resolution) * vec2(refScale, refScale * resolution.y / resolution.x);

  // The leak grows with the first half of the progress and is erased, from the other corner, by the second.
  vec3 patA = computePattern(uv, seed, evolveProgress * Pi);
  float threshA = 1.0 - evolveProgress;
  float revealAlpha = smoothstep(threshA, threshA + 0.3, patA.z);

  vec2 maxUv = vec2(refScale, refScale * resolution.y / resolution.x);
  vec2 retractUv = maxUv - uv;
  vec3 patB = computePattern(retractUv, retractSeed, retractProgress * Pi);
  float threshB = 1.0 - retractProgress;
  float eraseAlpha = smoothstep(threshB, threshB + 0.3, patB.z);

  float alpha = revealAlpha * (1.0 - eraseAlpha);

  vec3 yellow = vec3(1.0, 0.85, 0.2);
  vec3 orange = vec3(1.0, 0.5, 0.05);
  vec3 col = mix(yellow, orange, patA.y);
  col *= 0.6 + 0.6 * patA.x;

  // A rotation of the colour about the grey axis.
  float angle = hueShift * Pi / 180.0;
  float cosA = cos(angle);
  float sinA = sin(angle);
  mat3 hueRot = mat3(
    cosA + (1.0 - cosA) / 3.0,
    (1.0 - cosA) / 3.0 - sinA * 0.57735,
    (1.0 - cosA) / 3.0 + sinA * 0.57735,
    (1.0 - cosA) / 3.0 + sinA * 0.57735,
    cosA + (1.0 - cosA) / 3.0,
    (1.0 - cosA) / 3.0 - sinA * 0.57735,
    (1.0 - cosA) / 3.0 - sinA * 0.57735,
    (1.0 - cosA) / 3.0 + sinA * 0.57735,
    cosA + (1.0 - cosA) / 3.0
  );
  col = clamp(hueRot * col, 0.0, 1.0);

  gl_FragColor = vec4(col, alpha);
}
`;

/** The seed of the part of the leak that retracts is this far from the one that grows. */
const RETRACT_SEED_OFFSET = 42;

export interface LightLeakProps {
  /** Another seed is another leak. Default 0. */
  readonly seed?: number;
  /** Turns the leak's colour about the grey axis, in degrees, 0 to 360. Default 0. */
  readonly hueShift?: number;
  /** How long the leak lasts. Default: what is left of the enclosing sequence. */
  readonly durationInFrames?: number;
  readonly from?: number;
  readonly name?: string;
  readonly hidden?: boolean;
  readonly showInTimeline?: boolean;
  readonly trimBefore?: number;
  readonly playbackRate?: number;
  readonly loop?: boolean;
  readonly freeze?: number;
  readonly premountFor?: number;
  readonly postmountFor?: number;
  readonly styleWhilePremounted?: Record<string, string | number>;
  readonly styleWhilePostmounted?: Record<string, string | number>;
  /** Of the style, `opacity` and `mixBlendMode` (`screen` for a light leak) are applied; the rest is not. */
  readonly style?: Record<string, string | number>;
  readonly className?: string;
  readonly width?: number;
  readonly height?: number;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** CSS's `mix-blend-mode` as a layer's `blendMode`: `color-dodge` is `colorDodge`. */
function blendModeOf(value: unknown): BlendMode | undefined {
  if (value === undefined || value === 'normal') return undefined;
  if (typeof value !== 'string') return undefined;
  return value.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()) as BlendMode;
}

/** The part of a Remotion `style` that a layer takes. */
export function layerStyleOf(component: string, style: Record<string, string | number> | undefined): { opacity?: number; blendMode?: BlendMode } {
  if (style === undefined) return {};
  const { opacity, mixBlendMode, ...rest } = style;
  for (const key of Object.keys(rest)) {
    warnOnce(`${component}.${key}`, `<${component}> ignores style.${key}: only opacity and mixBlendMode are applied to a native layer.`);
  }
  const blendMode = blendModeOf(mixBlendMode);
  return { ...(opacity !== undefined ? { opacity: Number(opacity) } : {}), ...(blendMode !== undefined ? { blendMode } : {}) };
}

function LightLeakCanvas({ seed, hueShift, style }: { seed: number; hueShift: number; style: LightLeakProps['style'] }): ReactNode {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const gl = recordingContext(width, height, 1, { premultipliedAlpha: false, alpha: true });
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const program = useProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
  bindQuad(gl, program, 'position');

  const normalized = durationInFrames <= 1 ? 0 : frame / (durationInFrames - 1);
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform1f(gl.getUniformLocation(program, 'evolveProgress'), Math.min(1, normalized * 2));
  gl.uniform1f(gl.getUniformLocation(program, 'retractProgress'), Math.max(0, normalized * 2 - 1));
  gl.uniform1f(gl.getUniformLocation(program, 'seed'), seed);
  gl.uniform1f(gl.getUniformLocation(program, 'retractSeed'), seed + RETRACT_SEED_OFFSET);
  gl.uniform1f(gl.getUniformLocation(program, 'hueShift'), hueShift);
  gl.uniform2f(gl.getUniformLocation(program, 'resolution'), width, height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return <Layer glsl={{ width, height, ...gl.content() }} {...layerStyleOf('LightLeak', style)} />;
}

/**
 * A light leak over the composition (or the sequence it is in), growing over the first half of its duration and
 * retracting over the second. Put `mixBlendMode: 'screen'` in its `style` to add its light to the scene.
 */
export function LightLeak({ seed = 0, hueShift = 0, durationInFrames, from, name, style }: LightLeakProps): ReactNode {
  const { durationInFrames: enclosing } = useVideoConfig();
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new TypeError(`"seed" must be a finite number, but got ${JSON.stringify(seed)}`);
  }
  if (typeof hueShift !== 'number' || !Number.isFinite(hueShift)) {
    throw new TypeError(`"hueShift" must be a finite number, but got ${JSON.stringify(hueShift)}`);
  }
  if (hueShift < 0 || hueShift > 360) {
    throw new RangeError(`"hueShift" must be between 0 and 360, but got ${hueShift}`);
  }
  return (
    <Sequence durationInFrames={durationInFrames ?? enclosing} from={from} name={name ?? '<LightLeak>'}>
      <LightLeakCanvas seed={seed} hueShift={hueShift} style={style} />
    </Sequence>
  );
}
LightLeak.displayName = 'LightLeak';

// ---- the effect ----

export const lightLeakEffectSchema = {
  seed: { type: 'number', default: 0, description: 'Seed', hiddenFromList: false },
  hueShift: { type: 'number', min: 0, max: 360, default: 0, description: 'Hue Shift', hiddenFromList: false },
  progress: { type: 'number', min: 0, max: 1, step: 0.01, default: 0.5, description: 'Progress', hiddenFromList: false },
} as const;

export interface LightLeakEffectParams {
  readonly seed?: number;
  readonly hueShift?: number;
  /** Evolve/retract phase from 0 (start) to 1 (end). Defaults to 0.5. */
  readonly progress?: number;
}

function finiteNumber(value: unknown, name: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TypeError(`"${name}" must be a finite number, but got ${JSON.stringify(value)}`);
  }
}

// The same pattern as the component's, in WGSL, painted over what the layer holds (premultiplied, linear). The pixel is
// counted from the bottom, as `gl_FragCoord` is.
const EFFECT_CODE = `
const PI: f32 = 3.14159;

fn compute_pattern(uv: vec2<f32>, s: f32, t: f32) -> vec3<f32> {
  var p = uv * 0.8;
  p += vec2<f32>(sin(s * 1.61803) * 5.0, cos(s * 2.71828) * 5.0);
  for (var i = 1; i < 5; i = i + 1) {
    var newp = p;
    let fi = f32(i);
    let phase = s * 0.7 * fi;
    newp.x += 0.6 / fi * cos(fi * p.y + t * 0.7 + 0.3 * fi + phase) + 20.0;
    newp.y += 0.6 / fi * cos(fi * p.x + t * 0.7 + 0.3 * f32(i + 10) + phase) - 20.0 + 15.0;
    p = newp;
  }
  let v1 = 0.5 * sin(2.0 * p.x) + 0.5;
  let v2 = 0.5 * sin(2.0 * p.y) + 0.5;
  let blend = sin(p.x + p.y) * 0.5 + 0.5;
  let brightness = v1 * 0.5 + v2 * 0.5;
  return vec3<f32>(brightness, blend, brightness * 0.6 + blend * 0.4);
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
  return select(pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}

fn effect(px: vec2<f32>) -> vec4<f32> {
  let resolution = globals.canvas;
  let frag = vec2<f32>(px.x, resolution.y - px.y);
  let ref_scale = 1.92;
  let max_uv = vec2<f32>(ref_scale, ref_scale * resolution.y / resolution.x);
  let uv = (frag / resolution) * max_uv;

  let pat_a = compute_pattern(uv, u.seed, u.evolve * PI);
  let thresh_a = 1.0 - u.evolve;
  let reveal = smoothstep(thresh_a, thresh_a + 0.3, pat_a.z);
  let pat_b = compute_pattern(max_uv - uv, u.seed + 42.0, u.retract * PI);
  let thresh_b = 1.0 - u.retract;
  let erase = smoothstep(thresh_b, thresh_b + 0.3, pat_b.z);
  let alpha = reveal * (1.0 - erase);

  var col = mix(vec3<f32>(1.0, 0.85, 0.2), vec3<f32>(1.0, 0.5, 0.05), pat_a.y);
  col *= 0.6 + 0.6 * pat_a.x;
  let angle = u.hue_shift * PI / 180.0;
  let c = cos(angle);
  let s = sin(angle);
  let k = (1.0 - c) / 3.0;
  let rot = mat3x3<f32>(
    vec3<f32>(c + k, k - s * 0.57735, k + s * 0.57735),
    vec3<f32>(k + s * 0.57735, c + k, k - s * 0.57735),
    vec3<f32>(k - s * 0.57735, k + s * 0.57735, c + k)
  );
  col = clamp(rot * col, vec3<f32>(0.0), vec3<f32>(1.0));

  return vec4<f32>(srgb_to_linear(col) * alpha, alpha) + layer(px) * (1.0 - alpha);
}
`;

/**
 * The light leak as an effect of a layer (`<Layer effects={[lightLeak({ progress })]}>`): the leak is painted over what
 * the layer holds, across the canvas. `progress` is 0 to 1; the leak grows over the first half and retracts over the
 * second.
 */
export function lightLeak(params: LightLeakEffectParams & { readonly disabled?: boolean } = {}): ShaderEffect {
  if (params === null || typeof params !== 'object') {
    throw new TypeError(`lightLeak() effect requires a parameters object, but got ${JSON.stringify(params)}`);
  }
  finiteNumber(params.seed, 'seed');
  finiteNumber(params.hueShift, 'hueShift');
  finiteNumber(params.progress, 'progress');
  const { seed = 0, hueShift = 0, progress = 0.5 } = params;
  if (hueShift < 0) throw new TypeError(`"hueShift" must be >= 0, but got ${hueShift}`);
  if (hueShift > 360) throw new TypeError(`"hueShift" must be <= 360, but got ${hueShift}`);
  if (progress < 0) throw new TypeError(`"progress" must be >= 0, but got ${JSON.stringify(progress)}`);
  if (progress > 1) throw new TypeError(`"progress" must be <= 1, but got ${JSON.stringify(progress)}`);
  // A disabled effect leaves the layer as it is: a leak that is not there.
  const enabled = params.disabled !== true;
  return shader({
    code: EFFECT_CODE,
    uniforms: {
      seed,
      hue_shift: hueShift,
      evolve: enabled ? Math.min(1, progress * 2) : 0,
      retract: enabled ? Math.max(0, progress * 2 - 1) : 0,
    },
  });
}

/** Experimental internals of the published package, kept for imports of it. */
export const LightLeakInternals = { lightLeak } as const;
