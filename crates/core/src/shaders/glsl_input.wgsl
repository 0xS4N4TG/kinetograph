// Turns a child of a shader group (`GroupLayer::glsl`) into the texture the
// group's GLSL samples: the layer drawn on the canvas, as a browser would
// upload a canvas it had drawn it on. Rgba8, sRGB-encoded, straight alpha, and
// the same size as the group's drawing buffer, whose row 0 is the top of the
// box. The buffer's pixel `(x, y)` is the point `(x, y)` of the group's box,
// which the group's matrix takes to a pixel of the padded canvas, read from
// the layer's texture (linear, premultiplied) with a bilinear filter.

struct Params {
    // The matrix's a, b, c, d: x' = a x + c y + e, y' = b x + d y + f.
    abcd: vec4<f32>,
    // e, f.
    ef: vec4<f32>,
    // xy: the canvas pixel of the texture's texel (0, 0). zw: its size.
    texture: vec4<f32>,
    // x: 1 to multiply the colour by the alpha (UNPACK_PREMULTIPLY_ALPHA_WEBGL).
    flags: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var layer_tex: texture_2d<f32>;
@group(0) @binding(2) var layer_sampler: sampler;

@vertex
fn vs_input(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    // One triangle that covers the target.
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}

@fragment
fn fs_input(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let m = params.abcd;
    let canvas = vec2<f32>(
        m.x * p.x + m.z * p.y + params.ef.x,
        m.y * p.x + m.w * p.y + params.ef.y,
    );
    let uv = (canvas - params.texture.xy) / params.texture.zw;
    let c = textureSampleLevel(layer_tex, layer_sampler, uv, 0.0);
    let straight = select(vec3<f32>(0.0), c.rgb / c.a, c.a > 0.0);
    let a = clamp(c.a, 0.0, 1.0);
    let encoded = linear_to_srgb(clamp(straight, vec3<f32>(0.0), vec3<f32>(1.0)));
    return vec4<f32>(select(encoded, encoded * a, params.flags.x > 0.5), a);
}
