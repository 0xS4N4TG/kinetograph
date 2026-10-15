// Compositor passes. All intermediate textures are Rgba16Float, linear light,
// premultiplied alpha. Every pass draws one full-screen triangle and reads its
// inputs with textureLoad, so no samplers or filtering are involved. The
// textures need not be the size of the canvas: place.wgsl, put in front of
// this file, says where each sits on it.

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
//   mask:      tex_a = layer (linear premultiplied), tex_b = Vello output
//              (Rgba8, sRGB-encoded, straight alpha) that says what to keep
//   accumulate: tex_a = running sum, tex_b = sample; `opacity` is its weight
//   matte:     tex_a = layer, tex_b = matte source (linear premultiplied);
//              `opacity` is the source layer's opacity
// Unused bindings are bound to the same texture as tex_a.
@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var tex_b: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

// The pixel `xy` of the canvas in tex_b: transparent outside the texture.
fn load_b(xy: vec2<i32>) -> vec4<f32> {
    let q = xy - place.b.xy;
    if any(q < vec2<i32>(0)) || any(q >= place.b.zw) {
        return vec4<f32>(0.0);
    }
    return textureLoad(tex_b, q, 0);
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

// srgb_to_linear, linear_to_srgb, unpremultiply, blend_fn and the functions they use are
// in blend_math.wgsl, which the compositor puts in front of this file.

@fragment
fn fs_to_linear(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = load_a(canvas_xy(p));
    return vec4<f32>(srgb_to_linear(c.rgb) * c.a, c.a);
}

// W3C compositing and blending with premultiplied inputs:
//   co = cs*(1 - ab) + cb*(1 - as) + as*ab*B(Cb, Cs)
// `opacity` scales the source before compositing.
@fragment
fn fs_blend(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = canvas_xy(p);
    let b = load_a(xy);
    let s = load_b(xy) * params.opacity;
    let mixed = blend_fn(params.mode, unpremultiply(b), unpremultiply(s));
    let rgb = s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.a * b.a * mixed;
    let a = s.a + b.a * (1.0 - s.a);
    return vec4<f32>(rgb, a);
}

// How much of the layer a mask colour keeps. `m` is linear premultiplied.
// Modes: 0 alpha, 1 alpha inverted, 2 luminance (Rec. 709 on the linear
// colour; because `m` is premultiplied this is already times alpha), 3
// luminance inverted.
fn coverage(m: vec4<f32>, mode: u32) -> f32 {
    var c = m.a;
    if mode >= 2u {
        c = dot(m.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    }
    if mode % 2u == 1u {
        c = 1.0 - c;
    }
    return clamp(c, 0.0, 1.0);
}

// Multiplies the layer by what a Vello output keeps. A clip shape is drawn in
// opaque white, so its alpha is the anti-aliased coverage; a gradient mask
// is read by `mode`.
@fragment
fn fs_mask(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = canvas_xy(p);
    let v = load_b(xy);
    let m = vec4<f32>(srgb_to_linear(v.rgb) * v.a, v.a);
    return load_a(xy) * coverage(m, params.mode);
}

// Multiplies the layer by what a matte source (another layer, already
// rendered) keeps. The source's opacity counts, so a half-opaque source keeps
// half.
@fragment
fn fs_matte(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = canvas_xy(p);
    let m = load_b(xy) * params.opacity;
    return load_a(xy) * coverage(m, params.mode);
}

// Adds one sample of an average. The sum is premultiplied linear light, so a
// weighted sum of premultiplied pixels is the premultiplied average.
@fragment
fn fs_accumulate(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = canvas_xy(p);
    return load_a(xy) + load_b(xy) * params.opacity;
}

// Linear premultiplied -> sRGB-encoded, straight alpha, for readback.
@fragment
fn fs_encode(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = load_a(canvas_xy(p));
    let rgb = clamp(unpremultiply(c), vec3<f32>(0.0), vec3<f32>(1.0));
    return vec4<f32>(linear_to_srgb(rgb), clamp(c.a, 0.0, 1.0));
}
