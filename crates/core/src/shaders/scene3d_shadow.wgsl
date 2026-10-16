// The shadow pass of the 3D layer (`compositor/scene3d.rs`): the meshes that
// cast shadows, drawn into a depth map from a directional light's point of
// view. Only depth is written, so there is no fragment stage; the map is read
// by `scene3d.wgsl`.

struct Draw {
    model: mat4x4<f32>,
}

// World space to the light's clip space (`draw::Shadow::view_proj`).
@group(0) @binding(0) var<uniform> light_view_proj: mat4x4<f32>;
@group(1) @binding(0) var<uniform> draw: Draw;

@vertex
fn vs_shadow(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
    return light_view_proj * (draw.model * vec4<f32>(position, 1.0));
}
