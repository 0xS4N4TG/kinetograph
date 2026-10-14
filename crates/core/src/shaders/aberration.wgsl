// Chromatic aberration pass. Textures are Rgba16Float, linear, premultiplied.
//
//   fs_aberration: the red channel is read from `offset` pixels away from the
//                  output pixel, the blue channel from the same distance the
//                  other way, and green from the pixel itself. Reads are
//                  bilinear and on premultiplied values, so a channel taken
//                  from a faint edge stays faint. The alpha is the largest of
//                  the three samples' alphas, which keeps every channel at
//                  or below it. place.wgsl is put in front of this file by
//                  the compositor.

struct Params {
    // xy: offset in pixels of the red sample
    offset: vec4<f32>,
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

// Nothing outside the texture is part of the layer.
fn texel(xy: vec2<i32>) -> vec4<f32> {
    return load_a(xy);
}

// Bilinear read at p, a position in pixels where texel centres are at
// integer + 0.5 (the same convention as the fragment position).
fn sample_at(p: vec2<f32>) -> vec4<f32> {
    let q = p - vec2<f32>(0.5);
    let i = vec2<i32>(floor(q));
    let f = q - floor(q);
    let top = mix(texel(i), texel(i + vec2<i32>(1, 0)), f.x);
    let bottom = mix(texel(i + vec2<i32>(0, 1)), texel(i + vec2<i32>(1, 1)), f.x);
    return mix(top, bottom, f.y);
}

@fragment
fn fs_aberration(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let red = sample_at(canvas_pos(p) + params.offset.xy);
    let green = load_a(canvas_xy(p));
    let blue = sample_at(canvas_pos(p) - params.offset.xy);
    return vec4<f32>(red.r, green.g, blue.b, max(red.a, max(green.a, blue.a)));
}
