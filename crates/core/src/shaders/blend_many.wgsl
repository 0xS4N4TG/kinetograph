// Several blends in one pass: the canvas with up to eight layers composited
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

const SLOTS: u32 = 8u;

struct Slot {
    // xy: the canvas pixel of the layer's texel (0, 0). zw: its size in texels.
    place: vec4<i32>,
    // The canvas pixels the layer can be non-zero in: x0 y0 x1 y1.
    bounds: vec4<i32>,
    opacity: f32,
    mode: u32,
    pad0: u32,
    pad1: u32,
}

struct Params {
    // xy: the canvas pixel of the target's texel (0, 0).
    target_origin: vec4<i32>,
    // xy: the canvas pixel of the canvas texture's texel (0, 0). zw: its size.
    canvas: vec4<i32>,
    // x: how many slots are used.
    count: vec4<u32>,
    slots: array<Slot, 8>,
}

@group(0) @binding(0) var canvas_tex: texture_2d<f32>;
@group(0) @binding(1) var t0: texture_2d<f32>;
@group(0) @binding(2) var t1: texture_2d<f32>;
@group(0) @binding(3) var t2: texture_2d<f32>;
@group(0) @binding(4) var t3: texture_2d<f32>;
@group(0) @binding(5) var t4: texture_2d<f32>;
@group(0) @binding(6) var t5: texture_2d<f32>;
@group(0) @binding(7) var t6: texture_2d<f32>;
@group(0) @binding(8) var t7: texture_2d<f32>;
@group(0) @binding(9) var<uniform> params: Params;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

fn load_slot(i: u32, q: vec2<i32>) -> vec4<f32> {
    switch i {
        case 0u: {
            return textureLoad(t0, q, 0);
        }
        case 1u: {
            return textureLoad(t1, q, 0);
        }
        case 2u: {
            return textureLoad(t2, q, 0);
        }
        case 3u: {
            return textureLoad(t3, q, 0);
        }
        case 4u: {
            return textureLoad(t4, q, 0);
        }
        case 5u: {
            return textureLoad(t5, q, 0);
        }
        case 6u: {
            return textureLoad(t6, q, 0);
        }
        default: {
            return textureLoad(t7, q, 0);
        }
    }
}

@fragment
fn fs_blend_many(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = vec2<i32>(p.xy) + params.target_origin.xy;
    var b = vec4<f32>(0.0);
    let cq = xy - params.canvas.xy;
    if !(any(cq < vec2<i32>(0)) || any(cq >= params.canvas.zw)) {
        b = textureLoad(canvas_tex, cq, 0);
    }
    for (var i = 0u; i < params.count.x; i++) {
        let slot = params.slots[i];
        if any(xy < slot.bounds.xy) || any(xy >= slot.bounds.zw) {
            continue;
        }
        let q = xy - slot.place.xy;
        var layer = vec4<f32>(0.0);
        if !(any(q < vec2<i32>(0)) || any(q >= slot.place.zw)) {
            layer = load_slot(i, q);
        }
        let s = layer * slot.opacity;
        let mixed = blend_fn(slot.mode, unpremultiply(b), unpremultiply(s));
        let rgb = s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.a * b.a * mixed;
        let a = s.a + b.a * (1.0 - s.a);
        b = vec4<f32>(store_f16(rgb.x), store_f16(rgb.y), store_f16(rgb.z), store_f16(a));
    }
    return b;
}
