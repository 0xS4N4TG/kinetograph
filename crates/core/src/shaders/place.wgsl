// Where the textures of a pass sit on the padded canvas. The compositor puts
// this in front of every shader that calls `canvas_xy`, `canvas_pos` or
// `load_a` (see `shader_module`), and those shaders declare `tex_a` at
// binding 0.
//
// A layer's texture holds only the pixels from `origin` to `origin + size`
// of the canvas, and a pass writes a texture of its own the same way. So the
// fragment `p` is the canvas pixel `p + target_origin`, and the pixel `xy` of
// the canvas is the texel `xy - origin` of an input; what is outside the
// texture is transparent (layers are transparent outside their bounds, which
// the texture covers). Everything a shader works out from a position, a
// pattern that must not move with the layer, a layer's own coordinates, uses
// the canvas pixel, so it is the same whatever the texture's size.

struct Place {
    // xy: the canvas pixel of the target's texel (0, 0).
    target_origin: vec4<i32>,
    // xy: the canvas pixel of tex_a's texel (0, 0). zw: its size in texels.
    a: vec4<i32>,
    // The same for tex_b, in the shaders that have one.
    b: vec4<i32>,
}

@group(0) @binding(3) var<uniform> place: Place;

// The canvas pixel of the fragment at `p`.
fn canvas_xy(p: vec4<f32>) -> vec2<i32> {
    return vec2<i32>(p.xy) + place.target_origin.xy;
}

// Its centre, in pixels: the fragment position, moved to the canvas.
fn canvas_pos(p: vec4<f32>) -> vec2<f32> {
    return p.xy + vec2<f32>(place.target_origin.xy);
}

// The pixel `xy` of the canvas in tex_a: transparent outside the texture.
fn load_a(xy: vec2<i32>) -> vec4<f32> {
    let q = xy - place.a.xy;
    if any(q < vec2<i32>(0)) || any(q >= place.a.zw) {
        return vec4<f32>(0.0);
    }
    return textureLoad(tex_a, q, 0);
}
