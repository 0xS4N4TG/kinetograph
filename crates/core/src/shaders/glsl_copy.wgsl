// `blitFramebuffer` between two of a glsl layer's buffers (the drawing buffer or a framebuffer's texture): the
// source rectangle (GL pixels, y up from the bottom row) stretched over the destination rectangle, NEAREST or LINEAR.
// The drawing buffer's rows count down from the top and a framebuffer texture's up from GL's bottom row; `top_down`
// says which a buffer is. Straight copy: no blending, no colour mask.

struct Params {
    // x: the destination's height, y: 1 when it is the drawing buffer (rows from the top),
    // z, w: the source's size.
    dst: vec4<f32>,
    // x: 1 when the source is the drawing buffer, y: 1 for LINEAR.
    src: vec4<f32>,
    // The destination rectangle x0, y0, x1, y1 as the call gave it (may be reversed to mirror).
    dest: vec4<f32>,
    // The source rectangle.
    origin: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;

@vertex
fn vs_copy(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    // One triangle that covers the target.
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs_copy(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    // The pixel's centre in GL's coordinates, and where it falls in the destination rectangle.
    let gl_y = select(p.y, params.dst.x - p.y, params.dst.y > 0.5);
    let t = (vec2<f32>(p.x, gl_y) - params.dest.xy) / (params.dest.zw - params.dest.xy);
    let s = params.origin.xy + t * (params.origin.zw - params.origin.xy);
    let size = params.dst.zw;
    let top_down = params.src.x > 0.5;
    if params.src.y > 0.5 {
        let v = select(s.y / size.y, 1.0 - s.y / size.y, top_down);
        return textureSampleLevel(source, source_sampler, vec2<f32>(s.x / size.x, v), 0.0);
    }
    let texel = vec2<i32>(floor(s));
    let row = select(texel.y, i32(size.y) - 1 - texel.y, top_down);
    let at = clamp(vec2<i32>(texel.x, row), vec2<i32>(0), vec2<i32>(size) - vec2<i32>(1));
    return textureLoad(source, at, 0);
}
