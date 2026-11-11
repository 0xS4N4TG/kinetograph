// A `WebGLRenderingContext` and `WebGL2RenderingContext` that record instead of rasterising (packages/cli/skills/kinetograph-markup/references/SCENE.md, "glsl").
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

import type { CanvasSource, GlslContent, GlslDraw, GlslProgram, GlslLayer, GlslOp, GlslOutput, GlslPatch, GlslSampler, GlslStencil, GlslStencilFace, GlslTexture, GlslUniform } from './types.js';
import { CANVAS_SOURCE, pictureOf, type CanvasPicture } from './canvas.js';
import { preprocess } from './glsl-cpp.js';
import { parseBlocks, type BlockInfo, type BlockUniform } from './webgl-blocks.js';
import { carriedFor, carryOn, dependsOnHistory, emptyCarry, isCanvasOp, MAX_OPS_PER_TARGET, namedBy, pick, readsLastFrame, type Resources } from './webgl-carry.js';

/** The method a picture of another layer answers a texture upload with (`layerPicture`). */
export const LAYER_SOURCE: unique symbol = Symbol.for('kinetograph.layerSource');

/**
 * A picture of a child of a shader group or a canvas pass (packages/cli/skills/kinetograph-markup/references/SCENE.md, "Shader groups", "Canvas passes"), to upload as
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
    super(`unsupported: ${what} (packages/cli/skills/kinetograph-markup/references/SCENE.md, "glsl")`);
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
  MAX_RENDERBUFFER_SIZE: 0x84e8,
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
  TEXTURE_WRAP_R: 0x8072,
  TEXTURE: 0x1702,
  TEXTURE_CUBE_MAP: 0x8513,
  TEXTURE_BINDING_CUBE_MAP: 0x8514,
  TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515,
  TEXTURE_CUBE_MAP_NEGATIVE_X: 0x8516,
  TEXTURE_CUBE_MAP_POSITIVE_Y: 0x8517,
  TEXTURE_CUBE_MAP_NEGATIVE_Y: 0x8518,
  TEXTURE_CUBE_MAP_POSITIVE_Z: 0x8519,
  TEXTURE_CUBE_MAP_NEGATIVE_Z: 0x851a,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
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
  SAMPLE_BUFFERS: 0x80a8,
  SAMPLES: 0x80a9,
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
  RGB16F: 0x881b,
  R16F: 0x822d,
  RG16F: 0x822f,
  RG32F: 0x8230,
  SRGB8_ALPHA8: 0x8c43,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
  READ_FRAMEBUFFER_BINDING: 0x8caa,
  VERTEX_ARRAY_BINDING: 0x85b5,
  TEXTURE_3D: 0x806f,
  TEXTURE_BINDING_3D: 0x806a,
  MAX_3D_TEXTURE_SIZE: 0x8073,
  TEXTURE_2D_ARRAY: 0x8c1a,
  TEXTURE_BINDING_2D_ARRAY: 0x8c1d,
  TEXTURE_COMPARE_MODE: 0x884c,
  TEXTURE_COMPARE_FUNC: 0x884d,
  COMPARE_REF_TO_TEXTURE: 0x884e,
  SAMPLER_2D_ARRAY: 0x8dc1,
  MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
  UNIFORM_BUFFER: 0x8a11,
  MAX_VARYING_COMPONENTS: 0x8b4b,
  MAX_ELEMENT_INDEX: 0x8d6b,
  MAX_PROGRAM_TEXEL_OFFSET: 0x8905,
  MIN_PROGRAM_TEXEL_OFFSET: 0x8904,
  MAX_VERTEX_UNIFORM_COMPONENTS: 0x8b4a,
  MAX_FRAGMENT_UNIFORM_COMPONENTS: 0x8b49,
  MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS: 0x8a31,
  MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS: 0x8a33,
  MAX_VERTEX_OUTPUT_COMPONENTS: 0x9122,
  MAX_FRAGMENT_INPUT_COMPONENTS: 0x9125,
  UNIFORM_BUFFER_BINDING: 0x8a28,
  UNIFORM_BUFFER_START: 0x8a29,
  UNIFORM_BUFFER_SIZE: 0x8a2a,
  MAX_VERTEX_UNIFORM_BLOCKS: 0x8a2b,
  MAX_FRAGMENT_UNIFORM_BLOCKS: 0x8a2d,
  MAX_COMBINED_UNIFORM_BLOCKS: 0x8a2e,
  MAX_UNIFORM_BUFFER_BINDINGS: 0x8a2f,
  MAX_UNIFORM_BLOCK_SIZE: 0x8a30,
  UNIFORM_BUFFER_OFFSET_ALIGNMENT: 0x8a34,
  ACTIVE_UNIFORM_BLOCKS: 0x8a36,
  UNIFORM_TYPE: 0x8a37,
  UNIFORM_SIZE: 0x8a38,
  UNIFORM_BLOCK_INDEX: 0x8a3a,
  UNIFORM_OFFSET: 0x8a3b,
  UNIFORM_ARRAY_STRIDE: 0x8a3c,
  UNIFORM_MATRIX_STRIDE: 0x8a3d,
  UNIFORM_IS_ROW_MAJOR: 0x8a3e,
  UNIFORM_BLOCK_BINDING: 0x8a3f,
  UNIFORM_BLOCK_DATA_SIZE: 0x8a40,
  UNIFORM_BLOCK_ACTIVE_UNIFORMS: 0x8a42,
  UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES: 0x8a43,
  UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER: 0x8a44,
  UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER: 0x8a46,
  INVALID_INDEX: 0xffffffff,
  TRANSFORM_FEEDBACK_BUFFER: 0x8c8e,
  PIXEL_UNPACK_BUFFER: 0x88ec,
  PIXEL_PACK_BUFFER: 0x88eb,
  UNPACK_ROW_LENGTH: 0xcf2,
  UNPACK_SKIP_ROWS: 0xcf3,
  UNPACK_SKIP_PIXELS: 0xcf4,
  MAX_DRAW_BUFFERS: 0x8824,
  MAX_COLOR_ATTACHMENTS: 0x8cdf,
  MAX_SAMPLES: 0x8d57,
  RENDERBUFFER_SAMPLES: 0x8cab,
  FRAMEBUFFER_INCOMPLETE_MULTISAMPLE: 0x8d56,
  UNSIGNED_INT_VEC2: 0x8dc6,
  UNSIGNED_INT_VEC3: 0x8dc7,
  UNSIGNED_INT_VEC4: 0x8dc8,
  FLOAT_MAT2x3: 0x8b65,
  FLOAT_MAT2x4: 0x8b66,
  FLOAT_MAT3x2: 0x8b67,
  FLOAT_MAT3x4: 0x8b68,
  FLOAT_MAT4x2: 0x8b69,
  FLOAT_MAT4x3: 0x8b6a,
  SAMPLER_2D_SHADOW: 0x8b62,
  SAMPLER_2D_ARRAY_SHADOW: 0x8dc4,
  SAMPLER_CUBE_SHADOW: 0x8dc5,
  INT_SAMPLER_2D: 0x8dca,
  INT_SAMPLER_3D: 0x8dcb,
  INT_SAMPLER_CUBE: 0x8dcc,
  INT_SAMPLER_2D_ARRAY: 0x8dcf,
  UNSIGNED_INT_SAMPLER_2D: 0x8dd2,
  UNSIGNED_INT_SAMPLER_3D: 0x8dd3,
  UNSIGNED_INT_SAMPLER_CUBE: 0x8dd4,
  UNSIGNED_INT_SAMPLER_2D_ARRAY: 0x8dd7,
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

/** The float internal formats of WebGL 2: the components they hold, the `format` that goes with them, and their bits. */
const FLOAT_FORMATS: Record<number, { channels: number; format: number; bits: 16 | 32 }> = {
  [GL2.R32F]: { channels: 1, format: GL2.RED, bits: 32 },
  [GL2.RG32F]: { channels: 2, format: GL2.RG, bits: 32 },
  [GL2.RGB32F]: { channels: 3, format: GL.RGB, bits: 32 },
  [GL2.RGBA32F]: { channels: 4, format: GL.RGBA, bits: 32 },
  [GL2.R16F]: { channels: 1, format: GL2.RED, bits: 16 },
  [GL2.RG16F]: { channels: 2, format: GL2.RG, bits: 16 },
  [GL2.RGB16F]: { channels: 3, format: GL.RGB, bits: 16 },
  [GL2.RGBA16F]: { channels: 4, format: GL.RGBA, bits: 16 },
};

/** `MAX_VERTEX_ATTRIBS`. */
const MAX_VERTEX_ATTRIBS = 16;

/**
 * The uniform buffer limits, which are what the replay does: a block is read from a buffer of its own, up to wgpu's
 * `max_uniform_buffer_binding_size` (64 KiB) at offsets `min_uniform_buffer_offset_alignment` (at most 256) apart, and
 * a stage reads the most uniform buffers of the device (the ES 3.0 minimums, 12 a stage and 24 in all, with the one the
 * loose uniforms use besides).
 */
const MAX_UNIFORM_BUFFER_BINDINGS = 24;
const MAX_UNIFORM_BLOCK_SIZE = 65536;
const UNIFORM_BUFFER_OFFSET_ALIGNMENT = 256;
const MAX_STAGE_UNIFORM_BLOCKS = 12;
/**
 * The fixed limits WebGL 2 adds, as the replay has them: `MAX_*_UNIFORM_VECTORS` are 256 a stage, and a block adds its
 * 64 KiB, 12 of them, to the components a stage reads; a varying is one of the 15 `vec4`s a stage passes; the texel
 * offset of `textureOffset` is wgpu's (-8 to 7), and an index of `drawElements` is up to 32 bits.
 */
const FIXED_LIMITS: Record<number, number> = {
  [GL2.MAX_VARYING_COMPONENTS]: 60,
  [GL2.MAX_VERTEX_OUTPUT_COMPONENTS]: 60,
  [GL2.MAX_FRAGMENT_INPUT_COMPONENTS]: 60,
  [GL2.MAX_ELEMENT_INDEX]: 0xffffffff,
  [GL2.MAX_PROGRAM_TEXEL_OFFSET]: 7,
  [GL2.MIN_PROGRAM_TEXEL_OFFSET]: -8,
  [GL2.MAX_VERTEX_UNIFORM_COMPONENTS]: 1024,
  [GL2.MAX_FRAGMENT_UNIFORM_COMPONENTS]: 1024,
  [GL2.MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS]: 1024 + (12 * 65536) / 4,
  [GL2.MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS]: 1024 + (12 * 65536) / 4,
};
const UNIFORM_BUFFER_LIMITS: Record<number, number> = {
  [GL2.MAX_UNIFORM_BUFFER_BINDINGS]: MAX_UNIFORM_BUFFER_BINDINGS,
  [GL2.MAX_UNIFORM_BLOCK_SIZE]: MAX_UNIFORM_BLOCK_SIZE,
  [GL2.UNIFORM_BUFFER_OFFSET_ALIGNMENT]: UNIFORM_BUFFER_OFFSET_ALIGNMENT,
  [GL2.MAX_VERTEX_UNIFORM_BLOCKS]: MAX_STAGE_UNIFORM_BLOCKS,
  [GL2.MAX_FRAGMENT_UNIFORM_BLOCKS]: MAX_STAGE_UNIFORM_BLOCKS,
  [GL2.MAX_COMBINED_UNIFORM_BLOCKS]: 2 * MAX_STAGE_UNIFORM_BLOCKS,
};

/** What a disabled attribute array reads until `vertexAttrib*` sets it. */
const DEFAULT_ATTRIBUTE: readonly [number, number, number, number] = [0, 0, 0, 1];

/** `MAX_3D_TEXTURE_SIZE`: the longest side of a 3D texture. */
const MAX_3D_TEXTURE_SIZE = 2048;

/** The pixel format of each 8-bit internal format a 3D or array texture takes. */
const FORMATS_8BIT_3D: Record<number, number> = { [GL2.RGBA8]: GL.RGBA, [GL.RGBA]: GL.RGBA, [GL2.RGB8]: GL.RGB, [GL.RGB]: GL.RGB, [GL2.RG8]: GL2.RG, [GL2.R8]: GL2.RED };

/** The texture target each sampler type reads. */
const SAMPLER_TARGETS: Record<string, number> = { sampler2D: GL.TEXTURE_2D, sampler3D: GL2.TEXTURE_3D, samplerCube: GL.TEXTURE_CUBE_MAP, sampler2DArray: GL2.TEXTURE_2D_ARRAY, sampler2DShadow: GL.TEXTURE_2D, samplerCubeShadow: GL.TEXTURE_CUBE_MAP, sampler2DArrayShadow: GL2.TEXTURE_2D_ARRAY };

/** `MAX_ARRAY_TEXTURE_LAYERS`: the layers of a 2D array texture. */
const MAX_ARRAY_TEXTURE_LAYERS = 256;

/** `MAX_CUBE_MAP_TEXTURE_SIZE`: the side of a face. */
const MAX_CUBE_MAP_TEXTURE_SIZE = 8192;

/** The cube map face a texture target names (0 for +X to 5 for -Z), or -1. */
function faceIndex(target: number): number {
  return target >= GL.TEXTURE_CUBE_MAP_POSITIVE_X && target <= GL.TEXTURE_CUBE_MAP_NEGATIVE_Z ? target - GL.TEXTURE_CUBE_MAP_POSITIVE_X : -1;
}

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
  /** The layers of a 3D or 2D array texture (`texImage3D`, `texStorage3D`); 0 for a 2D one. */
  depth = 0;
  /** The target it was first bound to: a texture keeps its type. */
  target: number | null = null;
  /** The texels of a float texture (`pixels` holds the others), four floats each; the renderer keeps them as half floats, or as 32-bit ones with `float32`. */
  floats: Float32Array | null = null;
  float32 = false;
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
  /** Given its levels by `texStorage2D`: `generateMipmap` fills them, and makes no more. */
  immutable = false;
  /** `texSubImage2D` calls since it was specified that its pixels here cannot take: pictures over parts of it, in order. */
  patches: GlslPatch[] = [];
  min: number = GL.NEAREST_MIPMAP_LINEAR;
  mag: number = GL.LINEAR;
  wrapS: number = GL.REPEAT;
  wrapT: number = GL.REPEAT;
  wrapR: number = GL.REPEAT;
  /** `TEXTURE_COMPARE_MODE` and `TEXTURE_COMPARE_FUNC`: what a shadow sampler does with the depth texture. */
  compareMode: number = GL.NONE;
  compareFunc: number = GL.LEQUAL;
  /** `TEXTURE_MAX_LEVEL`: the last level sampling reads. */
  maxLevel = 1000;
  /** `TEXTURE_BASE_LEVEL`: the first level sampling reads, and the one `generateMipmap` makes the others from. */
  baseLevel = 0;
  version = 0;
  snapshot: { version: number; id: string; json: GlslTexture } | null = null;
  /** The six faces of a cube map (+X, -X, +Y, -Y, +Z, -Z), each a 2D texture of its own; null for any other texture. */
  faces: WebGLTexture[] | null = null;
}
/** What an attachment point of a framebuffer holds: a level of a texture (of a face of `cube`), or a renderbuffer. */
export type WebGLAttachment = { texture: WebGLTexture; level: number; cube?: WebGLTexture } | { renderbuffer: WebGLRenderbuffer };

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
  /** `renderbufferStorageMultisample`: 0, or `MAX_SAMPLES`. */
  samples = 0;
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
  /** Set by `vertexAttribIPointer`: the shader reads integers. */
  integer: boolean;
  buffer: WebGLBuffer | null;
  size: number;
  type: number;
  normalized: boolean;
  stride: number;
  offset: number;
  divisor: number;
}

function newAttribute(): VertexAttribute {
  return { enabled: false, integer: false, buffer: null, size: 4, type: GL.FLOAT, normalized: false, stride: 0, offset: 0, divisor: 0 };
}

interface Declaration {
  name: string;
  type: string;
  length: number;
  location: number | null;
  /** Declared with `[n]`, even `[1]`: a browser lists it as `name[0]`, which a library reads to tell an array from a single value. */
  array?: boolean;
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
  /** The uniform blocks of the two shaders in GL's order, with the stages that declare each. */
  blocks: (BlockInfo & { vertex: boolean; fragment: boolean })[] = [];
  /** The binding point of each block (`uniformBlockBinding`; 0 after a link). */
  blockBindings: number[] = [];
  /** Why the link failed, when it did for a reason other than a missing shader. */
  linkLog = '';
}

// ---- reading the source for names ----

interface StructField {
  name: string;
  type: string;
  /** The array length, or null for a single value. */
  length: number | null;
}

/** The structs a shader defines, with their fields. */
function structsOf(code: string, lengthOf: (text: string) => number | null): Map<string, StructField[]> {
  const structs = new Map<string, StructField[]>();
  for (const m of code.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}\s*;/g)) {
    const fields: StructField[] = [];
    for (const statement of m[2]!.split(';')) {
      const f = /^\s*(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+([\s\S]+)$/.exec(statement);
      if (f === null) continue;
      for (const declarator of f[2]!.split(',')) {
        const d = /^\s*(\w+)\s*(?:\[\s*(\w+)\s*\])?\s*$/.exec(declarator);
        if (d === null) continue;
        const length = d[2] === undefined ? null : lengthOf(d[2]);
        fields.push({ name: d[1]!, type: f[1]!, length });
      }
    }
    structs.set(m[1]!, fields);
  }
  return structs;
}

/**
 * What a uniform of this type is made of, named as WebGL names it: the uniform itself, or for a struct (or an array of
 * them) each field of each element (`lights[1].color`), which are the uniforms `getActiveUniform` lists.
 */
function uniformLeaves(name: string, type: string, length: number | null, structs: Map<string, StructField[]>, depth = 0): Declaration[] {
  const fields = structs.get(type);
  if (fields === undefined || depth > 4) return [{ name, type, length: length ?? 1, location: null }];
  const elements = length === null ? [name] : Array.from({ length }, (_, i) => `${name}[${i}]`);
  return elements.flatMap((element) => fields.flatMap((f) => uniformLeaves(`${element}.${f.name}`, f.type, f.length, structs, depth + 1)));
}

/** The top-level `uniform`, `attribute` and `in` declarations of a shader. */
function declarations(source: string, keywords: string[]): Declaration[] {
  // What the conditionals leave out is not declared, as the renderer reads it.
  const { code, length: lengthOf } = preprocess(source);
  const structs = structsOf(code, lengthOf);
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
      const d = /^\s*(\w+)\s*(?:\[\s*(\w+)\s*\])?\s*$/.exec(declarator);
      if (d === null) continue;
      const length = d[2] === undefined ? 1 : lengthOf(d[2]);
      // A length that is not an integer expression of numbers and macros is left to the renderer, which refuses the program.
      if (length === null) continue;
      if (structs.has(m[3]!)) {
        out.push(...uniformLeaves(d[1]!, m[3]!, d[2] === undefined ? null : length, structs));
        continue;
      }
      out.push({ name: d[1]!, type: m[3]!, length, location: location ? Number(location[1]) : null, ...(d[2] === undefined ? {} : { array: true }) });
    }
  }
  return out;
}

/** The uniform blocks a shader declares (WebGL 2). */
function blocksOf(source: string): BlockInfo[] {
  const { code, length } = preprocess(source);
  return parseBlocks(code, length, structsOf(code, length));
}

/** The columns (and locations) of a `mat2`, `mat3` or `mat4` attribute, which is read a column at a time; undefined for other types. */
function matrixColumns(type: string): number | undefined {
  return ({ mat2: 2, mat3: 3, mat4: 4 } as Record<string, number | undefined>)[type];
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
  sampler3D: GL2.SAMPLER_3D,
  samplerCube: GL.SAMPLER_CUBE,
  sampler2DArray: GL2.SAMPLER_2D_ARRAY,
  uvec2: GL2.UNSIGNED_INT_VEC2,
  uvec3: GL2.UNSIGNED_INT_VEC3,
  uvec4: GL2.UNSIGNED_INT_VEC4,
  mat2x3: GL2.FLOAT_MAT2x3,
  mat2x4: GL2.FLOAT_MAT2x4,
  mat3x2: GL2.FLOAT_MAT3x2,
  mat3x4: GL2.FLOAT_MAT3x4,
  mat4x2: GL2.FLOAT_MAT4x2,
  mat4x3: GL2.FLOAT_MAT4x3,
  mat2x2: GL.FLOAT_MAT2,
  mat3x3: GL.FLOAT_MAT3,
  mat4x4: GL.FLOAT_MAT4,
  sampler2DShadow: GL2.SAMPLER_2D_SHADOW,
  sampler2DArrayShadow: GL2.SAMPLER_2D_ARRAY_SHADOW,
  samplerCubeShadow: GL2.SAMPLER_CUBE_SHADOW,
  isampler2D: GL2.INT_SAMPLER_2D,
  isampler3D: GL2.INT_SAMPLER_3D,
  isamplerCube: GL2.INT_SAMPLER_CUBE,
  isampler2DArray: GL2.INT_SAMPLER_2D_ARRAY,
  usampler2D: GL2.UNSIGNED_INT_SAMPLER_2D,
  usampler3D: GL2.UNSIGNED_INT_SAMPLER_3D,
  usamplerCube: GL2.UNSIGNED_INT_SAMPLER_CUBE,
  usampler2DArray: GL2.UNSIGNED_INT_SAMPLER_2D_ARRAY,
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
  /** Told what a recording leaves out where the engine does not draw it right (the frame reports it as unsupported). */
  report?: (what: string) => void;
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
const COLOR_RENDERBUFFER = new Set<number>([GL.RGBA4, GL.RGB5_A1, GL.RGB565, GL2.RGBA8, GL2.SRGB8_ALPHA8, GL2.R8, GL2.RG8, GL2.R16F, GL2.RG16F, GL2.RGBA16F, GL2.R32F, GL2.RG32F, GL2.RGBA32F]);

/** The value of an IEEE half float's bits. */
function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

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

/** `MAX_SAMPLES`: what a multisampled renderbuffer has, as the canvas with `antialias` does (Chrome on Apple GPUs). */
const MAX_SAMPLES = 4;

/** The largest point drawn (`ALIASED_POINT_SIZE_RANGE`): `gl_PointSize` is clamped to 1 to this (crates/core/src/glsl.rs, `MAX_POINT_SIZE`). */
const POINT_SIZE_MAX = 511;

/** The formats other than RGBA8 colour can be drawn into (floats with `EXT_color_buffer_float`, and sRGB), by the name the recording gives them. */
const COLOR_TARGETS: Record<number, NonNullable<GlslTexture['colorFormat']>> = {
  [GL2.R16F]: 'R16F',
  [GL2.RG16F]: 'RG16F',
  [GL2.RGBA16F]: 'RGBA16F',
  [GL2.R32F]: 'R32F',
  [GL2.RG32F]: 'RG32F',
  [GL2.RGBA32F]: 'RGBA32F',
  [GL2.SRGB8_ALPHA8]: 'SRGB8_ALPHA8',
  [GL2.R8]: 'R8',
  [GL2.RG8]: 'RG8',
};

/** Formats of a texture that colour cannot be drawn into. */
const NOT_RENDERABLE = new Set<number>([GL.ALPHA, GL.LUMINANCE, GL.LUMINANCE_ALPHA, GL.DEPTH_COMPONENT]);

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
  /** What the frames before drew into render targets (`webgl-carry.ts`); a frame's recording opens with what its ops read of it. */
  private carry = emptyCarry();
  /** The next draw or clear starts a fresh drawing buffer. */
  private stale = false;
  private error: number = GL.NO_ERROR;

  private program: WebGLProgram | null = null;
  private arrayBuffer: WebGLBuffer | null = null;
  /** `UNIFORM_BUFFER`'s generic binding, and the indexed ones the blocks read (`size` 0 is the whole buffer). */
  private uniformBuffer: WebGLBuffer | null = null;
  private readonly uniformBindings: ({ buffer: WebGLBuffer; offset: number; size: number } | null)[] = Array.from({ length: MAX_UNIFORM_BUFFER_BINDINGS }, () => null);
  private defaultVao = new WebGLVertexArrayObject();
  /** What `vertexAttrib*` set: the value each disabled attribute array reads (a context's, not a vertex array object's). */
  private readonly currentAttributes: [number, number, number, number][] = [];
  private vao: WebGLVertexArrayObject = this.defaultVao;
  /** What draws and clears go to, and what `readPixels` and blits would read (WebGL 2); null is the canvas. */
  private drawFramebuffer: WebGLFramebuffer | null = null;
  private readFramebuffer: WebGLFramebuffer | null = null;
  private activeUnit = 0;
  private readonly units = new Map<number, WebGLTexture>();
  /** What each unit holds at `TEXTURE_3D`. */
  private readonly units3d = new Map<number, WebGLTexture>();
  private readonly unitsArray = new Map<number, WebGLTexture>();
  /** What each unit holds at `TEXTURE_CUBE_MAP`. */
  private readonly unitsCube = new Map<number, WebGLTexture>();
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
  /** `getExtension('EXT_float_blend')` was called: draws may blend into 32-bit float targets, as in a browser. */
  private floatBlend = false;
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
  private readonly programs = new Map<string, GlslProgram>();
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
    const known = this.known();
    const { ops: carried, incomplete } = carriedFor(this.carry.ops, this.carry.lost, this.ops, known);
    for (const id of incomplete) {
      this.options.report?.(`a render target is drawn into by more than ${MAX_OPS_PER_TARGET} ops that each read what the frames before left (feedback), so its oldest are dropped and it is not what the page drew (${id})`);
    }
    const named = namedBy(carried, known.textures);
    return {
      premultipliedAlpha: this.attributes.premultipliedAlpha,
      alpha: this.attributes.alpha,
      ...(this.attributes.depth ? {} : { depth: false }),
      ...(this.attributes.stencil ? { stencil: true } : {}),
      ...(this.attributes.antialias ? { antialias: true } : {}),
      programs: Object.fromEntries(new Map([...pick(named.programs, this.carry.programs), ...this.programs])),
      buffers: Object.fromEntries(new Map([...pick(named.buffers, this.carry.buffers), ...this.buffers])),
      textures: Object.fromEntries(new Map([...pick(named.textures, this.carry.textures), ...this.textures])),
      ops: carried.length === 0 ? this.ops : [...carried, ...this.ops],
    };
  }

  /** What the carried ops and this frame's name, the frame's own entries over the carried ones. */
  private known(): Resources {
    return {
      programs: new Map([...this.carry.programs, ...this.programs]),
      buffers: new Map([...this.carry.buffers, ...this.buffers]),
      textures: new Map([...this.carry.textures, ...this.textures]),
    };
  }

  /**
   * Whether this frame depends on the frames before it (`webgl-carry.ts`): it makes a render target from what it held
   * (a trail), reads one before covering it that it writes later, or reads one the frame before it wrote.
   */
  get dependsOnHistory(): boolean {
    const known = this.known();
    return dependsOnHistory(this.ops, known) || readsLastFrame(this.carry, this.ops, known);
  }

  /** Whether render targets hold what was drawn into them (carried, or drawn this frame). */
  get holdsTargets(): boolean {
    return this.carry.ops.length > 0 || this.ops.some((op) => !isCanvasOp(op));
  }

  /**
   * The state a frame's recording is made from, to put back with the function it returns. The frame loop takes it
   * before it renders the sub-frames of a motion blur and puts it back after them: what a sub-frame draws is its own,
   * and the frame after the frame is the same whether or not the sub-frames were rendered.
   */
  snapshot(): () => void {
    const { carry, ops, stale } = this;
    const [programs, buffers, textures] = [new Map(this.programs), new Map(this.buffers), new Map(this.textures)];
    return () => {
      this.carry = carry;
      this.ops = ops;
      this.stale = stale;
      for (const [held, kept] of [[this.programs, programs], [this.buffers, buffers], [this.textures, textures]] as const) {
        held.clear();
        for (const [id, value] of kept as Map<string, unknown>) (held as Map<string, unknown>).set(id, value);
      }
    };
  }

  /** Whether anything was drawn or cleared. */
  get drawn(): boolean {
    return this.ops.length > 0;
  }

  /**
   * The frame loop calls this before each frame: the drawing buffer is emptied, so a frame is what its own draws
   * make, whichever frame was rendered before. It holds with `preserveDrawingBuffer` too, which in a page keeps the
   * picture from one presented frame to the next; here each frame is a new context's first. A frame that draws
   * nothing draws nothing. What was drawn into render targets stays: it is what a texture holds, and a page that drew
   * a texture once (an environment map prefiltered when the scene was built) reads it in every frame. A target a
   * frame reads before it overwrites it then depends on the frames before that one (`webgl-carry.ts`).
   */
  resetState(): void {
    this.keepTargets();
    this.stale = true;
    this.ops = [];
  }

  /** Carries the render-target ops of the frame that ends, with the programs, buffers and textures they name. */
  private keepTargets(): void {
    if (this.ops.length === 0) {
      this.carry = { ...this.carry, last: new Set() };
      return;
    }
    const known = this.known();
    const { ops, lost, last } = carryOn(this.carry.ops, this.ops, known);
    const named = namedBy(ops, known.textures);
    this.carry = {
      ops,
      programs: pick(named.programs, this.programs, this.carry.programs),
      buffers: pick(named.buffers, this.buffers, this.carry.buffers),
      textures: pick(named.textures, this.textures, this.carry.textures),
      lost: new Set([...this.carry.lost, ...lost]),
      last,
    };
  }

  /** Empties the drawing buffer (`canvas.width` was set). */
  reset(): void {
    // Framebuffer objects, and what was drawn into their textures, outlive a resize.
    this.keepTargets();
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
    return this.version === 1 ? ['OES_standard_derivatives', 'WEBGL_depth_texture'] : ['OES_standard_derivatives', 'EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_float_blend'];
  }
  getExtension(name: string): object | null {
    // Derivatives are always available in the translated shaders, and depth textures (core in WebGL 2) in the replay.
    if (name === 'OES_standard_derivatives') return { FRAGMENT_SHADER_DERIVATIVE_HINT_OES: 0x8b8b };
    if (name === 'EXT_color_buffer_float' && this.version === 2) return {};
    // WebGL 2 draws into 16-bit floats with either extension; blending into 32-bit ones needs EXT_float_blend enabled.
    if (name === 'EXT_color_buffer_half_float' && this.version === 2) return { RGBA16F_EXT: 0x881a, RGB16F_EXT: 0x881b, FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT: 0x8211, UNSIGNED_NORMALIZED_EXT: 0x8c17 };
    if (name === 'EXT_float_blend' && this.version === 2) {
      this.floatBlend = true;
      return {};
    }
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
      case GL.MAX_RENDERBUFFER_SIZE:
        return 8192;
      case GL.SUBPIXEL_BITS:
        return 4;
      case GL.MAX_VIEWPORT_DIMS:
        return new Int32Array([8192, 8192]);
      case GL.MAX_VERTEX_ATTRIBS:
        return MAX_VERTEX_ATTRIBS;
      case GL.MAX_VERTEX_UNIFORM_VECTORS:
      case GL.MAX_FRAGMENT_UNIFORM_VECTORS:
        return 256;
      case GL.MAX_VARYING_VECTORS:
        return 15;
      case GL.MAX_TEXTURE_IMAGE_UNITS:
      case GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS:
        return 16;
      case GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS:
        return 16;
      case GL2.MAX_3D_TEXTURE_SIZE:
        if (this.version === 2) return MAX_3D_TEXTURE_SIZE;
        this.fail(GL.INVALID_ENUM);
        return null;
      case GL.ALIASED_POINT_SIZE_RANGE:
        return new Float32Array([1, POINT_SIZE_MAX]);
      case GL.ALIASED_LINE_WIDTH_RANGE:
        return new Float32Array([1, 1]);
      case GL.VIEWPORT:
        return new Int32Array(this.viewportNow());
      case GL.SCISSOR_BOX:
        return new Int32Array(this.scissorNow());
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
      case GL2.UNIFORM_BUFFER_BINDING:
      case GL2.MAX_UNIFORM_BUFFER_BINDINGS:
      case GL2.MAX_UNIFORM_BLOCK_SIZE:
      case GL2.UNIFORM_BUFFER_OFFSET_ALIGNMENT:
      case GL2.MAX_VERTEX_UNIFORM_BLOCKS:
      case GL2.MAX_FRAGMENT_UNIFORM_BLOCKS:
      case GL2.MAX_COMBINED_UNIFORM_BLOCKS:
        if (this.version !== 2) {
          this.fail(GL.INVALID_ENUM);
          return null;
        }
        return pname === GL2.UNIFORM_BUFFER_BINDING ? this.uniformBuffer : UNIFORM_BUFFER_LIMITS[pname]!;
      case GL2.VERTEX_ARRAY_BINDING:
        if (this.version === 2) return this.vao === this.defaultVao ? null : this.vao;
        this.fail(GL.INVALID_ENUM);
        return null;
      case GL.TEXTURE_BINDING_2D:
        return this.units.get(this.activeUnit) ?? null;
      case GL.TEXTURE_BINDING_CUBE_MAP:
        return this.unitsCube.get(this.activeUnit) ?? null;
      case GL.MAX_CUBE_MAP_TEXTURE_SIZE:
        return MAX_CUBE_MAP_TEXTURE_SIZE;
      case GL2.TEXTURE_BINDING_3D:
        if (this.version === 2) return this.units3d.get(this.activeUnit) ?? null;
        this.fail(GL.INVALID_ENUM);
        return null;
      case GL2.TEXTURE_BINDING_2D_ARRAY:
        if (this.version === 2) return this.unitsArray.get(this.activeUnit) ?? null;
        this.fail(GL.INVALID_ENUM);
        return null;
      case GL2.MAX_ARRAY_TEXTURE_LAYERS:
        if (this.version === 2) return MAX_ARRAY_TEXTURE_LAYERS;
        this.fail(GL.INVALID_ENUM);
        return null;
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
      case GL2.MAX_SAMPLES:
        if (this.version === 2) return MAX_SAMPLES;
        this.fail(GL.INVALID_ENUM);
        return null;
      case GL.SAMPLES:
        return this.samplesOf(this.drawFramebuffer);
      case GL.SAMPLE_BUFFERS:
        return this.samplesOf(this.drawFramebuffer) > 0 ? 1 : 0;
      default:
        if (this.version === 2 && FIXED_LIMITS[pname] !== undefined) return FIXED_LIMITS[pname];
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

  /** `copyTexImage2D`: the texture level specified empty, of the size copied, then `copyTexSubImage2D` into it. */
  copyTexImage2D(target: number, level: number, internalformat: number, x: number, y: number, width: number, height: number, border: number): void {
    if (border !== 0) return this.fail(GL.INVALID_VALUE);
    if (internalformat !== GL.RGBA && internalformat !== GL2.RGBA8 && internalformat !== GL2.SRGB8_ALPHA8) throw new WebGLUnsupportedError(`copyTexImage2D of the internal format 0x${internalformat.toString(16)}; use RGBA`);
    const before = this.error;
    this.texImage2D(target, level, internalformat, width, height, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    if (this.error !== before) return;
    this.copyTexSubImage2D(target, level, 0, 0, x, y, width, height);
  }

  /**
   * `copyTexSubImage2D`: a rectangle of the read framebuffer's read buffer (the canvas's picture without one) copied
   * into a level of the bound texture at `xoffset`, `yoffset`. It is a NEAREST blit into the texture, which is a
   * render target from then on, so it lands in order with the draws.
   */
  copyTexSubImage2D(target: number, level: number, xoffset: number, yoffset: number, x: number, y: number, width: number, height: number): void {
    const face = faceIndex(target) >= 0;
    if (!face && target !== GL.TEXTURE_2D) return this.fail(GL.INVALID_ENUM);
    const texture = face ? this.faceTarget(target) : this.bound(target);
    if (texture === null) return;
    const [w, h] = [Math.max(1, texture.width >> level), Math.max(1, texture.height >> level)];
    if (!texture.uploaded || !(level >= 0 && level < texture.levels)) return this.fail(GL.INVALID_OPERATION);
    if (!(width >= 0 && height >= 0 && xoffset >= 0 && yoffset >= 0 && xoffset + width <= w && yoffset + height <= h)) return this.fail(GL.INVALID_VALUE);
    const read = this.readFramebuffer;
    if (read !== null && this.statusOf(read) !== GL.FRAMEBUFFER_COMPLETE) return this.fail(GL.INVALID_FRAMEBUFFER_OPERATION);
    // A multisampled framebuffer is not read by a copy (the canvas is resolved first).
    if (read !== null && this.samplesOf(read) > 0) return this.fail(GL.INVALID_OPERATION);
    const source = read === null ? 'canvas' : read.readBuffer === GL.NONE ? null : (read.colors[read.readBuffer - GL.COLOR_ATTACHMENT0] ?? null);
    if (source === null) return this.fail(GL.INVALID_OPERATION);
    if (source !== 'canvas' && 'texture' in source) {
      // Reading the level it writes is a feedback loop.
      if (source.texture === texture && source.level === level) return this.fail(GL.INVALID_OPERATION);
      if (!source.texture.blank && source.texture.drawnAt !== source.texture.version) throw new WebGLUnsupportedError('copyTexSubImage2D from a texture that holds uploaded pixels; draw into it, or sample it');
    }
    if (kindOf(texture.format) !== 'color' || (texture.format !== GL.RGBA && texture.format !== GL2.RGBA8 && COLOR_TARGETS[texture.format] === undefined)) {
      throw new WebGLUnsupportedError(`copyTexSubImage2D into a texture of internal format 0x${texture.format.toString(16)}; allocate it as RGBA`);
    }
    if (!texture.blank && texture.drawnAt !== texture.version) throw new WebGLUnsupportedError('copyTexSubImage2D into a texture that holds uploaded pixels; allocate it with texImage2D(..., null)');
    if (width === 0 || height === 0) return;
    this.begin();
    const src = source === 'canvas' ? {} : { src: this.attachmentId(source), ...('texture' in source && source.level > 0 ? { srcLevel: source.level } : {}) };
    texture.drawnAt = texture.version;
    const into = this.registerTarget(texture);
    this.ops.push({ op: 'blit', ...src, target: into, ...(level > 0 ? { level } : {}), from: [x, y, x + width, y + height], to: [xoffset, yoffset, xoffset + width, yoffset + height] });
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
    // Nothing is blitted into a multisampled buffer (the canvas with `antialias`, or a multisampled renderbuffer), and
    // one is read only into a rectangle of its own bounds, as in a browser.
    if (this.samplesOf(draw) > 0) return this.fail(GL.INVALID_OPERATION);
    if (this.samplesOf(read) > 0 && (fx0 !== tx0 || fy0 !== ty0 || fx1 !== tx1 || fy1 !== ty1)) return this.fail(GL.INVALID_OPERATION);
    const geometry = {
      from: [fx0!, fy0!, fx1!, fy1!] as [number, number, number, number],
      to: [tx0!, ty0!, tx1!, ty1!] as [number, number, number, number],
      ...(this.caps.scissor ? { scissor: this.scissorNow() } : {}),
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
  /** Lines are one pixel wide, which is the whole of `ALIASED_LINE_WIDTH_RANGE`, as on most browsers' GPUs. */
  lineWidth(width: number): void {
    if (!(width > 0)) this.fail(GL.INVALID_VALUE);
  }
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
    if (color && this.colorMaskState.some((on) => !on)) throw new WebGLUnsupportedError('clear with a colour mask');
    if (stencil && stencilMask !== STENCIL_MAX) throw new WebGLUnsupportedError('clearing the stencil buffer through a stencilMask other than 0 or 0xff');
    if (this.framebufferIncomplete()) return;
    const values = {
      ...(color ? { color: [...this.clearColorValue] as [number, number, number, number] } : {}),
      ...(depth ? { depth: this.clearDepthValue } : {}),
      ...(stencil ? { stencil: this.clearStencilValue & STENCIL_MAX } : {}),
    };
    if (this.caps.scissor) this.pushScissoredClear(values);
    else this.pushClear(values, color);
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
      if (this.colorMaskState.some((on) => !on)) throw new WebGLUnsupportedError('clear with a colour mask');
      if (this.framebufferIncomplete()) return;
      const framebuffer = this.drawFramebuffer;
      const output = framebuffer === null ? (drawbuffer === 0 ? 'canvas' : null) : (this.outputsOf(framebuffer)[drawbuffer] ?? null);
      if (output === null) return;
      const color = values.slice(0, 4).map((v) => Math.min(1, Math.max(0, v))) as [number, number, number, number];
      if (this.caps.scissor) {
        // The attachment alone, at its output's place among the draw buffers.
        const outputs = framebuffer === null ? undefined : Array.from({ length: drawbuffer + 1 }, (_, i) => (i === drawbuffer ? (output as WebGLAttachment) : null));
        this.pushScissoredClear({ color }, outputs);
        return;
      }
      this.pushClear({ color }, true, output === 'canvas' ? undefined : [output]);
      return;
    }
    if (drawbuffer !== 0 || values.length < 1) return this.fail(GL.INVALID_VALUE);
    if (buffer !== GL2.DEPTH && buffer !== GL2.STENCIL) return this.fail(GL.INVALID_ENUM);
    const depth = buffer === GL2.DEPTH && this.hasDepth() && this.depthMaskValue;
    const stencilMask = this.stencilFront.writeMask & STENCIL_MAX;
    const stencil = buffer === GL2.STENCIL && this.hasStencil() && stencilMask !== 0;
    if (!depth && !stencil) return;
    if (stencil && stencilMask !== STENCIL_MAX) throw new WebGLUnsupportedError('clearing the stencil buffer through a stencilMask other than 0 or 0xff');
    if (this.framebufferIncomplete()) return;
    const value = depth ? { depth: Math.min(1, Math.max(0, values[0]!)) } : { stencil: Math.trunc(values[0]!) & STENCIL_MAX };
    if (this.caps.scissor) this.pushScissoredClear(value);
    else this.pushClear(value, false, []);
  }

  /** The scissor box: what `scissor` set, else the drawing buffer (not the viewport). */
  private scissorNow(): [number, number, number, number] {
    return this.scissorBox ?? [0, 0, this.drawingBufferWidth, this.drawingBufferHeight];
  }

  /** The size of what the bound draw framebuffer draws in (the drawing buffer for the canvas). */
  private drawSize(): [number, number] {
    const framebuffer = this.drawFramebuffer;
    if (framebuffer === null) return [this.drawingBufferWidth, this.drawingBufferHeight];
    const first = [...this.outputsOf(framebuffer), WebGLContext.depthStencilOf(framebuffer)].find((a): a is WebGLAttachment => a !== null);
    const image = this.imageOf(first!);
    return [image.width, image.height];
  }

  /**
   * A clear with the scissor test on: the box alone is cleared, and the rest of the buffers keep what they hold. A
   * render pass can only clear all of an attachment, so it is recorded as the draw of a quad over the box (clipped to
   * the buffer) that writes the clear values: the colour as the fragment colour, the depth as the quad's depth under
   * an ALWAYS test, the stencil by REPLACE under an ALWAYS test. Blending, culling and the other tests do not apply
   * to a clear, and the draw has none.
   */
  private pushScissoredClear(values: { color?: [number, number, number, number]; depth?: number; stencil?: number }, outputs?: (WebGLAttachment | null)[]): void {
    this.begin();
    const [bufferWidth, bufferHeight] = this.drawSize();
    const [sx, sy, sw, sh] = this.scissorNow();
    const x0 = Math.max(0, sx);
    const y0 = Math.max(0, sy);
    const x1 = Math.min(bufferWidth, sx + sw);
    const y1 = Math.min(bufferHeight, sy + sh);
    if (x1 <= x0 || y1 <= y0) return;
    const framebuffer = this.drawFramebuffer;
    const color = values.color !== undefined;
    // One fragment output for each colour attachment that is cleared.
    const list = outputs ?? (framebuffer === null ? [null] : this.outputsOf(framebuffer));
    const slots = color ? (framebuffer === null && outputs === undefined ? [0] : list.flatMap((a, i) => (a === null ? [] : [i]))) : [];
    const where = this.dest(values.depth !== undefined || values.stencil !== undefined, color ? outputs : []);
    if (where === null) return;
    const vertex = '#version 300 es\nin vec2 a_position;\nuniform float u_depth;\nvoid main() { gl_Position = vec4(a_position, u_depth, 1.0); }\n';
    const fragment = `#version 300 es\nprecision highp float;\nuniform vec4 u_color;\n${slots.map((i) => `layout(location = ${i}) out vec4 o${i};`).join('\n')}\nvoid main() { ${slots.map((i) => `o${i} = u_color;`).join(' ')} }\n`;
    const attributes = { a_position: 0 };
    const programId = `p${hashOf(JSON.stringify([vertex, fragment, attributes]))}`;
    if (!this.programs.has(programId)) this.programs.set(programId, { vertex, fragment, attributes });
    const quad = toBase64(new Uint8Array(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]).buffer));
    const buffer = `b${hashOf(quad)}`;
    if (!this.buffers.has(buffer)) this.buffers.set(buffer, quad);
    const box: [number, number, number, number] = [x0, y0, x1 - x0, y1 - y0];
    const face: GlslStencilFace = { func: 'ALWAYS', fail: 'REPLACE', zfail: 'REPLACE', zpass: 'REPLACE' };
    const draw: GlslDraw = {
      program: programId,
      mode: 'triangleStrip',
      first: 0,
      count: 4,
      attributes: { a_position: { buffer, size: 2, type: 'f32' } },
      uniforms: {
        u_color: [{ kind: 'f', value: values.color ?? [0, 0, 0, 0] }],
        u_depth: [{ kind: 'f', value: [(values.depth ?? 0.5) * 2 - 1] }],
      },
      units: {},
      // The quad fills the viewport, which is the box.
      viewport: box,
      scissor: box,
      colorMask: [color, color, color, color],
      ...(values.depth !== undefined ? { depth: { func: 'ALWAYS', mask: true, near: 0, far: 1 } } : {}),
      ...(values.stencil !== undefined ? { stencil: { ref: values.stencil, valueMask: STENCIL_MAX, writeMask: STENCIL_MAX, front: face, back: face } } : {}),
    };
    this.ops.push({ op: 'draw', ...draw, ...where });
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
    program.blocks = [];
    program.blockBindings = [];
    program.linkLog = '';
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
    this.linkBlocks(program);
    // Explicit locations and `bindAttribLocation` first; the rest take the lowest free locations in order.
    const taken = new Set<number>();
    const take = (at: number, width: number) => {
      for (let i = 0; i < width; i += 1) taken.add(at + i);
    };
    for (const d of program.attributeDeclarations) {
      const at = d.location ?? program.bound.get(d.name);
      if (at !== undefined) {
        program.attributes.set(d.name, at);
        take(at, matrixColumns(d.type) ?? 1);
      }
    }
    let next = 0;
    for (const d of program.attributeDeclarations) {
      if (program.attributes.has(d.name)) continue;
      const width = matrixColumns(d.type) ?? 1;
      // A matrix takes consecutive locations, one for each column.
      while (Array.from({ length: width }, (_, i) => next + i).some((l) => taken.has(l))) next += 1;
      program.attributes.set(d.name, next);
      take(next, width);
    }
  }
  /** The program's uniform blocks, in GL's order: the vertex shader's, then the fragment shader's that it does not declare. */
  private linkBlocks(program: WebGLProgram): void {
    if (this.version !== 2) return;
    for (const [source, stage] of [[program.vertex, 'vertex'], [program.fragment, 'fragment']] as const) {
      for (const b of blocksOf(source)) {
        const held = program.blocks.find((h) => h.name === b.name);
        if (held === undefined) program.blocks.push({ ...b, vertex: stage === 'vertex', fragment: stage === 'fragment' });
        else if (held.named !== b.named || JSON.stringify(held.members) !== JSON.stringify(b.members)) {
          program.linked = false;
          program.linkLog = `uniform block '${b.name}' is declared differently in the vertex and fragment shaders`;
        } else held[stage] = true;
      }
    }
    program.blockBindings = program.blocks.map(() => 0);
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
        return program.uniformDeclarations.length + this.blockUniforms(program).length;
      case GL2.ACTIVE_UNIFORM_BLOCKS:
        if (this.version === 2) return program.blocks.length;
        this.fail(GL.INVALID_ENUM);
        return null;
      default:
        this.fail(GL.INVALID_ENUM);
        return null;
    }
  }
  getProgramInfoLog(program: WebGLProgram): string {
    return program.linked ? '' : program.linkLog || 'a program needs a vertex shader and a fragment shader, both with source';
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
    if (d !== undefined) return new WebGLActiveInfo(d.length > 1 || d.array ? `${d.name}[0]` : d.name, d.length, TYPE_CODES[d.type] ?? 0);
    const u = this.blockUniforms(program)[index - program.uniformDeclarations.length];
    return u === undefined ? null : new WebGLActiveInfo(u.name, u.length, TYPE_CODES[u.type] ?? 0);
  }

  // ---- uniform blocks (WebGL 2) ----
  //
  // A uniform is listed after the loose uniforms: the block's uniforms in the order the blocks and their members are
  // declared. A block is read from the buffer bound at its binding point, laid out as std140 (`webgl-blocks.ts`); every
  // block a shader declares is active, as in a browser's.

  /** The uniforms the blocks hold, with the index of the block of each. */
  private blockUniforms(program: WebGLProgram): (BlockUniform & { block: number })[] {
    return program.blocks.flatMap((b, block) => b.uniforms.map((u) => ({ ...u, block })));
  }
  getUniformBlockIndex(program: WebGLProgram, name: string): number {
    const at = program.blocks.findIndex((b) => b.name === name);
    return at < 0 ? GL2.INVALID_INDEX : at;
  }
  getActiveUniformBlockName(program: WebGLProgram, index: number): string | null {
    const block = program.blocks[index];
    if (block === undefined) {
      this.fail(GL.INVALID_VALUE);
      return null;
    }
    return block.name;
  }
  getActiveUniformBlockParameter(program: WebGLProgram, index: number, pname: number): unknown {
    const block = program.blocks[index];
    if (block === undefined) {
      this.fail(GL.INVALID_VALUE);
      return null;
    }
    switch (pname) {
      case GL2.UNIFORM_BLOCK_BINDING:
        return program.blockBindings[index];
      case GL2.UNIFORM_BLOCK_DATA_SIZE:
        return block.size;
      case GL2.UNIFORM_BLOCK_ACTIVE_UNIFORMS:
        return block.uniforms.length;
      case GL2.UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES: {
        const first = program.uniformDeclarations.length + program.blocks.slice(0, index).reduce((n, b) => n + b.uniforms.length, 0);
        return new Uint32Array(block.uniforms.map((_, i) => first + i));
      }
      case GL2.UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER:
        return block.vertex;
      case GL2.UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER:
        return block.fragment;
      default:
        this.fail(GL.INVALID_ENUM);
        return null;
    }
  }
  uniformBlockBinding(program: WebGLProgram, index: number, binding: number): void {
    if (!(index >= 0 && index < program.blocks.length) || !(binding >= 0 && binding < MAX_UNIFORM_BUFFER_BINDINGS)) return this.fail(GL.INVALID_VALUE);
    program.blockBindings[index] = binding;
  }
  /** The index of each uniform name, a name or the first element of an array (`Block.member`), or `INVALID_INDEX`. */
  getUniformIndices(program: WebGLProgram, names: string[]): number[] {
    const listed = [...program.uniformDeclarations.map((d) => (d.length > 1 || d.array ? `${d.name}[0]` : d.name)), ...this.blockUniforms(program).map((u) => u.name)];
    return names.map((name) => {
      const at = listed.findIndex((n) => n === name || n === `${name}[0]`);
      return at < 0 ? GL2.INVALID_INDEX : at;
    });
  }
  getActiveUniforms(program: WebGLProgram, indices: number[], pname: number): number[] | boolean[] | null {
    const loose = program.uniformDeclarations.length;
    const blockUniforms = this.blockUniforms(program);
    const kinds = [GL2.UNIFORM_TYPE, GL2.UNIFORM_SIZE, GL2.UNIFORM_BLOCK_INDEX, GL2.UNIFORM_OFFSET, GL2.UNIFORM_ARRAY_STRIDE, GL2.UNIFORM_MATRIX_STRIDE, GL2.UNIFORM_IS_ROW_MAJOR];
    if (!(kinds as number[]).includes(pname)) {
      this.fail(GL.INVALID_ENUM);
      return null;
    }
    const list = Array.from(indices);
    if (list.some((i) => !(i >= 0 && i < loose + blockUniforms.length))) {
      this.fail(GL.INVALID_VALUE);
      return null;
    }
    if (pname === GL2.UNIFORM_IS_ROW_MAJOR) return list.map(() => false);
    return list.map((i) => {
      const d = program.uniformDeclarations[i];
      const u = d === undefined ? blockUniforms[i - loose]! : undefined;
      switch (pname) {
        case GL2.UNIFORM_TYPE:
          return TYPE_CODES[(d ?? u!).type] ?? 0;
        case GL2.UNIFORM_SIZE:
          return (d ?? u!).length;
        case GL2.UNIFORM_BLOCK_INDEX:
          return u?.block ?? -1;
        case GL2.UNIFORM_OFFSET:
          return u?.offset ?? -1;
        case GL2.UNIFORM_ARRAY_STRIDE:
          return u?.arrayStride ?? -1;
        default:
          return u?.matrixStride ?? -1;
      }
    });
  }

  getUniformLocation(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    // A struct field is named in full (`lights[1].color`); an array element is the array and an index.
    const whole = program.uniformDeclarations.find((u) => u.name === name);
    if (whole !== undefined) return new WebGLUniformLocation(program, whole.name, 0, whole.type);
    const m = /^([\w.[\]]+?)(?:\[(\d+)\])$/.exec(name);
    if (m === null) return null;
    const d = program.uniformDeclarations.find((u) => u.name === m[1]);
    if (d === undefined) return null;
    const index = Number(m[2]);
    if (index >= d.length) return null;
    return new WebGLUniformLocation(program, d.name, index, d.type);
  }

  // ---- uniforms ----

  private setUniform(location: WebGLUniformLocation | null | undefined, kind: 'f' | 'i' | 'm', value: ArrayLike<number>, components: number): void {
    // WebGL ignores a null location, and a library hands in undefined for a uniform the program lacks.
    if (location === null || location === undefined) return;
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
  uniform1f(l: WebGLUniformLocation | null | undefined, x: number): void {
    this.setUniform(l, 'f', [x], 1);
  }
  uniform2f(l: WebGLUniformLocation | null | undefined, x: number, y: number): void {
    this.setUniform(l, 'f', [x, y], 2);
  }
  uniform3f(l: WebGLUniformLocation | null | undefined, x: number, y: number, z: number): void {
    this.setUniform(l, 'f', [x, y, z], 3);
  }
  uniform4f(l: WebGLUniformLocation | null | undefined, x: number, y: number, z: number, w: number): void {
    this.setUniform(l, 'f', [x, y, z, w], 4);
  }
  uniform1i(l: WebGLUniformLocation | null | undefined, x: number): void {
    this.setUniform(l, 'i', [x], 1);
  }
  uniform2i(l: WebGLUniformLocation | null | undefined, x: number, y: number): void {
    this.setUniform(l, 'i', [x, y], 2);
  }
  uniform3i(l: WebGLUniformLocation | null | undefined, x: number, y: number, z: number): void {
    this.setUniform(l, 'i', [x, y, z], 3);
  }
  uniform4i(l: WebGLUniformLocation | null | undefined, x: number, y: number, z: number, w: number): void {
    this.setUniform(l, 'i', [x, y, z, w], 4);
  }
  uniform1ui(l: WebGLUniformLocation | null | undefined, x: number): void {
    this.setUniform(l, 'i', [x], 1);
  }
  uniform2ui(l: WebGLUniformLocation | null | undefined, x: number, y: number): void {
    this.setUniform(l, 'i', [x, y], 2);
  }
  uniform3ui(l: WebGLUniformLocation | null | undefined, x: number, y: number, z: number): void {
    this.setUniform(l, 'i', [x, y, z], 3);
  }
  uniform4ui(l: WebGLUniformLocation | null | undefined, x: number, y: number, z: number, w: number): void {
    this.setUniform(l, 'i', [x, y, z, w], 4);
  }
  uniform1fv(l: WebGLUniformLocation | null | undefined, v: ArrayLike<number>): void {
    this.setUniform(l, 'f', v, 1);
  }
  uniform2fv(l: WebGLUniformLocation | null | undefined, v: ArrayLike<number>): void {
    this.setUniform(l, 'f', v, 2);
  }
  uniform3fv(l: WebGLUniformLocation | null | undefined, v: ArrayLike<number>): void {
    this.setUniform(l, 'f', v, 3);
  }
  uniform4fv(l: WebGLUniformLocation | null | undefined, v: ArrayLike<number>): void {
    this.setUniform(l, 'f', v, 4);
  }
  uniform1iv(l: WebGLUniformLocation | null | undefined, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 1);
  }
  uniform2iv(l: WebGLUniformLocation | null | undefined, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 2);
  }
  uniform3iv(l: WebGLUniformLocation | null | undefined, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 3);
  }
  uniform4iv(l: WebGLUniformLocation | null | undefined, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 4);
  }
  uniform1uiv(l: WebGLUniformLocation | null | undefined, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 1);
  }
  uniform2uiv(l: WebGLUniformLocation | null | undefined, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 2);
  }
  uniform3uiv(l: WebGLUniformLocation | null | undefined, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 3);
  }
  uniform4uiv(l: WebGLUniformLocation | null | undefined, v: ArrayLike<number>): void {
    this.setUniform(l, 'i', v, 4);
  }
  uniformMatrix2fv(l: WebGLUniformLocation | null | undefined, transpose: boolean, v: ArrayLike<number>): void {
    this.setUniform(l, 'm', this.matrixValue(transpose, v, 2), 4);
  }
  uniformMatrix3fv(l: WebGLUniformLocation | null | undefined, transpose: boolean, v: ArrayLike<number>): void {
    this.setUniform(l, 'm', this.matrixValue(transpose, v, 3), 9);
  }
  uniformMatrix4fv(l: WebGLUniformLocation | null | undefined, transpose: boolean, v: ArrayLike<number>): void {
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
  setUniformCall(location: WebGLUniformLocation | null | undefined, kind: 'f' | 'i' | 'm', value: ArrayLike<number>): void {
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
    if (buffer === null) return;
    buffer.deleted = true;
    if (this.uniformBuffer === buffer) this.uniformBuffer = null;
    this.uniformBindings.forEach((b, i) => {
      if (b?.buffer === buffer) this.uniformBindings[i] = null;
    });
  }
  isBuffer(buffer: unknown): boolean {
    return buffer instanceof WebGLBuffer && !buffer.deleted;
  }
  bindBuffer(target: number, buffer: WebGLBuffer | null): void {
    if (target === GL.ARRAY_BUFFER) this.arrayBuffer = buffer;
    else if (target === GL.ELEMENT_ARRAY_BUFFER) this.vao.element = buffer;
    else if (this.version === 2 && target === GL2.UNIFORM_BUFFER) this.uniformBuffer = buffer;
    else if (this.version === 2 && (target === GL2.PIXEL_UNPACK_BUFFER || target === GL2.PIXEL_PACK_BUFFER)) {
      if (buffer !== null) throw new WebGLUnsupportedError('a pixel buffer object; upload textures from arrays or images');
    } else this.fail(GL.INVALID_ENUM);
  }
  /** `bindBufferBase`: a uniform buffer (WebGL 2) bound whole at an index, and as the generic binding. */
  bindBufferBase(target: number, index: number, buffer: WebGLBuffer | null): void {
    this.bindIndexed(target, index, buffer, 0, 0);
  }
  /** `bindBufferRange`: `size` bytes from `offset`, which is a multiple of `UNIFORM_BUFFER_OFFSET_ALIGNMENT`. */
  bindBufferRange(target: number, index: number, buffer: WebGLBuffer | null, offset: number, size: number): void {
    if (buffer !== null && this.version === 2 && target === GL2.UNIFORM_BUFFER && (!(size > 0) || !(offset >= 0) || offset % UNIFORM_BUFFER_OFFSET_ALIGNMENT !== 0)) return this.fail(GL.INVALID_VALUE);
    this.bindIndexed(target, index, buffer, offset, size);
  }
  private bindIndexed(target: number, index: number, buffer: WebGLBuffer | null, offset: number, size: number): void {
    if (this.version === 2 && target === GL2.TRANSFORM_FEEDBACK_BUFFER) throw new WebGLUnsupportedError('transform feedback buffers; compute the values in the vertex shader or in your own code');
    if (this.version !== 2 || target !== GL2.UNIFORM_BUFFER) return this.fail(GL.INVALID_ENUM);
    if (!(index >= 0 && index < MAX_UNIFORM_BUFFER_BINDINGS)) return this.fail(GL.INVALID_VALUE);
    if (buffer?.deleted) return this.fail(GL.INVALID_OPERATION);
    this.uniformBuffer = buffer;
    this.uniformBindings[index] = buffer === null ? null : { buffer, offset, size };
  }
  /** The buffer and range bound at an index of `UNIFORM_BUFFER` (`getIndexedParameter`). */
  getIndexedParameter(target: number, index: number): WebGLBuffer | number | null {
    const bound = this.uniformBindings[index];
    if (this.version !== 2 || (target !== GL2.UNIFORM_BUFFER_BINDING && target !== GL2.UNIFORM_BUFFER_START && target !== GL2.UNIFORM_BUFFER_SIZE)) {
      this.fail(GL.INVALID_ENUM);
      return null;
    }
    if (!(index >= 0 && index < MAX_UNIFORM_BUFFER_BINDINGS)) {
      this.fail(GL.INVALID_VALUE);
      return null;
    }
    if (target === GL2.UNIFORM_BUFFER_BINDING) return bound?.buffer ?? null;
    return (target === GL2.UNIFORM_BUFFER_START ? bound?.offset : bound?.size) ?? 0;
  }
  private target(target: number): WebGLBuffer | null {
    if (target === GL.ARRAY_BUFFER) return this.arrayBuffer;
    if (target === GL.ELEMENT_ARRAY_BUFFER) return this.vao.element;
    if (this.version === 2 && target === GL2.UNIFORM_BUFFER) return this.uniformBuffer;
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
    if (!(index >= 0 && index < MAX_VERTEX_ATTRIBS)) {
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
    Object.assign(a, { buffer: this.arrayBuffer, integer: false, size, type, normalized: Boolean(normalized), stride, offset });
  }
  /** WebGL 2's `vertexAttribPointer` for integer inputs (`ivecN`, `uvecN`): the values reach the shader as they are. */
  vertexAttribIPointer(index: number, size: number, type: number, stride: number, offset: number): void {
    const a = this.attribute(index);
    if (a === null) return;
    if (![GL.BYTE, GL.UNSIGNED_BYTE, GL.SHORT, GL.UNSIGNED_SHORT, GL.INT, GL.UNSIGNED_INT].includes(type as never)) return this.fail(GL.INVALID_ENUM);
    if (!(size >= 1 && size <= 4) || !(stride >= 0) || !(offset >= 0)) return this.fail(GL.INVALID_VALUE);
    if (this.arrayBuffer === null) return this.fail(GL.INVALID_OPERATION);
    Object.assign(a, { buffer: this.arrayBuffer, integer: true, size, type, normalized: false, stride, offset });
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
  /** The value a disabled array reads: context state, not part of a vertex array object. */
  vertexAttrib4f(index: number, x: number, y: number, z: number, w: number): void {
    if (!(index >= 0 && index < MAX_VERTEX_ATTRIBS)) return this.fail(GL.INVALID_VALUE);
    this.currentAttributes[index] = [Number(x), Number(y), Number(z), Number(w)];
  }
  vertexAttrib1fv(index: number, values: ArrayLike<number>): void {
    this.vertexAttribv(index, values, 1);
  }
  vertexAttrib2fv(index: number, values: ArrayLike<number>): void {
    this.vertexAttribv(index, values, 2);
  }
  vertexAttrib3fv(index: number, values: ArrayLike<number>): void {
    this.vertexAttribv(index, values, 3);
  }
  vertexAttrib4fv(index: number, values: ArrayLike<number>): void {
    this.vertexAttribv(index, values, 4);
  }
  private vertexAttribv(index: number, values: ArrayLike<number>, count: number): void {
    if (values === null || values === undefined || values.length < count) return this.fail(GL.INVALID_VALUE);
    const [x = 0, y = 0, z = 0, w = 1] = Array.from({ length: count }, (_, i) => values[i]!);
    this.vertexAttrib4f(index, x, count > 1 ? y : 0, count > 2 ? z : 0, count > 3 ? w : 1);
  }
  vertexAttribI4i(): never {
    throw new WebGLUnsupportedError('the current value of an integer attribute (vertexAttribI4i, vertexAttribI4ui and their v forms); give the attribute an array (vertexAttribIPointer)');
  }
  vertexAttribI4iv(): never {
    return this.vertexAttribI4i();
  }
  vertexAttribI4ui(): never {
    return this.vertexAttribI4i();
  }
  vertexAttribI4uiv(): never {
    return this.vertexAttribI4i();
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
  /** The texture bound to each unit for a texture target; null for a target the context does not have. */
  private unitMap(target: number): Map<number, WebGLTexture> | null {
    if (target === GL.TEXTURE_2D) return this.units;
    if (target === GL.TEXTURE_CUBE_MAP) return this.unitsCube;
    if (this.version !== 2) return null;
    return target === GL2.TEXTURE_3D ? this.units3d : target === GL2.TEXTURE_2D_ARRAY ? this.unitsArray : null;
  }
  bindTexture(target: number, texture: WebGLTexture | null): void {
    const isCube = target === GL.TEXTURE_CUBE_MAP;
    const units = this.unitMap(target);
    if (units === null) {
      if (texture === null) return;
      throw new WebGLUnsupportedError(`textures other than TEXTURE_2D, TEXTURE_CUBE_MAP, TEXTURE_3D and TEXTURE_2D_ARRAY (target 0x${target.toString(16)})`);
    }
    if (texture === null) {
      units.delete(this.activeUnit);
      return;
    }
    // A texture is of the type it was first bound to.
    if (texture.target !== null && texture.target !== target) return this.fail(GL.INVALID_OPERATION);
    texture.target = target;
    if (isCube && texture.faces === null) texture.faces = Array.from({ length: 6 }, () => new WebGLTexture());
    units.set(this.activeUnit, texture);
  }
  private bound(target: number): WebGLTexture | null {
    const units = this.unitMap(target);
    if (units === null) {
      this.fail(GL.INVALID_ENUM);
      return null;
    }
    const texture = units.get(this.activeUnit);
    if (texture === undefined) {
      this.fail(GL.INVALID_OPERATION);
      return null;
    }
    return texture;
  }
  /** The face a `texImage2D` or `texSubImage2D` of a cube face target writes: the bound cube map's, or null after the error. */
  private faceTarget(target: number): WebGLTexture | null {
    const cube = this.bound(GL.TEXTURE_CUBE_MAP);
    return cube?.faces?.[faceIndex(target)] ?? null;
  }
  /** A cube map is complete when its six faces are uploaded as pictures of one square size. */
  private cubeComplete(cube: WebGLTexture): boolean {
    const faces = cube.faces;
    if (faces === null) return false;
    const side = faces[0]!.width;
    const srgb = faces[0]!.format === GL2.SRGB8_ALPHA8;
    return side > 0 && faces.every((f) => f.uploaded && f.width === side && f.height === side && f.floats === null && f.layer === null && (f.format === GL2.SRGB8_ALPHA8) === srgb);
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
      case GL.TEXTURE_WRAP_R:
        if (this.version !== 2 || WRAPS[param] === undefined) return this.fail(GL.INVALID_ENUM);
        texture.wrapR = param;
        break;
      case GL2.TEXTURE_COMPARE_MODE:
        if (this.version !== 2 || (param !== GL.NONE && param !== GL2.COMPARE_REF_TO_TEXTURE)) return this.fail(GL.INVALID_ENUM);
        texture.compareMode = param;
        break;
      case GL2.TEXTURE_COMPARE_FUNC:
        if (this.version !== 2 || DEPTH_FUNCS[param] === undefined) return this.fail(GL.INVALID_ENUM);
        texture.compareFunc = param;
        break;
      case GL2.TEXTURE_MAX_LEVEL:
        if (this.version !== 2) return this.fail(GL.INVALID_ENUM);
        if (!(param >= 0)) return this.fail(GL.INVALID_VALUE);
        texture.maxLevel = Math.trunc(param);
        break;
      case GL2.TEXTURE_BASE_LEVEL:
        if (this.version !== 2) return this.fail(GL.INVALID_ENUM);
        if (!(param >= 0)) return this.fail(GL.INVALID_VALUE);
        texture.baseLevel = Math.trunc(param);
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
    if (target === GL.TEXTURE_CUBE_MAP) {
      if (WebGLContext.drawnCube(texture)) return this.mipmapDrawn(texture.faces!, texture.baseLevel);
      if (!this.cubeComplete(texture)) return this.fail(GL.INVALID_OPERATION);
      texture.mipmaps = true;
      texture.version += 1;
      return;
    }
    if (!texture.uploaded || kindOf(texture.format) !== 'color') return this.fail(GL.INVALID_OPERATION);
    if (target === GL2.TEXTURE_3D || target === GL2.TEXTURE_2D_ARRAY) throw new WebGLUnsupportedError('generateMipmap of a 3D or array texture; sample it with LINEAR or NEAREST');
    if (texture.drawnAt === texture.version) return this.mipmapDrawn([texture], texture.baseLevel);
    if (texture.floats !== null) throw new WebGLUnsupportedError('generateMipmap of a float texture; sample it with NEAREST');
    texture.mipmaps = true;
    texture.version += 1;
  }

  /**
   * `generateMipmap` of textures framebuffers drew in (a 2D one, or a cube map's faces): each level above `base`
   * (`TEXTURE_BASE_LEVEL`) becomes the one below it halved, by a LINEAR blit, in order with the draws. A texture
   * without storage for its levels is given all of them, as GL does.
   */
  private mipmapDrawn(textures: WebGLTexture[], base: number): void {
    for (const t of textures) {
      if (FLOAT_FORMATS[t.format]?.bits === 32) throw new WebGLUnsupportedError('generateMipmap of a 32-bit float render target; use a 16-bit one');
    }
    this.begin();
    for (const t of textures) {
      if (!t.immutable) t.levels = Math.floor(Math.log2(Math.max(t.width, t.height))) + 1;
      t.drawnAt = t.version;
      const id = this.registerTarget(t);
      for (let level = base; level + 1 < t.levels; level += 1) {
        const side = (l: number): [number, number, number, number] => [0, 0, Math.max(1, t.width >> l), Math.max(1, t.height >> l)];
        this.ops.push({ op: 'blit', src: id, ...(level > 0 ? { srcLevel: level } : {}), target: id, level: level + 1, from: side(level), to: side(level + 1), linear: true });
      }
    }
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
    // The float formats come in through `specifyFloat`; SRGB8_ALPHA8 is RGBA8 that a shader reads as linear.
    const sized = [GL2.RGBA32F, GL2.RGB32F, GL2.R32F, GL2.RGBA16F];
    if (sized.includes(internalformat as never)) throw new WebGLUnsupportedError(`the internal format 0x${internalformat.toString(16)}; use RGBA`);
  }

  /** Makes `texture` an empty depth (or depth and stencil) texture of this size: a framebuffer draws in it, and draws sample its depth. */
  private specifyDepth(texture: WebGLTexture, internalformat: number, width: number, height: number, source: unknown): void {
    if (source !== null && source !== undefined) throw new WebGLUnsupportedError('a depth texture with pixels; give it null and draw its depth');
    Object.assign(texture, { width, height, floats: null, float32: false, pixels: null, src: null, layer: null, uploaded: true, flipY: false, premultiply: false, mipmaps: false, format: internalformat, blank: true, levels: 1, patches: [] });
    texture.version += 1;
  }

  /** UNPACK_FLIP_Y_WEBGL and UNPACK_PREMULTIPLY_ALPHA_WEBGL apply to the floats of an upload as they do to bytes. */
  private unpackFloats(floats: Float32Array, width: number, height: number): void {
    if (this.flipY) {
      const row = width * 4;
      const turned = new Float32Array(floats.length);
      for (let y = 0; y < height; y += 1) turned.set(floats.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
      floats.set(turned);
    }
    if (this.premultiply) {
      for (let i = 0; i < width * height; i += 1) {
        for (let c = 0; c < 3; c += 1) floats[i * 4 + c]! *= floats[i * 4 + 3]!;
      }
    }
  }
  /** A 2D texture of a float format (`R32F`, `RGBA16F`, ...) from an array of floats, or empty. */
  private specifyFloat(texture: WebGLTexture, internalformat: number, float: { channels: number; format: number; bits: 16 | 32 }, [width, height]: [number, number], [format, type, source]: [number, number, unknown]): void {
    if (source !== null && source !== undefined && !ArrayBuffer.isView(source)) throw new WebGLUnsupportedError('a float texture from this source; use an array of floats or null');
    if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 0 && height >= 0 && width <= 8192 && height <= 8192)) return this.fail(GL.INVALID_VALUE);
    if (width === 0 || height === 0) throw new WebGLUnsupportedError('a float texture without texels');
    const floats = this.floatTexels(float, format, type, width * height, source as ArrayBufferView | null | undefined, 0);
    if (floats === null) return;
    this.unpackFloats(floats, width, height);
    const empty = source === null || source === undefined;
    // What a format has no alpha for reads as 1, in a texture with nothing in it as in one with pixels.
    if (empty && float.channels < 4) for (let i = 0; i < width * height; i += 1) floats[i * 4 + 3] = 1;
    Object.assign(texture, { width, height, depth: 0, floats, float32: float.bits === 32, pixels: null, src: null, layer: null, uploaded: true, flipY: false, premultiply: false, mipmaps: false, format: internalformat, blank: empty, levels: 1, patches: [], drawnAt: -1 });
    texture.version += 1;
  }

  /** `texImage2D(target, level, internalformat, width, height, border, format, type, pixels)` or `(…, internalformat, format, type, source)`. */
  texImage2D(target: number, level: number, internalformat: number, ...rest: unknown[]): void {
    if (faceIndex(target) >= 0) return this.texImageFace(target, level, internalformat, rest);
    const texture = this.bound(target);
    if (texture === null) return;
    this.specify2d(texture, level, internalformat, rest);
  }

  /** `texImage2D` of a face of the bound cube map: level 0, a square picture or pixels of a colour format. */
  private texImageFace(target: number, level: number, internalformat: number, rest: unknown[]): void {
    const cube = this.bound(GL.TEXTURE_CUBE_MAP);
    const face = cube?.faces?.[faceIndex(target)];
    if (cube === null || face === undefined) return;
    if (level !== 0) {
      // An empty level is storage a framebuffer can draw in (`specify2d` keeps what a level above 0 may hold); pixels are not drawn.
      this.specify2d(face, level, internalformat, rest);
      cube.version += 1;
      return;
    }
    // A float face is a render target: empty until a framebuffer draws in it.
    const empty = rest.length >= 6 && (rest[5] === null || rest[5] === undefined);
    if (kindOf(internalformat) !== 'color' || (FLOAT_FORMATS[internalformat] !== undefined && !empty)) throw new WebGLUnsupportedError('a cube map face of a depth format, or of float pixels; use RGBA8 or SRGB8_ALPHA8, or an empty float face to draw in');
    if (rest.length >= 6) {
      const [width, height] = rest as [number, number];
      if (!(Number.isInteger(width) && width >= 0 && width <= MAX_CUBE_MAP_TEXTURE_SIZE && Number.isInteger(height) && height >= 0 && height <= MAX_CUBE_MAP_TEXTURE_SIZE)) return this.fail(GL.INVALID_VALUE);
    }
    this.specify2d(face, level, internalformat, rest);
    if (face.layer !== null) throw new WebGLUnsupportedError('a cube map face from a layer picture; use an image, a canvas, ImageData or an array of pixels');
    // Each face of the six stays 2D data; the cube's own snapshot is made from them at the draw.
    cube.mipmaps = false;
    cube.version += 1;
  }

  /**
   * `texSubImage2D` of a face of the bound cube map, as three.js uploads one into `texStorage2D`: the whole of level 0,
   * which is the face specified again in its format.
   */
  private texSubImageFace(target: number, level: number, xoffset: number, yoffset: number, rest: unknown[]): void {
    const face = this.faceTarget(target);
    if (face === null) return;
    const [width, height] = rest.length >= 5 ? (rest as [number, number]) : [pictureOf(rest[2])?.width, pictureOf(rest[2])?.height];
    if (level !== 0 || xoffset !== 0 || yoffset !== 0 || width !== face.width || height !== face.height) {
      throw new WebGLUnsupportedError('texSubImage2D of part of a cube map face, or above level 0; upload the whole face at level 0, and call generateMipmap');
    }
    this.texImageFace(target, 0, face.format, rest.length >= 5 ? [rest[0], rest[1], 0, ...rest.slice(2)] : rest);
  }

  /** The body of `texImage2D`: `texture` is the 2D texture, or the face of a cube map, that the call specifies. */
  private specify2d(texture: WebGLTexture, level: number, internalformat: number, rest: unknown[]): void {
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
    const float = FLOAT_FORMATS[internalformat];
    if (float !== undefined && rest.length >= 6) return this.specifyFloat(texture, internalformat, float, [width, height], [format, type, source]);
    this.checkTextureType(type, internalformat);
    texture.floats = null;
    texture.float32 = false;
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
    if (internalformat === GL2.SRGB8_ALPHA8 && texture.layer !== null) throw new WebGLUnsupportedError('an sRGB texture from a layer picture; use RGBA8, or an image, a canvas or ImageData');
  }

  /**
   * The texels of a float upload of `count` texels, expanded to four floats each (what is not given is 0, and alpha 1).
   * `null` after setting the error when the call is invalid.
   */
  private floatTexels(float: { channels: number; format: number; bits: 16 | 32 }, format: number, type: number, count: number, view: ArrayBufferView | null | undefined, srcOffset: number): Float32Array | null {
    // 32-bit formats take FLOAT only; 16-bit ones take HALF_FLOAT as well.
    if (format !== float.format || (type !== GL.FLOAT && !(type === GL.HALF_FLOAT && float.bits === 16))) {
      this.fail(GL.INVALID_OPERATION);
      return null;
    }
    const out = new Float32Array(count * 4);
    if (view === null || view === undefined) return out;
    const need = count * float.channels;
    if (type === GL.FLOAT ? !(view instanceof Float32Array) : !(view instanceof Uint16Array)) {
      this.fail(GL.INVALID_OPERATION);
      return null;
    }
    const data = view as Float32Array | Uint16Array;
    if (data.length - srcOffset < need) {
      this.fail(GL.INVALID_OPERATION);
      return null;
    }
    for (let i = 0; i < count; i += 1) {
      for (let c = 0; c < 4; c += 1) {
        const v = c < float.channels ? data[srcOffset + i * float.channels + c]! : c === 3 ? 1 : 0;
        out[i * 4 + c] = type === GL.HALF_FLOAT && c < float.channels ? halfToFloat(v) : v;
      }
    }
    return out;
  }

  /**
   * The texels of a WebGL 2 `texImage3D` or `texSubImage3D` of `width * height * depth` from `source` (`null` is
   * zeros): RGBA8 bytes, or `RGBA16F` floats. `null` after setting the error when the call is invalid.
   */
  private texels3d(internalformat: number, format: number, type: number, size: [number, number, number], source: unknown, srcOffset: number): { pixels: Uint8Array } | { floats: Float32Array } | null {
    const [width, height, depth] = size;
    if (source !== null && source !== undefined && !ArrayBuffer.isView(source)) throw new WebGLUnsupportedError('a 3D texture from this source; use an array of pixels or null');
    const view = source as ArrayBufferView | null | undefined;
    const count = width * height * depth;
    if (!Number.isInteger(srcOffset) || srcOffset < 0) {
      this.fail(GL.INVALID_VALUE);
      return null;
    }
    const float = FLOAT_FORMATS[internalformat];
    if (float !== undefined) {
      const floats = this.floatTexels(float, format, type, count, view, srcOffset);
      return floats === null ? null : { floats };
    }
    const want = FORMATS_8BIT_3D[internalformat];
    if (want === undefined) throw new WebGLUnsupportedError(`the internal format 0x${internalformat.toString(16)} of a 3D texture; use RGBA8 or a float format`);
    if (format !== want || type !== GL.UNSIGNED_BYTE) {
      this.fail(GL.INVALID_OPERATION);
      return null;
    }
    if (view === null || view === undefined) return { pixels: new Uint8Array(count * 4) };
    if (!(view instanceof Uint8Array || view instanceof Uint8ClampedArray)) {
      this.fail(GL.INVALID_OPERATION);
      return null;
    }
    const channels = ({ [GL.RGBA]: 4, [GL.RGB]: 3, [GL2.RG]: 2, [GL2.RED]: 1 } as Record<number, number>)[format]!;
    const row = Math.ceil((width * channels) / this.unpackAlignment) * this.unpackAlignment;
    const bytes = new Uint8Array(view.buffer, view.byteOffset + srcOffset, view.byteLength - srcOffset);
    if (bytes.length < row * (height * depth - 1) + width * channels) {
      this.fail(GL.INVALID_OPERATION);
      return null;
    }
    // The images follow each other, each `height` rows of the row size.
    return { pixels: this.rgbaOf(width, height * depth, format, bytes) };
  }

  /** The bound texture of a `texImage3D`, `texSubImage3D` or `texStorage3D` target, and the most layers it can have; null after the error. */
  private bound3d(target: number): { texture: WebGLTexture; limit: number } | null {
    if (this.version !== 2) {
      this.fail(GL.INVALID_OPERATION);
      return null;
    }
    if (target !== GL2.TEXTURE_3D && target !== GL2.TEXTURE_2D_ARRAY) {
      this.fail(GL.INVALID_ENUM);
      return null;
    }
    const texture = this.bound(target);
    return texture === null ? null : { texture, limit: target === GL2.TEXTURE_3D ? MAX_3D_TEXTURE_SIZE : MAX_ARRAY_TEXTURE_LAYERS };
  }

  /** WebGL 2's `texImage3D(target, level, internalformat, width, height, depth, border, format, type, pixels, srcOffset)` of a `TEXTURE_3D` or `TEXTURE_2D_ARRAY`. */
  texImage3D(target: number, level: number, internalformat: number, width: number, height: number, depth: number, border: number, format: number, type: number, source?: unknown, srcOffset = 0): void {
    const bound = this.bound3d(target);
    if (bound === null) return;
    const { texture, limit } = bound;
    if (level !== 0) throw new WebGLUnsupportedError('texImage3D above level 0; a 3D or array texture has one level');
    const sides = [width, height, depth];
    if (border !== 0 || !sides.every((v) => Number.isInteger(v) && v >= 0) || Math.max(width, height) > MAX_3D_TEXTURE_SIZE || depth > limit) return this.fail(GL.INVALID_VALUE);
    // WebGL refuses the flip and the premultiply for these textures.
    if (this.flipY || this.premultiply) return this.fail(GL.INVALID_OPERATION);
    if (sides.some((v) => v === 0)) throw new WebGLUnsupportedError('a 3D or array texture without texels');
    const texels = this.texels3d(internalformat, format, type, [width, height, depth], source, srcOffset);
    if (texels === null) return;
    Object.assign(texture, { width, height, depth, pixels: 'pixels' in texels ? texels.pixels : null, floats: 'floats' in texels ? texels.floats : null, float32: FLOAT_FORMATS[internalformat]?.bits === 32, src: null, layer: null, uploaded: true, flipY: false, premultiply: false, mipmaps: false, format: internalformat, blank: false, levels: 1, patches: [], drawnAt: -1 });
    texture.version += 1;
  }

  /** WebGL 2's `texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixels, srcOffset)`. */
  texSubImage3D(target: number, level: number, xoffset: number, yoffset: number, zoffset: number, width: number, height: number, depth: number, format: number, type: number, source?: unknown, srcOffset = 0): void {
    const bound = this.bound3d(target);
    if (bound === null) return;
    const { texture } = bound;
    if (level !== 0) throw new WebGLUnsupportedError('texSubImage3D above level 0; a 3D or array texture has one level');
    if (this.flipY || this.premultiply || texture.depth === 0) return this.fail(GL.INVALID_OPERATION);
    const numbers = [xoffset, yoffset, zoffset, width, height, depth];
    if (!numbers.every((v) => Number.isInteger(v) && v >= 0) || xoffset + width > texture.width || yoffset + height > texture.height || zoffset + depth > texture.depth) return this.fail(GL.INVALID_VALUE);
    if (source === null || source === undefined) return this.fail(GL.INVALID_VALUE);
    const texels = this.texels3d(texture.format, format, type, [width, height, depth], source, srcOffset);
    if (texels === null) return;
    const [held, part] = 'floats' in texels ? [texture.floats!, texels.floats] : [texture.pixels!, texels.pixels];
    for (let z = 0; z < depth; z += 1) {
      for (let y = 0; y < height; y += 1) {
        const from = ((z * height + y) * width) * 4;
        held.set(part.subarray(from, from + width * 4), (((zoffset + z) * texture.height + yoffset + y) * texture.width + xoffset) * 4);
      }
    }
    texture.version += 1;
  }

  /** WebGL 2's `texStorage3D`: a 3D or array texture of this size, zeros, of one level (more are refused: only level 0 is held). */
  texStorage3D(target: number, levels: number, internalformat: number, width: number, height: number, depth: number): void {
    const bound = this.bound3d(target);
    if (bound === null) return;
    const { texture, limit } = bound;
    if (!(Number.isInteger(levels) && levels >= 1)) return this.fail(GL.INVALID_VALUE);
    const sides = [width, height, depth];
    if (!sides.every((v) => Number.isInteger(v) && v >= 1) || Math.max(width, height) > MAX_3D_TEXTURE_SIZE || depth > limit) return this.fail(GL.INVALID_VALUE);
    if (levels > 1) throw new WebGLUnsupportedError('texStorage3D of more than one level; a 3D or array texture has one level');
    const float = FLOAT_FORMATS[internalformat];
    const format = float?.format ?? FORMATS_8BIT_3D[internalformat];
    if (format === undefined) throw new WebGLUnsupportedError(`the internal format 0x${internalformat.toString(16)} of a 3D or array texture; use RGBA8 or a float format`);
    const texels = this.texels3d(internalformat, format, float === undefined ? GL.UNSIGNED_BYTE : GL.FLOAT, [width, height, depth], null, 0);
    if (texels === null) return;
    Object.assign(texture, { width, height, depth, pixels: 'pixels' in texels ? texels.pixels : null, floats: 'floats' in texels ? texels.floats : null, float32: float?.bits === 32, src: null, layer: null, uploaded: true, flipY: false, premultiply: false, mipmaps: false, format: internalformat, blank: false, levels: 1, patches: [], drawnAt: -1 });
    texture.version += 1;
  }

  /** `texElementImage2D(target, level, internalformat, format, type, elementImage)` of HTML in Canvas: `texImage2D` of an element's picture. */
  texElementImage2D(target: number, level: number, internalformat: number, format: number, type: number, elementImage: unknown): void {
    this.texImage2D(target, level, internalformat, format, type, elementImage);
  }

  /** `texSubImage2D` of floats (`width, height, format, type, pixels[, srcOffset]`) into a float texture: they replace that rectangle of the floats it holds. */
  private subFloats(texture: WebGLTexture, xoffset: number, yoffset: number, rest: unknown[]): void {
    const float = FLOAT_FORMATS[texture.format]!;
    if (rest.length < 5) throw new WebGLUnsupportedError('texSubImage2D into a float texture from a picture; use an array of floats');
    if (texture.drawnAt === texture.version) throw new WebGLUnsupportedError('texSubImage2D into a float texture a framebuffer drew in; draw into it, or upload the whole texture again');
    const [width, height, format, type, source, srcOffset = 0] = rest as [number, number, number, number, ArrayBufferView | null, number | undefined];
    const numbers = [xoffset, yoffset, width, height];
    if (!numbers.every((v) => Number.isInteger(v) && v >= 0) || xoffset + width > texture.width || yoffset + height > texture.height) return this.fail(GL.INVALID_VALUE);
    if (source === null || source === undefined) return this.fail(GL.INVALID_VALUE);
    const floats = this.floatTexels(float, format, type, width * height, source, Number(srcOffset));
    if (floats === null) return;
    this.unpackFloats(floats, width, height);
    const held = texture.floats!;
    for (let y = 0; y < height; y += 1) held.set(floats.subarray(y * width * 4, (y + 1) * width * 4), ((yoffset + y) * texture.width + xoffset) * 4);
    texture.blank = false;
    texture.version += 1;
  }

  /**
   * A picture over a rectangle of level 0. Into a texture a framebuffer draws in it is an op after the draws before
   * it; into an uploaded texture whose pixels are here it edits them; anything else (an image file, a layer, a
   * texture made from one) is a patch the renderer lays over the texture's picture.
   */
  texSubImage2D(target: number, level: number, xoffset: number, yoffset: number, ...rest: unknown[]): void {
    if (faceIndex(target) >= 0) return this.texSubImageFace(target, level, xoffset, yoffset, rest);
    const texture = this.bound(target);
    if (texture === null) return;
    if (level !== 0) throw new WebGLUnsupportedError('texSubImage2D above level 0; call generateMipmap');
    if (kindOf(texture.format) !== 'color') throw new WebGLUnsupportedError('texSubImage2D into a depth texture; draw its depth');
    if (texture.floats !== null) return this.subFloats(texture, xoffset, yoffset, rest);
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
      // The bytes of an upload are RGBA8, which an R8 or RG8 target does not hold.
      if (texture.format === GL2.R8 || texture.format === GL2.RG8) throw new WebGLUnsupportedError('texSubImage2D into an R8 or RG8 texture a framebuffer drew in; draw into it, or upload the whole texture again');
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
    if (target === GL.TEXTURE_CUBE_MAP) {
      // Each of the six faces is given the storage, as a 2D texture is.
      if (width !== height) return this.fail(GL.INVALID_VALUE);
      if (kindOf(internalformat) !== 'color') throw new WebGLUnsupportedError('a cube map of a depth format; use RGBA8, SRGB8_ALPHA8 or a float format');
      for (const face of texture.faces!) this.storage2d(face, levels, internalformat, width, height);
      texture.mipmaps = false;
      texture.version += 1;
      return;
    }
    this.storage2d(texture, levels, internalformat, width, height);
  }

  /** The body of `texStorage2D` for a 2D texture, or a face of a cube map. */
  private storage2d(texture: WebGLTexture, levels: number, internalformat: number, width: number, height: number): void {
    if (kindOf(internalformat) !== 'color') {
      if (levels > 1) throw new WebGLUnsupportedError('a depth texture of more than one level');
      return this.specifyDepth(texture, internalformat, width, height, null);
    }
    const float = FLOAT_FORMATS[internalformat];
    if (float !== undefined) {
      this.specifyFloat(texture, internalformat, float, [width, height], [float.format, GL.FLOAT, null]);
      // The levels above 0 are storage a framebuffer, or generateMipmap, draws in.
      Object.assign(texture, { levels, immutable: true });
      return;
    }
    this.checkTextureType(GL.UNSIGNED_BYTE, internalformat);
    // Its upper levels are mipmaps of the empty level 0 until a framebuffer draws in them.
    Object.assign(texture, { width, height, floats: null, float32: false, pixels: new Uint8Array(width * height * 4), src: null, layer: null, uploaded: true, flipY: false, premultiply: false, mipmaps: levels > 1, format: internalformat, blank: true, levels, immutable: true, patches: [] });
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
    } else if (s.kind === 'ref') {
      throw new WebGLUnsupportedError('a texture from a sources table entry (only a written scene holds one)');
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
    const face = faceIndex(textarget);
    if (texture !== null) {
      // A face of a cube map is attached as the 2D texture it is.
      if (face >= 0 ? texture.faces === null : textarget !== GL.TEXTURE_2D || texture.faces !== null) return this.fail(GL.INVALID_OPERATION);
      if (!(level >= 0) || (this.version === 1 && level !== 0)) return this.fail(GL.INVALID_VALUE);
    }
    this.attach(framebuffer, attachment, texture === null ? null : face >= 0 ? { texture: texture.faces![face]!, level: Math.trunc(level), cube: texture } : { texture, level: Math.trunc(level) });
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
    // Every attachment has one number of samples (a texture has none).
    const samples = new Set(all.map((a) => ('renderbuffer' in a ? a.renderbuffer.samples : 0)));
    if (samples.size > 1) return GL2.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE;
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
      if (texture.format !== GL.RGBA && texture.format !== GL2.RGBA8 && COLOR_TARGETS[texture.format] === undefined) {
        throw new WebGLUnsupportedError(`drawing into a texture of internal format 0x${texture.format.toString(16)}; allocate it as RGBA, SRGB8_ALPHA8, R8, RG8, or as R16F, RG16F, RGBA16F, R32F, RG32F or RGBA32F`);
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
      ...(COLOR_TARGETS[texture.format] !== undefined ? { colorFormat: COLOR_TARGETS[texture.format]! } : {}),
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
    const colorFormat = COLOR_TARGETS[r.format ?? 0];
    this.textures.set(id, { target: true, width: r.width, height: r.height, ...(kind === 'color' ? {} : { format: kind }), ...(colorFormat !== undefined ? { colorFormat } : {}), ...(r.samples > 0 ? { samples: r.samples } : {}) });
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
        return a === null ? null : 'texture' in a ? (a.cube ?? a.texture) : a.renderbuffer;
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
    this.storeRenderbuffer(target, internalformat, width, height, 0);
  }
  private storeRenderbuffer(target: number, internalformat: number, width: number, height: number, samples: number): void {
    if (target !== GL.RENDERBUFFER) return this.fail(GL.INVALID_ENUM);
    if (!(width >= 0 && height >= 0)) return this.fail(GL.INVALID_VALUE);
    const renderbuffer = this.renderbuffer;
    if (renderbuffer === null) return this.fail(GL.INVALID_OPERATION);
    const v2 = this.version === 2;
    const v2only = [GL2.RGBA8, GL2.SRGB8_ALPHA8, GL2.R8, GL2.RG8, GL2.R16F, GL2.RG16F, GL2.RGBA16F, GL2.R32F, GL2.RG32F, GL2.RGBA32F, GL2.DEPTH_COMPONENT24, GL2.DEPTH_COMPONENT32F, GL2.DEPTH24_STENCIL8, GL2.DEPTH32F_STENCIL8] as number[];
    const known = kindOf(internalformat) !== 'color' || COLOR_RENDERBUFFER.has(internalformat);
    if (internalformat === GL.DEPTH_COMPONENT) return this.fail(GL.INVALID_ENUM);
    if (!known || (!v2 && v2only.includes(internalformat))) {
      return this.fail(GL.INVALID_ENUM);
    }
    renderbuffer.format = internalformat;
    renderbuffer.width = Math.trunc(width);
    renderbuffer.height = Math.trunc(height);
    renderbuffer.samples = samples;
    renderbuffer.version += 1;
  }
  /**
   * WebGL 2's multisampled storage; with 0 samples it is `renderbufferStorage`. Any other count is `MAX_SAMPLES`, the
   * one count the GPU has (GL may give more samples than asked for).
   */
  renderbufferStorageMultisample(target: number, samples: number, internalformat: number, width: number, height: number): void {
    if (this.version !== 2) return this.fail(GL.INVALID_OPERATION);
    if (!(samples >= 0 && samples <= MAX_SAMPLES)) return this.fail(GL.INVALID_OPERATION);
    if (samples > 0 && FLOAT_FORMATS[internalformat]?.bits === 32) throw new WebGLUnsupportedError('a multisampled renderbuffer of 32-bit floats; use a 16-bit format');
    this.storeRenderbuffer(target, internalformat, width, height, samples > 0 ? MAX_SAMPLES : 0);
  }

  /** The samples of what the framebuffer draws in (the canvas for null): 0 when it is not multisampled. */
  private samplesOf(framebuffer: WebGLFramebuffer | null): number {
    if (framebuffer === null) return this.attributes.antialias ? MAX_SAMPLES : 0;
    const a = [...framebuffer.colors, framebuffer.depth, framebuffer.stencil].find((a) => a !== null && a !== undefined);
    return a !== undefined && a !== null && 'renderbuffer' in a ? a.renderbuffer.samples : 0;
  }
  /**
   * `getInternalformatParameter(RENDERBUFFER, format, SAMPLES)`: the one count `renderbufferStorageMultisample` has (a format it
   * does not draw multisampled, the 32-bit floats, has none). Formats that cannot be a renderbuffer's are an error, as in GL.
   */
  getInternalformatParameter(target: number, internalformat: number, pname: number): Int32Array | null {
    if (this.version !== 2) {
      this.fail(GL.INVALID_OPERATION);
      return null;
    }
    const known = (kindOf(internalformat) !== 'color' || COLOR_RENDERBUFFER.has(internalformat)) && internalformat !== GL.DEPTH_COMPONENT;
    if (target !== GL.RENDERBUFFER || pname !== GL.SAMPLES || !known) {
      this.fail(GL.INVALID_ENUM);
      return null;
    }
    return new Int32Array(FLOAT_FORMATS[internalformat]?.bits === 32 ? [] : [MAX_SAMPLES]);
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
    if (pname === GL2.RENDERBUFFER_SAMPLES && this.version === 2) return r.samples;
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
    const modes: Record<number, GlslDraw['mode']> = { [GL.POINTS]: 'points', [GL.TRIANGLES]: 'triangles', [GL.TRIANGLE_STRIP]: 'triangleStrip', [GL.TRIANGLE_FAN]: 'triangleFan', [GL.LINES]: 'lines', [GL.LINE_STRIP]: 'lineStrip', [GL.LINE_LOOP]: 'lineLoop' };
    if (mode < GL.POINTS || mode > GL.TRIANGLE_FAN) return this.fail(GL.INVALID_ENUM);
    const program = this.program;
    if (program === null) return this.fail(GL.INVALID_OPERATION);
    const named = modes[mode];
    if (named === undefined) return this.fail(GL.INVALID_ENUM);
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
    if (!this.programs.has(programId)) {
      const blocks = program.blocks.map(({ name, size, members }) => ({ name, size, members }));
      this.programs.set(programId, { vertex: program.vertex, fragment: program.fragment, attributes, ...(blocks.length > 0 ? { blocks } : {}) });
    }

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
    // A matrix attribute is read as one attribute for each of its columns, at consecutive locations.
    const reads = program.attributeDeclarations.flatMap((d): { key: string; at: number }[] => {
      const base = program.attributes.get(d.name)!;
      const columns = matrixColumns(d.type);
      return columns === undefined ? [{ key: d.name, at: base }] : Array.from({ length: columns }, (_, i) => ({ key: `${d.name}[${i}]`, at: base + i }));
    });
    for (const { key, at } of reads) {
      const d = { name: key };
      const a = this.vao.attributes[at];
      if (a === undefined || !a.enabled) {
        // A disabled array reads the current value; the renderer reads it only for the attributes the shader keeps.
        const value = this.currentAttributes[at] ?? DEFAULT_ATTRIBUTE;
        draw.attributes[d.name] = { buffer: `constant:${value.join(',')}`, size: 4, type: 'f32', constant: [...value] };
        continue;
      }
      if (a.buffer === null) continue;
      if (a.divisor >= 1 && named === 'points') throw new WebGLUnsupportedError('instanced attributes of points');
      const type = ({ [GL.FLOAT]: 'f32', [GL.UNSIGNED_BYTE]: 'u8', [GL.BYTE]: 'i8', [GL.UNSIGNED_SHORT]: 'u16', [GL.SHORT]: 'i16', [GL.INT]: 'i32', [GL.UNSIGNED_INT]: 'u32' } as Record<number, GlslDraw['attributes'][string]['type']>)[a.type];
      if (type === undefined) throw new WebGLUnsupportedError(`the attribute "${d.name}" has type 0x${a.type.toString(16)}; use FLOAT, BYTE, UNSIGNED_BYTE, SHORT, UNSIGNED_SHORT, INT or UNSIGNED_INT`);
      draw.attributes[d.name] = { buffer: this.bufferId(a.buffer), size: a.size, type, normalized: a.normalized, ...(a.integer ? { integer: true } : {}), stride: a.stride, offset: a.offset, ...(a.divisor >= 1 ? { divisor: a.divisor } : {}) };
    }
    if (indexed !== null) {
      const element = this.vao.element;
      if (element === null) return this.fail(GL.INVALID_OPERATION);
      draw.indices = { buffer: this.bufferId(element), type: indexed.type, offset: indexed.offset };
      draw.first = 0;
    }

    // Each uniform block reads the range bound at its binding point as the draw finds it: a draw is refused when a
    // block has no buffer, or one that holds less than the block does (WebGL 2, as in a browser).
    for (const [i, block] of program.blocks.entries()) {
      const bound = this.uniformBindings[program.blockBindings[i]!];
      // The bytes from its offset, to the end of the buffer or of the range, whichever comes first (a whole-buffer binding has size 0).
      const available = bound === null || bound === undefined ? 0 : Math.max(0, Math.min(bound.size === 0 ? Infinity : bound.size, bound.buffer.data.length - bound.offset));
      if (bound === null || bound === undefined || available < block.size) return this.fail(GL.INVALID_OPERATION);
      (draw.blocks ??= {})[block.name] = { buffer: this.bufferId(bound.buffer), offset: bound.offset, size: available };
    }

    // Uniforms and the texture units the samplers name.
    for (const [name, calls] of program.uniforms) {
      draw.uniforms[name] = calls.map((c): GlslUniform => ({ kind: c.kind, value: [...c.value], ...(c.index === 0 ? {} : { index: c.index }) }));
    }
    const fb = this.drawFramebuffer;
    const attached = fb === null ? [] : [...fb.colors, fb.depth, fb.stencil].flatMap((a) => (a !== null && a !== undefined && 'texture' in a ? [a.texture] : []));
    // The type of sampler that reads each unit: WebGL refuses a draw in which one unit is read as two.
    const unitTypes = new Map<number, string>();
    for (const d of program.uniformDeclarations) {
      const samplerTarget = SAMPLER_TARGETS[d.type];
      if (samplerTarget === undefined) continue;
      // The units of its elements: one for a sampler, each of an array of them as the calls gave it.
      const units: number[] = Array.from({ length: d.length }, () => 0);
      const calls = program.uniforms.get(d.name) ?? [];
      if (d.length === 1) units[0] = calls.at(-1)?.value[0] ?? 0;
      else for (const call of calls) call.value.forEach((v, i) => { if (call.index + i < units.length) units[call.index + i] = v; });
      const shadow = d.type.endsWith('Shadow');
      for (const unit of units) {
        if (unitTypes.get(unit) !== undefined && unitTypes.get(unit) !== d.type) return this.fail(GL.INVALID_OPERATION);
        unitTypes.set(unit, d.type);
        const texture = this.unitMap(samplerTarget)?.get(unit);
        if (texture === undefined) continue;
        // Reading what the draw writes is undefined; WebGL refuses it.
        if (attached.includes(texture) || texture.faces?.some((f) => attached.includes(f))) return this.fail(GL.INVALID_OPERATION);
        // A shadow sampler reads a depth texture that compares; any other sampler does not read one that does.
        const compares = texture.compareMode === GL2.COMPARE_REF_TO_TEXTURE;
        if (shadow ? !compares || kindOf(texture.format) === 'color' : compares && kindOf(texture.format) !== 'color') return this.fail(GL.INVALID_OPERATION);
        if (draw.units[String(unit)] === undefined) draw.units[String(unit)] = this.samplerOf(texture);
      }
    }

    // State.
    if (this.caps.scissor) draw.scissor = this.scissorNow();
    if (this.caps.blend) {
      const into32 = this.drawFramebuffer !== null && this.outputsOf(this.drawFramebuffer).some((a) => a !== null && FLOAT_FORMATS[('texture' in a ? a.texture.format : a.renderbuffer.format) ?? 0]?.bits === 32);
      // As in a browser, without EXT_float_blend enabled such a draw is refused.
      if (into32 && !this.floatBlend) return this.fail(GL.INVALID_OPERATION);
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
      if (this.caps.polygonOffset && named !== 'points' && !named.startsWith('line') && (factor !== 0 || units !== 0)) draw.polygonOffset = { factor, units };
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
    const cube = texture.faces !== null;
    const target = !cube && (texture.drawnAt === texture.version || kindOf(texture.format) !== 'color');
    const id = target ? this.registerTarget(texture) : cube && WebGLContext.drawnCube(texture) ? this.drawnCubeId(texture) : this.uploadedId(texture);
    // A texStorage2D texture's levels clamp its base and max level (ES 3.0 §3.8.10), so it is complete without
    // TEXTURE_MAX_LEVEL; a cube map keeps its storage on its faces.
    const storage = cube ? texture.faces![0]! : texture;
    const baseLevel = storage.immutable ? Math.min(texture.baseLevel, storage.levels - 1) : texture.baseLevel;
    const maxLevel = storage.immutable ? Math.min(Math.max(texture.maxLevel, baseLevel), storage.levels - 1) : texture.maxLevel;
    return {
      texture: id,
      min: FILTERS[texture.min]!,
      mag: FILTERS[texture.mag]!,
      wrapS: WRAPS[texture.wrapS]!,
      wrapT: WRAPS[texture.wrapT]!,
      ...((texture.depth > 0 && texture.target === GL2.TEXTURE_3D) || cube ? { wrapR: WRAPS[texture.wrapR]! } : {}),
      ...(maxLevel < 1000 ? { maxLevel } : {}),
      ...(baseLevel > 0 ? { baseLevel } : {}),
      ...(texture.compareMode === GL2.COMPARE_REF_TO_TEXTURE ? { compare: DEPTH_FUNCS[texture.compareFunc]! } : {}),
    };
  }

  /** Whether a framebuffer drew in a face of the cube map: its faces are render targets from then on. */
  private static drawnCube(cube: WebGLTexture): boolean {
    return cube.faces!.some((f) => f.drawnAt === f.version);
  }

  /**
   * A cube map a framebuffer drew in, in the recording: the six targets of its faces. It is complete when they are
   * square, of one size, format and level count; a face that holds uploaded pixels cannot be one of them.
   */
  private drawnCubeId(cube: WebGLTexture): string {
    const faces = cube.faces!;
    if (faces.some((f) => f.uploaded && !f.blank && f.drawnAt !== f.version)) throw new WebGLUnsupportedError('a cube map with both uploaded and drawn faces; draw in every face, or upload every face');
    const first = faces[0]!;
    const complete = faces.every((f) => f.uploaded && f.width === first.width && f.height === first.width && f.format === first.format && f.levels === first.levels);
    const id = `c${cube.id}.${faces.map((f) => f.version).join('.')}`;
    this.textures.set(id, complete ? { cube: true, targets: faces.map((f) => this.registerTarget(f)) } : { cube: true, faces: [] });
    return id;
  }

  /** A cube map in the recording: its six faces, or none while it is incomplete (it then samples as opaque black). */
  private cubeJson(cube: WebGLTexture): GlslTexture {
    if (!this.cubeComplete(cube)) return { cube: true, faces: [] };
    const faces = cube.faces!.map((f) => ({
      ...(f.src !== null ? { src: f.src } : { pixels: toBase64(f.pixels ?? new Uint8Array(0)) }),
      ...(f.flipY ? { flipY: true } : {}),
      ...(f.premultiply ? { premultiply: true } : {}),
    }));
    return { cube: true, width: cube.faces![0]!.width, height: cube.faces![0]!.width, faces, ...(cube.mipmaps ? { mipmaps: true } : {}), ...(cube.faces![0]!.format === GL2.SRGB8_ALPHA8 ? { srgb: true } : {}) };
  }

  /** An uploaded texture in the recording: its pixels, once, by an id of what they are. */
  private uploadedId(texture: WebGLTexture): string {
    if (texture.snapshot?.version !== texture.version) {
      const json: GlslTexture = texture.faces !== null ? this.cubeJson(texture) : texture.depth > 0 || texture.floats !== null
        ? {
            ...(texture.floats !== null ? { floats: toBase64(new Uint8Array(texture.floats.buffer, texture.floats.byteOffset, texture.floats.byteLength)), ...(texture.float32 ? { float32: true } : {}) } : { pixels: toBase64(texture.pixels ?? new Uint8Array(0)) }),
            width: texture.width,
            height: texture.height,
            ...(texture.depth > 0 ? { depth: texture.depth } : {}),
            ...(texture.target === GL2.TEXTURE_2D_ARRAY ? { array: true } : {}),
          }
        : {
        ...(texture.layer !== null
          ? { layer: texture.layer }
          : texture.src !== null
            ? { src: texture.src }
            : { pixels: toBase64(texture.pixels ?? new Uint8Array(0)) }),
        ...(texture.pixels !== null ? { width: texture.width, height: texture.height } : {}),
        ...(texture.flipY ? { flipY: true } : {}),
        ...(texture.premultiply ? { premultiply: true } : {}),
        ...(texture.mipmaps ? { mipmaps: true } : {}),
        ...(texture.format === GL2.SRGB8_ALPHA8 ? { srgb: true } : {}),
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
