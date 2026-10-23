// Several blends in one pass: the canvas with up to seven layers composited
// over it in order, each by the same formula as `fs_blend` (composite.wgsl).
// All textures are Rgba16Float, linear light, premultiplied.
//
// The passes this stands for each wrote the canvas to a texture of 16-bit
// floats and the next read it back, so the canvas is rounded to a half float
// (the way a render target stores it, `store_f16`) after every layer. A layer
// is read only inside its `bounds`, which is where it is not transparent; a
// pixel that no layer's bounds hold is the canvas as it was, and a pixel
// where a layer is transparent comes out as the canvas was, exactly (see
// `Compositor::blend`), so drawing the box that holds all the layers changes
// only what the separate passes changed.
//
// A run of layers can be a group, composited into a buffer of its own that starts
// transparent, as the pass that blends the group's children into the group's
// texture would, and then over the canvas with the group's opacity and blend
// mode, as the pass that blends the group's texture would. `flags` bit 0 says
// the group opens before the layer, bit 1 that it closes after it (the group's
// opacity and mode are `gopacity` and `gmode`, the box it can be non-zero in
// `gbounds`). The accumulator is rounded to half floats after every step, as
// the group's texture would be.

const SLOTS: u32 = 7u;

struct Slot {
    // xy: the canvas pixel of `a`'s texel (0, 0). zw: its size in texels.
    place: vec4<i32>,
    // The canvas pixels the layer can be non-zero in: x0 y0 x1 y1.
    bounds: vec4<i32>,
    opacity: f32,
    mode: u32,
    // Bit 0: a group opens before this slot's layer. Bit 1: it closes after it.
    flags: u32,
    pad: u32,
    gopacity: f32,
    gmode: u32,
    pad0: u32,
    pad1: u32,
    // The canvas pixels the group can be non-zero in.
    gbounds: vec4<i32>,
}

struct Params {
    // xy: the canvas pixel of the target's texel (0, 0).
    target_origin: vec4<i32>,
    // xy: the canvas pixel of the canvas texture's texel (0, 0). zw: its size.
    canvas: vec4<i32>,
    // x: how many slots are used.
    count: vec4<u32>,
    slots: array<Slot, 7>,
}

@group(0) @binding(0) var canvas_tex: texture_2d<f32>;
@group(0) @binding(1) var a0: texture_2d<f32>;
@group(0) @binding(2) var a1: texture_2d<f32>;
@group(0) @binding(3) var a2: texture_2d<f32>;
@group(0) @binding(4) var a3: texture_2d<f32>;
@group(0) @binding(5) var a4: texture_2d<f32>;
@group(0) @binding(6) var a5: texture_2d<f32>;
@group(0) @binding(7) var a6: texture_2d<f32>;
@group(0) @binding(8) var<uniform> params: Params;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

fn load_a_slot(i: u32, q: vec2<i32>) -> vec4<f32> {
    switch i {
        case 0u: {
            return textureLoad(a0, q, 0);
        }
        case 1u: {
            return textureLoad(a1, q, 0);
        }
        case 2u: {
            return textureLoad(a2, q, 0);
        }
        case 3u: {
            return textureLoad(a3, q, 0);
        }
        case 4u: {
            return textureLoad(a4, q, 0);
        }
        case 5u: {
            return textureLoad(a5, q, 0);
        }
        default: {
            return textureLoad(a6, q, 0);
        }
    }
}

fn inside(q: vec2<i32>, size: vec2<i32>) -> bool {
    return !(any(q < vec2<i32>(0)) || any(q >= size));
}

fn in_box(xy: vec2<i32>, box: vec4<i32>) -> bool {
    return !(any(xy < box.xy) || any(xy >= box.zw));
}

// `s` composited over `b` in the mode of `mode_word` (the mode, and in bit 16
// whether to composite in sRGB), the result rounded to half floats.
fn composite(b: vec4<f32>, s: vec4<f32>, mode_word: u32) -> vec4<f32> {
    let mode = mode_word & 0xffffu;
    let a = s.a + b.a * (1.0 - s.a);
    if (mode_word >> 16u) == 1u {
        // As `fs_blend` in sRGB (`Scene::blend_space`): the formulas on
        // the encoded colours, then back to linear light.
        if a <= 0.0 {
            return vec4<f32>(0.0);
        }
        let cb = linear_to_srgb(clamp(unpremultiply(b), vec3<f32>(0.0), vec3<f32>(1.0)));
        let cs = linear_to_srgb(clamp(unpremultiply(s), vec3<f32>(0.0), vec3<f32>(1.0)));
        let mixed_e = blend_fn(mode, cb, cs);
        let rgb_e = cs * s.a * (1.0 - b.a) + cb * b.a * (1.0 - s.a) + s.a * b.a * mixed_e;
        let rgb = srgb_to_linear(rgb_e / a) * a;
        return vec4<f32>(store_f16(rgb.x), store_f16(rgb.y), store_f16(rgb.z), store_f16(a));
    }
    let mixed = blend_fn(mode, unpremultiply(b), unpremultiply(s));
    let rgb = s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.a * b.a * mixed;
    return vec4<f32>(store_f16(rgb.x), store_f16(rgb.y), store_f16(rgb.z), store_f16(a));
}

@fragment
fn fs_blend_many(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = vec2<i32>(p.xy) + params.target_origin.xy;
    var b = vec4<f32>(0.0);
    let cq = xy - params.canvas.xy;
    if inside(cq, params.canvas.zw) {
        b = textureLoad(canvas_tex, cq, 0);
    }
    var acc = vec4<f32>(0.0);
    var open = false;
    for (var i = 0u; i < params.count.x; i++) {
        let slot = params.slots[i];
        if (slot.flags & 1u) != 0u {
            open = true;
            acc = vec4<f32>(0.0);
        }
        if in_box(xy, slot.bounds) {
            let q = xy - slot.place.xy;
            var layer = vec4<f32>(0.0);
            if inside(q, slot.place.zw) {
                layer = load_a_slot(i, q);
            }
            let s = layer * slot.opacity;
            if open {
                acc = composite(acc, s, slot.mode);
            } else {
                b = composite(b, s, slot.mode);
            }
        }
        if (slot.flags & 2u) != 0u {
            open = false;
            if in_box(xy, slot.gbounds) {
                b = composite(b, acc * slot.gopacity, slot.gmode);
            }
        }
    }
    return b;
}
