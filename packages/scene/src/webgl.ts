// A `WebGLRenderingContext` and `WebGL2RenderingContext` that record instead of rasterising (packages/cli/skills/kinetograph/references/SCENE.md, "glsl").
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

import type { CanvasSource, GlslContent, GlslDraw, GlslLayer, GlslOp, GlslOutput, GlslPatch, GlslSampler, GlslStencil, GlslStencilFace, GlslTexture, GlslUniform } from './types.js';
import { CANVAS_SOURCE, pictureOf, type CanvasPicture } from './canvas.js';

/** The method a picture of another layer answers a texture upload with (`layerPicture`). */
export const LAYER_SOURCE: unique symbol = Symbol.for('kinetograph.layerSource');

/**
 * A picture of a child of a shader group or a canvas pass (packages/cli/skills/kinetograph/references/SCENE.md, "Shader groups", "Canvas passes"), to upload as
 * a texture the way a page uploads a canvas (`gl.texImage2D(..., picture)`) or to draw on a 2D canvas
 * (`ctx.drawImage(picture, ...)`). The renderer draws the child and reads it; nothing is read here.
 */
export function layerPicture(id: string, width: number, height: number): { readonly width: number; readonly height: number } {
  const picture: CanvasPicture = { source: { kind: 'layer', id, width, height }, width, height };
  return { width, height, [LAYER_SOURCE]: () => ({ id, width, height }), [CANVAS_SOURCE]: () => picture } as { readonly width: number; readonly height: number };
}

/** Thrown by a call the engine does not draw. The message starts with "unsupported:". */
export class WebGLUnsupportedError extends Error {
  override name = 'WebGLUnsupportedError';
  constructor(what: string) {
    super(`unsupported: ${what} (packages/cli/skills/kinetograph/references/SCENE.md, "glsl")`);
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
  ALIASED_POINT_SIZE_RANGE: 0x846d,
  ALIASED_LINE_WIDTH_RANGE: 0x846e,
  CULL_FACE_MODE: 0xb45,
  FRONT_FACE: 0xb46,
  DEPTH_RANGE: 0xb70,
  DEPTH_WRITEMASK: 0xb72,
  DEPTH_CLEAR_VALUE: 0xb73,
  DEPTH_FUNC: 0xb74,
  POLYGON_OFFSET_FACTOR: 0x8038,
  POLYGON_OFFSET_UNITS: 0x2a00,
  DEPTH_STENCIL: 0x84f9,
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
  KEEP: 0x1e00,
  REPLACE: 0x1e01,
  INCR: 0x1e02,
  DECR: 0x1e03,
  INVERT: 0x150a,
  INCR_WRAP: 0x8507,
  DECR_WRAP: 0x8508,
  STENCIL_CLEAR_VALUE: 0xb91,
  STENCIL_FUNC: 0xb92,
  STENCIL_VALUE_MASK: 0xb93,
  STENCIL_FAIL: 0xb94,
  STENCIL_PASS_DEPTH_FAIL: 0xb95,
  STENCIL_PASS_DEPTH_PASS: 0xb96,
  STENCIL_REF: 0xb97,
  STENCIL_WRITEMASK: 0xb98,
  STENCIL_BACK_FUNC: 0x8800,
  STENCIL_BACK_FAIL: 0x8801,
  STENCIL_BACK_PASS_DEPTH_FAIL: 0x8802,
  STENCIL_BACK_PASS_DEPTH_PASS: 0x8803,
  STENCIL_BACK_REF: 0x8ca3,
  STENCIL_BACK_VALUE_MASK: 0x8ca4,
  STENCIL_BACK_WRITEMASK: 0x8ca5,
  STENCIL_INDEX8: 0x8d48,
  FRAMEBUFFER_INCOMPLETE_DIMENSIONS: 0x8cd9,
  FRAMEBUFFER_UNSUPPORTED: 0x8cdd,
  RENDERBUFFER_BINDING: 0x8ca7,
  RENDERBUFFER_WIDTH: 0x8d42,
  RENDERBUFFER_HEIGHT: 0x8d43,
  RENDERBUFFER_INTERNAL_FORMAT: 0x8d44,
  FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: 0x8cd0,
  FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: 0x8cd1,
  FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL: 0x8cd2,
} as const;

/** What WebGL 2 adds that a recorded context takes. */
export const GL2 = {
  DEPTH_COMPONENT24: 0x81a6,
  DEPTH_COMPONENT32F: 0x8cac,
  DEPTH24_STENCIL8: 0x88f0,
  DEPTH32F_STENCIL8: 0x8cad,
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
  VERTEX_ARRAY_BINDING: 0x85b5,
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
  COLOR: 0x1800,
  DEPTH: 0x1801,
  STENCIL: 0x1802,
  UNSIGNED_INT_24_8: 0x84fa,
  FLOAT_32_UNSIGNED_INT_24_8_REV: 0x8dad,
  READ_BUFFER: 0xc02,
  TEXTURE_BASE_LEVEL: 0x813c,
  TEXTURE_MAX_LEVEL: 0x813d,
  COLOR_ATTACHMENT1: 0x8ce1,
  COLOR_ATTACHMENT2: 0x8ce2,
  COLOR_ATTACHMENT3: 0x8ce3,
  COLOR_ATTACHMENT4: 0x8ce4,
  COLOR_ATTACHMENT5: 0x8ce5,
  COLOR_ATTACHMENT6: 0x8ce6,
  COLOR_ATTACHMENT7: 0x8ce7,
  COLOR_ATTACHMENT8: 0x8ce8,
  COLOR_ATTACHMENT9: 0x8ce9,
  COLOR_ATTACHMENT10: 0x8cea,
  COLOR_ATTACHMENT11: 0x8ceb,
  COLOR_ATTACHMENT12: 0x8cec,
  COLOR_ATTACHMENT13: 0x8ced,
  COLOR_ATTACHMENT14: 0x8cee,
  COLOR_ATTACHMENT15: 0x8cef,
  DRAW_BUFFER0: 0x8825,
  DRAW_BUFFER1: 0x8826,
  DRAW_BUFFER2: 0x8827,
  DRAW_BUFFER3: 0x8828,
  DRAW_BUFFER4: 0x8829,
  DRAW_BUFFER5: 0x882a,
  DRAW_BUFFER6: 0x882b,
  DRAW_BUFFER7: 0x882c,
} as const;

/** How many colour outputs a draw writes (`MAX_DRAW_BUFFERS`, `MAX_COLOR_ATTACHMENTS`): the colour attachments a render pass takes. */
const MAX_DRAW_BUFFERS = 8;

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
  /** The mip levels it has storage for (`texStorage2D`, or `texImage2D` of an empty level): what a framebuffer can draw in. */
  levels = 1;
  /** `texSubImage2D` calls since it was specified that its pixels here cannot take: pictures over parts of it, in order. */
  patches: GlslPatch[] = [];
  min: number = GL.NEAREST_MIPMAP_LINEAR;
  mag: number = GL.LINEAR;
  wrapS: number = GL.REPEAT;
  wrapT: number = GL.REPEAT;
  /** `TEXTURE_MAX_LEVEL`: the last level sampling reads. */
  maxLevel = 1000;
  version = 0;
  snapshot: { version: number; id: string; json: GlslTexture } | null = null;
}
/** What an attachment point of a framebuffer holds: a level of a texture, or a renderbuffer. */
export type WebGLAttachment = { texture: WebGLTexture; level: number } | { renderbuffer: WebGLRenderbuffer };

export class WebGLFramebuffer extends WebGLObject {
  /** What COLOR_ATTACHMENT0 and up hold. */
  readonly colors: (WebGLAttachment | null)[] = [];
  /** DEPTH_ATTACHMENT and STENCIL_ATTACHMENT; DEPTH_STENCIL_ATTACHMENT puts one image in both. */
  depth: WebGLAttachment | null = null;
  stencil: WebGLAttachment | null = null;
  /** `drawBuffers`: what output `i` of a fragment shader is written to, COLOR_ATTACHMENTi or NONE. */
  drawBuffers: number[] = [GL.COLOR_ATTACHMENT0];
  /** `readBuffer`: the colour attachment `blitFramebuffer` reads. */
  readBuffer: number = GL.COLOR_ATTACHMENT0;
  /** Bound at least once, as `isFramebuffer` asks. */
  bound = false;
  /** The texture attached to COLOR_ATTACHMENT0. */
  get color(): WebGLTexture | null {
    const a = this.colors[0];
    return a !== null && a !== undefined && 'texture' in a ? a.texture : null;
  }
}
export class WebGLRenderbuffer extends WebGLObject {
  /** The internal format `renderbufferStorage` gave it; null before. */
  format: number | null = null;
  width = 0;
  height = 0;
  /** Changes with each `renderbufferStorage`, which makes it a new, empty image. */
  version = 0;
}
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

export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Two FNV-1a passes with different bases: an id for content, 16 hex digits. */
export function hashOf(text: string): string {
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
  polygonOffset: boolean;
}

/** The depth functions, by the name the recording uses. */
const DEPTH_FUNCS: Record<number, string> = {
  [GL.NEVER]: 'NEVER',
  [GL.LESS]: 'LESS',
  [GL.EQUAL]: 'EQUAL',
  [GL.LEQUAL]: 'LEQUAL',
  [GL.GREATER]: 'GREATER',
  [GL.NOTEQUAL]: 'NOTEQUAL',
  [GL.GEQUAL]: 'GEQUAL',
  [GL.ALWAYS]: 'ALWAYS',
};

/** The stencil operations, by the name the recording uses. */
const STENCIL_OPS: Record<number, string> = {
  [GL.KEEP]: 'KEEP',
  [GL.ZERO]: 'ZERO',
  [GL.REPLACE]: 'REPLACE',
  [GL.INCR]: 'INCR',
  [GL.DECR]: 'DECR',
  [GL.INVERT]: 'INVERT',
  [GL.INCR_WRAP]: 'INCR_WRAP',
  [GL.DECR_WRAP]: 'DECR_WRAP',
};

/** What an image of an internal format can be: colour, a depth buffer, a stencil buffer, or both of those. */
type ImageKind = 'color' | 'depth' | 'stencil' | 'depthStencil';
const DEPTH_ONLY = new Set<number>([GL.DEPTH_COMPONENT, GL.DEPTH_COMPONENT16, GL2.DEPTH_COMPONENT24, GL2.DEPTH_COMPONENT32F]);
const DEPTH_AND_STENCIL = new Set<number>([GL.DEPTH_STENCIL, GL2.DEPTH24_STENCIL8, GL2.DEPTH32F_STENCIL8]);
/** The colour formats of a renderbuffer; each is drawn as RGBA8. */
const COLOR_RENDERBUFFER = new Set<number>([GL.RGBA4, GL.RGB5_A1, GL.RGB565, GL2.RGBA8]);

function kindOf(format: number): ImageKind {
  if (DEPTH_ONLY.has(format)) return 'depth';
  if (DEPTH_AND_STENCIL.has(format)) return 'depthStencil';
  if (format === GL.STENCIL_INDEX8) return 'stencil';
  return 'color';
}

/** One face's stencil state: `stencilFunc`, `stencilOp` and `stencilMask`, as GL keeps them. */
interface StencilState {
  func: number;
  ref: number;
  valueMask: number;
  fail: number;
  zfail: number;
  zpass: number;
  writeMask: number;
}

function newStencil(): StencilState {
  return { func: GL.ALWAYS, ref: 0, valueMask: 0x7fffffff, fail: GL.KEEP, zfail: GL.KEEP, zpass: GL.KEEP, writeMask: 0x7fffffff };
}

/** The bits of the stencil buffers here. */
const STENCIL_BITS = 8;
const STENCIL_MAX = (1 << STENCIL_BITS) - 1;

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
  [GL.SAMPLE_ALPHA_TO_COVERAGE, 'alpha to coverage'],
  [GL.SAMPLE_COVERAGE, 'sample coverage'],
]);

/** The largest point drawn (`ALIASED_POINT_SIZE_RANGE`): `gl_PointSize` is clamped to 1 to this (crates/core/src/glsl.rs, `MAX_POINT_SIZE`). */
const POINT_SIZE_MAX = 511;

/** Formats of a texture that colour cannot be drawn into. */
const NOT_RENDERABLE = new Set<number>([GL.ALPHA, GL.LUMINANCE, GL.LUMINANCE_ALPHA, GL.DEPTH_COMPONENT]);

/** Whether an op goes to the canvas: its drawing buffer, or its depth and stencil buffer. */
function isCanvasOp(op: GlslOp): boolean {
  if (op.op === 'upload') return false;
  return op.target === undefined && (op.op === 'blit' || (op.outputs === undefined && op.depthStencil === undefined));
}

/**
 * `WebGLRenderingContext` (and, with `version: 2`, the `WebGL2RenderingContext` calls shader pages use) as a recorder.
 * `content()` is what the `glsl` layer is made of. A context keeps its objects (programs, buffers, textures) and its
 * state between frames as a browser's does; the drawing buffer is emptied by `resetState()` (the frame loop calls it
 * before a frame), also when the context was made with `preserveDrawingBuffer`.
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
  private caps: Capability = { blend: false, cull: false, scissor: false, depth: false, stencil: false, polygonOffset: false };
  private depthFuncValue: number = GL.LESS;
  private depthMaskValue = true;
  private clearDepthValue = 1;
  private depthRangeValue: [number, number] = [0, 1];
  private polygonOffsetValue: [number, number] = [0, 0];
  private stencilFront: StencilState = newStencil();
  private stencilBack: StencilState = newStencil();
  private clearStencilValue = 0;
  /** `drawBuffers` of the canvas: BACK, or NONE. */
  private canvasDrawBuffer: number = GL.BACK;
  private renderbuffer: WebGLRenderbuffer | null = null;
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
      ...(this.attributes.depth ? {} : { depth: false }),
      ...(this.attributes.stencil ? { stencil: true } : {}),
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
   * The frame loop calls this before each frame: the drawing buffer is emptied, so a frame is what its own draws
   * make, whichever frame was rendered before (a frame is a function of its number, and the frames of one render
   * may be made in any order or by different processes). It holds with `preserveDrawingBuffer` too, which in a page
   * keeps the picture from one presented frame to the next; here each frame is a new context's first. A frame that
   * draws nothing draws nothing.
   */
  resetState(): void {
    this.stale = true;
    this.ops = [];
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
    return this.version === 1 ? ['OES_standard_derivatives', 'WEBGL_depth_texture'] : ['OES_standard_derivatives'];
  }
  getExtension(name: string): object | null {
    // Derivatives are always available in the translated shaders, and depth textures (core in WebGL 2) in the replay.
    if (name === 'OES_standard_derivatives') return { FRAGMENT_SHADER_DERIVATIVE_HINT_OES: 0x8b8b };
    if (name === 'WEBGL_depth_texture' && this.version === 1) return { UNSIGNED_INT_24_8_WEBGL: GL2.UNSIGNED_INT_24_8 };
    return null;
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
      case GL.ALIASED_POINT_SIZE_RANGE:
        return new Float32Array([1, POINT_SIZE_MAX]);
      case GL.ALIASED_LINE_WIDTH_RANGE:
        return new Float32Array([1, 1]);
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
      case GL2.VERTEX_ARRAY_BINDING:
        if (this.version === 2) return this.vao === this.defaultVao ? null : this.vao;
        this.fail(GL.INVALID_ENUM);
        return null;
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
      case GL.POLYGON_OFFSET_FILL:
        return this.caps.polygonOffset;
      case GL.DEPTH_FUNC:
        return this.depthFuncValue;
      case GL.DEPTH_WRITEMASK:
        return this.depthMaskValue;
      case GL.DEPTH_CLEAR_VALUE:
        return this.clearDepthValue;
      case GL.DEPTH_RANGE:
        return new Float32Array(this.depthRangeValue);
      case GL.POLYGON_OFFSET_FACTOR:
        return this.polygonOffsetValue[0];
      case GL.POLYGON_OFFSET_UNITS:
        return this.polygonOffsetValue[1];
      case GL.STENCIL_FUNC:
        return this.stencilFront.func;
      case GL.STENCIL_REF:
        return this.stencilFront.ref;
      case GL.STENCIL_VALUE_MASK:
        return this.stencilFront.valueMask;
      case GL.STENCIL_FAIL:
        return this.stencilFront.fail;
      case GL.STENCIL_PASS_DEPTH_FAIL:
        return this.stencilFront.zfail;
      case GL.STENCIL_PASS_DEPTH_PASS:
        return this.stencilFront.zpass;
      case GL.STENCIL_WRITEMASK:
        return this.stencilFront.writeMask;
      case GL.STENCIL_BACK_FUNC:
        return this.stencilBack.func;
      case GL.STENCIL_BACK_REF:
        return this.stencilBack.ref;
      case GL.STENCIL_BACK_VALUE_MASK:
        return this.stencilBack.valueMask;
      case GL.STENCIL_BACK_FAIL:
        return this.stencilBack.fail;
      case GL.STENCIL_BACK_PASS_DEPTH_FAIL:
        return this.stencilBack.zfail;
      case GL.STENCIL_BACK_PASS_DEPTH_PASS:
        return this.stencilBack.zpass;
      case GL.STENCIL_BACK_WRITEMASK:
        return this.stencilBack.writeMask;
      case GL.STENCIL_CLEAR_VALUE:
        return this.clearStencilValue;
      case GL.RENDERBUFFER_BINDING:
        return this.renderbuffer;
      case GL2.MAX_DRAW_BUFFERS:
      case GL2.MAX_COLOR_ATTACHMENTS:
        if (this.version === 2) return MAX_DRAW_BUFFERS;
        this.fail(GL.INVALID_ENUM);
        return null;
      case GL2.READ_BUFFER:
        if (this.version === 2) return this.readFramebuffer === null ? GL.BACK : this.readFramebuffer.readBuffer;
        this.fail(GL.INVALID_ENUM);
        return null;
      default:
        if (this.version === 2 && pname >= GL2.DRAW_BUFFER0 && pname < GL2.DRAW_BUFFER0 + MAX_DRAW_BUFFERS) {
          const i = pname - GL2.DRAW_BUFFER0;
          if (this.drawFramebuffer === null) return i === 0 ? this.canvasDrawBuffer : GL.NONE;
          return this.drawFramebuffer.drawBuffers[i] ?? GL.NONE;
        }
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

  /**
   * Copies a rectangle of the read framebuffer over one of the draw framebuffer (the canvas, or what a framebuffer
   * draws in): the colour of the read buffer into each draw buffer, and the depth and the stencil buffer.
   */
  blitFramebuffer(sx0: number, sy0: number, sx1: number, sy1: number, dx0: number, dy0: number, dx1: number, dy1: number, mask: number, filter: number): void {
    if (this.version !== 2) return this.fail(GL.INVALID_OPERATION);
    if (mask & ~(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT)) return this.fail(GL.INVALID_VALUE);
    if (filter !== GL.NEAREST && filter !== GL.LINEAR) return this.fail(GL.INVALID_ENUM);
    const read = this.readFramebuffer;
    const draw = this.drawFramebuffer;
    if (read !== null && this.statusOf(read) !== GL.FRAMEBUFFER_COMPLETE) return this.fail(GL.INVALID_FRAMEBUFFER_OPERATION);
    if (this.framebufferIncomplete()) return;
    // Depth and stencil are copied texel for texel.
    if (mask & (GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT) && filter !== GL.NEAREST) return this.fail(GL.INVALID_OPERATION);
    const rects = [sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1].map(Number);
    if (rects.some((v) => !Number.isFinite(v))) return this.fail(GL.INVALID_VALUE);
    const [fx0, fy0, fx1, fy1, tx0, ty0, tx1, ty1] = rects.map(Math.trunc);
    // With `antialias` the canvas is multisampled, as in a browser: nothing is blitted into it, and it is read only
    // into a rectangle of its own bounds.
    if (this.attributes.antialias) {
      if (draw === null) return this.fail(GL.INVALID_OPERATION);
      if (read === null && (fx0 !== tx0 || fy0 !== ty0 || fx1 !== tx1 || fy1 !== ty1)) return this.fail(GL.INVALID_OPERATION);
    }
    const geometry = {
      from: [fx0!, fy0!, fx1!, fy1!] as [number, number, number, number],
      to: [tx0!, ty0!, tx1!, ty1!] as [number, number, number, number],
      ...(this.caps.scissor ? { scissor: this.scissorBox ?? this.viewportNow() } : {}),
    };

    // Colour: the read buffer (nothing when it is NONE or empty) into each draw buffer.
    let source: WebGLAttachment | 'canvas' | null = null;
    let dests: (WebGLAttachment | 'canvas')[] = [];
    if (mask & GL.COLOR_BUFFER_BIT) {
      source = read === null ? 'canvas' : read.readBuffer === GL.NONE ? null : (read.colors[read.readBuffer - GL.COLOR_ATTACHMENT0] ?? null);
      dests = draw === null ? ['canvas'] : this.outputsOf(draw).filter((a): a is WebGLAttachment => a !== null);
      const sameAs = (d: WebGLAttachment | 'canvas') => d === source || (d !== 'canvas' && source !== null && source !== 'canvas' && WebGLContext.same(d, source));
      if (source !== null && dests.some(sameAs)) return this.fail(GL.INVALID_OPERATION);
      if (source !== null && source !== 'canvas' && 'texture' in source) {
        const t = source.texture;
        if (!t.blank && t.drawnAt !== t.version) throw new WebGLUnsupportedError('blitFramebuffer from a texture that holds uploaded pixels; draw into it, or sample it');
      }
    }
    // Depth and stencil: what both framebuffers have, of one format.
    const has = (kind: ImageKind | null, aspect: 'depth' | 'stencil') => kind === aspect || kind === 'depthStencil';
    const readKind = this.depthStencilKind(read);
    const drawKind = this.depthStencilKind(draw);
    const depth = (mask & GL.DEPTH_BUFFER_BIT) !== 0 && has(readKind, 'depth') && has(drawKind, 'depth');
    const stencil = (mask & GL.STENCIL_BUFFER_BIT) !== 0 && has(readKind, 'stencil') && has(drawKind, 'stencil');
    const readDs = read === null ? 'canvas' : WebGLContext.depthStencilOf(read);
    const drawDs = draw === null ? 'canvas' : WebGLContext.depthStencilOf(draw);
    if (depth || stencil) {
      if (this.depthStencilFormat(read) !== this.depthStencilFormat(draw)) return this.fail(GL.INVALID_OPERATION);
      const one = readDs === drawDs || (readDs !== 'canvas' && drawDs !== 'canvas' && WebGLContext.same(readDs, drawDs));
      if (one) return this.fail(GL.INVALID_OPERATION);
    }

    this.begin();
    if (source !== null) {
      const read = source === 'canvas' ? {} : { src: this.attachmentId(source), ...('texture' in source && source.level > 0 ? { srcLevel: source.level } : {}) };
      for (const d of dests) {
        const written = d === 'canvas' ? {} : this.outputOf(d);
        this.ops.push({ op: 'blit', ...read, ...written, ...geometry, ...(filter === GL.LINEAR ? { linear: true } : {}) });
      }
    }
    if (depth || stencil) {
      const aspect = depth && stencil ? 'depthStencil' : depth ? 'depth' : 'stencil';
      this.ops.push({
        op: 'blit',
        aspect,
        ...(readDs === 'canvas' || readDs === null ? {} : { src: this.attachmentId(readDs) }),
        ...(drawDs === 'canvas' || drawDs === null ? {} : { target: this.attachmentId(drawDs) }),
        ...geometry,
      });
    }
  }

  /** The internal format of a framebuffer's depth and stencil buffer (the canvas's for null), which a blit must match. */
  private depthStencilFormat(framebuffer: WebGLFramebuffer | null): number {
    if (framebuffer === null) {
      const { depth, stencil } = this.attributes;
      return depth && stencil ? GL2.DEPTH24_STENCIL8 : depth ? GL2.DEPTH_COMPONENT24 : GL.STENCIL_INDEX8;
    }
    const a = WebGLContext.depthStencilOf(framebuffer);
    const format = a === null ? 0 : this.imageOf(a).format;
    return format === GL.DEPTH_STENCIL ? GL2.DEPTH24_STENCIL8 : format;
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
      case GL.POLYGON_OFFSET_FILL:
        this.caps.polygonOffset = on;
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
  clearDepth(depth: number): void {
    this.clearDepthValue = Math.min(1, Math.max(0, Number(depth)));
  }
  clearStencil(s: number): void {
    this.clearStencilValue = Math.trunc(Number(s)) | 0;
  }
  depthFunc(func: number): void {
    if (DEPTH_FUNCS[func] === undefined) return this.fail(GL.INVALID_ENUM);
    this.depthFuncValue = func;
  }
  depthMask(flag: boolean): void {
    this.depthMaskValue = Boolean(flag);
  }
  depthRange(near: number, far: number): void {
    const n = Math.min(1, Math.max(0, Number(near)));
    const f = Math.min(1, Math.max(0, Number(far)));
    if (n > f) return this.fail(GL.INVALID_OPERATION);
    this.depthRangeValue = [n, f];
  }
  polygonOffset(factor: number, units: number): void {
    this.polygonOffsetValue = [Number(factor), Number(units)];
  }
  stencilFunc(func: number, ref: number, mask: number): void {
    this.stencilFuncSeparate(GL.FRONT_AND_BACK, func, ref, mask);
  }
  stencilFuncSeparate(face: number, func: number, ref: number, mask: number): void {
    if (DEPTH_FUNCS[func] === undefined) return this.fail(GL.INVALID_ENUM);
    for (const s of this.faces(face)) Object.assign(s, { func, ref: Math.trunc(Number(ref)) | 0, valueMask: Number(mask) >>> 0 });
  }
  stencilOp(fail: number, zfail: number, zpass: number): void {
    this.stencilOpSeparate(GL.FRONT_AND_BACK, fail, zfail, zpass);
  }
  stencilOpSeparate(face: number, fail: number, zfail: number, zpass: number): void {
    if ([fail, zfail, zpass].some((op) => STENCIL_OPS[op] === undefined)) return this.fail(GL.INVALID_ENUM);
    for (const s of this.faces(face)) Object.assign(s, { fail, zfail, zpass });
  }
  stencilMask(mask: number): void {
    this.stencilMaskSeparate(GL.FRONT_AND_BACK, mask);
  }
  stencilMaskSeparate(face: number, mask: number): void {
    for (const s of this.faces(face)) s.writeMask = Number(mask) >>> 0;
  }
  /** The faces a `*Separate` call names; none, with INVALID_ENUM, for another value. */
  private faces(face: number): StencilState[] {
    if (face === GL.FRONT) return [this.stencilFront];
    if (face === GL.BACK) return [this.stencilBack];
    if (face === GL.FRONT_AND_BACK) return [this.stencilFront, this.stencilBack];
    this.fail(GL.INVALID_ENUM);
    return [];
  }
  lineWidth(): void {}
  cullFace(mode: number): void {
    if (mode !== GL.FRONT && mode !== GL.BACK && mode !== GL.FRONT_AND_BACK) return this.fail(GL.INVALID_ENUM);
    this.cullMode = mode;
  }
  frontFace(mode: number): void {
    if (mode !== GL.CW && mode !== GL.CCW) return this.fail(GL.INVALID_ENUM);
    this.frontFaceMode = mode;
  }

  /** Whether the framebuffer drawn into has a depth buffer: the canvas's `depth` attribute, or a depth attachment. */
  private hasDepth(): boolean {
    const kind = this.depthStencilKind(this.drawFramebuffer);
    return kind === 'depth' || kind === 'depthStencil';
  }
  /** Whether it has a stencil buffer: the canvas's `stencil` attribute, or a stencil attachment. */
  private hasStencil(): boolean {
    const kind = this.depthStencilKind(this.drawFramebuffer);
    return kind === 'stencil' || kind === 'depthStencil';
  }

  clear(mask: number): void {
    if (mask & ~(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT)) return this.fail(GL.INVALID_VALUE);
    // The depth and stencil buffers are cleared only where there are such buffers, as far as their masks let them be written.
    const color = (mask & GL.COLOR_BUFFER_BIT) !== 0;
    const depth = (mask & GL.DEPTH_BUFFER_BIT) !== 0 && this.hasDepth() && this.depthMaskValue;
    const stencilMask = this.stencilFront.writeMask & STENCIL_MAX;
    const stencil = (mask & GL.STENCIL_BUFFER_BIT) !== 0 && this.hasStencil() && stencilMask !== 0;
    if (!color && !depth && !stencil) return;
    if (this.caps.scissor) throw new WebGLUnsupportedError('clear with the scissor test on; draw a quad over the box instead');
    if (color && this.colorMaskState.some((on) => !on)) throw new WebGLUnsupportedError('clear with a colour mask');
    if (stencil && stencilMask !== STENCIL_MAX) throw new WebGLUnsupportedError('clearing the stencil buffer through a stencilMask other than 0 or 0xff');
    if (this.framebufferIncomplete()) return;
    this.pushClear({
      ...(color ? { color: [...this.clearColorValue] as [number, number, number, number] } : {}),
      ...(depth ? { depth: this.clearDepthValue } : {}),
      ...(stencil ? { stencil: this.clearStencilValue & STENCIL_MAX } : {}),
    }, color);
  }

  /**
   * WebGL 2's `clearBufferfv`, `clearBufferiv`, `clearBufferuiv` and `clearBufferfi`: one draw buffer's colour, or the
   * depth or stencil buffer, to the value given (masks apply, as for `clear`).
   */
  clearBufferfv(buffer: number, drawbuffer: number, values: ArrayLike<number>, srcOffset = 0): void {
    this.clearBuffer(buffer, drawbuffer, Array.from(values).slice(srcOffset).map(Number));
  }
  clearBufferiv(buffer: number, drawbuffer: number, values: ArrayLike<number>, srcOffset = 0): void {
    this.clearBuffer(buffer, drawbuffer, Array.from(values).slice(srcOffset).map(Number));
  }
  clearBufferuiv(buffer: number, drawbuffer: number, values: ArrayLike<number>, srcOffset = 0): void {
    this.clearBuffer(buffer, drawbuffer, Array.from(values).slice(srcOffset).map(Number));
  }
  clearBufferfi(buffer: number, drawbuffer: number, depth: number, stencil: number): void {
    if (buffer !== GL.DEPTH_STENCIL) return this.fail(GL.INVALID_ENUM);
    this.clearBuffer(GL2.DEPTH, drawbuffer, [depth]);
    this.clearBuffer(GL2.STENCIL, drawbuffer, [stencil]);
  }
  private clearBuffer(buffer: number, drawbuffer: number, values: number[]): void {
    if (this.version !== 2) return this.fail(GL.INVALID_OPERATION);
    if (buffer === GL2.COLOR) {
      if (!(drawbuffer >= 0 && drawbuffer < MAX_DRAW_BUFFERS) || values.length < 4) return this.fail(GL.INVALID_VALUE);
      if (this.caps.scissor) throw new WebGLUnsupportedError('clearBuffer with the scissor test on; draw a quad over the box instead');
      if (this.colorMaskState.some((on) => !on)) throw new WebGLUnsupportedError('clear with a colour mask');
      if (this.framebufferIncomplete()) return;
      const framebuffer = this.drawFramebuffer;
      const output = framebuffer === null ? (drawbuffer === 0 ? 'canvas' : null) : (this.outputsOf(framebuffer)[drawbuffer] ?? null);
      if (output === null) return;
      const color = values.slice(0, 4).map((v) => Math.min(1, Math.max(0, v))) as [number, number, number, number];
      this.pushClear({ color }, true, output === 'canvas' ? undefined : [output]);
      return;
    }
    if (drawbuffer !== 0 || values.length < 1) return this.fail(GL.INVALID_VALUE);
    if (buffer !== GL2.DEPTH && buffer !== GL2.STENCIL) return this.fail(GL.INVALID_ENUM);
    const depth = buffer === GL2.DEPTH && this.hasDepth() && this.depthMaskValue;
    const stencilMask = this.stencilFront.writeMask & STENCIL_MAX;
    const stencil = buffer === GL2.STENCIL && this.hasStencil() && stencilMask !== 0;
    if (!depth && !stencil) return;
    if (this.caps.scissor) throw new WebGLUnsupportedError('clearBuffer with the scissor test on; draw a quad over the box instead');
    if (stencil && stencilMask !== STENCIL_MAX) throw new WebGLUnsupportedError('clearing the stencil buffer through a stencilMask other than 0 or 0xff');
    if (this.framebufferIncomplete()) return;
    this.pushClear(depth ? { depth: Math.min(1, Math.max(0, values[0]!)) } : { stencil: Math.trunc(values[0]!) & STENCIL_MAX }, false, []);
  }

  /**
   * Records a clear of the bound draw framebuffer (of `outputs` instead of its draw buffers, when given). Everything
   * drawn to the canvas before it is gone with it, when the clear takes the colour and what the draws left in the
   * depth and stencil buffers matters no more; what went to framebuffers stays, as later draws may read it. (A blit
   * that reads the canvas keeps them: the replay drops what no blit reads.)
   */
  private pushClear(values: { color?: [number, number, number, number]; depth?: number; stencil?: number }, color: boolean, outputs?: (WebGLAttachment | null)[]): void {
    this.begin();
    const where = this.dest(values.depth !== undefined || values.stencil !== undefined, outputs);
    if (where === null) return;
    const op: GlslOp = { op: 'clear', ...values, ...where };
    if (!isCanvasOp(op)) {
      this.ops.push(op);
      return;
    }
    const canvas = this.ops.filter(isCanvasOp);
    const read = this.ops.some((o) => o.op === 'blit' && o.src === undefined);
    const tested = canvas.some((o) => (o.op === 'draw' && o.depth !== undefined) || (o.op === 'blit' && (o.aspect === 'depth' || o.aspect === 'depthStencil')));
    const stenciled = canvas.some((o) => (o.op === 'draw' && o.stencil !== undefined) || (o.op === 'blit' && (o.aspect === 'stencil' || o.aspect === 'depthStencil')));
    const gone = color && (values.depth !== undefined || !tested) && (values.stencil !== undefined || !stenciled) && !read;
    this.ops = [...(gone ? this.ops.filter((o) => !isCanvasOp(o)) : this.ops), op];
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
    texture.levels = 1;
    texture.patches = [];
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
      case GL2.TEXTURE_MAX_LEVEL:
        if (this.version !== 2) return this.fail(GL.INVALID_ENUM);
        if (!(param >= 0)) return this.fail(GL.INVALID_VALUE);
        texture.maxLevel = Math.trunc(param);
        break;
      case GL2.TEXTURE_BASE_LEVEL:
        if (this.version !== 2) return this.fail(GL.INVALID_ENUM);
        if (param !== 0) throw new WebGLUnsupportedError('a TEXTURE_BASE_LEVEL other than 0');
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
    if (!texture.uploaded || kindOf(texture.format) !== 'color') return this.fail(GL.INVALID_OPERATION);
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

  /** Makes `texture` an empty depth (or depth and stencil) texture of this size: a framebuffer draws in it, and draws sample its depth. */
  private specifyDepth(texture: WebGLTexture, internalformat: number, width: number, height: number, source: unknown): void {
    if (source !== null && source !== undefined) throw new WebGLUnsupportedError('a depth texture with pixels; give it null and draw its depth');
    Object.assign(texture, { width, height, pixels: null, src: null, layer: null, uploaded: true, flipY: false, premultiply: false, mipmaps: false, format: internalformat, blank: true, levels: 1, patches: [] });
    texture.version += 1;
  }

  /** `texImage2D(target, level, internalformat, width, height, border, format, type, pixels)` or `(…, internalformat, format, type, source)`. */
  texImage2D(target: number, level: number, internalformat: number, ...rest: unknown[]): void {
    const texture = this.bound(target);
    if (texture === null) return;
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
    if (level !== 0) {
      // An empty level of a texture: storage a framebuffer can draw in.
      const empty = rest.length >= 6 && (source === null || source === undefined);
      if (!empty) throw new WebGLUnsupportedError('texture levels above 0 with pixels; call generateMipmap');
      if (!(level > 0 && level < 16)) return this.fail(GL.INVALID_VALUE);
      if (texture.width === 0 || !texture.blank || internalformat !== texture.format || kindOf(internalformat) !== 'color') {
        throw new WebGLUnsupportedError('a texture level above 0 of a texture that is not an empty RGBA one (specify level 0 with null first)');
      }
      if (width !== Math.max(1, texture.width >> level) || height !== Math.max(1, texture.height >> level)) {
        throw new WebGLUnsupportedError(`a texture level ${level} of ${width} x ${height}; level ${level} of a ${texture.width} x ${texture.height} texture is ${Math.max(1, texture.width >> level)} x ${Math.max(1, texture.height >> level)}`);
      }
      texture.levels = Math.max(texture.levels, level + 1);
      texture.version += 1;
      return;
    }
    if (kindOf(internalformat) !== 'color') return this.specifyDepth(texture, internalformat, width, height, source);
    this.checkTextureType(type, internalformat);
    texture.flipY = this.flipY;
    texture.premultiply = this.premultiply;
    texture.mipmaps = false;
    texture.layer = null;
    texture.uploaded = true;
    texture.version += 1;
    texture.format = internalformat;
    texture.levels = 1;
    texture.patches = [];
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

  /** `texElementImage2D(target, level, internalformat, format, type, elementImage)` of HTML in Canvas: `texImage2D` of an element's picture. */
  texElementImage2D(target: number, level: number, internalformat: number, format: number, type: number, elementImage: unknown): void {
    this.texImage2D(target, level, internalformat, format, type, elementImage);
  }

  /**
   * A picture over a rectangle of level 0. Into a texture a framebuffer draws in it is an op after the draws before
   * it; into an uploaded texture whose pixels are here it edits them; anything else (an image file, a layer, a
   * texture made from one) is a patch the renderer lays over the texture's picture.
   */
  texSubImage2D(target: number, level: number, xoffset: number, yoffset: number, ...rest: unknown[]): void {
    const texture = this.bound(target);
    if (texture === null) return;
    if (level !== 0) throw new WebGLUnsupportedError('texSubImage2D above level 0; call generateMipmap');
    if (kindOf(texture.format) !== 'color') throw new WebGLUnsupportedError('texSubImage2D into a depth texture; draw its depth');
    let width: number;
    let height: number;
    let part: { pixels: Uint8Array } | { src: string } | { layer: string };
    if (rest.length >= 5) {
      let format: number;
      let type: number;
      let source: unknown;
      [width, height, format, type, source] = rest as [number, number, number, number, ArrayBufferView];
      this.checkTextureType(type, GL.RGBA);
      part = { pixels: this.rgbaOf(width, height, format, source as ArrayBufferView) };
    } else {
      const layer = (rest[2] as { [LAYER_SOURCE]?: () => { id: string; width: number; height: number } } | null | undefined)?.[LAYER_SOURCE]?.();
      if (layer !== undefined) {
        part = { layer: layer.id };
        width = layer.width;
        height = layer.height;
      } else {
        const picture = pictureOf(rest[2]);
        if (picture === null) throw new WebGLUnsupportedError('texSubImage2D from this source; use an image, a canvas, ImageData or an array of pixels');
        const s = picture.source;
        if (s.kind === 'pixels') {
          part = { pixels: new Uint8Array(Buffer.from(s.data, 'base64')) };
        } else if (s.kind === 'canvas' || s.kind === 'video') {
          const drawn = this.rasterized(s, picture.width, picture.height);
          if (drawn === null) throw new WebGLUnsupportedError(`texSubImage2D from a ${s.kind} here (its pixels need the addon)`);
          part = { pixels: drawn };
        } else if (s.kind === 'src') {
          part = { src: s.src };
        } else {
          throw new WebGLUnsupportedError('a texture from a layer picture outside layerPicture()');
        }
        width = picture.width;
        height = picture.height;
      }
    }
    if (xoffset < 0 || yoffset < 0 || xoffset + width > texture.width || yoffset + height > texture.height) return this.fail(GL.INVALID_VALUE);
    const flags = { ...(this.flipY ? { flipY: true } : {}), ...(this.premultiply ? { premultiply: true } : {}) };
    const json = 'pixels' in part ? { pixels: toBase64(part.pixels) } : part;
    if (texture.drawnAt === texture.version) {
      this.begin();
      this.ops.push({ op: 'upload', target: this.registerTarget(texture), x: xoffset, y: yoffset, width, height, ...json, ...flags });
      return;
    }
    // Pixels over pixels held here, unflipped and premultiplied alike, are written in place.
    const inPlace = texture.pixels !== null && texture.patches.length === 0 && !texture.flipY && !this.flipY && texture.premultiply === this.premultiply;
    if ('pixels' in part && inPlace) {
      const held = texture.pixels!;
      for (let y = 0; y < height; y += 1) {
        held.set(part.pixels.subarray(y * width * 4, (y + 1) * width * 4), ((yoffset + y) * texture.width + xoffset) * 4);
      }
    } else {
      texture.patches.push({ x: xoffset, y: yoffset, width, height, ...json, ...flags });
    }
    texture.blank = false;
    texture.version += 1;
  }

  /** WebGL 2's `texStorage2D`: a texture of this size, empty, with `levels` mip levels. */
  texStorage2D(target: number, levels: number, internalformat: number, width: number, height: number): void {
    const texture = this.bound(target);
    if (texture === null) return;
    if (!(levels >= 1 && levels <= 16)) return this.fail(GL.INVALID_VALUE);
    if (kindOf(internalformat) !== 'color') {
      if (levels > 1) throw new WebGLUnsupportedError('a depth texture of more than one level');
      return this.specifyDepth(texture, internalformat, width, height, null);
    }
    this.checkTextureType(GL.UNSIGNED_BYTE, internalformat);
    // Its upper levels are mipmaps of the empty level 0 until a framebuffer draws in them.
    Object.assign(texture, { width, height, pixels: new Uint8Array(width * height * 4), src: null, layer: null, uploaded: true, flipY: false, premultiply: false, mipmaps: levels > 1, format: internalformat, blank: true, levels, patches: [] });
    texture.version += 1;
  }

  /** The pixels of a canvas, or of a video frame (drawn 1:1 on a canvas of its size), through the addon. */
  private rasterized(source: Extract<CanvasSource, { kind: 'canvas' | 'video' }>, width: number, height: number): Uint8Array | null {
    if (source.kind === 'canvas') return this.options.rasterize?.(source) ?? null;
    return this.options.rasterize?.({ kind: 'canvas', width, height, commands: [{ op: 'image', source, dx: 0, dy: 0, dw: width, dh: height }] }) ?? null;
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
    } else if (s.kind === 'layer') {
      throw new WebGLUnsupportedError('a texture from a layer picture outside layerPicture()');
    } else {
      const pixels = this.rasterized(s, picture.width, picture.height);
      if (pixels === null) throw new WebGLUnsupportedError(`a texture from a ${s.kind} here (its pixels need the addon)`);
      texture.src = null;
      texture.pixels = pixels;
    }
  }

  // ---- framebuffers ----
  //
  // A framebuffer draws into what is attached to it: colour attachments (an RGBA texture's level, or a colour
  // renderbuffer), which `drawBuffers` maps the fragment shader's outputs to, and a depth, stencil or depth-and-stencil
  // buffer (a renderbuffer, or a depth texture later draws can sample). Each is a target of the recording, by an id
  // that changes when it is specified again. A target starts the frame empty: a frame is a function of its own calls,
  // so what an earlier frame left in it does not carry over.

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

  /** The framebuffer an attaching call changes, or null with the error it sets. */
  private attachingTo(target: number): WebGLFramebuffer | null {
    const { draw, read } = this.framebufferSides(target);
    if (!draw && !read) {
      this.fail(GL.INVALID_ENUM);
      return null;
    }
    const framebuffer = draw ? this.drawFramebuffer : this.readFramebuffer;
    if (framebuffer === null) this.fail(GL.INVALID_OPERATION);
    return framebuffer;
  }

  /** Puts `image` at the attachment point `attachment`, or sets INVALID_ENUM when there is no such point. */
  private attach(framebuffer: WebGLFramebuffer, attachment: number, image: WebGLAttachment | null): void {
    const colors = this.version === 2 ? MAX_DRAW_BUFFERS : 1;
    if (attachment >= GL.COLOR_ATTACHMENT0 && attachment < GL.COLOR_ATTACHMENT0 + colors) {
      framebuffer.colors[attachment - GL.COLOR_ATTACHMENT0] = image;
    } else if (attachment === GL.DEPTH_ATTACHMENT) {
      framebuffer.depth = image;
    } else if (attachment === GL.STENCIL_ATTACHMENT) {
      framebuffer.stencil = image;
    } else if (attachment === GL.DEPTH_STENCIL_ATTACHMENT) {
      framebuffer.depth = image;
      framebuffer.stencil = image;
    } else {
      this.fail(GL.INVALID_ENUM);
    }
  }

  framebufferTexture2D(target: number, attachment: number, textarget: number, texture: WebGLTexture | null, level: number): void {
    const framebuffer = this.attachingTo(target);
    if (framebuffer === null) return;
    if (texture !== null) {
      if (textarget !== GL.TEXTURE_2D) return this.fail(GL.INVALID_OPERATION);
      if (!(level >= 0) || (this.version === 1 && level !== 0)) return this.fail(GL.INVALID_VALUE);
    }
    this.attach(framebuffer, attachment, texture === null ? null : { texture, level: Math.trunc(level) });
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

  /** An attached image: its size, its internal format, and whether it has been specified. */
  private imageOf(a: WebGLAttachment): { width: number; height: number; format: number; specified: boolean } {
    if ('renderbuffer' in a) {
      const r = a.renderbuffer;
      return { width: r.width, height: r.height, format: r.format ?? 0, specified: r.format !== null && !r.deleted };
    }
    const t = a.texture;
    return {
      width: Math.max(1, t.width >> a.level),
      height: Math.max(1, t.height >> a.level),
      format: t.format,
      specified: t.uploaded && !t.deleted && a.level < t.levels && t.width > 0 && t.height > 0,
    };
  }

  private static same(a: WebGLAttachment | null, b: WebGLAttachment | null): boolean {
    if (a === null || b === null) return a === b;
    if ('renderbuffer' in a) return 'renderbuffer' in b && a.renderbuffer === b.renderbuffer;
    return 'texture' in b && a.texture === b.texture && a.level === b.level;
  }

  private statusOf(framebuffer: WebGLFramebuffer): number {
    const colors = framebuffer.colors.filter((a): a is WebGLAttachment => a !== null && a !== undefined);
    const all = [...colors, ...[framebuffer.depth, framebuffer.stencil].filter((a): a is WebGLAttachment => a !== null)];
    if (all.length === 0) return GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT;
    for (const a of all) {
      const image = this.imageOf(a);
      if (!image.specified || image.width === 0 || image.height === 0) return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    }
    // Colour attachments of a colour format, a depth attachment with depth, a stencil one with stencil.
    for (const a of colors) {
      const format = this.imageOf(a).format;
      if (kindOf(format) !== 'color' || ('texture' in a && NOT_RENDERABLE.has(format))) return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    }
    const depth = framebuffer.depth === null ? null : kindOf(this.imageOf(framebuffer.depth).format);
    if (depth !== null && depth !== 'depth' && depth !== 'depthStencil') return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    const stencil = framebuffer.stencil === null ? null : kindOf(this.imageOf(framebuffer.stencil).format);
    if (stencil !== null && stencil !== 'stencil' && stencil !== 'depthStencil') return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    // A depth buffer and a stencil buffer are one image, as WebGL 2 has it (WebGL 1 says unsupported for two).
    if (framebuffer.depth !== null && framebuffer.stencil !== null && !WebGLContext.same(framebuffer.depth, framebuffer.stencil)) return GL.FRAMEBUFFER_UNSUPPORTED;
    if (this.version === 1) {
      const sizes = new Set(all.map((a) => `${this.imageOf(a).width}x${this.imageOf(a).height}`));
      if (sizes.size > 1) return GL.FRAMEBUFFER_INCOMPLETE_DIMENSIONS;
    }
    return GL.FRAMEBUFFER_COMPLETE;
  }

  /** The colour attachments the outputs of a fragment shader go to (null for NONE), as `drawBuffers` says. */
  private outputsOf(framebuffer: WebGLFramebuffer): (WebGLAttachment | null)[] {
    return framebuffer.drawBuffers.map((b, i) => (b === GL.NONE ? null : (framebuffer.colors[i] ?? null)));
  }

  /** The depth or stencil buffer of a framebuffer (one image when it has both). */
  private static depthStencilOf(framebuffer: WebGLFramebuffer): WebGLAttachment | null {
    return framebuffer.depth ?? framebuffer.stencil;
  }

  /** What the depth and stencil buffer of a framebuffer (the canvas for null) holds, or null when it has none. */
  private depthStencilKind(framebuffer: WebGLFramebuffer | null): ImageKind | null {
    if (framebuffer === null) {
      const { depth, stencil } = this.attributes;
      return depth && stencil ? 'depthStencil' : depth ? 'depth' : stencil ? 'stencil' : null;
    }
    const a = WebGLContext.depthStencilOf(framebuffer);
    return a === null ? null : kindOf(this.imageOf(a).format);
  }

  /**
   * Whether the bound framebuffer cannot be drawn into: an incomplete one sets INVALID_FRAMEBUFFER_OPERATION and the
   * call does nothing. A complete one that cannot be drawn here throws.
   */
  private framebufferIncomplete(): boolean {
    const framebuffer = this.drawFramebuffer;
    if (framebuffer === null) {
      if (this.canvasDrawBuffer === GL.NONE) throw new WebGLUnsupportedError('drawBuffers([NONE]) on the canvas; turn the colour off with colorMask');
      return false;
    }
    if (this.statusOf(framebuffer) !== GL.FRAMEBUFFER_COMPLETE) {
      this.fail(GL.INVALID_FRAMEBUFFER_OPERATION);
      return true;
    }
    const drawn = [...this.outputsOf(framebuffer), WebGLContext.depthStencilOf(framebuffer)].filter((a): a is WebGLAttachment => a !== null);
    for (const a of drawn) {
      if (!('texture' in a)) continue;
      const texture = a.texture;
      if (kindOf(texture.format) !== 'color') continue;
      if (texture.format !== GL.RGBA && texture.format !== GL2.RGBA8) {
        throw new WebGLUnsupportedError(`drawing into a texture of internal format 0x${texture.format.toString(16)}; allocate it as RGBA`);
      }
      if (!texture.blank) throw new WebGLUnsupportedError('drawing into a texture that holds uploaded pixels; allocate it with texImage2D(..., null)');
    }
    const sizes = new Set(drawn.map((a) => `${this.imageOf(a).width}x${this.imageOf(a).height}`));
    if (sizes.size > 1) throw new WebGLUnsupportedError('attachments of different sizes in one framebuffer; give them one size');
    return false;
  }

  /** A texture a framebuffer draws in, as the recording names it: its size, by an id that changes when it is specified again. */
  private registerTarget(texture: WebGLTexture): string {
    const id = `f${texture.id}.${texture.version}`;
    const kind = kindOf(texture.format);
    this.textures.set(id, {
      target: true,
      width: texture.width,
      height: texture.height,
      ...(kind === 'color' ? {} : { format: kind }),
      // WebGL 1 samples a depth texture as luminance (WEBGL_depth_texture), WebGL 2 as red.
      ...(kind !== 'color' && this.version === 1 ? { luminance: true } : {}),
      ...(texture.levels > 1 ? { levels: texture.levels } : {}),
    });
    return id;
  }

  /** The target an attachment is in the recording; a texture drawn in is a render target from now on. */
  private attachmentId(a: WebGLAttachment): string {
    if ('texture' in a) {
      a.texture.drawnAt = a.texture.version;
      return this.registerTarget(a.texture);
    }
    const r = a.renderbuffer;
    const id = `r${r.id}.${r.version}`;
    const kind = kindOf(r.format ?? 0);
    this.textures.set(id, { target: true, width: r.width, height: r.height, ...(kind === 'color' ? {} : { format: kind }) });
    return id;
  }

  private outputOf(a: WebGLAttachment): GlslOutput {
    const target = this.attachmentId(a);
    return 'texture' in a && a.level > 0 ? { target, level: a.level } : { target };
  }

  /**
   * Where the ops of the bound draw framebuffer go, as the fields of an op: nothing for the canvas, and for a
   * framebuffer its colour outputs (`outputs`, or these instead) and its depth or stencil buffer (when
   * `withDepthStencil`). Null when that leaves nothing to draw in. Call it once the op is certain: the textures it
   * names are render targets from then on.
   */
  private dest(withDepthStencil = true, outputs?: (WebGLAttachment | null)[]): Pick<GlslDraw, 'target' | 'level' | 'outputs' | 'depthStencil'> | null {
    const framebuffer = this.drawFramebuffer;
    if (framebuffer === null) return {};
    const list = [...(outputs ?? this.outputsOf(framebuffer))];
    while (list.length > 0 && list.at(-1) === null) list.pop();
    const ds = withDepthStencil ? WebGLContext.depthStencilOf(framebuffer) : null;
    if (list.length === 0 && ds === null) return null;
    const out: Pick<GlslDraw, 'target' | 'level' | 'outputs' | 'depthStencil'> = {};
    if (list.length === 1 && list[0] !== null) Object.assign(out, this.outputOf(list[0]!));
    else if (list.length > 0) out.outputs = list.map((a) => (a === null ? null : this.outputOf(a)));
    if (ds !== null) out.depthStencil = this.attachmentId(ds);
    return out;
  }

  /** WebGL 2's `drawBuffers`: output `i` goes to COLOR_ATTACHMENTi, or nowhere (NONE); the canvas takes BACK or NONE. */
  drawBuffers(buffers: number[]): void {
    const list = Array.from(buffers, Number);
    if (this.drawFramebuffer === null) {
      if (list.length !== 1 || (list[0] !== GL.BACK && list[0] !== GL.NONE)) return this.fail(GL.INVALID_OPERATION);
      this.canvasDrawBuffer = list[0]!;
      return;
    }
    if (list.length > MAX_DRAW_BUFFERS) return this.fail(GL.INVALID_VALUE);
    if (list.some((b, i) => b !== GL.NONE && b !== GL.COLOR_ATTACHMENT0 + i)) return this.fail(GL.INVALID_OPERATION);
    this.drawFramebuffer.drawBuffers = list;
  }

  /** WebGL 2's `readBuffer`: the colour attachment `blitFramebuffer` reads (BACK for the canvas), or NONE. */
  readBuffer(src: number): void {
    const framebuffer = this.readFramebuffer;
    if (framebuffer === null) {
      if (src !== GL.BACK && src !== GL.NONE) return this.fail(GL.INVALID_OPERATION);
      return;
    }
    if (src !== GL.NONE && !(src >= GL.COLOR_ATTACHMENT0 && src < GL.COLOR_ATTACHMENT0 + MAX_DRAW_BUFFERS)) return this.fail(GL.INVALID_OPERATION);
    framebuffer.readBuffer = src;
  }

  /** WebGL 2's `invalidateFramebuffer`: the contents may be dropped, and keeping them is one of the allowed results. */
  invalidateFramebuffer(): void {}
  invalidateSubFramebuffer(): void {}

  getFramebufferAttachmentParameter(target: number, attachment: number, pname: number): unknown {
    const framebuffer = this.attachingTo(target);
    if (framebuffer === null) return null;
    const a =
      attachment >= GL.COLOR_ATTACHMENT0 && attachment < GL.COLOR_ATTACHMENT0 + MAX_DRAW_BUFFERS
        ? (framebuffer.colors[attachment - GL.COLOR_ATTACHMENT0] ?? null)
        : attachment === GL.DEPTH_ATTACHMENT || attachment === GL.DEPTH_STENCIL_ATTACHMENT
          ? framebuffer.depth
          : attachment === GL.STENCIL_ATTACHMENT
            ? framebuffer.stencil
            : undefined;
    if (a === undefined) {
      this.fail(GL.INVALID_ENUM);
      return null;
    }
    switch (pname) {
      case GL.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE:
        return a === null ? GL.NONE : 'texture' in a ? GL.TEXTURE : GL.RENDERBUFFER;
      case GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME:
        return a === null ? null : 'texture' in a ? a.texture : a.renderbuffer;
      case GL.FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL:
        if (a !== null && 'texture' in a) return a.level;
        this.fail(GL.INVALID_ENUM);
        return null;
      default:
        this.fail(GL.INVALID_ENUM);
        return null;
    }
  }

  // ---- renderbuffers ----
  //
  // A renderbuffer is an image a framebuffer draws in and no draw samples: colour (RGBA4, RGB565, RGB5_A1 and RGBA8,
  // each drawn as RGBA8), depth, stencil, or depth and stencil.

  createRenderbuffer(): WebGLRenderbuffer {
    return new WebGLRenderbuffer();
  }
  deleteRenderbuffer(renderbuffer: WebGLRenderbuffer | null): void {
    if (renderbuffer === null) return;
    renderbuffer.deleted = true;
    if (this.renderbuffer === renderbuffer) this.renderbuffer = null;
  }
  isRenderbuffer(renderbuffer: unknown): boolean {
    return renderbuffer instanceof WebGLRenderbuffer && renderbuffer.format !== null && !renderbuffer.deleted;
  }
  bindRenderbuffer(target: number, renderbuffer: WebGLRenderbuffer | null): void {
    if (target !== GL.RENDERBUFFER) return this.fail(GL.INVALID_ENUM);
    if (renderbuffer?.deleted) return this.fail(GL.INVALID_OPERATION);
    this.renderbuffer = renderbuffer;
  }
  renderbufferStorage(target: number, internalformat: number, width: number, height: number): void {
    if (target !== GL.RENDERBUFFER) return this.fail(GL.INVALID_ENUM);
    if (!(width >= 0 && height >= 0)) return this.fail(GL.INVALID_VALUE);
    const renderbuffer = this.renderbuffer;
    if (renderbuffer === null) return this.fail(GL.INVALID_OPERATION);
    const v2 = this.version === 2;
    const v2only = [GL2.RGBA8, GL2.DEPTH_COMPONENT24, GL2.DEPTH_COMPONENT32F, GL2.DEPTH24_STENCIL8, GL2.DEPTH32F_STENCIL8] as number[];
    const known = kindOf(internalformat) !== 'color' || COLOR_RENDERBUFFER.has(internalformat);
    if (internalformat === GL.DEPTH_COMPONENT) return this.fail(GL.INVALID_ENUM);
    if (!known || (!v2 && v2only.includes(internalformat))) {
      if (v2 && internalformat === GL2.SRGB8_ALPHA8) throw new WebGLUnsupportedError('an SRGB8_ALPHA8 renderbuffer; use RGBA8');
      return this.fail(GL.INVALID_ENUM);
    }
    renderbuffer.format = internalformat;
    renderbuffer.width = Math.trunc(width);
    renderbuffer.height = Math.trunc(height);
    renderbuffer.version += 1;
  }
  /** WebGL 2's multisampled storage; with 0 samples it is `renderbufferStorage`. */
  renderbufferStorageMultisample(target: number, samples: number, internalformat: number, width: number, height: number): void {
    if (this.version !== 2) return this.fail(GL.INVALID_OPERATION);
    if (samples > 0) throw new WebGLUnsupportedError('a multisampled renderbuffer; use renderbufferStorage (edges are not multisampled)');
    this.renderbufferStorage(target, internalformat, width, height);
  }
  getRenderbufferParameter(target: number, pname: number): number | null {
    if (target !== GL.RENDERBUFFER) {
      this.fail(GL.INVALID_ENUM);
      return null;
    }
    const r = this.renderbuffer;
    if (r === null) {
      this.fail(GL.INVALID_OPERATION);
      return null;
    }
    if (pname === GL.RENDERBUFFER_WIDTH) return r.width;
    if (pname === GL.RENDERBUFFER_HEIGHT) return r.height;
    if (pname === GL.RENDERBUFFER_INTERNAL_FORMAT) return r.format ?? GL.RGBA4;
    this.fail(GL.INVALID_ENUM);
    return null;
  }
  framebufferRenderbuffer(target: number, attachment: number, renderbufferTarget: number, renderbuffer: WebGLRenderbuffer | null): void {
    if (renderbufferTarget !== GL.RENDERBUFFER) return this.fail(GL.INVALID_ENUM);
    const framebuffer = this.attachingTo(target);
    if (framebuffer === null) return;
    this.attach(framebuffer, attachment, renderbuffer === null ? null : { renderbuffer });
  }

  // ---- instanced drawing ----

  drawArraysInstanced(mode: number, first: number, count: number, instances: number): void {
    if (!(first >= 0 && count >= 0 && instances >= 0)) return this.fail(GL.INVALID_VALUE);
    this.draw(mode, first, count, null, instances);
  }
  drawElementsInstanced(mode: number, count: number, type: number, offset: number, instances: number): void {
    if (!(count >= 0 && offset >= 0 && instances >= 0)) return this.fail(GL.INVALID_VALUE);
    const ty = this.indexType(type);
    if (ty === null) return this.fail(GL.INVALID_ENUM);
    this.draw(mode, 0, count, { type: ty, offset }, instances);
  }

  // ---- drawing ----

  drawArrays(mode: number, first: number, count: number): void {
    if (!(first >= 0 && count >= 0)) return this.fail(GL.INVALID_VALUE);
    this.draw(mode, first, count, null);
  }
  drawElements(mode: number, count: number, type: number, offset: number): void {
    if (!(count >= 0 && offset >= 0)) return this.fail(GL.INVALID_VALUE);
    const ty = this.indexType(type);
    if (ty === null) return this.fail(GL.INVALID_ENUM);
    this.draw(mode, 0, count, { type: ty, offset });
  }
  private indexType(type: number): 'u8' | 'u16' | 'u32' | null {
    return type === GL.UNSIGNED_BYTE ? 'u8' : type === GL.UNSIGNED_SHORT ? 'u16' : type === GL.UNSIGNED_INT ? 'u32' : null;
  }

  private draw(mode: number, first: number, count: number, indexed: { type: 'u8' | 'u16' | 'u32'; offset: number } | null, instances = 1): void {
    const modes: Record<number, GlslDraw['mode']> = { [GL.POINTS]: 'points', [GL.TRIANGLES]: 'triangles', [GL.TRIANGLE_STRIP]: 'triangleStrip', [GL.TRIANGLE_FAN]: 'triangleFan' };
    if (mode < GL.POINTS || mode > GL.TRIANGLE_FAN) return this.fail(GL.INVALID_ENUM);
    const program = this.program;
    if (program === null) return this.fail(GL.INVALID_OPERATION);
    const named = modes[mode];
    if (named === undefined) throw new WebGLUnsupportedError('drawing lines; draw triangles (points are drawn)');
    if (this.framebufferIncomplete()) return;
    // WebGL refuses a stencil test whose faces differ in the reference or the masks.
    const stencilTest = this.caps.stencil && this.hasStencil();
    const [front, back] = [this.stencilFront, this.stencilBack];
    const ref = (s: StencilState) => Math.min(Math.max(s.ref, 0), STENCIL_MAX);
    if (stencilTest && (ref(front) !== ref(back) || (front.valueMask & STENCIL_MAX) !== (back.valueMask & STENCIL_MAX) || (front.writeMask & STENCIL_MAX) !== (back.writeMask & STENCIL_MAX))) {
      return this.fail(GL.INVALID_OPERATION);
    }
    if (instances === 0) return;
    if (named === 'points' && instances !== 1) throw new WebGLUnsupportedError('instanced points; draw the points with one drawArrays');
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
      ...(instances === 1 ? {} : { instances }),
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
      if (a.divisor > 1) throw new WebGLUnsupportedError(`vertexAttribDivisor(${a.divisor}, ...) of the attribute "${d.name}"; use 0 or 1`);
      if (a.divisor === 1 && named === 'points') throw new WebGLUnsupportedError('instanced attributes of points');
      const type = ({ [GL.FLOAT]: 'f32', [GL.UNSIGNED_BYTE]: 'u8', [GL.BYTE]: 'i8', [GL.UNSIGNED_SHORT]: 'u16', [GL.SHORT]: 'i16' } as Record<number, GlslDraw['attributes'][string]['type']>)[a.type];
      if (type === undefined) throw new WebGLUnsupportedError(`the attribute "${d.name}" has type 0x${a.type.toString(16)}; use FLOAT, or a normalised byte or short`);
      draw.attributes[d.name] = { buffer: this.bufferId(a.buffer), size: a.size, type, normalized: a.normalized, stride: a.stride, offset: a.offset, ...(a.divisor === 1 ? { divisor: 1 } : {}) };
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
    const fb = this.drawFramebuffer;
    const attached = fb === null ? [] : [...fb.colors, fb.depth, fb.stencil].flatMap((a) => (a !== null && a !== undefined && 'texture' in a ? [a.texture] : []));
    for (const d of program.uniformDeclarations) {
      if (d.type === 'samplerCube') throw new WebGLUnsupportedError(`the sampler "${d.name}" is a samplerCube; only sampler2D is available`);
      if (d.type !== 'sampler2D') continue;
      const unit = program.uniforms.get(d.name)?.at(-1)?.value[0] ?? 0;
      const texture = this.units.get(unit);
      // Reading what the draw writes is undefined; WebGL refuses it.
      if (texture !== undefined && attached.includes(texture)) return this.fail(GL.INVALID_OPERATION);
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
    // Without a depth buffer the test passes and nothing is written, as in a browser.
    if (this.caps.depth && this.hasDepth()) {
      const [near, far] = this.depthRangeValue;
      draw.depth = { func: DEPTH_FUNCS[this.depthFuncValue]!, mask: this.depthMaskValue, near, far };
      const [factor, units] = this.polygonOffsetValue;
      if (this.caps.polygonOffset && named !== 'points' && (factor !== 0 || units !== 0)) draw.polygonOffset = { factor, units };
    }
    if (stencilTest) {
      const face = (s: StencilState): GlslStencilFace => ({ func: DEPTH_FUNCS[s.func]!, fail: STENCIL_OPS[s.fail]!, zfail: STENCIL_OPS[s.zfail]!, zpass: STENCIL_OPS[s.zpass]! });
      const stencil: GlslStencil = { ref: ref(front), valueMask: front.valueMask & STENCIL_MAX, writeMask: front.writeMask & STENCIL_MAX, front: face(front), back: face(back) };
      draw.stencil = stencil;
    }
    const where = this.dest(draw.depth !== undefined || draw.stencil !== undefined);
    if (where === null) return;
    this.ops.push({ op: 'draw', ...draw, ...where });
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
    // A depth texture is a render target from the start: its depth is drawn, never uploaded.
    const target = texture.drawnAt === texture.version || kindOf(texture.format) !== 'color';
    const id = target ? this.registerTarget(texture) : this.uploadedId(texture);
    return {
      texture: id,
      min: FILTERS[texture.min]!,
      mag: FILTERS[texture.mag]!,
      wrapS: WRAPS[texture.wrapS]!,
      wrapT: WRAPS[texture.wrapT]!,
      ...(texture.maxLevel < 1000 ? { maxLevel: texture.maxLevel } : {}),
    };
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
        ...(texture.patches.length > 0 ? { patches: [...texture.patches] } : {}),
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
