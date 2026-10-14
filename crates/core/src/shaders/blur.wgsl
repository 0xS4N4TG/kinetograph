// Dual Kawase blur passes. Textures are Rgba16Float, linear, premultiplied.
//
//   fs_pad:  copy the layer into the middle of a larger transparent texture
//   fs_down: 2x downsample, 5 taps (centre x4, four diagonal corners x1)
//   fs_up:   2x upsample, 8 taps (four axis taps x1, four diagonal taps x2)
//
// `offset` stretches the taps; the Rust side picks it so the whole chain
// approximates a Gaussian of the requested radius.

struct Params {
    // x: offset, yz: origin (pad: where the source starts in the target;
    // up: where the target starts inside the virtual output)
    a: vec4<f32>,
    // xy: size of the (virtual) output in pixels
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
    let uv = p.xy / params.b.xy;
    let d = params.a.x / vec2<f32>(textureDimensions(tex));
    var sum = tap(uv) * 4.0;
    sum += tap(uv + vec2<f32>(-d.x, -d.y));
    sum += tap(uv + vec2<f32>(d.x, -d.y));
    sum += tap(uv + vec2<f32>(-d.x, d.y));
    sum += tap(uv + vec2<f32>(d.x, d.y));
    return sum / 8.0;
}

@fragment
fn fs_up(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = (p.xy + params.a.yz) / params.b.xy;
    let h = 0.5 * params.a.x / vec2<f32>(textureDimensions(tex));
    var sum = tap(uv + vec2<f32>(-2.0 * h.x, 0.0));
    sum += tap(uv + vec2<f32>(2.0 * h.x, 0.0));
    sum += tap(uv + vec2<f32>(0.0, -2.0 * h.y));
    sum += tap(uv + vec2<f32>(0.0, 2.0 * h.y));
    sum += 2.0 * tap(uv + vec2<f32>(-h.x, h.y));
    sum += 2.0 * tap(uv + vec2<f32>(h.x, h.y));
    sum += 2.0 * tap(uv + vec2<f32>(h.x, -h.y));
    sum += 2.0 * tap(uv + vec2<f32>(-h.x, -h.y));
    return sum / 12.0;
}
