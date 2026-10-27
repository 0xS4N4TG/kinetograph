// The passes the look effects of the colour grade (color_grade.wgsl) read from: blur, bloom and Kuwahara. HyperFrames'
// runtime runs the same passes in framebuffers before its main shader (packages/core/src/runtime/colorGrading.ts,
// Apache-2.0, heygen-com/hyperframes); here they run on the layer's texture, in canvas pixels, and write straight sRGB
// colour (what its framebuffers hold) into a texture the main pass reads.
//
//   fs_blur:      one direction of a 25-tap Gaussian (the blur effect, radius step / 12 a tap), or one of the two
//                 passes of the bloom: thresholded 9-tap Gaussian, the first reading the picture.
//   fs_moments:   the Kuwahara filter's first pass: the mean and mean square of the colour along a row.
//   fs_kuwahara:  its second: the four quadrants' means and variances, weighted by how flat each is.
//
// `tex_a` is the input (the layer, linear premultiplied, when `flags.x` is 0; a pass's own straight sRGB output when
// 1); `tex_b` the blur texture the Kuwahara pass mixes in. `bounds` is the box of the layer's pixels in the canvas.

struct Params {
    // x0, y0, x1, y1: the layer's bounds in canvas pixels.
    bounds: vec4<f32>,
    // x, y: the direction of the pass. z: the step in canvas pixels. w: 0 for the blur, 1 for the bloom's first pass
    // (thresholded), 2 for its second.
    pass_a: vec4<f32>,
    // x: 1 when `tex_a` holds straight sRGB colour already. y: the Kuwahara radius in pixels. z: its sharpness.
    // w: its saturation.
    flags: vec4<f32>,
    // x: how much of the blur texture the Kuwahara pass mixes in (0 for none).
    mix_blur: vec4<f32>,
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

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}

fn load_b(xy: vec2<i32>) -> vec4<f32> {
    let q = xy - place.b.xy;
    if any(q < vec2<i32>(0)) || any(q >= place.b.zw) {
        return vec4<f32>(0.0);
    }
    return textureLoad(tex_b, q, 0);
}

// The input's texel as straight sRGB colour with its alpha.
fn input_texel(xy: vec2<i32>) -> vec4<f32> {
    let c = load_a(xy);
    if params.flags.x > 0.5 {
        return c;
    }
    if c.a <= 0.0 {
        return vec4<f32>(0.0);
    }
    return vec4<f32>(linear_to_srgb(clamp(c.rgb / c.a, vec3<f32>(0.0), vec3<f32>(1.0))), c.a);
}

// The same texel with the coordinates held inside the layer's bounds (clamp to edge).
fn clamped_texel(xy: vec2<i32>) -> vec4<f32> {
    let lo = vec2<i32>(params.bounds.xy);
    let hi = vec2<i32>(params.bounds.zw) - vec2<i32>(1);
    return input_texel(clamp(xy, lo, hi));
}

// Bilinear read at the continuous pixel `pos`, straight colour, clamped to the bounds.
fn read_bilinear(pos: vec2<f32>) -> vec4<f32> {
    let q = pos - vec2<f32>(0.5);
    let i = floor(q);
    let f = q - i;
    let xy = vec2<i32>(i);
    let a = clamped_texel(xy);
    let b = clamped_texel(xy + vec2<i32>(1, 0));
    let c = clamped_texel(xy + vec2<i32>(0, 1));
    let d = clamped_texel(xy + vec2<i32>(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// The blur's reader: colour premultiplied by alpha, so a transparent edge does not bleed its colour in.
fn blur_read(pos: vec2<f32>) -> vec4<f32> {
    var c = read_bilinear(pos);
    c = vec4<f32>(c.rgb * c.a, c.a);
    return c;
}

// The bloom's reader: the colour above the threshold, with an alpha of 1.
fn bloom_read(pos: vec2<f32>) -> vec4<f32> {
    let c = read_bilinear(pos);
    var rgb = c.rgb;
    if params.pass_a.w < 1.5 {
        let luminance = dot(rgb, vec3<f32>(0.299, 0.587, 0.114));
        if luminance <= 0.5 {
            rgb = vec3<f32>(0.0);
        }
    }
    return vec4<f32>(rgb, 1.0);
}

@fragment
fn fs_blur(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let pos = canvas_pos(p);
    let dir = params.pass_a.xy;
    let step_px = dir * params.pass_a.z;
    if params.pass_a.w > 0.5 {
        var bloom = bloom_read(pos) * 0.227027;
        bloom += bloom_read(pos + step_px) * 0.1945946;
        bloom += bloom_read(pos - step_px) * 0.1945946;
        bloom += bloom_read(pos + step_px * 2.0) * 0.1216216;
        bloom += bloom_read(pos - step_px * 2.0) * 0.1216216;
        bloom += bloom_read(pos + step_px * 3.0) * 0.054054;
        bloom += bloom_read(pos - step_px * 3.0) * 0.054054;
        bloom += bloom_read(pos + step_px * 4.0) * 0.016216;
        bloom += bloom_read(pos - step_px * 4.0) * 0.016216;
        return bloom;
    }
    var weights = array<f32, 13>(
        0.08077993, 0.07918038, 0.07456928, 0.06747307, 0.05865827, 0.04899551, 0.03931982,
        0.03031761, 0.02245983, 0.01598624, 0.01093238, 0.00718308, 0.00453456,
    );
    var color = blur_read(pos) * weights[0];
    for (var k = 1; k <= 12; k++) {
        let off = step_px * f32(k);
        color += (blur_read(pos + off) + blur_read(pos - off)) * weights[k];
    }
    if color.a > 0.0001 {
        color = vec4<f32>(color.rgb / color.a, color.a);
    }
    return color;
}

// The picture the Kuwahara filter reads: straight colour, mixed with the blur texture when the blur is on.
fn kuwahara_input(xy: vec2<i32>) -> vec3<f32> {
    let lo = vec2<i32>(params.bounds.xy);
    let hi = vec2<i32>(params.bounds.zw) - vec2<i32>(1);
    let c = clamp(xy, lo, hi);
    var color = input_texel(c).rgb;
    if params.mix_blur.x > 0.0 {
        color = mix(color, load_b(c).rgb, clamp(params.mix_blur.x, 0.0, 1.0));
    }
    return color;
}

@fragment
fn fs_moments(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = canvas_xy(p);
    let radius = i32(params.flags.y);
    var sum = vec3<f32>(0.0);
    var sum_squares = 0.0;
    var count = 0.0;
    for (var offset = 0; offset <= 64; offset++) {
        if offset > radius {
            break;
        }
        let color = kuwahara_input(xy + vec2<i32>(offset, 0));
        sum += color;
        sum_squares += dot(color, color) / 3.0;
        count += 1.0;
    }
    return vec4<f32>(sum / count, sum_squares / count);
}

fn moment_texel(xy: vec2<i32>) -> vec4<f32> {
    let lo = vec2<i32>(params.bounds.xy);
    let hi = vec2<i32>(params.bounds.zw) - vec2<i32>(1);
    return load_a(clamp(xy, lo, hi));
}

@fragment
fn fs_kuwahara(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = canvas_xy(p);
    let radius = i32(params.flags.y);
    var origins = array<vec2<i32>, 4>(
        vec2<i32>(-radius, -radius),
        vec2<i32>(0, -radius),
        vec2<i32>(-radius, 0),
        vec2<i32>(0, 0),
    );
    var means: array<vec3<f32>, 4>;
    var variances: array<f32, 4>;
    var min_variance = 1.0;
    for (var quadrant = 0; quadrant < 4; quadrant++) {
        var moment = vec4<f32>(0.0);
        var count = 0.0;
        for (var offset = 0; offset <= 64; offset++) {
            if offset > radius {
                break;
            }
            moment += moment_texel(xy + origins[quadrant] + vec2<i32>(0, offset));
            count += 1.0;
        }
        moment /= count;
        let mean = moment.rgb;
        let mean_square = moment.a * 3.0;
        let variance = max(mean_square - dot(mean, mean), 0.0);
        means[quadrant] = mean;
        variances[quadrant] = variance;
        min_variance = min(min_variance, variance);
    }
    let exponent = 1.0 + clamp(params.flags.z, 0.0, 1.0) * 8.0;
    var result = vec3<f32>(0.0);
    var total_weight = 0.0;
    for (var quadrant = 0; quadrant < 4; quadrant++) {
        let weight = pow((min_variance + 0.0001) / (variances[quadrant] + 0.0001), exponent);
        result += means[quadrant] * weight;
        total_weight += weight;
    }
    result /= max(total_weight, 0.0001);
    let luma = dot(result, vec3<f32>(0.2126, 0.7152, 0.0722));
    let saturation = clamp(params.flags.w, 0.0, 1.0) * 2.0;
    return vec4<f32>(clamp(mix(vec3<f32>(luma), result, saturation), vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
