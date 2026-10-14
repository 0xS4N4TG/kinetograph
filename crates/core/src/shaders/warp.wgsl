// Warp pass. Textures are Rgba16Float, linear, premultiplied.
//
//   fs_warp: moves the layer by a homography H of the padded canvas's pixels
//            (a layer turned in 3D and seen through the camera, or a corner
//            pin). For each output pixel, q = H^-1 (x, y, 1), and the colour
//            comes from the layer at the texel q.xy / q.z, read bilinearly on
//            premultiplied colour. What lies outside the texture is
//            transparent.
//
//            H maps a point (u, v, 1) of the layer to a point with the third
//            component w, and the point of the plane that lands on an output
//            pixel has w = 1 / q.z. So a plane point behind the eye (w <= 0) has
//            q.z <= 0, and is not drawn: the part of a plane that passes the
//            eye plane is cut off, not mirrored back onto the screen. The back
//            of a layer turned away is drawn, mirrored, as in CSS.

struct Params {
    // The rows of H^-1; the w components are unused.
    row0: vec4<f32>,
    row1: vec4<f32>,
    row2: vec4<f32>,
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
fn fs_warp(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let v = vec3<f32>(p.xy, 1.0);
    let q = vec3<f32>(dot(params.row0.xyz, v), dot(params.row1.xyz, v), dot(params.row2.xyz, v));
    if q.z <= 0.0 {
        return vec4<f32>(0.0);
    }
    let texel = q.xy / q.z;
    let dims = vec2<f32>(textureDimensions(tex));
    if any(texel < vec2<f32>(0.0)) || any(texel > dims) {
        return vec4<f32>(0.0);
    }
    return textureSampleLevel(tex, samp, texel / dims, 0.0);
}
