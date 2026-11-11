// The canvas's sRGB bytes (the readback texture) as yuv420p planes, Y then U then V, rows packed: byte for byte what
// the encoder's converter makes of them (`compositor/yuv.rs`, swscale's RGBA to yuv420p with BT.709 and limited
// range). Each invocation writes one 32-bit word of the planes, four bytes.

struct Params {
    width: u32,
    height: u32,
    /// Where the canvas starts in the texture (the margin).
    margin: u32,
    /// Taps of the vertical chroma filter per chroma row.
    taps: u32,
    /// Bytes of the three planes.
    total: u32,
    /// Words in a row of workgroups (the dispatch is two-dimensional).
    row_words: u32,
}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var canvas: texture_2d<f32>;
/// Per chroma row: the first source row, then `taps` weights (out of 4096).
@group(0) @binding(2) var<storage, read> chroma: array<i32>;
@group(0) @binding(3) var<storage, read_write> planes: array<u32>;

fn rgb(x: u32, y: u32) -> vec3<i32> {
    let c = textureLoad(canvas, vec2<i32>(i32(x + p.margin), i32(y + p.margin)), 0);
    return vec3<i32>(round(c.rgb * 255.0));
}

/// Luma: the 15-bit intermediate and its rounding to 8 bits.
fn luma(x: u32, y: u32) -> u32 {
    let c = rgb(x, y);
    let y14 = (5983 * c.r + 20127 * c.g + 2032 * c.b + (16 << 15) + (1 << 8)) >> 9;
    return u32(min(255, (2 * y14 + 64) >> 7));
}

/// The 15-bit U (`v` false) or V of the pair of pixels at `2 * cx` in row `y`: their sum, converted.
fn chroma15(cx: u32, y: u32, v: bool) -> i32 {
    let c = rgb(2u * cx, y) + rgb(2u * cx + 1u, y);
    var k = vec3<i32>(-3298, -11094, 14392);
    if v {
        k = vec3<i32>(14392, -13073, -1320);
    }
    return 2 * ((k.r * c.r + k.g * c.g + k.b * c.b + (256 << 15) + (1 << 9)) >> 10);
}

/// A chroma byte: the rows of the filter, weighted, rounded and clipped.
fn chroma8(cx: u32, cy: u32, v: bool) -> u32 {
    let at = cy * (p.taps + 1u);
    let first = u32(chroma[at]);
    var sum = 64 << 12;
    for (var j = 0u; j < p.taps; j++) {
        let w = chroma[at + 1u + j];
        if w != 0 {
            sum += chroma15(cx, first + j, v) * w;
        }
    }
    return u32(clamp(sum >> 19, 0, 255));
}

fn byte_at(i: u32) -> u32 {
    let luma_bytes = p.width * p.height;
    if i < luma_bytes {
        return luma(i % p.width, i / p.width);
    }
    let cw = p.width / 2u;
    let plane = cw * (p.height / 2u);
    let c = i - luma_bytes;
    let v = c >= plane;
    let k = select(c, c - plane, v);
    return chroma8(k % cw, k / cw, v);
}

@compute @workgroup_size(256)
fn convert(@builtin(global_invocation_id) id: vec3<u32>) {
    let word = id.y * p.row_words + id.x;
    let first = word * 4u;
    if first >= p.total {
        return;
    }
    var packed = 0u;
    for (var b = 0u; b < 4u; b++) {
        if first + b < p.total {
            packed |= byte_at(first + b) << (8u * b);
        }
    }
    planes[word] = packed;
}
