/**
 * The texel arithmetic of raw texture calls (`GlslTexCall`): how many bytes a texel of a format and a type takes, and
 * the tightly packed bytes an upload reads out of a page's array under the pixel-store state (ES 3.0 §3.7.1).
 */

const GL = {
  BYTE: 0x1400,
  UNSIGNED_BYTE: 0x1401,
  SHORT: 0x1402,
  UNSIGNED_SHORT: 0x1403,
  INT: 0x1404,
  UNSIGNED_INT: 0x1405,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,
  UNSIGNED_SHORT_4_4_4_4: 0x8033,
  UNSIGNED_SHORT_5_5_5_1: 0x8034,
  UNSIGNED_SHORT_5_6_5: 0x8363,
  UNSIGNED_INT_2_10_10_10_REV: 0x8368,
  UNSIGNED_INT_10F_11F_11F_REV: 0x8c3b,
  UNSIGNED_INT_5_9_9_9_REV: 0x8c3e,
  UNSIGNED_INT_24_8: 0x84fa,
  FLOAT_32_UNSIGNED_INT_24_8_REV: 0x8dad,
} as const;

/** The components of an upload's format, by its enum. */
const COMPONENTS: Record<number, number> = {
  0x1908: 4, // RGBA
  0x1907: 3, // RGB
  0x8227: 2, // RG
  0x1903: 1, // RED
  0x190a: 2, // LUMINANCE_ALPHA
  0x1909: 1, // LUMINANCE
  0x1906: 1, // ALPHA
  0x8d99: 4, // RGBA_INTEGER
  0x8d98: 3, // RGB_INTEGER
  0x8228: 2, // RG_INTEGER
  0x8d94: 1, // RED_INTEGER
  0x1902: 1, // DEPTH_COMPONENT
  0x84f9: 2, // DEPTH_STENCIL
};

/** The bytes of one value of a type, and whether it packs the channels of a texel into itself. */
function typeSize(type: number): { size: number; packed: boolean } | null {
  switch (type) {
    case GL.BYTE:
    case GL.UNSIGNED_BYTE:
      return { size: 1, packed: false };
    case GL.SHORT:
    case GL.UNSIGNED_SHORT:
    case GL.HALF_FLOAT:
      return { size: 2, packed: false };
    case GL.INT:
    case GL.UNSIGNED_INT:
    case GL.FLOAT:
      return { size: 4, packed: false };
    case GL.UNSIGNED_SHORT_4_4_4_4:
    case GL.UNSIGNED_SHORT_5_5_5_1:
    case GL.UNSIGNED_SHORT_5_6_5:
      return { size: 2, packed: true };
    case GL.UNSIGNED_INT_2_10_10_10_REV:
    case GL.UNSIGNED_INT_10F_11F_11F_REV:
    case GL.UNSIGNED_INT_5_9_9_9_REV:
    case GL.UNSIGNED_INT_24_8:
      return { size: 4, packed: true };
    case GL.FLOAT_32_UNSIGNED_INT_24_8_REV:
      return { size: 8, packed: true };
    default:
      return null;
  }
}

/** The bytes of one texel of `format` and `type`, and of one of its channels (the whole texel for a packed type); null for a pair GL does not take. */
export function texelSize(format: number, type: number): { texel: number; unit: number } | null {
  const t = typeSize(type);
  const components = COMPONENTS[format];
  if (t === null || components === undefined) return null;
  return t.packed ? { texel: t.size, unit: t.size } : { texel: t.size * components, unit: t.size };
}

/** The array class an upload of `type` reads (WebGL refuses another with INVALID_OPERATION). */
export function arrayFits(type: number, view: ArrayBufferView): boolean {
  switch (type) {
    case GL.BYTE:
      return view instanceof Int8Array;
    case GL.UNSIGNED_BYTE:
      return view instanceof Uint8Array || view instanceof Uint8ClampedArray;
    case GL.SHORT:
      return view instanceof Int16Array;
    case GL.UNSIGNED_SHORT:
    case GL.HALF_FLOAT:
    case GL.UNSIGNED_SHORT_4_4_4_4:
    case GL.UNSIGNED_SHORT_5_5_5_1:
    case GL.UNSIGNED_SHORT_5_6_5:
      return view instanceof Uint16Array;
    case GL.INT:
      return view instanceof Int32Array;
    case GL.UNSIGNED_INT:
    case GL.UNSIGNED_INT_2_10_10_10_REV:
    case GL.UNSIGNED_INT_10F_11F_11F_REV:
    case GL.UNSIGNED_INT_5_9_9_9_REV:
    case GL.UNSIGNED_INT_24_8:
      return view instanceof Uint32Array;
    case GL.FLOAT:
      return view instanceof Float32Array;
    default:
      return true;
  }
}

/** `pixelStorei`'s unpack state that sizes an upload. */
export interface UnpackStore {
  alignment: number;
  rowLength: number;
  imageHeight: number;
  skipPixels: number;
  skipRows: number;
  skipImages: number;
}

/**
 * The tightly packed texels of a `width` x `height` x `depth` upload read from `view` at the element `srcOffset`, with
 * the rows, images and skips of `store`; null when `view` is shorter than the upload reads.
 */
export function unpackBytes(view: ArrayBufferView, srcOffset: number, [width, height, depth]: [number, number, number], size: { texel: number; unit: number }, store: UnpackStore): Uint8Array | null {
  const { texel, unit } = size;
  const rowTexels = store.rowLength > 0 ? store.rowLength : width;
  const align = store.alignment;
  // ES 3.0 §3.7.1: a row is `texel * n` bytes, rounded up to the alignment when one value is smaller than it.
  const rowBytes = unit < align ? Math.ceil((rowTexels * texel) / align) * align : rowTexels * texel;
  const rows = store.imageHeight > 0 ? store.imageHeight : height;
  const imageBytes = rowBytes * rows;
  const start = store.skipImages * imageBytes + store.skipRows * rowBytes + store.skipPixels * texel;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  // `srcOffset` counts the array's elements (a DataView's are bytes).
  const base = srcOffset * ('BYTES_PER_ELEMENT' in view ? (view as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT : 1);
  const first = base + start;
  if (width === 0 || height === 0 || depth === 0) return new Uint8Array(0);
  const last = first + (depth - 1) * imageBytes + (height - 1) * rowBytes + width * texel;
  if (!Number.isSafeInteger(last) || last > bytes.length) return null;
  const out = new Uint8Array(width * height * depth * texel);
  const row = width * texel;
  for (let z = 0; z < depth; z += 1) {
    for (let y = 0; y < height; y += 1) {
      const from = first + z * imageBytes + y * rowBytes;
      out.set(bytes.subarray(from, from + row), (z * height + y) * row);
    }
  }
  return out;
}

/** The integer internal formats (`R8UI` ... `RGBA32I`): a shader reads them through `isampler` and `usampler`, and the collapsed texture model holds none. */
const INTEGER_INTERNAL = new Set([
  0x8232, 0x8231, 0x8234, 0x8233, 0x8236, 0x8235, // R8UI R8I R16UI R16I R32UI R32I
  0x8238, 0x8237, 0x823a, 0x8239, 0x823c, 0x823b, // RG8UI RG8I RG16UI RG16I RG32UI RG32I
  0x8d7d, 0x8d8f, 0x8d77, 0x8d89, 0x8d71, 0x8d83, // RGB8UI RGB8I RGB16UI RGB16I RGB32UI RGB32I
  0x8d7c, 0x8d8e, 0x906f, 0x8d76, 0x8d88, 0x8d70, 0x8d82, // RGBA8UI RGBA8I RGB10_A2UI RGBA16UI RGBA16I RGBA32UI RGBA32I
]);

export function isIntegerInternal(internalformat: number): boolean {
  return INTEGER_INTERNAL.has(internalformat);
}

/** The signed integer internal formats among `INTEGER_INTERNAL`. */
const SIGNED_INTERNAL = new Set([0x8231, 0x8233, 0x8235, 0x8237, 0x8239, 0x823b, 0x8d8f, 0x8d89, 0x8d83, 0x8d8e, 0x8d88, 0x8d82]);

/** `i` or `u` for an integer internal format (which an `isampler` or a `usampler` reads), null for any other. */
export function integerSign(internalformat: number): 'i' | 'u' | null {
  if (!INTEGER_INTERNAL.has(internalformat)) return null;
  return SIGNED_INTERNAL.has(internalformat) ? 'i' : 'u';
}

/** The compressed texture formats WebGL has extensions for, by extension: the constants it exposes, as the extension object. */
export const COMPRESSED_EXTENSIONS: Record<string, Record<string, number>> = {
  WEBGL_compressed_texture_s3tc: { COMPRESSED_RGB_S3TC_DXT1_EXT: 0x83f0, COMPRESSED_RGBA_S3TC_DXT1_EXT: 0x83f1, COMPRESSED_RGBA_S3TC_DXT3_EXT: 0x83f2, COMPRESSED_RGBA_S3TC_DXT5_EXT: 0x83f3 },
  EXT_texture_compression_bptc: { COMPRESSED_RGBA_BPTC_UNORM_EXT: 0x8e8c, COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT: 0x8e8d, COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT: 0x8e8e, COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT: 0x8e8f },
  EXT_texture_compression_rgtc: { COMPRESSED_RED_RGTC1_EXT: 0x8dbb, COMPRESSED_SIGNED_RED_RGTC1_EXT: 0x8dbc, COMPRESSED_RED_GREEN_RGTC2_EXT: 0x8dbd, COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT: 0x8dbe },
  WEBGL_compressed_texture_etc: { COMPRESSED_R11_EAC: 0x9270, COMPRESSED_SIGNED_R11_EAC: 0x9271, COMPRESSED_RG11_EAC: 0x9272, COMPRESSED_SIGNED_RG11_EAC: 0x9273, COMPRESSED_RGB8_ETC2: 0x9274, COMPRESSED_SRGB8_ETC2: 0x9275, COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9276, COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9277, COMPRESSED_RGBA8_ETC2_EAC: 0x9278, COMPRESSED_SRGB8_ALPHA8_ETC2_EAC: 0x9279 },
  WEBGL_compressed_texture_astc: Object.fromEntries([
    ...['4x4', '5x4', '5x5', '6x5', '6x6', '8x5', '8x6', '8x8', '10x5', '10x6', '10x8', '10x10', '12x10', '12x12'].map((n, i) => [`COMPRESSED_RGBA_ASTC_${n}_KHR`, 0x93b0 + i]),
    ...['4x4', '5x4', '5x5', '6x5', '6x6', '8x5', '8x6', '8x8', '10x5', '10x6', '10x8', '10x10', '12x10', '12x12'].map((n, i) => [`COMPRESSED_SRGB8_ALPHA8_ASTC_${n}_KHR`, 0x93d0 + i]),
  ]),
};

/** Whether `internalformat` is one of the compressed formats above (such a texture is made of raw calls). */
export function isCompressedInternal(internalformat: number): boolean {
  return Object.values(COMPRESSED_EXTENSIONS).some((constants) => Object.values(constants).includes(internalformat));
}
