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
//
//                The result must not depend on the scene's margin, which only
//                says how far the texture reaches past the canvas. So the
//                matrix is the layer's on the CANVAS (the margin taken out),
//                the noise is evaluated at the canvas pixel, which is exact in
//                f32 whatever the margin, and the layer is read with a
//                bilinear filter written out on `textureLoad`: the hardware
//                works its weights out from the texture's size and position
//                in 8 bits, which differ with the margin by a level or more.

struct Params {
    // The inverse of the layer matrix (canvas -> layer): its linear part
    // a, b, c, d as kurbo orders them (x' = a x + c y + e, y' = b x + d y + f).
    inverse: vec4<f32>,
    // x, y: the inverse's translation e, f. z: scale, in layer pixels. w: the
    // margin in pixels (a whole number), the texel of the canvas's pixel (0, 0).
    offset: vec4<f32>,
    // The layer matrix's linear part (layer -> canvas).
    forward: vec4<f32>,
    // x, y: the noise's base frequency per axis.
    frequency: vec4<f32>,
    // x: octaves. y, z: the channel (0 R .. 3 A) that moves a pixel across and
    // down. w: 1 for fractalNoise, 0 for turbulence.
    options: vec4<u32>,
}

@group(0) @binding(0) var tex: texture_2d<f32>;
// Bound by the compositor's filtered layout but not used: see above.
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: Params;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

// The texel `xy` of the layer: transparent outside the texture.
fn load_texel(xy: vec2<i32>) -> vec4<f32> {
    if any(xy < vec2<i32>(0)) || any(xy >= vec2<i32>(textureDimensions(tex))) {
        return vec4<f32>(0.0);
    }
    return textureLoad(tex, xy, 0);
}

@fragment
fn fs_displace(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let inv = params.inverse;
    let margin = vec2<f32>(params.offset.w);
    // The pixel's centre on the canvas, and in layer space.
    let pixel = p.xy - margin;
    let layer = vec2<f32>(
        inv.x * pixel.x + inv.z * pixel.y + params.offset.x,
        inv.y * pixel.x + inv.w * pixel.y + params.offset.y,
    );
    let frequency = params.frequency.xy;
    let octaves = params.options.x;
    let fractal = params.options.w != 0u;
    let shift = params.offset.z * vec2<f32>(
        turbulence_value(params.options.y, layer, frequency, octaves, fractal) - 0.5,
        turbulence_value(params.options.z, layer, frequency, octaves, fractal) - 0.5,
    );

    // Where that is on the canvas: the shift in layer space through the
    // matrix's linear part. The filter's four texels start half a pixel back,
    // at the floor of that, and its weights are the fraction; both are worked
    // out from canvas positions, and only the texel index adds the margin.
    let f = params.forward;
    let moved = vec2<f32>(f.x * shift.x + f.z * shift.y, f.y * shift.x + f.w * shift.y);
    let at = pixel + moved - vec2<f32>(0.5);
    let base = floor(at);
    let t = at - base;
    let xy = vec2<i32>(base) + vec2<i32>(margin);
    let top = mix(load_texel(xy), load_texel(xy + vec2<i32>(1, 0)), t.x);
    let bottom = mix(load_texel(xy + vec2<i32>(0, 1)), load_texel(xy + vec2<i32>(1, 1)), t.x);
    return mix(top, bottom, t.y);
}
