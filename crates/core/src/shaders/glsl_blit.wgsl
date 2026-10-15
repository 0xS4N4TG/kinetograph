// Places a WebGL layer's drawing buffer on the canvas. The buffer is an Rgba8
// texture holding what the page's shaders wrote, as a browser's canvas holds
// it: sRGB-encoded values, premultiplied by alpha unless the context was made
// with `premultipliedAlpha: false`. This pass draws the buffer's quad, taken to
// texels of the (padded) canvas texture by the layer's matrix, and converts
// each pixel to linear premultiplied light.

struct Params {
    // Texel position of each corner (xy) and its place in the buffer, 0..1
    // (zw): top left, top right, bottom left, bottom right.
    corners: array<vec4<f32>, 4>,
    // xy: the target's size in texels. z: 1 when the buffer is premultiplied.
    // w: 1 when the context has no alpha channel.
    flags: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var buffer_tex: texture_2d<f32>;
@group(0) @binding(2) var buffer_sampler: sampler;

struct Varying {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_glsl(@builtin(vertex_index) i: u32) -> Varying {
    var order = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);
    let c = params.corners[order[i]];
    // Texel space has y down, clip space y up.
    let x = c.x / params.flags.x * 2.0 - 1.0;
    let y = 1.0 - c.y / params.flags.y * 2.0;
    return Varying(vec4<f32>(x, y, 0.0, 1.0), c.zw);
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
    return select(hi, lo, c <= vec3<f32>(0.04045));
}

@fragment
fn fs_glsl(v: Varying) -> @location(0) vec4<f32> {
    let c = textureSample(buffer_tex, buffer_sampler, v.uv);
    var a = c.a;
    if params.flags.w > 0.5 {
        a = 1.0;
    }
    var straight = c.rgb;
    if params.flags.z > 0.5 && params.flags.w < 0.5 {
        straight = select(vec3<f32>(0.0), c.rgb / a, a > 0.0);
    }
    return vec4<f32>(srgb_to_linear(clamp(straight, vec3<f32>(0.0), vec3<f32>(1.0))) * a, a);
}
