// Blur passes. Textures are Rgba16Float, linear, premultiplied.
//
//   fs_pad:   copy the layer into the middle of a larger transparent texture.
//             The layer's texture holds only part of the canvas (its origin and
//             size come in `c`), and what is outside it is transparent
//   fs_down:  2x downsample with the [1 3 3 1] / 8 filter per axis (4 bilinear
//             taps). This tent filter keeps the centre of mass of whatever it
//             shrinks, so a moving layer moves its blur by the same amount.
//   fs_gauss: one axis of a separable Gaussian. The centre tap is an exact
//             texel load; the others are read in pairs, one filtered fetch
//             between two texels weighted for both
//   fs_up:    2x upsample, one bilinear tap (the transpose of fs_down)
//
// The Rust side shrinks the layer until the Gaussian is at least a few texels
// wide, so the coarse grid cannot show.

struct Params {
    // x: sigma in texels, yz: origin (pad: where the source starts in the
    // target; down, gauss, up: where the target's texel 0 is, against the
    // input's, see each pass)
    a: vec4<f32>,
    // xy: up: twice the input's size; zw: gauss axis
    b: vec4<f32>,
    // pad: xy: the canvas pixel of the source's texel (0, 0), zw: its size
    c: vec4<i32>,
    // pad: a box of the canvas (x0, y0, x1, y1) the source is read in,
    // mirrored past its edges; none when it is empty
    d: vec4<i32>,
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

// `x` reflected into lo..hi, again and again past either end.
fn mirrored(x: i32, lo: i32, hi: i32) -> i32 {
    let w = hi - lo;
    let t = ((x - lo) % (2 * w) + 2 * w) % (2 * w);
    return select(lo + t, lo + 2 * w - 1 - t, t >= w);
}

@fragment
fn fs_pad(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    // The canvas pixel that this texel of the padded image stands for, and
    // the texel of the source that is.
    var c = vec2<i32>(p.xy) - vec2<i32>(params.a.yz);
    let m = params.d;
    if m.z > m.x && m.w > m.y {
        c = vec2<i32>(mirrored(c.x, m.x, m.z), mirrored(c.y, m.y, m.w));
    }
    let q = c - params.c.xy;
    if any(q < vec2<i32>(0)) || any(q >= params.c.zw) {
        return vec4<f32>(0.0);
    }
    return textureLoad(tex, q, 0);
}

@fragment
fn fs_down(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    // The output texel centre sits on a corner between four input texels.
    // Taps 0.75 texel either side of it weigh the pairs 3:1. Each image holds
    // a window of its level: a.yz is where the output's texel 0 is in the
    // input's texels, times two, less where the input's texel 0 is.
    let size = vec2<f32>(textureDimensions(tex));
    let uv = (p.xy * 2.0 + params.a.yz) / size;
    let d = 0.75 / size;
    var sum = tap(uv + vec2<f32>(-d.x, -d.y));
    sum += tap(uv + vec2<f32>(d.x, -d.y));
    sum += tap(uv + vec2<f32>(-d.x, d.y));
    sum += tap(uv + vec2<f32>(d.x, d.y));
    return sum / 4.0;
}

fn gauss_weight(i: i32, sigma: f32) -> f32 {
    return exp(-0.5 * f32(i * i) / (sigma * sigma));
}

// The weights are those of one load per texel from -reach to reach. A pair of
// neighbouring texels i and i + 1 with weights w1 and w2 is read by one
// bilinear fetch at i + w2 / (w1 + w2), which weighs them w1 / (w1 + w2) and
// w2 / (w1 + w2), times the pair's weight w1 + w2. When reach is odd the last
// texel has no partner and is read on its own (w2 = 0). The sampler clamps to
// the edge texel on every tap of a fetch, as the loads clamped their indices,
// so no tap reads outside the texture.
@fragment
fn fs_gauss(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let sigma = params.a.x;
    let reach = i32(ceil(3.0 * sigma));
    let size = vec2<f32>(textureDimensions(tex));
    let last = vec2<i32>(textureDimensions(tex)) - vec2<i32>(1);
    let q = vec2<i32>(p.xy) + vec2<i32>(params.a.yz);
    let centre = vec2<f32>(q) + vec2<f32>(0.5);
    let axis = params.b.zw;
    var sum = textureLoad(tex, clamp(q, vec2<i32>(0), last), 0);
    var weights = 1.0;
    for (var i = 1; i <= reach; i += 2) {
        let w1 = gauss_weight(i, sigma);
        var w2 = 0.0;
        if i + 1 <= reach {
            w2 = gauss_weight(i + 1, sigma);
        }
        let w = w1 + w2;
        let offset = (f32(i) + w2 / w) * axis;
        sum += w * (tap((centre + offset) / size) + tap((centre - offset) / size));
        weights += 2.0 * w;
    }
    return sum / weights;
}

// The output texel at p reads the input at (p + a.yz) / 2 texels: a.yz is
// where the output's texel 0 is in its level, less twice where the input's is.
@fragment
fn fs_up(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    return tap((p.xy + params.a.yz) / params.b.xy);
}
