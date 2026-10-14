// Colour filter pass. Textures are Rgba16Float, linear, premultiplied.
//
//   fs_color: applies a 4x5 colour matrix (see color::ColorMatrix) the way a
//             browser applies CSS filters: to straight alpha, sRGB-encoded
//             values, clamped to 0..1 afterwards. The result goes back to
//             linear premultiplied. Fully transparent pixels stay empty.
//             place.wgsl is put in front of this file by the compositor.

struct Params {
    // m[0..4]: the four coefficients of the output r, g, b, a rows.
    // m[4]: the offsets of the output r, g, b, a.
    m: array<vec4<f32>, 5>,
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

@fragment
fn fs_color(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = load_a(canvas_xy(p));
    if c.a <= 0.0 {
        return vec4<f32>(0.0);
    }
    let straight = clamp(c.rgb / c.a, vec3<f32>(0.0), vec3<f32>(1.0));
    let v = vec4<f32>(linear_to_srgb(straight), c.a);
    let out = clamp(
        vec4<f32>(
            dot(params.m[0], v),
            dot(params.m[1], v),
            dot(params.m[2], v),
            dot(params.m[3], v),
        ) + params.m[4],
        vec4<f32>(0.0),
        vec4<f32>(1.0),
    );
    return vec4<f32>(srgb_to_linear(out.rgb) * out.a, out.a);
}
