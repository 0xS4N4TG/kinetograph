// Shadow passes. Textures are Rgba16Float, linear, premultiplied, and are
// read with exact texel loads; nothing outside a texture is part of the
// layer, so out-of-range reads give 0. A texture holds only part of the
// canvas (see place.wgsl, put in front of this file), and the pixels are the
// canvas's: the spread and the offset are in canvas pixels.
//
//   fs_spread: one axis of a square grow (spread > 0) or shrink (spread < 0)
//              of the alpha channel, with a fractional radius blended in so
//              animating the spread does not step. Optionally inverts the
//              result (1 - alpha) for inset shadows. Writes (0, 0, 0, alpha).
//   fs_drop:   the layer composited over a shadow made from the alpha of
//              tex_b, shifted by the offset, tinted by the colour.
//   fs_inset:  the layer, with a shadow made the same way composited over it
//              and kept to the layer's own shape.
//
// The Rust side runs fs_spread (if needed), then the blur, then one of the
// last two.

struct Params {
    // x: spread in pixels, yz: axis (1 = along it), w: 1 to invert
    spread: vec4<f32>,
    // xy: shadow offset in pixels
    offset: vec4<f32>,
    // linear premultiplied shadow colour
    color: vec4<f32>,
}

// tex_a: the layer (fs_spread: its alpha is spread). tex_b: the shadow alpha.
@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var tex_b: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

// The pixel `xy` of the canvas in tex_b: transparent outside the texture.
fn load_b(xy: vec2<i32>) -> vec4<f32> {
    let q = xy - place.b.xy;
    if any(q < vec2<i32>(0)) || any(q >= place.b.zw) {
        return vec4<f32>(0.0);
    }
    return textureLoad(tex_b, q, 0);
}

fn alpha_a(xy: vec2<i32>) -> f32 {
    return load_a(xy).a;
}

fn alpha_b(xy: vec2<i32>) -> f32 {
    return load_b(xy).a;
}

fn extreme(a: f32, b: f32, grow: bool) -> f32 {
    return select(min(a, b), max(a, b), grow);
}

@fragment
fn fs_spread(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = canvas_xy(p);
    let axis = vec2<i32>(params.spread.yz);
    let grow = params.spread.x > 0.0;
    let radius = abs(params.spread.x);
    let whole = i32(floor(radius));
    var v = alpha_a(xy);
    for (var i = 1; i <= whole; i++) {
        v = extreme(v, extreme(alpha_a(xy + i * axis), alpha_a(xy - i * axis), grow), grow);
    }
    // The part of a pixel beyond the whole radius: blend towards the result
    // of one more step.
    let part = radius - f32(whole);
    if part > 0.0 {
        let next = extreme(alpha_a(xy + (whole + 1) * axis), alpha_a(xy - (whole + 1) * axis), grow);
        v = mix(v, extreme(v, next, grow), part);
    }
    if params.spread.w > 0.5 {
        v = 1.0 - v;
    }
    return vec4<f32>(0.0, 0.0, 0.0, v);
}

// Bilinear read of tex_b's alpha at the pixel centre p moved back by the
// offset, so the shadow lands `offset` pixels from where it was.
fn shadow_alpha(p: vec2<f32>) -> f32 {
    let q = p - params.offset.xy - vec2<f32>(0.5);
    let i = vec2<i32>(floor(q));
    let f = q - floor(q);
    let top = mix(alpha_b(i), alpha_b(i + vec2<i32>(1, 0)), f.x);
    let bottom = mix(alpha_b(i + vec2<i32>(0, 1)), alpha_b(i + vec2<i32>(1, 1)), f.x);
    return mix(top, bottom, f.y);
}

@fragment
fn fs_drop(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let layer = load_a(canvas_xy(p));
    let shadow = params.color * shadow_alpha(canvas_pos(p));
    return layer + shadow * (1.0 - layer.a);
}

@fragment
fn fs_inset(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let layer = load_a(canvas_xy(p));
    let shadow = params.color * (shadow_alpha(canvas_pos(p)) * layer.a);
    return shadow + layer * (1.0 - shadow.a);
}
