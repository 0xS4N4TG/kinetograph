// Compositor passes. All intermediate textures are Rgba16Float, linear light,
// premultiplied alpha. Every pass draws one full-screen triangle and reads its
// inputs with textureLoad, so no samplers or filtering are involved.

struct Params {
    opacity: f32,
    mode: u32,
    pad0: u32,
    pad1: u32,
}

// Pass-specific meaning:
//   to_linear: tex_a = Vello output (Rgba8, sRGB-encoded, straight alpha)
//   blend:     tex_a = backdrop, tex_b = source
//   encode:    tex_a = linear premultiplied image
// Unused bindings are bound to the same texture as tex_a.
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

fn unpremultiply(c: vec4<f32>) -> vec3<f32> {
    if c.a > 0.0 {
        return c.rgb / c.a;
    }
    return vec3<f32>(0.0);
}

// Blend function B(backdrop, source) on unpremultiplied linear colours.
// Mode numbers match `mode_index` in compositor.rs. Add new modes here.
fn blend_fn(mode: u32, cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
    switch mode {
        // 0: normal
        default: {
            return cs;
        }
    }
}

@fragment
fn fs_to_linear(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = textureLoad(tex_a, vec2<i32>(p.xy), 0);
    return vec4<f32>(srgb_to_linear(c.rgb) * c.a, c.a);
}

// W3C compositing and blending with premultiplied inputs:
//   co = cs*(1 - ab) + cb*(1 - as) + as*ab*B(Cb, Cs)
// `opacity` scales the source before compositing.
@fragment
fn fs_blend(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = vec2<i32>(p.xy);
    let b = textureLoad(tex_a, xy, 0);
    let s = textureLoad(tex_b, xy, 0) * params.opacity;
    let mixed = blend_fn(params.mode, unpremultiply(b), unpremultiply(s));
    let rgb = s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.a * b.a * mixed;
    let a = s.a + b.a * (1.0 - s.a);
    return vec4<f32>(rgb, a);
}

// Linear premultiplied -> sRGB-encoded, straight alpha, for readback.
@fragment
fn fs_encode(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = textureLoad(tex_a, vec2<i32>(p.xy), 0);
    let rgb = clamp(unpremultiply(c), vec3<f32>(0.0), vec3<f32>(1.0));
    return vec4<f32>(linear_to_srgb(rgb), clamp(c.a, 0.0, 1.0));
}
