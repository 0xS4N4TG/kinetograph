// Blur passes. Textures are Rgba16Float, linear, premultiplied.
//
//   fs_pad:   copy the layer into the middle of a larger transparent texture
//   fs_down:  2x downsample with the [1 3 3 1] / 8 filter per axis (4 bilinear
//             taps). This tent filter keeps the centre of mass of whatever it
//             shrinks, so a moving layer moves its blur by the same amount.
//   fs_gauss: one axis of a separable Gaussian, read with exact texel loads
//   fs_up:    2x upsample, one bilinear tap (the transpose of fs_down)
//
// The Rust side shrinks the layer until the Gaussian is at least a few texels
// wide, so the coarse grid cannot show.

struct Params {
    // x: sigma in texels, yz: origin (pad: where the source starts in the
    // target; gauss, up: where the target starts inside the virtual output)
    a: vec4<f32>,
    // xy: size of the (virtual) output in pixels, zw: gauss axis
    b: vec4<f32>,
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

fn tap(uv: vec2<f32>) -> vec4<f32> {
    return textureSampleLevel(tex, samp, uv, 0.0);
}

@fragment
fn fs_pad(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let q = vec2<i32>(p.xy) - vec2<i32>(params.a.yz);
    let size = vec2<i32>(textureDimensions(tex));
    if any(q < vec2<i32>(0)) || any(q >= size) {
        return vec4<f32>(0.0);
    }
    return textureLoad(tex, q, 0);
}

@fragment
fn fs_down(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    // The output texel centre sits on a corner between four input texels.
    // Taps 0.75 texel either side of it weigh the pairs 3:1.
    let uv = p.xy / params.b.xy;
    let d = 0.75 / vec2<f32>(textureDimensions(tex));
    var sum = tap(uv + vec2<f32>(-d.x, -d.y));
    sum += tap(uv + vec2<f32>(d.x, -d.y));
    sum += tap(uv + vec2<f32>(-d.x, d.y));
    sum += tap(uv + vec2<f32>(d.x, d.y));
    return sum / 4.0;
}

@fragment
fn fs_gauss(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let sigma = params.a.x;
    let reach = i32(ceil(3.0 * sigma));
    let last = vec2<i32>(textureDimensions(tex)) - vec2<i32>(1);
    let q = vec2<i32>(p.xy) + vec2<i32>(params.a.yz);
    let axis = vec2<i32>(params.b.zw);
    var sum = vec4<f32>(0.0);
    var weights = 0.0;
    for (var i = -reach; i <= reach; i++) {
        let w = exp(-0.5 * f32(i * i) / (sigma * sigma));
        sum += w * textureLoad(tex, clamp(q + i * axis, vec2<i32>(0), last), 0);
        weights += w;
    }
    return sum / weights;
}

@fragment
fn fs_up(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    return tap((p.xy + params.a.yz) / params.b.xy);
}
