// Glow pass. Textures are Rgba16Float, linear, premultiplied.
//
//   fs_glow: the layer (tex_a) composited over a halo made from its blurred
//            copy (tex_b). The halo is the blurred layer, or, when a colour
//            is given, that colour scaled by the blurred layer's alpha,
//            times the intensity. A halo that comes out brighter than
//            opaque is scaled back to alpha 1, which keeps its colour.
//            place.wgsl is put in front of this file by the compositor.

struct Params {
    // x: intensity, y: 1 to tint the halo with `color`, 0 to use the
    // blurred layer's own colours
    glow: vec4<f32>,
    // linear premultiplied halo colour
    color: vec4<f32>,
}

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

@fragment
fn fs_glow(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = canvas_xy(p);
    let layer = load_a(xy);
    let blurred = load_b(xy);
    var halo = blurred;
    if params.glow.y > 0.5 {
        halo = params.color * blurred.a;
    }
    halo = halo * params.glow.x;
    if halo.a > 1.0 {
        halo = halo / halo.a;
    }
    return layer + halo * (1.0 - layer.a);
}
