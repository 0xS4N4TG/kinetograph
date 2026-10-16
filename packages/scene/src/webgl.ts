// A `WebGLRenderingContext` and `WebGL2RenderingContext` that record instead of rasterising (docs/SCENE.md, "glsl").
// It keeps the context's state as a browser's does and writes each clear and each draw as an op that carries the
// program, the vertex data, the uniforms, the textures and the state it ran with; the renderer replays the ops on the
// GPU with the page's own GLSL, translated to WGSL by naga. Nothing here reads a clock or anything else outside the
// calls, so what a context holds is a function of what it was told.
//
// The slice that is drawn is the one shader-toy pages and shader transitions use: programs of two shaders, buffers,
// attributes of floats (and normalised bytes and shorts), uniforms, 2D textures, `drawArrays` and `drawElements` of
// triangles, viewport, scissor, blending, colour mask, culling and clear, into the canvas or into the texture of a
// framebuffer (render to texture, ping-pong). Anything else throws a
// `WebGLUnsupportedError` whose message starts with "unsupported:" and says what to do instead; a call is never
// accepted and then ignored where it would change the picture.

import type { CanvasSource, GlslContent, GlslDraw, GlslLayer, GlslOp, GlslSampler, GlslTexture, GlslUniform } from './types.js';
import { pictureOf } from './canvas.js';

/** The method a picture of another layer answers a texture upload with (`layerPicture`). */
export const LAYER_SOURCE: unique symbol = Symbol.for('kinetograph.layerSource');

/**
 * A picture of a child of a shader group (docs/SCENE.md, "Shader groups"), to upload as a texture the way a page uploads
 * a canvas: `gl.texImage2D(..., picture)`. The renderer draws the child and samples it; nothing is read here.
 */
export function layerPicture(id: string, width: number, height: number): { readonly width: number; readonly height: number } {
  return { width, height, [LAYER_SOURCE]: () => ({ id, width, height }) } as { readonly width: number; readonly height: number };
}

/** Thrown by a call the engine does not draw. The message starts with "unsupported:". */
export class WebGLUnsupportedError extends Error {
  override name = 'WebGLUnsupportedError';
  constructor(what: string) {
    super(`unsupported: ${what} (docs/SCENE.md, "glsl")`);
  }
}

export const GL = {
  DEPTH_BUFFER_BIT: 0x100,
  STENCIL_BUFFER_BIT: 0x400,
  COLOR_BUFFER_BIT: 0x4000,
  POINTS: 0,
  LINES: 1,
  LINE_LOOP: 2,
  LINE_STRIP: 3,
  TRIANGLES: 4,
  TRIANGLE_STRIP: 5,
  TRIANGLE_FAN: 6,
  ZERO: 0,
  ONE: 1,
  SRC_COLOR: 0x300,
  ONE_MINUS_SRC_COLOR: 0x301,
  SRC_ALPHA: 0x302,
  ONE_MINUS_SRC_ALPHA: 0x303,
  DST_ALPHA: 0x304,
  ONE_MINUS_DST_ALPHA: 0x305,
  DST_COLOR: 0x306,
  ONE_MINUS_DST_COLOR: 0x307,
  SRC_ALPHA_SATURATE: 0x308,
  FUNC_ADD: 0x8006,
  BLEND_EQUATION: 0x8009,
  BLEND_EQUATION_RGB: 0x8009,
  BLEND_EQUATION_ALPHA: 0x883d,
  FUNC_SUBTRACT: 0x800a,
  FUNC_REVERSE_SUBTRACT: 0x800b,
  MIN: 0x8007,
  MAX: 0x8008,
  BLEND_DST_RGB: 0x80c8,
  BLEND_SRC_RGB: 0x80c9,
  BLEND_DST_ALPHA: 0x80ca,
  BLEND_SRC_ALPHA: 0x80cb,
  CONSTANT_COLOR: 0x8001,
  ONE_MINUS_CONSTANT_COLOR: 0x8002,
  CONSTANT_ALPHA: 0x8003,
  ONE_MINUS_CONSTANT_ALPHA: 0x8004,
  BLEND_COLOR: 0x8005,
  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  ARRAY_BUFFER_BINDING: 0x8894,
  ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
  STREAM_DRAW: 0x88e0,
  STATIC_DRAW: 0x88e4,
  DYNAMIC_DRAW: 0x88e8,
  BUFFER_SIZE: 0x8764,
  BUFFER_USAGE: 0x8765,
  FRONT: 0x404,
  BACK: 0x405,
  FRONT_AND_BACK: 0x408,
  TEXTURE_2D: 0xde1,
  CULL_FACE: 0xb44,
  BLEND: 0xbe2,
  DITHER: 0xbd0,
  STENCIL_TEST: 0xb90,
  DEPTH_TEST: 0xb71,
  SCISSOR_TEST: 0xc11,
  POLYGON_OFFSET_FILL: 0x8037,
  SAMPLE_ALPHA_TO_COVERAGE: 0x809e,
  SAMPLE_COVERAGE: 0x80a0,
  NO_ERROR: 0,
  INVALID_ENUM: 0x500,
  INVALID_VALUE: 0x501,
  INVALID_OPERATION: 0x502,
  INVALID_FRAMEBUFFER_OPERATION: 0x506,
  OUT_OF_MEMORY: 0x505,
  CW: 0x900,
  CCW: 0x901,
  LINE_WIDTH: 0xb21,
  CULL_FACE_MODE: 0xb45,
  FRONT_FACE: 0xb46,
  DEPTH_RANGE: 0xb70,
  VIEWPORT: 0xba2,
  SCISSOR_BOX: 0xc10,
  COLOR_CLEAR_VALUE: 0xc22,
  COLOR_WRITEMASK: 0xc23,
  UNPACK_ALIGNMENT: 0xcf5,
  PACK_ALIGNMENT: 0xd05,
  MAX_TEXTURE_SIZE: 0xd33,
  MAX_VIEWPORT_DIMS: 0xd3a,
  SUBPIXEL_BITS: 0xd50,
  RED_BITS: 0xd52,
  GREEN_BITS: 0xd53,
  BLUE_BITS: 0xd54,
  ALPHA_BITS: 0xd55,
  DEPTH_BITS: 0xd56,
  STENCIL_BITS: 0xd57,
  DONT_CARE: 0x1100,
  FASTEST: 0x1101,
  NICEST: 0x1102,
  BYTE: 0x1400,
  UNSIGNED_BYTE: 0x1401,
  SHORT: 0x1402,
  UNSIGNED_SHORT: 0x1403,
  INT: 0x1404,
  UNSIGNED_INT: 0x1405,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,
  DEPTH_COMPONENT: 0x1902,
  ALPHA: 0x1906,
  RGB: 0x1907,
  RGBA: 0x1908,
  LUMINANCE: 0x1909,
  LUMINANCE_ALPHA: 0x190a,
  FRAGMENT_SHADER: 0x8b30,
  VERTEX_SHADER: 0x8b31,
  MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
  MAX_VARYING_VECTORS: 0x8dfc,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
  SHADER_TYPE: 0x8b4f,
  DELETE_STATUS: 0x8b80,
  LINK_STATUS: 0x8b82,
  VALIDATE_STATUS: 0x8b83,
  ATTACHED_SHADERS: 0x8b85,
  ACTIVE_UNIFORMS: 0x8b86,
  ACTIVE_ATTRIBUTES: 0x8b89,
  COMPILE_STATUS: 0x8b81,
  SHADING_LANGUAGE_VERSION: 0x8b8c,
  CURRENT_PROGRAM: 0x8b8d,
  LOW_FLOAT: 0x8df0,
  MEDIUM_FLOAT: 0x8df1,
  HIGH_FLOAT: 0x8df2,
  LOW_INT: 0x8df3,
  MEDIUM_INT: 0x8df4,
  HIGH_INT: 0x8df5,
  FLOAT_VEC2: 0x8b50,
  FLOAT_VEC3: 0x8b51,
  FLOAT_VEC4: 0x8b52,
  INT_VEC2: 0x8b53,
  INT_VEC3: 0x8b54,
  INT_VEC4: 0x8b55,
  BOOL: 0x8b56,
  BOOL_VEC2: 0x8b57,
  BOOL_VEC3: 0x8b58,
  BOOL_VEC4: 0x8b59,
  FLOAT_MAT2: 0x8b5a,
  FLOAT_MAT3: 0x8b5b,
  FLOAT_MAT4: 0x8b5c,
  SAMPLER_2D: 0x8b5e,
  SAMPLER_CUBE: 0x8b60,
  VERTEX_ATTRIB_ARRAY_ENABLED: 0x8622,
  VERTEX_ATTRIB_ARRAY_SIZE: 0x8623,
  VERTEX_ATTRIB_ARRAY_STRIDE: 0x8624,
  VERTEX_ATTRIB_ARRAY_TYPE: 0x8625,
  VERTEX_ATTRIB_ARRAY_NORMALIZED: 0x886a,
  VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: 0x889f,
  VERTEX_ATTRIB_ARRAY_DIVISOR: 0x88fe,
  CURRENT_VERTEX_ATTRIB: 0x8626,
  NEVER: 0x200,
  LESS: 0x201,
  EQUAL: 0x202,
  LEQUAL: 0x203,
  GREATER: 0x204,
  NOTEQUAL: 0x205,
  GEQUAL: 0x206,
  ALWAYS: 0x207,
  NEAREST: 0x2600,
  LINEAR: 0x2601,
  NEAREST_MIPMAP_NEAREST: 0x2700,
  LINEAR_MIPMAP_NEAREST: 0x2701,
  NEAREST_MIPMAP_LINEAR: 0x2702,
  LINEAR_MIPMAP_LINEAR: 0x2703,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  TEXTURE: 0x1702,
  TEXTURE_CUBE_MAP: 0x8513,
  TEXTURE_BINDING_2D: 0x8069,
  TEXTURE0: 0x84c0,
  TEXTURE1: 0x84c1,
  TEXTURE2: 0x84c2,
  TEXTURE3: 0x84c3,
  TEXTURE4: 0x84c4,
  TEXTURE5: 0x84c5,
  TEXTURE6: 0x84c6,
  TEXTURE7: 0x84c7,
  TEXTURE8: 0x84c8,
  TEXTURE9: 0x84c9,
  TEXTURE10: 0x84ca,
  TEXTURE11: 0x84cb,
  TEXTURE12: 0x84cc,
  TEXTURE13: 0x84cd,
  TEXTURE14: 0x84ce,
  TEXTURE15: 0x84cf,
  ACTIVE_TEXTURE: 0x84e0,
  REPEAT: 0x2901,
  CLAMP_TO_EDGE: 0x812f,
  MIRRORED_REPEAT: 0x8370,
  FRAMEBUFFER: 0x8d40,
  RENDERBUFFER: 0x8d41,
  RGBA4: 0x8056,
  RGB5_A1: 0x8057,
  RGB565: 0x8d62,
  DEPTH_COMPONENT16: 0x81a5,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8cd6,
  FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: 0x8cd7,
  FRAMEBUFFER_BINDING: 0x8ca6,
  COLOR_ATTACHMENT0: 0x8ce0,
  DEPTH_ATTACHMENT: 0x8d00,
  STENCIL_ATTACHMENT: 0x8d20,
  DEPTH_STENCIL_ATTACHMENT: 0x821a,
  NONE: 0,
  BROWSER_DEFAULT_WEBGL: 0x9244,
  UNPACK_FLIP_Y_WEBGL: 0x9240,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  CONTEXT_LOST_WEBGL: 0x9242,
  UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
  VENDOR: 0x1f00,
  RENDERER: 0x1f01,
  VERSION: 0x1f02,
} as const;

/** What WebGL 2 adds that a recorded context takes. */
export const GL2 = {
  RED: 0x1903,
  RG: 0x8227,
  R8: 0x8229,
  RG8: 0x822b,
  RGB8: 0x8051,
  RGBA8: 0x8058,
  RGBA32F: 0x8814,
  RGB32F: 0x8815,
  R32F: 0x822e,
  RGBA16F: 0x881a,
  SRGB8_ALPHA8: 0x8c43,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
  READ_FRAMEBUFFER_BINDING: 0x8caa,
  TEXTURE_3D: 0x806f,
  TEXTURE_2D_ARRAY: 0x8c1a,
  UNIFORM_BUFFER: 0x8a11,
  PIXEL_UNPACK_BUFFER: 0x88ec,
  PIXEL_PACK_BUFFER: 0x88eb,
  UNPACK_ROW_LENGTH: 0xcf2,
  UNPACK_SKIP_ROWS: 0xcf3,
  UNPACK_SKIP_PIXELS: 0xcf4,
  MAX_DRAW_BUFFERS: 0x8824,
  MAX_COLOR_ATTACHMENTS: 0x8cdf,
  UNSIGNED_INT_VEC2: 0x8dc6,
  UNSIGNED_INT_VEC3: 0x8dc7,
  UNSIGNED_INT_VEC4: 0x8dc8,
  FLOAT_MAT2x3: 0x8b65,
  SAMPLER_3D: 0x8b5f,
} as const;

// ---- objects ----

let nextId = 1;

export class WebGLObject {
  readonly id = nextId++;
  deleted = false;
}
export class WebGLShader extends WebGLObject {
  source = '';
  constructor(readonly type: number) {
    super();
  }
}
export class WebGLBuffer extends WebGLObject {
  data: Uint8Array = new Uint8Array(0);
  /** Changes with the contents, so the recording keeps a snapshot once for each. */
  version = 0;
  snapshot: { version: number; id: string; base64: string } | null = null;
  usage: number = GL.STATIC_DRAW;
}
export class WebGLTexture extends WebGLObject {
  width = 0;
  height = 0;
  /** RGBA8, straight alpha, as uploaded. */
  pixels: Uint8Array | null = null;
  src: string | null = null;
  /** A child of a shader group, drawn (`layerPicture`). */
  layer: string | null = null;
  flipY = false;
  premultiply = false;
  mipmaps = false;
  uploaded = false;
  /** The internal format it was specified with. */
  format: number = GL.RGBA;
  /** Whether it holds transparent black (what a framebuffer's texture starts as). */
  blank = false;
  /** The `version` at which a framebuffer last drew in it: until it is specified again, it is a render target. */
  drawnAt = -1;
  min: number = GL.NEAREST_MIPMAP_LINEAR;
  mag: number = GL.LINEAR;
  wrapS: number = GL.REPEAT;
  wrapT: number = GL.REPEAT;
  version = 0;
  snapshot: { version: number; id: string; json: GlslTexture } | null = null;
}
export class WebGLFramebuffer extends WebGLObject {
  /** The texture attached to COLOR_ATTACHMENT0. */
  color: WebGLTexture | null = null;
  /** Bound at least once, as `isFramebuffer` asks. */
  bound = false;
}
export class WebGLRenderbuffer extends WebGLObject {}
export class WebGLVertexArrayObject extends WebGLObject {
  readonly attributes: VertexAttribute[] = [];
  element: WebGLBuffer | null = null;
}
export class WebGLUniformLocation {
  constructor(
    readonly program: WebGLProgram,
    readonly name: string,
    readonly index: number,
    readonly type: string,
  ) {}
}
export class WebGLActiveInfo {
  constructor(
    readonly name: string,
    readonly size: number,
    readonly type: number,
  ) {}
}
export class WebGLShaderPrecisionFormat {
  rangeMin = 127;
  rangeMax = 127;
  precision = 23;
}

interface VertexAttribute {
  enabled: boolean;
  buffer: WebGLBuffer | null;
  size: number;
  type: number;
  normalized: boolean;
  stride: number;
  offset: number;
  divisor: number;
  /** `vertexAttrib4f`'s value, used while the array is disabled. */
  constant: [number, number, number, number] | null;
}

function newAttribute(): VertexAttribute {
  return { enabled: false, buffer: null, size: 4, type: GL.FLOAT, normalized: false, stride: 0, offset: 0, divisor: 0, constant: null };
}

interface Declaration {
  name: string;
  type: string;
  length: number;
  location: number | null;
}

interface UniformCall {
  kind: 'f' | 'i' | 'm';
  value: number[];
  index: number;
}

export class WebGLProgram extends WebGLObject {
  shaders: WebGLShader[] = [];
  linked = false;
  vertex = '';
  fragment = '';
  /** Attribute name to location, as the link left it. */
  attributes = new Map<string, number>();
  bound = new Map<string, number>();
  uniformDeclarations: Declaration[] = [];
  attributeDeclarations: Declaration[] = [];
  /** The uniform values set so far, by name. */
  uniforms = new Map<string, UniformCall[]>();
}

// ---- reading the source for names ----

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
}

/** The top-level `uniform`, `attribute` and `in` declarations of a shader. */
function declarations(source: string, keywords: string[]): Declaration[] {
  const code = stripComments(source).replace(/^[ \t]*#.*$/gm, '');
  const statements: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of code) {
    if (c === '{') {
      depth += 1;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      if (depth === 0) current = '';
      continue;
    }
    if (depth > 0) continue;
    if (c === ';') {
      statements.push(current);
      current = '';
    } else current += c;
  }
  const out: Declaration[] = [];
  const pattern = /^\s*(?:layout\s*\(([^)]*)\)\s*)?(?:(?:invariant|flat|smooth|centroid|highp|mediump|lowp)\s+)*(uniform|attribute|in|varying|out)\s+(?:(?:flat|smooth|centroid|highp|mediump|lowp)\s+)*(\w+)\s+([\s\S]+)$/;
  for (const statement of statements) {
    const m = pattern.exec(statement);
    if (m === null || !keywords.includes(m[2]!)) continue;
    const location = /location\s*=\s*(\d+)/.exec(m[1] ?? '');
    for (const declarator of m[4]!.split(',')) {
      const d = /^\s*(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*$/.exec(declarator);
      if (d === null) continue;
      out.push({ name: d[1]!, type: m[3]!, length: d[2] === undefined ? 1 : Number(d[2]), location: location ? Number(location[1]) : null });
    }
  }
  return out;
}

const TYPE_CODES: Record<string, number> = {
  float: GL.FLOAT,
  vec2: GL.FLOAT_VEC2,
  vec3: GL.FLOAT_VEC3,
  vec4: GL.FLOAT_VEC4,
  int: GL.INT,
  ivec2: GL.INT_VEC2,
  ivec3: GL.INT_VEC3,
  ivec4: GL.INT_VEC4,
  uint: GL.UNSIGNED_INT,
  bool: GL.BOOL,
  bvec2: GL.BOOL_VEC2,
  bvec3: GL.BOOL_VEC3,
  bvec4: GL.BOOL_VEC4,
  mat2: GL.FLOAT_MAT2,
  mat3: GL.FLOAT_MAT3,
  mat4: GL.FLOAT_MAT4,
  sampler2D: GL.SAMPLER_2D,
  samplerCube: GL.SAMPLER_CUBE,
};

// ---- names of enums in the scene format ----

const FILTERS: Record<number, string> = {
  [GL.NEAREST]: 'NEAREST',
  [GL.LINEAR]: 'LINEAR',
  [GL.NEAREST_MIPMAP_NEAREST]: 'NEAREST_MIPMAP_NEAREST',
  [GL.LINEAR_MIPMAP_NEAREST]: 'LINEAR_MIPMAP_NEAREST',
  [GL.NEAREST_MIPMAP_LINEAR]: 'NEAREST_MIPMAP_LINEAR',
  [GL.LINEAR_MIPMAP_LINEAR]: 'LINEAR_MIPMAP_LINEAR',
};
const WRAPS: Record<number, string> = { [GL.REPEAT]: 'REPEAT', [GL.CLAMP_TO_EDGE]: 'CLAMP_TO_EDGE', [GL.MIRRORED_REPEAT]: 'MIRRORED_REPEAT' };
const FACTORS: Record<number, string> = {
  [GL.ZERO]: 'ZERO',
  [GL.ONE]: 'ONE',
  [GL.SRC_COLOR]: 'SRC_COLOR',
  [GL.ONE_MINUS_SRC_COLOR]: 'ONE_MINUS_SRC_COLOR',
  [GL.DST_COLOR]: 'DST_COLOR',
  [GL.ONE_MINUS_DST_COLOR]: 'ONE_MINUS_DST_COLOR',
  [GL.SRC_ALPHA]: 'SRC_ALPHA',
  [GL.ONE_MINUS_SRC_ALPHA]: 'ONE_MINUS_SRC_ALPHA',
  [GL.DST_ALPHA]: 'DST_ALPHA',
  [GL.ONE_MINUS_DST_ALPHA]: 'ONE_MINUS_DST_ALPHA',
  [GL.SRC_ALPHA_SATURATE]: 'SRC_ALPHA_SATURATE',
  [GL.CONSTANT_COLOR]: 'CONSTANT_COLOR',
  [GL.ONE_MINUS_CONSTANT_COLOR]: 'ONE_MINUS_CONSTANT_COLOR',
  [GL.CONSTANT_ALPHA]: 'CONSTANT_ALPHA',
  [GL.ONE_MINUS_CONSTANT_ALPHA]: 'ONE_MINUS_CONSTANT_ALPHA',
};
const EQUATIONS: Record<number, string> = {
  [GL.FUNC_ADD]: 'FUNC_ADD',
  [GL.FUNC_SUBTRACT]: 'FUNC_SUBTRACT',
  [GL.FUNC_REVERSE_SUBTRACT]: 'FUNC_REVERSE_SUBTRACT',
  [GL.MIN]: 'MIN',
  [GL.MAX]: 'MAX',
};

// ---- bytes ----

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Two FNV-1a passes with different bases: an id for content, 16 hex digits. */
function hashOf(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

type BufferSource = ArrayBuffer | ArrayBufferView | SharedArrayBuffer;

function bytesOf(data: BufferSource, srcOffset = 0, length = 0): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    const size = (data as ArrayBufferView & { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
    const start = data.byteOffset + srcOffset * size;
    const count = length > 0 ? length * size : data.byteLength - srcOffset * size;
    return new Uint8Array(data.buffer.slice(start, start + count));
  }
  return new Uint8Array((data as ArrayBuffer).slice(0));
}

// ---- the context ----

export interface WebGLContextAttributesLike {
  alpha?: boolean;
  premultipliedAlpha?: boolean;
  preserveDrawingBuffer?: boolean;
  antialias?: boolean;
  depth?: boolean;
  stencil?: boolean;
  [key: string]: unknown;
}

export interface WebGLContextOptions {
  /** The drawing buffer's size now (it changes with `canvas.width`). */
  size: () => { width: number; height: number };
  /** The element the context draws on (`gl.canvas`). */
  canvas?: unknown;
  /** 1 for `webgl`, 2 for `webgl2`. */
  version?: 1 | 2;
  attributes?: WebGLContextAttributesLike;
  /** The straight-alpha RGBA8 pixels of a canvas drawn into a texture, or null when they cannot be had. */
  rasterize?: (source: Extract<CanvasSource, { kind: 'canvas' }>) => Uint8Array | null;
}

interface Capability {
  blend: boolean;
  cull: boolean;
  scissor: boolean;
  depth: boolean;
  stencil: boolean;
}

interface BlendState {
  srcRgb: number;
  dstRgb: number;
  srcAlpha: number;
  dstAlpha: number;
  eqRgb: number;
  eqAlpha: number;
  color: [number, number, number, number];
}

const UNSUPPORTED_CAPS = new Map<number, string>([
  [GL.DEPTH_TEST, 'the depth test (disable(gl.DEPTH_TEST); a flat quad does not need it)'],
  [GL.STENCIL_TEST, 'the stencil test'],
  [GL.POLYGON_OFFSET_FILL, 'polygon offset'],
  [GL.SAMPLE_ALPHA_TO_COVERAGE, 'alpha to coverage'],
  [GL.SAMPLE_COVERAGE, 'sample coverage'],
]);

/** Formats of a texture that colour cannot be drawn into. */
const NOT_RENDERABLE = new Set<number>([GL.ALPHA, GL.LUMINANCE, GL.LUMINANCE_ALPHA, GL.DEPTH_COMPONENT]);

/**
 * `WebGLRenderingContext` (and, with `version: 2`, the `WebGL2RenderingContext` calls shader pages use) as a recorder.
 * `content()` is what the `glsl` layer is made of. A context keeps its objects (programs, buffers, textures) and its
 * state between frames as a browser's does; the drawing buffer is a browser's too: the first draw or clear after
 * `resetState()` (the frame loop calls it before a frame) starts it afresh, unless the context was made with
 * `preserveDrawingBuffer`.
 */
export class WebGLContext {
  readonly canvas: unknown;
  readonly version: 1 | 2;
  private readonly options: WebGLContextOptions;
  private readonly attributes: Required<Pick<WebGLContextAttributesLike, 'alpha' | 'premultipliedAlpha' | 'preserveDrawingBuffer' | 'antialias' | 'depth' | 'stencil'>>;
  private ops: GlslOp[] = [];
  /** The next draw or clear starts a fresh drawing buffer. */
  private stale = false;
  private error: number = GL.NO_ERROR;

  private program: WebGLProgram | null = null;
  private arrayBuffer: WebGLBuffer | null = null;
  private defaultVao = new WebGLVertexArrayObject();
  private vao: WebGLVertexArrayObject = this.defaultVao;
  /** What draws and clears go to, and what `readPixels` and blits would read (WebGL 2); null is the canvas. */
  private drawFramebuffer: WebGLFramebuffer | null = null;
  private readFramebuffer: WebGLFramebuffer | null = null;
  private activeUnit = 0;
  private readonly units = new Map<number, WebGLTexture>();
  private caps: Capability = { blend: false, cull: false, scissor: false, depth: false, stencil: false };
  private viewportBox: [number, number, number, number] | null = null;
  private scissorBox: [number, number, number, number] | null = null;
  private blend: BlendState = { srcRgb: GL.ONE, dstRgb: GL.ZERO, srcAlpha: GL.ONE, dstAlpha: GL.ZERO, eqRgb: GL.FUNC_ADD, eqAlpha: GL.FUNC_ADD, color: [0, 0, 0, 0] };
  private colorMaskState: [boolean, boolean, boolean, boolean] = [true, true, true, true];
  private clearColorValue: [number, number, number, number] = [0, 0, 0, 0];
  private cullMode: number = GL.BACK;
  private frontFaceMode: number = GL.CCW;
  private flipY = false;
  private premultiply = false;
  private unpackAlignment = 4;

  // What the ops refer to, by id.
  private readonly programs = new Map<string, { vertex: string; fragment: string; attributes: Record<string, number> }>();
  private readonly buffers = new Map<string, string>();
  private readonly textures = new Map<string, GlslTexture>();

  constructor(options: WebGLContextOptions) {
    this.options = options;
    this.canvas = options.canvas;
    this.version = options.version ?? 1;
    const a = options.attributes ?? {};
    this.attributes = {
      alpha: a.alpha ?? true,
      premultipliedAlpha: a.premultipliedAlpha ?? true,
      preserveDrawingBuffer: a.preserveDrawingBuffer ?? false,
      antialias: a.antialias ?? true,
      depth: a.depth ?? true,
      stencil: a.stencil ?? false,
    };
    Object.assign(this, GL);
    if (this.version === 2) Object.assign(this, GL2);
  }

  // ---- the frame ----

  /** The recording: what the `glsl` layer holds. */
  content(): GlslContent {
    return {
      premultipliedAlpha: this.attributes.premultipliedAlpha,
      alpha: this.attributes.alpha,
      programs: Object.fromEntries(this.programs),
      buffers: Object.fromEntries(this.buffers),
      textures: Object.fromEntries(this.textures),
      ops: this.ops,
    };
  }

  /** Whether anything was drawn or cleared. */
  get drawn(): boolean {
    return this.ops.length > 0;
  }

  /**
   * The frame loop calls this before each frame: the drawing buffer a browser presented is cleared, so the next draw
   * starts a new one. A frame that draws nothing keeps the picture, as the canvas of a page does.
   */
  resetState(): void {
    if (!this.attributes.preserveDrawingBuffer) this.stale = true;
  }

  /** Empties the drawing buffer (`canvas.width` was set). */
  reset(): void {
    this.ops = [];
    this.programs.clear();
    this.buffers.clear();
    this.textures.clear();
    this.stale = false;
    this.viewportBox = null;
    this.scissorBox = null;
  }

  private begin(): void {
    if (this.stale) {
      this.ops = [];
      this.programs.clear();
      this.buffers.clear();
      this.textures.clear();
      this.stale = false;
    }
  }

  private fail(code: number): void {
    if (this.error === GL.NO_ERROR) this.error = code;
  }

  get drawingBufferWidth(): number {
    return this.options.size().width;
  }
  get drawingBufferHeight(): number {
    return this.options.size().height;
  }

  // ---- context ----

  isContextLost(): boolean {
    return false;
  }
  getContextAttributes() {
    return { ...this.attributes, desynchronized: false, failIfMajorPerformanceCaveat: false, powerPreference: 'default', xrCompatible: false };
  }
  getError(): number {
    const e = this.error;
    this.error = GL.NO_ERROR;
    return e;
  }
  getSupportedExtensions(): string[] {
    return ['OES_standard_derivatives'];
  }
  getExtension(name: string): object | null {
    // Derivatives are always available in the translated shaders.
    return name === 'OES_standard_derivatives' ? { FRAGMENT_SHADER_DERIVATIVE_HINT_OES: 0x8b8b } : null;
  }
  getParameter(pname: number): unknown {
    switch (pname) {
      case GL.VERSION:
        return this.version === 2 ? 'WebGL 2.0 (Kinetograph)' : 'WebGL 1.0 (Kinetograph)';
      case GL.VENDOR:
        return 'Kinetograph';
      case GL.RENDERER:
        return 'Kinetograph (wgpu)';
      case GL.SHADING_LANGUAGE_VERSION:
        return this.version === 2 ? 'WebGL GLSL ES 3.00 (Kinetograph)' : 'WebGL GLSL ES 1.0 (Kinetograph)';
      case GL.MAX_TEXTURE_SIZE:
        return 8192;
      case GL.MAX_VIEWPORT_DIMS:
        return new Int32Array([8192, 8192]);
      case GL.MAX_VERTEX_ATTRIBS:
        return 16;
      case GL.MAX_VERTEX_UNIFORM_VECTORS:
      case GL.MAX_FRAGMENT_UNIFORM_VECTORS:
        return 256;
      case GL.MAX_VARYING_VECTORS:
        return 15;
      case GL.MAX_TEXTURE_IMAGE_UNITS:
      case GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS:
        return 16;
      case GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS:
        return 0;
      case GL.VIEWPORT:
        return new Int32Array(this.viewportNow());
      case GL.SCISSOR_BOX:
        return new Int32Array(this.scissorBox ?? this.viewportNow());
      case GL.COLOR_CLEAR_VALUE:
        return new Float32Array(this.clearColorValue);
      case GL.COLOR_WRITEMASK:
        return [...this.colorMaskState];
      case GL.ACTIVE_TEXTURE:
        return GL.TEXTURE0 + this.activeUnit;
      case GL.CURRENT_PROGRAM:
        return this.program;
      case GL.ARRAY_BUFFER_BINDING:
        return this.arrayBuffer;
      case GL.ELEMENT_ARRAY_BUFFER_BINDING:
        return this.vao.element;
      case GL.TEXTURE_BINDING_2D:
        return this.units.get(this.activeUnit) ?? null;
      case GL.FRAMEBUFFER_BINDING:
        return this.drawFramebuffer;
      case GL2.READ_FRAMEBUFFER_BINDING:
        if (this.version === 2) return this.readFramebuffer;
        this.fail(GL.INVALID_ENUM);
        return null;
      case GL.RED_BITS:
      case GL.GREEN_BITS:
      case GL.BLUE_BITS:
        return 8;
      case GL.ALPHA_BITS:
        return this.attributes.alpha ? 8 : 0;
      case GL.DEPTH_BITS:
        return this.attributes.depth ? 24 : 0;
      case GL.STENCIL_BITS:
        return this.attributes.stencil ? 8 : 0;
      case GL.BLEND:
        return this.caps.blend;
      case GL.CULL_FACE:
        return this.caps.cull;
      case GL.SCISSOR_TEST:
        return this.caps.scissor;
      case GL.DEPTH_TEST:
        return this.caps.depth;
      case GL.STENCIL_TEST:
        return this.caps.stencil;
      default:
        this.fail(GL.INVALID_ENUM);
        return null;
    }
  }
  getShaderPrecisionFormat(): WebGLShaderPrecisionFormat {
    return new WebGLShaderPrecisionFormat();
  }
  isEnabled(cap: number): boolean {
    return this.getParameter(cap) === true;
  }
  flush(): void {}
  finish(): void {}
  hint(): void {}
  pixelStorei(pname: number, param: number | boolean): void {
    if (pname === GL.UNPACK_FLIP_Y_WEBGL) this.flipY = Boolean(param);
    else if (pname === GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL) this.premultiply = Boolean(param);
    else if (pname === GL.UNPACK_ALIGNMENT) this.unpackAlignment = Number(param);
    else if (pname === GL.UNPACK_COLORSPACE_CONVERSION_WEBGL || pname === GL.PACK_ALIGNMENT) return;
    else if (this.version === 2 && (pname === GL2.UNPACK_ROW_LENGTH || pname === GL2.UNPACK_SKIP_ROWS || pname === GL2.UNPACK_SKIP_PIXELS)) {
      if (Number(param) !== 0) throw new WebGLUnsupportedError('pixelStorei UNPACK_ROW_LENGTH, UNPACK_SKIP_ROWS and UNPACK_SKIP_PIXELS other than 0');
    } else this.fail(GL.INVALID_ENUM);
  }
  readPixels(): never {
    throw new WebGLUnsupportedError('readPixels; the picture is drawn by the renderer, and the context cannot be read back');
  }

  // ---- state ----

  private viewportNow(): [number, number, number, number] {
    return this.viewportBox ?? [0, 0, this.drawingBufferWidth, this.drawingBufferHeight];
  }
  viewport(x: number, y: number, width: number, height: number): void {
    this.viewportBox = [Math.trunc(x), Math.trunc(y), Math.trunc(width), Math.trunc(height)];
  }
  enable(cap: number): void {
    this.setCap(cap, true);
  }
  disable(cap: number): void {
    this.setCap(cap, false);
  }
  private setCap(cap: number, on: boolean): void {
    switch (cap) {
      case GL.BLEND:
        this.caps.blend = on;
        break;
      case GL.CULL_FACE:
        this.caps.cull = on;
        break;
      case GL.SCISSOR_TEST:
        this.caps.scissor = on;
        break;
      case GL.DEPTH_TEST:
        this.caps.depth = on;
        break;
      case GL.STENCIL_TEST:
        this.caps.stencil = on;
        break;
      case GL.DITHER:
        break;
      default:
        if (UNSUPPORTED_CAPS.has(cap)) {
          if (on) throw new WebGLUnsupportedError(UNSUPPORTED_CAPS.get(cap)!);
        } else this.fail(GL.INVALID_ENUM);
    }
  }
  scissor(x: number, y: number, width: number, height: number): void {
    this.scissorBox = [Math.trunc(x), Math.trunc(y), Math.trunc(width), Math.trunc(height)];
  }
  blendFunc(src: number, dst: number): void {
    this.blendFuncSeparate(src, dst, src, dst);
  }
  blendFuncSeparate(srcRgb: number, dstRgb: number, srcAlpha: number, dstAlpha: number): void {
    for (const f of [srcRgb, dstRgb, srcAlpha, dstAlpha]) {
      if (FACTORS[f] === undefined) return this.fail(GL.INVALID_ENUM);
    }
    Object.assign(this.blend, { srcRgb, dstRgb, srcAlpha, dstAlpha });
  }
  blendEquation(mode: number): void {
    this.blendEquationSeparate(mode, mode);
  }
  blendEquationSeparate(eqRgb: number, eqAlpha: number): void {
    if (EQUATIONS[eqRgb] === undefined || EQUATIONS[eqAlpha] === undefined) return this.fail(GL.INVALID_ENUM);
    Object.assign(this.blend, { eqRgb, eqAlpha });
  }
  blendColor(r: number, g: number, b: number, a: number): void {
    this.blend.color = [r, g, b, a];
  }
  colorMask(r: boolean, g: boolean, b: boolean, a: boolean): void {
    this.colorMaskState = [Boolean(r), Boolean(g), Boolean(b), Boolean(a)];
  }
  clearColor(r: number, g: number, b: number, a: number): void {
    this.clearColorValue = [Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, b)), Math.min(1, Math.max(0, a))];
  }
  clearDepth(): void {}
  clearStencil(): void {}
  depthFunc(): void {}
  depthMask(): void {}
  depthRange(): void {}
  stencilFunc(): void {}
  stencilOp(): void {}
  stencilMask(): void {}
  lineWidth(): void {}
  cullFace(mode: number): void {
    if (mode !== GL.FRONT && mode !== GL.BACK && mode !== GL.FRONT_AND_BACK) return this.fail(GL.INVALID_ENUM);
    this.cullMode = mode;
  }
  frontFace(mode: number): void {
    if (mode !== GL.CW && mode !== GL.CCW) return this.fail(GL.INVALID_ENUM);
    this.frontFaceMode = mode;
  }

  clear(mask: number): void {
    if (mask & ~(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT)) return this.fail(GL.INVALID_VALUE);
    if (!(mask & GL.COLOR_BUFFER_BIT)) return;
    if (this.caps.scissor) throw new WebGLUnsupportedError('clear with the scissor test on; draw a quad over the box instead');
    if (this.colorMaskState.some((on) => !on)) throw new WebGLUnsupportedError('clear with a colour mask');
    if (this.framebufferIncomplete()) return;
    this.begin();
    const target = this.targetId();
    if (target !== undefined) {
      this.ops.push({ op: 'clear', color: [...this.clearColorValue], target });
      return;
    }
    // Everything drawn to the canvas before it is gone with it; what went to textures stays, as later draws may read it.
    this.ops = [...this.ops.filter((op) => op.target !== undefined), { op: 'clear', color: [...this.clearColorValue] }];
  }

  // ---- shaders and programs ----

  createShader(type: number): WebGLShader | null {
    if (type !== GL.VERTEX_SHADER && type !== GL.FRAGMENT_SHADER) {
      this.fail(GL.INVALID_ENUM);
      return null;
    }
    return new WebGLShader(type);
  }
  shaderSource(shader: WebGLShader, source: string): void {
    shader.source = String(source);
  }
  getShaderSource(shader: WebGLShader): string {
    return shader.source;
  }
  /** The shaders are read when the layer is made: a broken one fails then, with the line (SCENE.md, "glsl"). */
  compileShader(_shader?: WebGLShader): void {}
  getShaderParameter(shader: WebGLShader, pname: number): unknown {
    if (pname === GL.COMPILE_STATUS) return shader.source !== '';
    if (pname === GL.SHADER_TYPE) return shader.type;
    if (pname === GL.DELETE_STATUS) return shader.deleted;
    this.fail(GL.INVALID_ENUM);
    return null;
  }
  getShaderInfoLog(): string {
    return '';
  }
  deleteShader(shader: WebGLShader | null): void {
    if (shader) shader.deleted = true;
  }
  createProgram(): WebGLProgram {
    return new WebGLProgram();
  }
  attachShader(program: WebGLProgram, shader: WebGLShader): void {
    program.shaders = program.shaders.filter((s) => s.type !== shader.type).concat(shader);
  }
  detachShader(program: WebGLProgram, shader: WebGLShader): void {
    program.shaders = program.shaders.filter((s) => s !== shader);
  }
  bindAttribLocation(program: WebGLProgram, index: number, name: string): void {
    program.bound.set(name, index);
  }
  linkProgram(program: WebGLProgram): void {
    const vertex = program.shaders.find((s) => s.type === GL.VERTEX_SHADER);
    const fragment = program.shaders.find((s) => s.type === GL.FRAGMENT_SHADER);
    program.linked = vertex !== undefined && fragment !== undefined && vertex.source !== '' && fragment.source !== '';
    program.attributes = new Map();
    program.uniforms.clear();
    if (!program.linked) return;
    program.vertex = vertex!.source;
    program.fragment = fragment!.source;
    program.attributeDeclarations = declarations(program.vertex, ['attribute', 'in']);
    const seen = new Set<string>();
    program.uniformDeclarations = [...declarations(program.vertex, ['uniform']), ...declarations(program.fragment, ['uniform'])].filter((d) => {
      if (seen.has(d.name)) return false;
      seen.add(d.name);
      return true;
    });
    // Explicit locations and `bindAttribLocation` first; the rest take the lowest free locations in order.
    const taken = new Set<number>();
    for (const d of program.attributeDeclarations) {
      const at = d.location ?? program.bound.get(d.name);
      if (at !== undefined) {
        program.attributes.set(d.name, at);
        taken.add(at);
      }
    }
    let next = 0;
    for (const d of program.attributeDeclarations) {
      if (program.attributes.has(d.name)) continue;
      while (taken.has(next)) next += 1;
      program.attributes.set(d.name, next);
      taken.add(next);
    }
  }
  validateProgram(): void {}
  getProgramParameter(program: WebGLProgram, pname: number): unknown {
    switch (pname) {
      case GL.LINK_STATUS:
        return program.linked;
      case GL.VALIDATE_STATUS:
        return program.linked;
      case GL.DELETE_STATUS:
        return program.deleted;
      case GL.ATTACHED_SHADERS:
        return program.shaders.length;
      case GL.ACTIVE_ATTRIBUTES:
        return program.attributeDeclarations.length;
      case GL.ACTIVE_UNIFORMS:
        return program.uniformDeclarations.length;
      default:
        this.fail(GL.INVALID_ENUM);
        return null;
    }
  }
  getProgramInfoLog(program: WebGLProgram): string {
    return program.linked ? '' : 'a program needs a vertex shader and a fragment shader, both with source';
  }
  deleteProgram(program: WebGLProgram | null): void {
    if (program) program.deleted = true;
  }
  useProgram(program: WebGLProgram | null): void {
    if (program !== null && !program.linked) return this.fail(GL.INVALID_OPERATION);
    this.program = program;
  }
  getAttribLocation(program: WebGLProgram, name: string): number {
    return program.attributes.get(name) ?? -1;
  }
  getActiveAttrib(program: WebGLProgram, index: number): WebGLActiveInfo | null {
    const d = program.attributeDeclarations[index];
    return d === undefined ? null : new WebGLActiveInfo(d.name, d.length, TYPE_CODES[d.type] ?? 0);
  }
  getActiveUniform(program: WebGLProgram, index: number): WebGLActiveInfo | null {
    const d = program.uniformDeclarations[index];
    return d === undefined ? null : new WebGLActiveInfo(d.length > 1 ? `${d.name}[0]` : d.name, d.length, TYPE_CODES[d.type] ?? 0);
  }
  getUniformLocation(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    const m = /^(\w+)(?:\[(\d+)\])?$/.exec(name);
    if (m === null) return null;
    const d = program.uniformDeclarations.find((u) => u.name === m[1]);
    if (d === undefined) return null;
    const index = m[2] === undefined ? 0 : Number(m[2]);
    if (index >= d.length) return null;
    return new WebGLUniformLocation(program, d.name, index, d.type);
  }

  // ---- uniforms ----

  private setUniform(location: WebGLUniformLocation | null, kind: 'f' | 'i' | 'm', value: ArrayLike<number>, components: number): void {
    if (location === null) return;
    const program = this.program;
    if (program === null) return this.fail(GL.INVALID_OPERATION);
    if (location.program !== program) return this.fail(GL.INVALID_OPERATION);
    if (value.length === 0 || value.length % components !== 0) return this.fail(GL.INVALID_VALUE);
    const call: UniformCall = { kind, value: Array.from(value, Number), index: location.index };
    const calls = program.uniforms.get(location.name) ?? [];
    const same = calls.findIndex((c) => c.index === call.index && c.value.length === call.value.length);
    if (same >= 0) calls[same] = call;
    else calls.push(call);
    program.uniforms.set(location.name, calls);
  }
  uniform1f(l: WebGLUniformLocation | null, x: number): void {
    this.setUniform(l, 'f', [x], 1);
  }
  uniform2f(l: WebGLUniformLocation | null, x: number, y: number): void {
    this.setUniform(l, 'f', [x, y], 2);
  }
  uniform3f(l: WebGLUniformLocation | null, x: number, y: number, z: number): void {
    this.setUniform(l, 'f', [x, y, z], 3);
  }
  uniform4f(l: WebGLUniformLocation | null, x: number, y: number, z: number, w: number): void {
    this.setUniform(l, 'f', [x, y, z, w], 4);
  }
  uniform1i(l: WebGLUniformLocation | null, x: number): void {
    this.setUniform(l, 'i', [x], 1);
  }
  uniform2i(l: WebGLUniformLocation | null, x: number, y: number): void {
    this.setUniform(l, 'i', [x, y], 2);
  }
  uniform3i(l: WebGLUniformLocation | null, x: number, y: number, z: number): void {
    this.setUniform(l, 'i', [x, y, z], 3);
  }
  uniform4i(l: WebGLUniformLocation | null, x: number, y: number, z: number, w: number): void {
    this.setUniform(l, 'i', [x, y, z, w], 4);
  }
  uniform1ui(l: WebGLUniformLocation | null, x: number): void {
    this.setUniform(l, 'i', [x], 1);
  }
  uniform2ui(l: WebGLUniformLocation | null, x: number, y: number): void {
    this.setUniform(l, 'i', [x, y], 2);
  }
  uniform3ui(l: WebGLUniformLocation | null, x: number, y: number, z: number): void {
    this.setUniform(l, 'i', [x, y, z], 3);
  }
  uniform4ui(l: WebGLUniformLocation | null, x: number, y: number, z: number, w: number): void {
    this.setUniform(l, 'i', [x, y, z, w], 4);
  }
  uniform1fv(l: WebGLUniformLocation | null, v: ArrayLike<number>): void {
    this.setUniform(l, 'f', v, 1);
  }
  uniform2fv(l: WebGLUniformLocation | null, v: ArrayLike<number>): void {
    this.setUniform(l, 'f', v, 2);
  }
  uniform3fv(l: WebGLUniformLocation | null, v: ArrayLike<number>): void {
    this.setUniform(l, 'f', v, 3);
  }
  uniform4fv(l: WebGLUniformLocation | null, v: ArrayLike<number>): void {
    this.setUniform(l, 'f', v, 4);
  }
  uniform1iv(l: WebGLUniformLocation | null, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 1);
  }
  uniform2iv(l: WebGLUniformLocation | null, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 2);
  }
  uniform3iv(l: WebGLUniformLocation | null, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 3);
  }
  uniform4iv(l: WebGLUniformLocation | null, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 4);
  }
  uniform1uiv(l: WebGLUniformLocation | null, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 1);
  }
  uniform2uiv(l: WebGLUniformLocation | null, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 2);
  }
  uniform3uiv(l: WebGLUniformLocation | null, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 3);
  }
  uniform4uiv(l: WebGLUniformLocation | null, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 4);
  }
  uniformMatrix2fv(l: WebGLUniformLocation | null, transpose: boolean, v: ArrayLike<number>): void {
    this.setUniform(l, 'm', this.matrixValue(transpose, v, 2), 4);
  }
  uniformMatrix3fv(l: WebGLUniformLocation | null, transpose: boolean, v: ArrayLike<number>): void {
    this.setUniform(l, 'm', this.matrixValue(transpose, v, 3), 9);
  }
  uniformMatrix4fv(l: WebGLUniformLocation | null, transpose: boolean, v: ArrayLike<number>): void {
    this.setUniform(l, 'm', this.matrixValue(transpose, v, 4), 16);
  }
  private matrixValue(transpose: boolean, v: ArrayLike<number>, n: number): ArrayLike<number> {
    if (!transpose) return v;
    if (this.version === 1) {
      this.fail(GL.INVALID_VALUE);
      return [];
    }
    const out: number[] = [];
    for (let m = 0; m + n * n <= v.length; m += n * n) {
      for (let c = 0; c < n; c += 1) for (let r = 0; r < n; r += 1) out.push(v[m + r * n + c]!);
    }
    return out;
  }
  /** A uniform set by kind and values, without the component check of the `uniform*` calls (for `glslShader`). */
  setUniformCall(location: WebGLUniformLocation | null, kind: 'f' | 'i' | 'm', value: ArrayLike<number>): void {
    this.setUniform(location, kind, value, 1);
  }
  /** Makes `texture` (bound) an image file of the scene. */
  textureFromSource(texture: WebGLTexture, src: string): void {
    texture.src = src;
    texture.pixels = null;
    texture.layer = null;
    texture.uploaded = true;
    texture.blank = false;
    texture.version += 1;
  }
  getUniform(): never {
    throw new WebGLUnsupportedError('getUniform; keep the values in your own code');
  }

  // ---- buffers ----

  createBuffer(): WebGLBuffer {
    return new WebGLBuffer();
  }
  deleteBuffer(buffer: WebGLBuffer | null): void {
    if (buffer) buffer.deleted = true;
  }
  isBuffer(buffer: unknown): boolean {
    return buffer instanceof WebGLBuffer && !buffer.deleted;
  }
  bindBuffer(target: number, buffer: WebGLBuffer | null): void {
    if (target === GL.ARRAY_BUFFER) this.arrayBuffer = buffer;
    else if (target === GL.ELEMENT_ARRAY_BUFFER) this.vao.element = buffer;
    else if (this.version === 2 && (target === GL2.PIXEL_UNPACK_BUFFER || target === GL2.PIXEL_PACK_BUFFER || target === GL2.UNIFORM_BUFFER)) {
      if (buffer !== null) throw new WebGLUnsupportedError('a pixel or uniform buffer object; set uniforms one by one and upload textures from arrays or images');
    } else this.fail(GL.INVALID_ENUM);
  }
  private target(target: number): WebGLBuffer | null {
    if (target === GL.ARRAY_BUFFER) return this.arrayBuffer;
    if (target === GL.ELEMENT_ARRAY_BUFFER) return this.vao.element;
    this.fail(GL.INVALID_ENUM);
    return null;
  }
  bufferData(target: number, data: number | BufferSource | null, usage: number, srcOffset = 0, length = 0): void {
    const buffer = this.target(target);
    if (buffer === null) return this.fail(GL.INVALID_OPERATION);
    if (data === null) return this.fail(GL.INVALID_VALUE);
    buffer.data = typeof data === 'number' ? new Uint8Array(data) : bytesOf(data, srcOffset, length);
    buffer.usage = usage;
    buffer.version += 1;
  }
  bufferSubData(target: number, offset: number, data: BufferSource, srcOffset = 0, length = 0): void {
    const buffer = this.target(target);
    if (buffer === null) return this.fail(GL.INVALID_OPERATION);
    const bytes = bytesOf(data, srcOffset, length);
    if (offset < 0 || offset + bytes.length > buffer.data.length) return this.fail(GL.INVALID_VALUE);
    buffer.data.set(bytes, offset);
    buffer.version += 1;
  }
  getBufferParameter(target: number, pname: number): number | null {
    const buffer = this.target(target);
    if (buffer === null) return null;
    return pname === GL.BUFFER_SIZE ? buffer.data.length : pname === GL.BUFFER_USAGE ? buffer.usage : null;
  }

  // ---- vertex arrays ----

  createVertexArray(): WebGLVertexArrayObject {
    return new WebGLVertexArrayObject();
  }
  deleteVertexArray(vao: WebGLVertexArrayObject | null): void {
    if (vao) vao.deleted = true;
  }
  bindVertexArray(vao: WebGLVertexArrayObject | null): void {
    this.vao = vao ?? this.defaultVao;
  }
  private attribute(index: number): VertexAttribute | null {
    if (!(index >= 0 && index < 16)) {
      this.fail(GL.INVALID_VALUE);
      return null;
    }
    while (this.vao.attributes.length <= index) this.vao.attributes.push(newAttribute());
    return this.vao.attributes[index]!;
  }
  enableVertexAttribArray(index: number): void {
    const a = this.attribute(index);
    if (a) a.enabled = true;
  }
  disableVertexAttribArray(index: number): void {
    const a = this.attribute(index);
    if (a) a.enabled = false;
  }
  vertexAttribPointer(index: number, size: number, type: number, normalized: boolean, stride: number, offset: number): void {
    const a = this.attribute(index);
    if (a === null) return;
    if (this.arrayBuffer === null) return this.fail(GL.INVALID_OPERATION);
    Object.assign(a, { buffer: this.arrayBuffer, size, type, normalized: Boolean(normalized), stride, offset });
  }
  vertexAttribIPointer(): never {
    throw new WebGLUnsupportedError('integer attributes (vertexAttribIPointer); use float attributes');
  }
  vertexAttribDivisor(index: number, divisor: number): void {
    const a = this.attribute(index);
    if (a) a.divisor = divisor;
  }
  vertexAttrib1f(index: number, x: number): void {
    this.vertexAttrib4f(index, x, 0, 0, 1);
  }
  vertexAttrib2f(index: number, x: number, y: number): void {
    this.vertexAttrib4f(index, x, y, 0, 1);
  }
  vertexAttrib3f(index: number, x: number, y: number, z: number): void {
    this.vertexAttrib4f(index, x, y, z, 1);
  }
  vertexAttrib4f(index: number, x: number, y: number, z: number, w: number): void {
    const a = this.attribute(index);
    if (a) a.constant = [x, y, z, w];
  }

  // ---- textures ----

  createTexture(): WebGLTexture {
    return new WebGLTexture();
  }
  deleteTexture(texture: WebGLTexture | null): void {
    if (texture) texture.deleted = true;
  }
  isTexture(texture: unknown): boolean {
    return texture instanceof WebGLTexture && !texture.deleted;
  }
  activeTexture(unit: number): void {
    const n = unit - GL.TEXTURE0;
    if (!(n >= 0 && n < 16)) return this.fail(GL.INVALID_ENUM);
    this.activeUnit = n;
  }
  bindTexture(target: number, texture: WebGLTexture | null): void {
    if (target !== GL.TEXTURE_2D) {
      if (texture === null) return;
      throw new WebGLUnsupportedError(target === GL.TEXTURE_CUBE_MAP ? 'cube map textures' : 'textures other than TEXTURE_2D');
    }
    if (texture === null) this.units.delete(this.activeUnit);
    else this.units.set(this.activeUnit, texture);
  }
  private bound(target: number): WebGLTexture | null {
    if (target !== GL.TEXTURE_2D) {
      this.fail(GL.INVALID_ENUM);
      return null;
    }
    const texture = this.units.get(this.activeUnit);
    if (texture === undefined) {
      this.fail(GL.INVALID_OPERATION);
      return null;
    }
    return texture;
  }
  texParameteri(target: number, pname: number, param: number): void {
    const texture = this.bound(target);
    if (texture === null) return;
    switch (pname) {
      case GL.TEXTURE_MIN_FILTER:
        if (FILTERS[param] === undefined) return this.fail(GL.INVALID_ENUM);
        texture.min = param;
        break;
      case GL.TEXTURE_MAG_FILTER:
        if (param !== GL.NEAREST && param !== GL.LINEAR) return this.fail(GL.INVALID_ENUM);
        texture.mag = param;
        break;
      case GL.TEXTURE_WRAP_S:
        if (WRAPS[param] === undefined) return this.fail(GL.INVALID_ENUM);
        texture.wrapS = param;
        break;
      case GL.TEXTURE_WRAP_T:
        if (WRAPS[param] === undefined) return this.fail(GL.INVALID_ENUM);
        texture.wrapT = param;
        break;
      default:
        // Anisotropy, level of detail and the like: not drawn.
        if (pname !== 0x84fe) throw new WebGLUnsupportedError(`texParameter 0x${pname.toString(16)}`);
    }
  }
  texParameterf(target: number, pname: number, param: number): void {
    this.texParameteri(target, pname, param);
  }
  generateMipmap(target: number): void {
    const texture = this.bound(target);
    if (texture === null) return;
    if (!texture.uploaded) return this.fail(GL.INVALID_OPERATION);
    if (texture.drawnAt === texture.version) throw new WebGLUnsupportedError('generateMipmap of a texture a framebuffer drew in; sample it with LINEAR or NEAREST');
    texture.mipmaps = true;
    texture.version += 1;
  }

  /** RGBA8 pixels from the bytes of `format` rows, honouring the unpack alignment. */
  private rgbaOf(width: number, height: number, format: number, pixels: ArrayBufferView): Uint8Array {
    const channels = ({ [GL.RGBA]: 4, [GL.RGB]: 3, [GL.LUMINANCE_ALPHA]: 2, [GL.LUMINANCE]: 1, [GL.ALPHA]: 1, [GL2.RED]: 1, [GL2.RG]: 2 } as Record<number, number>)[format];
    if (channels === undefined) throw new WebGLUnsupportedError(`texture format 0x${format.toString(16)}`);
    const source = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    const row = Math.ceil((width * channels) / this.unpackAlignment) * this.unpackAlignment;
    if (source.length < row * (height - 1) + width * channels) {
      this.fail(GL.INVALID_OPERATION);
      return new Uint8Array(width * height * 4);
    }
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const s = y * row + x * channels;
        const d = (y * width + x) * 4;
        switch (format) {
          case GL.RGBA:
            out.set(source.subarray(s, s + 4), d);
            break;
          case GL.RGB:
            out.set(source.subarray(s, s + 3), d);
            out[d + 3] = 255;
            break;
          case GL.LUMINANCE:
            out[d] = out[d + 1] = out[d + 2] = source[s]!;
            out[d + 3] = 255;
            break;
          case GL.LUMINANCE_ALPHA:
            out[d] = out[d + 1] = out[d + 2] = source[s]!;
            out[d + 3] = source[s + 1]!;
            break;
          case GL.ALPHA:
            out[d + 3] = source[s]!;
            break;
          case GL2.RED:
            out[d] = source[s]!;
            out[d + 3] = 255;
            break;
          default:
            out[d] = source[s]!;
            out[d + 1] = source[s + 1]!;
            out[d + 3] = 255;
        }
      }
    }
    return out;
  }

  private checkTextureType(type: number, internalformat: number): void {
    if (type !== GL.UNSIGNED_BYTE) throw new WebGLUnsupportedError(`texture data of type 0x${type.toString(16)}; use UNSIGNED_BYTE (float and half-float textures are not available)`);
    const sized = [GL2.RGBA32F, GL2.RGB32F, GL2.R32F, GL2.RGBA16F, GL2.SRGB8_ALPHA8];
    if (sized.includes(internalformat as never)) throw new WebGLUnsupportedError(`the internal format 0x${internalformat.toString(16)}; use RGBA`);
  }

  /** `texImage2D(target, level, internalformat, width, height, border, format, type, pixels)` or `(…, internalformat, format, type, source)`. */
  texImage2D(target: number, level: number, internalformat: number, ...rest: unknown[]): void {
    const texture = this.bound(target);
    if (texture === null) return;
    if (level !== 0) throw new WebGLUnsupportedError('texture levels above 0; call generateMipmap');
    let width: number;
    let height: number;
    let format: number;
    let type: number;
    let source: unknown;
    if (rest.length >= 6) {
      [width, height, , format, type, source] = rest as [number, number, number, number, number, unknown];
    } else {
      [format, type, source] = rest as [number, number, unknown];
      width = height = 0;
    }
    this.checkTextureType(type, internalformat);
    texture.flipY = this.flipY;
    texture.premultiply = this.premultiply;
    texture.mipmaps = false;
    texture.layer = null;
    texture.uploaded = true;
    texture.version += 1;
    texture.format = internalformat;
    if (rest.length >= 6) {
      texture.src = null;
      texture.width = width;
      texture.height = height;
      if (source === null || source === undefined) {
        texture.pixels = new Uint8Array(width * height * 4);
        texture.blank = true;
      } else {
        texture.pixels = this.rgbaOf(width, height, format, source as ArrayBufferView);
        texture.blank = texture.pixels.every((byte) => byte === 0);
      }
      return;
    }
    texture.blank = false;
    this.uploadPicture(texture, source);
  }

  texSubImage2D(target: number, level: number, xoffset: number, yoffset: number, ...rest: unknown[]): void {
    const texture = this.bound(target);
    if (texture === null) return;
    if (level !== 0 || texture.pixels === null) throw new WebGLUnsupportedError('texSubImage2D into a texture from an image file, or above level 0');
    if (texture.drawnAt === texture.version) throw new WebGLUnsupportedError('texSubImage2D into a texture a framebuffer drew in');
    let width: number;
    let height: number;
    let format: number;
    let pixels: Uint8Array;
    if (rest.length >= 5) {
      let type: number;
      let source: unknown;
      [width, height, format, type, source] = rest as [number, number, number, number, ArrayBufferView];
      this.checkTextureType(type, GL.RGBA);
      pixels = this.rgbaOf(width, height, format, source as ArrayBufferView);
    } else {
      const picture = pictureOf(rest[2]);
      if (picture === null || picture.source.kind !== 'pixels') throw new WebGLUnsupportedError('texSubImage2D from anything but pixels');
      width = picture.width;
      height = picture.height;
      pixels = new Uint8Array(Buffer.from(picture.source.data, 'base64'));
    }
    if (xoffset < 0 || yoffset < 0 || xoffset + width > texture.width || yoffset + height > texture.height) return this.fail(GL.INVALID_VALUE);
    for (let y = 0; y < height; y += 1) {
      texture.pixels.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), ((yoffset + y) * texture.width + xoffset) * 4);
    }
    texture.blank = false;
    texture.version += 1;
  }

  /** WebGL 2's `texStorage2D`: a texture of this size, empty. */
  texStorage2D(target: number, levels: number, internalformat: number, width: number, height: number): void {
    const texture = this.bound(target);
    if (texture === null) return;
    this.checkTextureType(GL.UNSIGNED_BYTE, internalformat);
    if (levels > 1) throw new WebGLUnsupportedError('texStorage2D with more than one level; call generateMipmap');
    Object.assign(texture, { width, height, pixels: new Uint8Array(width * height * 4), src: null, layer: null, uploaded: true, flipY: false, premultiply: false, mipmaps: false, format: internalformat, blank: true });
    texture.version += 1;
  }

  private uploadPicture(texture: WebGLTexture, source: unknown): void {
    const layer = (source as { [LAYER_SOURCE]?: () => { id: string; width: number; height: number } } | null | undefined)?.[LAYER_SOURCE]?.();
    if (layer !== undefined) {
      Object.assign(texture, { layer: layer.id, width: layer.width, height: layer.height, src: null, pixels: null });
      return;
    }
    const picture = pictureOf(source);
    if (picture === null) {
      throw new WebGLUnsupportedError(
        `a texture from ${source === null || source === undefined ? String(source) : ((source as object).constructor?.name ?? typeof source)}; use an image, a canvas, ImageData or an array of pixels`,
      );
    }
    texture.width = picture.width;
    texture.height = picture.height;
    const s = picture.source;
    if (s.kind === 'src') {
      texture.src = s.src;
      texture.pixels = null;
    } else if (s.kind === 'pixels') {
      texture.src = null;
      texture.pixels = new Uint8Array(Buffer.from(s.data, 'base64'));
    } else {
      const pixels = this.options.rasterize?.(s) ?? null;
      if (pixels === null) throw new WebGLUnsupportedError('a texture from a canvas here (the pixels of a canvas need the addon)');
      texture.src = null;
      texture.pixels = pixels;
    }
  }

  // ---- framebuffers ----
  //
  // A framebuffer draws into the RGBA texture attached to COLOR_ATTACHMENT0, which later draws sample (multi-pass
  // shaders). The texture starts the frame transparent black: a frame is a function of its own calls, so what an
  // earlier frame left in it does not carry over. Depth, stencil and renderbuffer attachments are not drawn.

  createFramebuffer(): WebGLFramebuffer {
    return new WebGLFramebuffer();
  }
  deleteFramebuffer(framebuffer: WebGLFramebuffer | null): void {
    if (framebuffer === null) return;
    framebuffer.deleted = true;
    if (this.drawFramebuffer === framebuffer) this.drawFramebuffer = null;
    if (this.readFramebuffer === framebuffer) this.readFramebuffer = null;
  }
  isFramebuffer(framebuffer: unknown): boolean {
    return framebuffer instanceof WebGLFramebuffer && framebuffer.bound && !framebuffer.deleted;
  }

  /** The bindings a framebuffer target names: `FRAMEBUFFER` both, and in WebGL 2 `DRAW_FRAMEBUFFER` or `READ_FRAMEBUFFER` one. */
  private framebufferSides(target: number): { draw: boolean; read: boolean } {
    const v2 = this.version === 2;
    return {
      draw: target === GL.FRAMEBUFFER || (v2 && target === GL2.DRAW_FRAMEBUFFER),
      read: target === GL.FRAMEBUFFER || (v2 && target === GL2.READ_FRAMEBUFFER),
    };
  }

  bindFramebuffer(target: number, framebuffer: WebGLFramebuffer | null): void {
    const { draw, read } = this.framebufferSides(target);
    if (!draw && !read) return this.fail(GL.INVALID_ENUM);
    if (framebuffer !== null) {
      if (framebuffer.deleted) return this.fail(GL.INVALID_OPERATION);
      framebuffer.bound = true;
    }
    if (draw) this.drawFramebuffer = framebuffer;
    if (read) this.readFramebuffer = framebuffer;
  }

  framebufferTexture2D(target: number, attachment: number, textarget: number, texture: WebGLTexture | null, level: number): void {
    const { draw, read } = this.framebufferSides(target);
    if (!draw && !read) return this.fail(GL.INVALID_ENUM);
    if (attachment === GL.DEPTH_ATTACHMENT || attachment === GL.STENCIL_ATTACHMENT || attachment === GL.DEPTH_STENCIL_ATTACHMENT) {
      if (texture !== null) throw new WebGLUnsupportedError('a depth or stencil attachment; draw without a depth buffer (disable(gl.DEPTH_TEST))');
      return;
    }
    if (attachment !== GL.COLOR_ATTACHMENT0) {
      if (this.version === 2 && attachment > GL.COLOR_ATTACHMENT0 && attachment < GL.COLOR_ATTACHMENT0 + 16) throw new WebGLUnsupportedError('several colour outputs');
      return this.fail(GL.INVALID_ENUM);
    }
    const framebuffer = draw ? this.drawFramebuffer : this.readFramebuffer;
    if (framebuffer === null) return this.fail(GL.INVALID_OPERATION);
    if (texture !== null) {
      if (textarget !== GL.TEXTURE_2D) return this.fail(GL.INVALID_OPERATION);
      if (level !== 0) throw new WebGLUnsupportedError('a framebuffer attached to a texture level above 0');
    }
    framebuffer.color = texture;
  }

  checkFramebufferStatus(target: number): number {
    const { draw, read } = this.framebufferSides(target);
    if (!draw && !read) {
      this.fail(GL.INVALID_ENUM);
      return 0;
    }
    const framebuffer = draw ? this.drawFramebuffer : this.readFramebuffer;
    return framebuffer === null ? GL.FRAMEBUFFER_COMPLETE : this.statusOf(framebuffer);
  }

  private statusOf(framebuffer: WebGLFramebuffer): number {
    const texture = framebuffer.color;
    if (texture === null) return GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT;
    // Not specified yet, empty, or of a format colour cannot be drawn in.
    if (!texture.uploaded || texture.width === 0 || texture.height === 0 || NOT_RENDERABLE.has(texture.format)) return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    return GL.FRAMEBUFFER_COMPLETE;
  }

  /**
   * Whether the bound framebuffer cannot be drawn into: an incomplete one sets INVALID_FRAMEBUFFER_OPERATION and the
   * call does nothing. A complete one whose texture cannot be drawn here throws.
   */
  private framebufferIncomplete(): boolean {
    const framebuffer = this.drawFramebuffer;
    if (framebuffer === null) return false;
    if (this.statusOf(framebuffer) !== GL.FRAMEBUFFER_COMPLETE) {
      this.fail(GL.INVALID_FRAMEBUFFER_OPERATION);
      return true;
    }
    const texture = framebuffer.color!;
    if (texture.format !== GL.RGBA && texture.format !== GL2.RGBA8) {
      throw new WebGLUnsupportedError(`drawing into a texture of internal format 0x${texture.format.toString(16)}; allocate it as RGBA`);
    }
    if (!texture.blank) throw new WebGLUnsupportedError('drawing into a texture that holds uploaded pixels; allocate it with texImage2D(..., null)');
    return false;
  }

  /** A texture a framebuffer draws in, as the recording names it: its size, by an id that changes when it is specified again. */
  private registerTarget(texture: WebGLTexture): string {
    const id = `f${texture.id}.${texture.version}`;
    this.textures.set(id, { target: true, width: texture.width, height: texture.height });
    return id;
  }

  /** The target the bound framebuffer's draws and clears go to; undefined for the canvas. Call it once the draw is certain. */
  private targetId(): string | undefined {
    const texture = this.drawFramebuffer?.color;
    if (texture === null || texture === undefined) return undefined;
    texture.drawnAt = texture.version;
    return this.registerTarget(texture);
  }

  // ---- unsupported objects ----

  createRenderbuffer(): WebGLRenderbuffer {
    return new WebGLRenderbuffer();
  }
  bindRenderbuffer(_target: number, renderbuffer: WebGLRenderbuffer | null): void {
    if (renderbuffer !== null) throw new WebGLUnsupportedError('renderbuffers; render to a texture');
  }
  drawBuffers(buffers: number[]): void {
    if (buffers.length !== 1 || (buffers[0] !== GL.BACK && buffers[0] !== GL.COLOR_ATTACHMENT0)) throw new WebGLUnsupportedError('several colour outputs');
  }
  drawArraysInstanced(mode: number, first: number, count: number, instances: number): void {
    if (instances !== 1) throw new WebGLUnsupportedError('instanced drawing');
    this.drawArrays(mode, first, count);
  }
  drawElementsInstanced(mode: number, count: number, type: number, offset: number, instances: number): void {
    if (instances !== 1) throw new WebGLUnsupportedError('instanced drawing');
    this.drawElements(mode, count, type, offset);
  }

  // ---- drawing ----

  drawArrays(mode: number, first: number, count: number): void {
    if (!(first >= 0 && count >= 0)) return this.fail(GL.INVALID_VALUE);
    this.draw(mode, first, count, null);
  }
  drawElements(mode: number, count: number, type: number, offset: number): void {
    if (!(count >= 0 && offset >= 0)) return this.fail(GL.INVALID_VALUE);
    const ty = type === GL.UNSIGNED_BYTE ? 'u8' : type === GL.UNSIGNED_SHORT ? 'u16' : type === GL.UNSIGNED_INT && (this.version === 2 || true) ? 'u32' : null;
    if (ty === null) return this.fail(GL.INVALID_ENUM);
    this.draw(mode, 0, count, { type: ty, offset });
  }

  private draw(mode: number, first: number, count: number, indexed: { type: 'u8' | 'u16' | 'u32'; offset: number } | null): void {
    const modes: Record<number, GlslDraw['mode']> = { [GL.TRIANGLES]: 'triangles', [GL.TRIANGLE_STRIP]: 'triangleStrip', [GL.TRIANGLE_FAN]: 'triangleFan' };
    if (mode < GL.POINTS || mode > GL.TRIANGLE_FAN) return this.fail(GL.INVALID_ENUM);
    const program = this.program;
    if (program === null) return this.fail(GL.INVALID_OPERATION);
    const named = modes[mode];
    if (named === undefined) throw new WebGLUnsupportedError('drawing points and lines; draw triangles');
    if (this.caps.depth) throw new WebGLUnsupportedError('drawing with the depth test on (disable(gl.DEPTH_TEST); a flat quad does not need it)');
    if (this.caps.stencil) throw new WebGLUnsupportedError('drawing with the stencil test on');
    if (this.framebufferIncomplete()) return;
    this.begin();

    // The program, by what it is made of.
    const attributes: Record<string, number> = {};
    for (const [name, at] of program.attributes) attributes[name] = at;
    const programKey = JSON.stringify([program.vertex, program.fragment, attributes]);
    const programId = `p${hashOf(programKey)}`;
    if (!this.programs.has(programId)) this.programs.set(programId, { vertex: program.vertex, fragment: program.fragment, attributes });

    // Vertex data.
    const draw: GlslDraw = {
      program: programId,
      mode: named,
      first,
      count,
      attributes: {},
      uniforms: {},
      units: {},
      viewport: this.viewportNow(),
      colorMask: [...this.colorMaskState],
    };
    for (const d of program.attributeDeclarations) {
      const at = program.attributes.get(d.name)!;
      const a = this.vao.attributes[at];
      if (a === undefined || !a.enabled || a.buffer === null) {
        if (a?.constant) throw new WebGLUnsupportedError(`the attribute "${d.name}" is read as a constant (vertexAttrib4f); give it a buffer`);
        continue;
      }
      if (a.divisor !== 0) throw new WebGLUnsupportedError('instanced attributes (vertexAttribDivisor)');
      const type = ({ [GL.FLOAT]: 'f32', [GL.UNSIGNED_BYTE]: 'u8', [GL.BYTE]: 'i8', [GL.UNSIGNED_SHORT]: 'u16', [GL.SHORT]: 'i16' } as Record<number, GlslDraw['attributes'][string]['type']>)[a.type];
      if (type === undefined) throw new WebGLUnsupportedError(`the attribute "${d.name}" has type 0x${a.type.toString(16)}; use FLOAT, or a normalised byte or short`);
      draw.attributes[d.name] = { buffer: this.bufferId(a.buffer), size: a.size, type, normalized: a.normalized, stride: a.stride, offset: a.offset };
    }
    if (indexed !== null) {
      const element = this.vao.element;
      if (element === null) return this.fail(GL.INVALID_OPERATION);
      draw.indices = { buffer: this.bufferId(element), type: indexed.type, offset: indexed.offset };
      draw.first = 0;
    }

    // Uniforms and the texture units the samplers name.
    for (const [name, calls] of program.uniforms) {
      draw.uniforms[name] = calls.map((c): GlslUniform => ({ kind: c.kind, value: [...c.value], ...(c.index === 0 ? {} : { index: c.index }) }));
    }
    for (const d of program.uniformDeclarations) {
      if (d.type === 'samplerCube') throw new WebGLUnsupportedError(`the sampler "${d.name}" is a samplerCube; only sampler2D is available`);
      if (d.type !== 'sampler2D') continue;
      const unit = program.uniforms.get(d.name)?.at(-1)?.value[0] ?? 0;
      const texture = this.units.get(unit);
      // Reading what the draw writes is undefined; WebGL refuses it.
      if (texture !== undefined && texture === this.drawFramebuffer?.color) return this.fail(GL.INVALID_OPERATION);
      if (texture !== undefined && draw.units[String(unit)] === undefined) draw.units[String(unit)] = this.samplerOf(texture);
    }

    // State.
    if (this.caps.scissor) draw.scissor = this.scissorBox ?? this.viewportNow();
    if (this.caps.blend) {
      const b = this.blend;
      draw.blend = {
        srcRgb: FACTORS[b.srcRgb]!,
        dstRgb: FACTORS[b.dstRgb]!,
        srcAlpha: FACTORS[b.srcAlpha]!,
        dstAlpha: FACTORS[b.dstAlpha]!,
        eqRgb: EQUATIONS[b.eqRgb]!,
        eqAlpha: EQUATIONS[b.eqAlpha]!,
        color: [...b.color],
      };
    }
    if (this.caps.cull) draw.cull = { face: this.cullMode === GL.FRONT ? 'FRONT' : this.cullMode === GL.BACK ? 'BACK' : 'FRONT_AND_BACK', front: this.frontFaceMode === GL.CW ? 'CW' : 'CCW' };
    if (draw.cull?.face === 'FRONT_AND_BACK') return;
    const target = this.targetId();
    if (target !== undefined) draw.target = target;
    this.ops.push({ op: 'draw', ...draw });
  }

  private bufferId(buffer: WebGLBuffer): string {
    if (buffer.snapshot?.version !== buffer.version) {
      const base64 = toBase64(buffer.data);
      buffer.snapshot = { version: buffer.version, id: `b${hashOf(base64)}`, base64 };
    }
    const { id, base64 } = buffer.snapshot;
    if (!this.buffers.has(id)) this.buffers.set(id, base64);
    return id;
  }

  /** The texture's state at this draw: its pixels (once, by id) and how this unit samples it. */
  private samplerOf(texture: WebGLTexture): GlslSampler {
    const id = texture.drawnAt === texture.version ? this.registerTarget(texture) : this.uploadedId(texture);
    return { texture: id, min: FILTERS[texture.min]!, mag: FILTERS[texture.mag]!, wrapS: WRAPS[texture.wrapS]!, wrapT: WRAPS[texture.wrapT]! };
  }

  /** An uploaded texture in the recording: its pixels, once, by an id of what they are. */
  private uploadedId(texture: WebGLTexture): string {
    if (texture.snapshot?.version !== texture.version) {
      const json: GlslTexture = {
        ...(texture.layer !== null
          ? { layer: texture.layer }
          : texture.src !== null
            ? { src: texture.src }
            : { pixels: toBase64(texture.pixels ?? new Uint8Array(0)) }),
        ...(texture.pixels !== null ? { width: texture.width, height: texture.height } : {}),
        ...(texture.flipY ? { flipY: true } : {}),
        ...(texture.premultiply ? { premultiply: true } : {}),
        ...(texture.mipmaps ? { mipmaps: true } : {}),
      };
      texture.snapshot = { version: texture.version, id: `t${hashOf(JSON.stringify(json))}`, json };
    }
    const { id, json } = texture.snapshot;
    if (!this.textures.has(id)) this.textures.set(id, json);
    return id;
  }
}

export function createWebGLContext(options: WebGLContextOptions): WebGLContext {
  return new WebGLContext(options);
}

/** The scene layer for a context's drawing: its recording in a box of `width` by `height`. */
export function glslLayer(context: WebGLContext, layer: Omit<GlslLayer, 'type' | keyof GlslContent>): GlslLayer {
  return { ...layer, type: 'glsl', ...context.content() };
}

export interface GlslTextureOptions {
  /** An image file of the scene, or a `data:` URL. */
  src: string;
  /** Default `linear`. */
  filter?: 'linear' | 'nearest';
  /** Default `clamp`. */
  wrap?: 'clamp' | 'repeat' | 'mirror';
}

export interface GlslShaderOptions {
  /** The fragment shader, GLSL ES 100 or 300 es. `gl_FragCoord` counts up from the bottom row, as in a browser. */
  fragment: string;
  /** The vertex shader. Default: one that covers the box with a single attribute, `a_position`, in clip space. */
  vertex?: string;
  /** Values for the shader's uniforms, by name: a number, or an array for a vector, a matrix (column-major) or an array. */
  uniforms?: Record<string, number | boolean | readonly number[]>;
  /** Pictures for its `sampler2D` uniforms, by name. */
  textures?: Record<string, string | GlslTextureOptions>;
  /** The size of the drawing buffer. */
  width: number;
  height: number;
}

const DEFAULT_VERTEX_ES1 = 'attribute vec2 a_position;\nvoid main() { gl_Position = vec4(a_position, 0.0, 1.0); }\n';
const DEFAULT_VERTEX_ES3 = '#version 300 es\nin vec2 a_position;\nvoid main() { gl_Position = vec4(a_position, 0.0, 1.0); }\n';

/**
 * A full-screen GLSL fragment shader as the recording of a context: one draw of a quad that covers the box, with the
 * uniforms and pictures given. `<GlslShader>` is this as a component.
 */
export function glslShader(options: GlslShaderOptions): GlslContent {
  const { width, height } = options;
  const gl = createWebGLContext({ size: () => ({ width, height }), version: 1 });
  const vertex = options.vertex ?? (/^\s*#version\s+300\s+es/.test(options.fragment) ? DEFAULT_VERTEX_ES3 : DEFAULT_VERTEX_ES1);
  const program = gl.createProgram();
  for (const [type, source] of [[GL.VERTEX_SHADER, vertex], [GL.FRAGMENT_SHADER, options.fragment]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.attachShader(program, shader);
  }
  gl.bindAttribLocation(program, 0, 'a_position');
  gl.linkProgram(program);
  gl.useProgram(program);

  const quad = gl.createBuffer();
  gl.bindBuffer(GL.ARRAY_BUFFER, quad);
  gl.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), GL.STATIC_DRAW);
  const at = gl.getAttribLocation(program, 'a_position');
  if (at >= 0) {
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, GL.FLOAT, false, 0, 0);
  }

  const declared = new Map(program.uniformDeclarations.map((d) => [d.name, d]));
  let unit = 0;
  for (const [name, spec] of Object.entries(options.textures ?? {})) {
    const d = declared.get(name);
    if (d === undefined || d.type !== 'sampler2D') throw new Error(`glslShader: the shader has no sampler2D uniform "${name}"`);
    const { src, filter = 'linear', wrap = 'clamp' } = typeof spec === 'string' ? { src: spec } : spec;
    const texture = gl.createTexture();
    gl.activeTexture(GL.TEXTURE0 + unit);
    gl.bindTexture(GL.TEXTURE_2D, texture);
    gl.textureFromSource(texture, src);
    const f = filter === 'nearest' ? GL.NEAREST : GL.LINEAR;
    const w = wrap === 'repeat' ? GL.REPEAT : wrap === 'mirror' ? GL.MIRRORED_REPEAT : GL.CLAMP_TO_EDGE;
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, w);
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, w);
    gl.uniform1i(gl.getUniformLocation(program, name), unit);
    unit += 1;
  }
  for (const [name, raw] of Object.entries(options.uniforms ?? {})) {
    const d = declared.get(name);
    if (d === undefined) throw new Error(`glslShader: the shader has no uniform "${name}"`);
    const location = gl.getUniformLocation(program, name)!;
    const value = typeof raw === 'object' ? Array.from(raw) : [Number(raw)];
    const kind = /^mat/.test(d.type) ? 'm' : /^(float|vec)/.test(d.type) ? 'f' : 'i';
    gl.setUniformCall(location, kind, value);
  }
  gl.viewport(0, 0, width, height);
  gl.drawArrays(GL.TRIANGLES, 0, 6);
  return gl.content();
}
