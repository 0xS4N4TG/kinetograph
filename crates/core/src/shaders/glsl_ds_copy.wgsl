// `blitFramebuffer` of DEPTH_BUFFER_BIT and STENCIL_BUFFER_BIT between two of a glsl layer's depth and stencil buffers
// (the drawing buffer's, or a framebuffer's): the source rectangle over the destination rectangle, texel for texel
// (NEAREST, the only filter GL takes for these). `fs_depth` writes the source's depth. A fragment shader cannot write
// stencil, so the stencil is copied a bit at a time: `fs_stencil_zero` runs with a pipeline that zeroes it, then
// `fs_stencil_bit` once for each bit, with a pipeline whose write mask is that bit and whose operation sets it, and
// keeps only the fragments whose source has the bit. The rectangles are as in `glsl_copy.wgsl`.

struct Params {
    // x: the destination's height, y: 1 when it is the drawing buffer (rows from the top),
    // z, w: the source's size.
    dst: vec4<f32>,
    // x: 1 when the source is the drawing buffer; z: the stencil bit.
    src: vec4<f32>,
    // The destination rectangle x0, y0, x1, y1 as the call gave it (may be reversed to mirror).
    dest: vec4<f32>,
    // The source rectangle.
    origin: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var depth_source: texture_depth_2d;
@group(0) @binding(2) var stencil_source: texture_2d<u32>;

@vertex
fn vs_copy(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    // One triangle that covers the target.
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

// The source texel under the destination pixel at `p`.
fn texel(p: vec4<f32>) -> vec2<i32> {
    let gl_y = select(p.y, params.dst.x - p.y, params.dst.y > 0.5);
    let t = (vec2<f32>(p.x, gl_y) - params.dest.xy) / (params.dest.zw - params.dest.xy);
    let s = params.origin.xy + t * (params.origin.zw - params.origin.xy);
    let size = params.dst.zw;
    let at = vec2<i32>(floor(s));
    let row = select(at.y, i32(size.y) - 1 - at.y, params.src.x > 0.5);
    return clamp(vec2<i32>(at.x, row), vec2<i32>(0), vec2<i32>(size) - vec2<i32>(1));
}

@fragment
fn fs_depth(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {
    return textureLoad(depth_source, texel(p), 0);
}

@fragment
fn fs_stencil_zero(@builtin(position) p: vec4<f32>) {
}

@fragment
fn fs_stencil_bit(@builtin(position) p: vec4<f32>) {
    let s = textureLoad(stencil_source, texel(p), 0).r;
    if ((s >> u32(params.src.z)) & 1u) == 0u {
        discard;
    }
}
