// Passes that read a Vello page (Rgba8, sRGB-encoded, straight alpha) where
// the passes they replace read the linear texture that `fs_to_linear`
// (composite.wgsl) cut a leaf out of it. place.wgsl is put in front of this
// file: tex_a is the page, placed on the canvas, and what it holds is the
// pixels Vello drew of the page; outside them it is transparent.
//
// A leaf's texture is the page converted to linear premultiplied light,
// rounded to half floats as a render target stores them, inside the leaf's
// box and transparent outside it, which is where the page holds the other
// leaves of its page.

struct Params {
    // The leaf's box of the canvas: x0 y0 x1 y1.
    region: vec4<i32>,
    // xy: the shadow's offset in pixels. zw: the size of the canvas texture.
    shadow: vec4<f32>,
    // Linear premultiplied shadow colour.
    color: vec4<f32>,
}

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

// What the leaf's texture holds at the canvas pixel `xy`.
fn leaf_pixel(xy: vec2<i32>) -> vec4<f32> {
    if any(xy < params.region.xy) || any(xy >= params.region.zw) {
        return vec4<f32>(0.0);
    }
    let c = load_a(xy);
    let linear = vec4<f32>(srgb_to_linear(c.rgb) * c.a, c.a);
    return vec4<f32>(
        store_f16(linear.x), store_f16(linear.y), store_f16(linear.z), store_f16(linear.w));
}

// The inverted alpha of the leaf as `fs_spread` (shadow.wgsl) writes it with
// nothing to spread, 0 outside the canvas texture, where its texture ended.
fn inverted_alpha(xy: vec2<i32>) -> f32 {
    if any(xy < vec2<i32>(0)) || any(xy >= vec2<i32>(params.shadow.zw)) {
        return 0.0;
    }
    return store_f16(1.0 - leaf_pixel(xy).a);
}

fn inverted_shadow_alpha(p: vec2<f32>) -> f32 {
    let q = p - params.shadow.xy - vec2<f32>(0.5);
    let i = vec2<i32>(floor(q));
    let f = q - floor(q);
    let top = mix(inverted_alpha(i), inverted_alpha(i + vec2<i32>(1, 0)), f.x);
    let bottom = mix(inverted_alpha(i + vec2<i32>(0, 1)), inverted_alpha(i + vec2<i32>(1, 1)), f.x);
    return mix(top, bottom, f.y);
}

// The leaf's texture with an inset shadow with no blur and no spread over it
// (`fs_inset_inverted` in shadow.wgsl).
@fragment
fn fs_inset_page(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let layer = leaf_pixel(canvas_xy(p));
    let shadow = params.color * (inverted_shadow_alpha(canvas_pos(p)) * layer.a);
    return shadow + layer * (1.0 - shadow.a);
}
