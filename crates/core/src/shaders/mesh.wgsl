// Mesh gradient layer pass. Draws the triangles the CPU tessellated
// (mesh.rs) into a 4x multisampled Rgba16Float target, which the render pass
// resolves into a plain layer texture: linear, premultiplied.
//
// Each vertex carries its position in texels of the padded canvas and its
// colour in sRGB with straight alpha. The colour is interpolated across the
// triangle as it is, which is the space a mesh gradient is specified in, and
// only converted per fragment: to linear light, premultiplied by alpha. The
// multisample resolve then averages that, so the mesh's outer edge is
// anti-aliased by its coverage.

struct Params {
    // x, y: the target's size in texels.
    size: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;

struct Vertex {
    @location(0) position: vec2<f32>,
    @location(1) color: vec4<f32>,
}

struct Varying {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
}

@vertex
fn vs_mesh(v: Vertex) -> Varying {
    // Texel space has y down, clip space y up.
    let x = v.position.x / params.size.x * 2.0 - 1.0;
    let y = 1.0 - v.position.y / params.size.y * 2.0;
    return Varying(vec4<f32>(x, y, 0.0, 1.0), v.color);
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
    return select(hi, lo, c <= vec3<f32>(0.04045));
}

@fragment
fn fs_mesh(v: Varying) -> @location(0) vec4<f32> {
    let a = v.color.a;
    return vec4<f32>(srgb_to_linear(v.color.rgb) * a, a);
}
