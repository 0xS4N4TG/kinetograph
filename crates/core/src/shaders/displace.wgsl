// Displacement pass. Textures are Rgba16Float, linear, premultiplied.
//
//   fs_displace: SVG's feTurbulence -> feDisplacementMap on the layer. An output
//                pixel takes the colour the layer has at
//
//                  P'(x, y) = P(x + scale * (XC - 0.5), y + scale * (YC - 0.5))
//
//                where (x, y) and `scale` are in LAYER space (SVG user space),
//                so the pattern and the push move, scale and rotate with the
//                layer, and XC, YC are the raw turbulence channel values (0..1)
//                the x and y selectors pick, at the pixel's centre in layer
//                space (turbulence.wgsl is put in front of this file by the
//                compositor). Colours are premultiplied when interpolated; what
//                lies outside the texture is transparent.

struct Params {
    // The inverse of the layer matrix (texel -> layer): its linear part
    // a, b, c, d as kurbo orders them (x' = a x + c y + e, y' = b x + d y + f).
    inverse: vec4<f32>,
    // x, y: the inverse's translation e, f. z: scale, in layer pixels.
    offset: vec4<f32>,
    // The layer matrix's linear part (layer -> texel).
    forward: vec4<f32>,
    // x, y: the noise's base frequency per axis.
    frequency: vec4<f32>,
    // x: octaves. y, z: the channel (0 R .. 3 A) that moves a pixel across and
    // down. w: 1 for fractalNoise, 0 for turbulence.
    options: vec4<u32>,
}

@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: Params;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs_displace(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let inv = params.inverse;
    // The pixel's centre in layer space.
    let layer = vec2<f32>(
        inv.x * p.x + inv.z * p.y + params.offset.x,
        inv.y * p.x + inv.w * p.y + params.offset.y,
    );
    let frequency = params.frequency.xy;
    let octaves = params.options.x;
    let fractal = params.options.w != 0u;
    let shift = params.offset.z * vec2<f32>(
        turbulence_value(params.options.y, layer, frequency, octaves, fractal) - 0.5,
        turbulence_value(params.options.z, layer, frequency, octaves, fractal) - 0.5,
    );

    // Where that is on the texture: the shift in layer space through the
    // matrix's linear part.
    let f = params.forward;
    let texel = p.xy + vec2<f32>(f.x * shift.x + f.z * shift.y, f.y * shift.x + f.w * shift.y);
    let dims = vec2<f32>(textureDimensions(tex));
    if any(texel < vec2<f32>(0.0)) || any(texel > dims) {
        return vec4<f32>(0.0);
    }
    return textureSampleLevel(tex, samp, texel / dims, 0.0);
}
