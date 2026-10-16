// `@remotion/starburst`: rays in a palette of colours fanning out from a point. `<Starburst>` is the component (a WebGL
// shader over the composition, run natively as a recorded draw, docs/AUTHORING.md §6.7), with a vignette that fades it
// out toward the edges; `starburst()` is the same rays as an effect of a layer, which replaces what the layer holds.

import type { ReactNode } from 'react';
import { Layer } from '@kinetograph/react';
import { shader, type ShaderEffect } from '@kinetograph/scene';
import { parseColor } from './colors.js';
import { bindQuad, recordingContext, useProgram } from './gl-recording.js';
import { layerStyleOf, type LightLeakProps } from './light-leaks.js';
import { Sequence, useVideoConfig } from './timeline.js';

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

uniform float numRays;
uniform float rotationOffset;
uniform float smoothEdge;
uniform vec2 resolution;
uniform sampler2D colorPalette;
uniform float numColors;
uniform float vignetteAmount;
uniform vec2 originOffset;

const float Pi = 3.14159265359;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec2 center = uv - 0.5 - originOffset;
  center.x *= resolution.x / resolution.y;

  // Which ray the pixel is in, and so which colour of the palette.
  float angle = atan(center.y, center.x) + rotationOffset;
  float normalizedAngle = (angle + Pi) / (2.0 * Pi);
  float sector = normalizedAngle * numRays;
  float rayIndex = mod(floor(sector), numRays);

  float colorIndex = mod(rayIndex, numColors);
  float texCoord = (colorIndex + 0.5) / numColors;
  vec3 col = texture2D(colorPalette, vec2(texCoord, 0.5)).rgb;

  // Near the edge between two rays the colours blend.
  float fractSector = fract(sector);
  float edgeSmooth = smoothEdge * 0.5;
  float nextColorIndex = mod(rayIndex + 1.0, numColors);
  float nextTexCoord = (nextColorIndex + 0.5) / numColors;
  vec3 nextCol = texture2D(colorPalette, vec2(nextTexCoord, 0.5)).rgb;

  float blend = smoothstep(1.0 - edgeSmooth, 1.0, fractSector);
  col = mix(col, nextCol, blend);
  float blendStart = smoothstep(edgeSmooth, 0.0, fractSector);
  float prevColorIndex = mod(rayIndex - 1.0 + numColors, numColors);
  float prevTexCoord = (prevColorIndex + 0.5) / numColors;
  vec3 prevCol = texture2D(colorPalette, vec2(prevTexCoord, 0.5)).rgb;
  col = mix(col, prevCol, blendStart);

  vec2 vignetteCenter = (uv - 0.5) * vec2(resolution.x / resolution.y, 1.0);
  float dist = length(vignetteCenter);
  float radius = vignetteAmount * 3.0;
  float alpha = smoothstep(radius, radius * 0.5, dist);

  gl_FragColor = vec4(col, alpha);
}
`;

/** `[r, g, b]` bytes of a colour. */
export const colorToRgb = (color: string): [number, number, number] => {
  const parsed = parseColor(color);
  if (parsed === null) throw new TypeError(`Invalid color "${color}"`);
  return [parsed.r, parsed.g, parsed.b];
};

export interface StarburstProps extends Omit<LightLeakProps, 'seed' | 'hueShift'> {
  /** The number of rays, 2 to 100. */
  readonly rays: number;
  /** The colours the rays take in turn, at least two. */
  readonly colors: readonly string[];
  /** Turns the rays, in degrees. Default 0. */
  readonly rotation?: number;
  /** How much neighbouring rays blend at their edges, 0 to 1. Default 0. */
  readonly smoothness?: number;
  /** How far the rays reach before they fade out, 0 to 1. Default 1. */
  readonly vignette?: number;
  /** Moves the point the rays come from, as a fraction of the frame. Default 0. */
  readonly originOffsetX?: number;
  readonly originOffsetY?: number;
}

function StarburstCanvas({ rays, colors, rotation, smoothness, vignette, originOffsetX, originOffsetY, style }: Required<Pick<StarburstProps, 'rays' | 'colors' | 'rotation' | 'smoothness' | 'vignette' | 'originOffsetX' | 'originOffsetY'>> & Pick<StarburstProps, 'style'>): ReactNode {
  const { width, height } = useVideoConfig();
  const gl = recordingContext(width, height, 1, { premultipliedAlpha: false, alpha: true });
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const program = useProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
  bindQuad(gl, program, 'position');

  // The palette is a texture a colour wide, one texel for each colour, sampled without filtering.
  const palette = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, palette);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, 'colorPalette'), 0);
  const pixels = new Uint8Array(colors.length * 4);
  colors.forEach((color, i) => pixels.set([...colorToRgb(color), 255], i * 4));
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, colors.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform1f(gl.getUniformLocation(program, 'numRays'), rays);
  gl.uniform1f(gl.getUniformLocation(program, 'numColors'), colors.length);
  gl.uniform1f(gl.getUniformLocation(program, 'rotationOffset'), (rotation * Math.PI) / 180);
  gl.uniform1f(gl.getUniformLocation(program, 'smoothEdge'), smoothness);
  gl.uniform1f(gl.getUniformLocation(program, 'vignetteAmount'), vignette);
  gl.uniform2f(gl.getUniformLocation(program, 'originOffset'), originOffsetX, originOffsetY);
  gl.uniform2f(gl.getUniformLocation(program, 'resolution'), width, height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return <Layer glsl={{ width, height, ...gl.content() }} {...layerStyleOf('Starburst', style)} />;
}

/** Rays in a palette of colours, fanning out from the middle of the composition (or the sequence it is in). */
export function Starburst({
  rays,
  colors,
  rotation = 0,
  smoothness = 0,
  vignette = 1,
  originOffsetX = 0,
  originOffsetY = 0,
  durationInFrames,
  from,
  name,
  style,
}: StarburstProps): ReactNode {
  const { durationInFrames: enclosing } = useVideoConfig();
  if (typeof rays !== 'number' || !Number.isFinite(rays)) {
    throw new TypeError(`"rays" must be a finite number, but got ${JSON.stringify(rays)}`);
  }
  if (rays < 2 || rays > 100) {
    throw new RangeError(`"rays" must be between 2 and 100, but got ${rays}`);
  }
  if (!Array.isArray(colors) || colors.length < 2) {
    throw new TypeError(`"colors" must be an array with at least 2 colors, but got ${JSON.stringify(colors)}`);
  }
  if (typeof rotation !== 'number' || !Number.isFinite(rotation)) {
    throw new TypeError(`"rotation" must be a finite number, but got ${JSON.stringify(rotation)}`);
  }
  if (typeof smoothness !== 'number' || !Number.isFinite(smoothness)) {
    throw new TypeError(`"smoothness" must be a finite number, but got ${JSON.stringify(smoothness)}`);
  }
  if (smoothness < 0 || smoothness > 1) {
    throw new RangeError(`"smoothness" must be between 0 and 1, but got ${smoothness}`);
  }
  if (typeof vignette !== 'number' || !Number.isFinite(vignette)) {
    throw new TypeError(`"vignette" must be a finite number, but got ${JSON.stringify(vignette)}`);
  }
  if (vignette < 0 || vignette > 1) {
    throw new RangeError(`"vignette" must be between 0 and 1, but got ${vignette}`);
  }
  return (
    <Sequence durationInFrames={durationInFrames ?? enclosing} from={from} name={name ?? '<Starburst>'}>
      <StarburstCanvas
        rays={rays}
        colors={colors}
        rotation={rotation}
        smoothness={smoothness}
        vignette={vignette}
        originOffsetX={originOffsetX}
        originOffsetY={originOffsetY}
        style={style}
      />
    </Sequence>
  );
}
Starburst.displayName = 'Starburst';

// ---- the effect ----

export type StarburstOrigin = readonly [number, number];

export interface StarburstEffectParams {
  readonly rays: number;
  readonly colors: readonly string[];
  readonly rotation?: number;
  readonly smoothness?: number;
  /** Where the rays come from, as a fraction of the frame from its top left corner. Default the middle. */
  readonly origin?: StarburstOrigin;
}

const DEFAULT_ORIGIN: StarburstOrigin = [0.5, 0.5];

export const starburstEffectSchema = {
  rays: { type: 'number', min: 2, max: 100, step: 1, default: undefined, description: 'Number of Rays', hiddenFromList: false },
  colors: { type: 'array', item: { type: 'color' }, default: undefined, minLength: 2, newItemDefault: '#ff0000', description: 'Colors', keyframable: false },
  rotation: { type: 'number', min: 0, max: 360, step: 1, default: 0, description: 'Rotation', hiddenFromList: false },
  smoothness: { type: 'number', min: 0, max: 1, step: 0.01, default: 0, description: 'Edge Smoothness', hiddenFromList: false },
  origin: { type: 'uv-coordinate', min: 0, max: 1, step: 0.01, default: DEFAULT_ORIGIN, description: 'Origin' },
} as const;

function validateEffectParams(params: StarburstEffectParams): void {
  if (params === null || typeof params !== 'object') {
    throw new TypeError(`Starburst effect requires a parameters object, but got ${JSON.stringify(params)}`);
  }
  const { rays, colors, rotation = 0, smoothness = 0, origin = DEFAULT_ORIGIN } = params;
  if (typeof rays !== 'number' || !Number.isFinite(rays)) {
    throw new TypeError(`"rays" must be a finite number, but got ${JSON.stringify(rays)}`);
  }
  if (rays < 2 || rays > 100) {
    throw new RangeError(`"rays" must be between 2 and 100, but got ${rays}`);
  }
  if (!Array.isArray(colors) || colors.length < 2) {
    throw new TypeError(`"colors" must be an array with at least 2 colors, but got ${JSON.stringify(colors)}`);
  }
  if (typeof rotation !== 'number' || !Number.isFinite(rotation)) {
    throw new TypeError(`"rotation" must be a finite number, but got ${JSON.stringify(params.rotation)}`);
  }
  if (typeof smoothness !== 'number' || !Number.isFinite(smoothness)) {
    throw new TypeError(`"smoothness" must be a finite number, but got ${JSON.stringify(params.smoothness)}`);
  }
  if (smoothness < 0 || smoothness > 1) {
    throw new RangeError(`"smoothness" must be between 0 and 1, but got ${smoothness}`);
  }
  if (!Array.isArray(origin) || origin.length !== 2 || origin.some((c) => typeof c !== 'number' || !Number.isFinite(c))) {
    throw new TypeError('"origin" must be a [number, number] tuple');
  }
  if (origin.some((c) => c < 0 || c > 1)) {
    throw new RangeError(`"origin" must contain coordinates between 0 and 1, but got ${JSON.stringify(origin)}`);
  }
  colors.forEach(colorToRgb);
}

const srgbToLinear = (byte: number): number => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WGSL of the rays over the canvas, for `colors` (sRGB, mixed as the browser's canvas mixes them, then linear). */
function effectCode(colors: readonly string[]): string {
  const rgb = colors.map((c) => colorToRgb(c).map((byte) => (byte / 255).toFixed(6)));
  return `
const PI: f32 = 3.14159265359;
const COUNT: i32 = ${colors.length};

fn gmod(x: f32, y: f32) -> f32 {
  return x - y * floor(x / y);
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
  return select(pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}

fn palette(index: f32) -> vec3<f32> {
  var colors = array<vec3<f32>, ${colors.length}>(${rgb.map(([r, g, b]) => `vec3<f32>(${r}, ${g}, ${b})`).join(', ')});
  return colors[i32(index)];
}

fn effect(px: vec2<f32>) -> vec4<f32> {
  let resolution = globals.canvas;
  let uv = vec2<f32>(px.x / resolution.x, 1.0 - px.y / resolution.y);
  var center = uv - vec2<f32>(u.origin_x, 1.0 - u.origin_y);
  center.x *= resolution.x / resolution.y;

  let angle = atan2(center.y, center.x) + u.rotation;
  let sector = (angle + PI) / (2.0 * PI) * u.rays;
  let ray = gmod(floor(sector), u.rays);
  let n = f32(COUNT);

  var col = palette(gmod(ray, n));
  let fract_sector = fract(sector);
  let edge = u.smoothness * 0.5;
  col = mix(col, palette(gmod(ray + 1.0, n)), smoothstep(1.0 - edge, 1.0, fract_sector));
  col = mix(col, palette(gmod(ray - 1.0 + n, n)), smoothstep(edge, 0.0, fract_sector));
  return vec4<f32>(srgb_to_linear(col), 1.0);
}
`;
}

/**
 * The rays as an effect of a layer (`<Layer effects={[starburst({ rays, colors })]}>`): they replace what the layer
 * holds, across the canvas. The colours are fixed by the effect's code, so they are not animated by frame.
 */
export function starburst(params: StarburstEffectParams & { readonly disabled?: boolean }): ShaderEffect {
  validateEffectParams(params);
  const { rays, colors, rotation = 0, smoothness = 0, origin = DEFAULT_ORIGIN } = params;
  // A disabled effect leaves the layer as it is.
  if (params.disabled === true) return shader({ code: 'fn effect(px: vec2<f32>) -> vec4<f32> { return layer(px); }' });
  return shader({
    code: effectCode(colors),
    uniforms: { rays, rotation: (rotation * Math.PI) / 180, smoothness, origin_x: origin[0], origin_y: origin[1] },
  });
}

/** Experimental internals of the published package, kept for imports of it. */
export const StarburstInternals = { starburst } as const;
