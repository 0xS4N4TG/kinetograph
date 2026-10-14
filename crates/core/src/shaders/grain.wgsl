// Film grain pass. Textures are Rgba16Float, linear, premultiplied.
//
//   fs_grain: adds zero-mean noise to the layer's straight colour in sRGB
//             encoding and clamps to 0..1. Alpha is unchanged and fully
//             transparent pixels stay empty.
//
// The noise is a function of (seed, canvas pixel, frame) only, through the
// integer hash in hash.wgsl, which the compositor puts in front of this file.
// Canvas pixels are the texel minus the margin, so the grain stays on the
// screen when a layer moves and does not shift when the margin changes.
//
// Each lattice point has a triangular value in [-1, 1] (the sum of two
// uniform hashes, less 1), one per channel or one shared by all three. With
// `size` 1 every pixel is a lattice point. A larger size spaces the lattice
// `size` pixels apart and smooths between points with a smoothstep (value
// noise), so grain gets softer and fainter as it grows, but is not blocky.
// place.wgsl is put in front of this file by the compositor: the canvas pixel
// is the same whatever size the layer's texture has.

struct Params {
    // x: amount, y: size, z: 1 for monochrome grain, else 0
    a: vec4<f32>,
    // x: seed, y: frame (0 when the grain is not animated), z: margin
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

// Triangular noise in [-1, 1] from two hashes.
fn triangular(a: u32, b: u32) -> f32 {
    return unit_float(a) + unit_float(b) - 1.0;
}

// The noise at one lattice point, for r, g and b.
fn lattice(ix: i32, iy: i32) -> vec3<f32> {
    let h = cell_hash(params.b.x, bitcast<u32>(ix), bitcast<u32>(iy), params.b.y);
    let r0 = hash(h);
    let r1 = hash(r0);
    if params.a.z > 0.5 {
        return vec3<f32>(triangular(r0, r1));
    }
    let r2 = hash(r1);
    let r3 = hash(r2);
    let r4 = hash(r3);
    let r5 = hash(r4);
    return vec3<f32>(triangular(r0, r1), triangular(r2, r3), triangular(r4, r5));
}

fn grain_at(pixel: vec2<i32>) -> vec3<f32> {
    let size = params.a.y;
    if size <= 1.0 {
        return lattice(pixel.x, pixel.y);
    }
    let p = vec2<f32>(pixel) / size;
    let i = vec2<i32>(floor(p));
    let f = p - vec2<f32>(i);
    let w = f * f * (3.0 - 2.0 * f);
    let top = mix(lattice(i.x, i.y), lattice(i.x + 1, i.y), w.x);
    let bottom = mix(lattice(i.x, i.y + 1), lattice(i.x + 1, i.y + 1), w.x);
    return mix(top, bottom, w.y);
}

@fragment
fn fs_grain(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = canvas_xy(p);
    let c = load_a(xy);
    if c.a <= 0.0 {
        return vec4<f32>(0.0);
    }
    let straight = clamp(c.rgb / c.a, vec3<f32>(0.0), vec3<f32>(1.0));
    let noise = grain_at(xy - vec2<i32>(i32(params.b.z)));
    let rgb = clamp(linear_to_srgb(straight) + params.a.x * noise, vec3<f32>(0.0), vec3<f32>(1.0));
    return vec4<f32>(srgb_to_linear(rgb) * c.a, c.a);
}
