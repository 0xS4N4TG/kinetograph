// Noise layer pass. Textures are Rgba16Float, linear, premultiplied.
//
//   fs_noise: fills a box with the raw feTurbulence image. The input is the
//             box's coverage, drawn by Skia in opaque white through the layer
//             matrix (so the edge is anti-aliased like any shape's); this pass
//             replaces its colour with the noise and keeps its alpha as the
//             coverage.
//
//             The noise is evaluated at each pixel's centre in LAYER space, so
//             it sticks to the layer (turbulence.wgsl is put in front of this
//             file by the compositor). Its channels are used as SVG's
//             linearRGB feTurbulence has them, which is how the compositor
//             stores colour, so there is no conversion:
//
//               rgba  the four channels are red, green, blue and alpha, not
//                     premultiplied; the pass premultiplies them
//               gray  the red channel as grey, fully opaque
//
//             place.wgsl is put in front of this file by the compositor.

struct Params {
    // The inverse of the layer matrix (texel -> layer): its linear part
    // a, b, c, d as kurbo orders them (x' = a x + c y + e, y' = b x + d y + f).
    inverse: vec4<f32>,
    // x, y: the inverse's translation e, f.
    offset: vec4<f32>,
    // x, y: the noise's base frequency per axis.
    frequency: vec4<f32>,
    // x: octaves. y: 1 for fractalNoise, 0 for turbulence. z: 1 for gray.
    options: vec4<u32>,
}

// tex_a: the box's coverage in its alpha. tex_b is bound but unused (the
// compositor's shared layout).
@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var tex_b: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs_noise(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let coverage = load_a(canvas_xy(p)).a;
    if coverage <= 0.0 {
        return vec4<f32>(0.0);
    }
    let inv = params.inverse;
    let pos = canvas_pos(p);
    // The pixel's centre in layer space.
    let layer = vec2<f32>(
        inv.x * pos.x + inv.z * pos.y + params.offset.x,
        inv.y * pos.x + inv.w * pos.y + params.offset.y,
    );
    let frequency = params.frequency.xy;
    let octaves = params.options.x;
    let fractal = params.options.y != 0u;
    let red = turbulence_value(0u, layer, frequency, octaves, fractal);
    if params.options.z != 0u {
        return vec4<f32>(red, red, red, 1.0) * coverage;
    }
    let green = turbulence_value(1u, layer, frequency, octaves, fractal);
    let blue = turbulence_value(2u, layer, frequency, octaves, fractal);
    let alpha = turbulence_value(3u, layer, frequency, octaves, fractal);
    return vec4<f32>(red * alpha, green * alpha, blue * alpha, alpha) * coverage;
}
