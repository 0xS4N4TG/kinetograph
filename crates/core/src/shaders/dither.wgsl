// Dither pass. Textures are Rgba16Float, linear, premultiplied.
//
//   fs_dither: quantises each channel of the layer's straight sRGB colour to
//              `levels` evenly spaced values, choosing between the two
//              nearest by comparing the colour's fractional part with a
//              threshold: an ordered 8x8 Bayer matrix, or seeded white noise.
//              Alpha is kept as it is, and fully transparent pixels stay
//              empty.
//
// The threshold belongs to a cell of `size` canvas pixels (the texel minus the
// margin, so it does not move when the margin changes). Random thresholds are
// a function of (seed, cell, frame) through hash.wgsl, which the compositor
// puts in front of this file.

struct Params {
    // x: levels, y: size, z: 0 for ordered, 1 for random
    a: vec4<f32>,
    // x: seed, y: frame (0 unless the random pattern animates), z: margin
    b: vec4<u32>,
}

// tex_a: the layer. tex_b is bound but unused (the compositor's shared layout).
@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var tex_b: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
    return select(hi, lo, c <= vec3<f32>(0.04045));
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}

// The 8x8 Bayer matrix, 0..63, from the bits of x and y: at each bit i (the
// finest first), x ^ y goes in the higher and y in the lower of the two bits
// that bit owns, the finest bit owning the top two.
fn bayer8(x: u32, y: u32) -> u32 {
    var v = 0u;
    for (var i = 0u; i < 3u; i++) {
        let xb = (x >> i) & 1u;
        let yb = (y >> i) & 1u;
        v |= (2u * (xb ^ yb) + yb) << (2u * (2u - i));
    }
    return v;
}

@fragment
fn fs_dither(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = vec2<i32>(p.xy);
    let c = textureLoad(tex_a, xy, 0);
    if c.a <= 0.0 {
        return vec4<f32>(0.0);
    }
    let straight = clamp(c.rgb / c.a, vec3<f32>(0.0), vec3<f32>(1.0));
    let srgb = linear_to_srgb(straight);

    let pixel = xy - vec2<i32>(i32(params.b.z));
    let cell = vec2<i32>(floor(vec2<f32>(pixel) / params.a.y));
    var threshold: f32;
    if params.a.z > 0.5 {
        threshold = unit_float(cell_hash(params.b.x, bitcast<u32>(cell.x), bitcast<u32>(cell.y), params.b.y));
    } else {
        threshold = (f32(bayer8(bitcast<u32>(cell.x) & 7u, bitcast<u32>(cell.y) & 7u)) + 0.5) / 64.0;
    }

    // The small offset keeps a value that should be exactly 1 (white after
    // the sRGB round trip may be a hair under) from falling to the level below
    // when the threshold is near 0; it is far under one level.
    let steps = params.a.x - 1.0;
    let q = clamp(floor(srgb * steps + vec3<f32>(threshold + 0.0001)) / steps, vec3<f32>(0.0), vec3<f32>(1.0));
    return vec4<f32>(srgb_to_linear(q) * c.a, c.a);
}
