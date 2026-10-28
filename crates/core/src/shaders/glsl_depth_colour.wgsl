// A glsl layer's depth texture as a draw samples it: WebGL 2 reads a depth texture as (depth, 0, 0, 1), so its depth
// is copied texel for texel into the red channel of an R32Float texture, which samples so; WebGL 1 reads it as
// luminance, (depth, depth, depth, 1), which `fs_depth_luminance` writes into an Rgba32Float one.

@group(0) @binding(0) var depth_source: texture_depth_2d;

@vertex
fn vs_depth_colour(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    // One triangle that covers the target.
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs_depth_colour(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    return vec4<f32>(textureLoad(depth_source, vec2<i32>(p.xy), 0), 0.0, 0.0, 1.0);
}

@fragment
fn fs_depth_luminance(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let d = textureLoad(depth_source, vec2<i32>(p.xy), 0);
    return vec4<f32>(d, d, d, 1.0);
}
