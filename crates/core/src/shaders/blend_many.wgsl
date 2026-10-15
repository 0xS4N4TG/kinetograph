// Several blends in one pass: the canvas with up to seven layers composited
// over it in order, each by the same formula as `fs_blend` (composite.wgsl).
// All textures but a Vello page are Rgba16Float, linear light, premultiplied.
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
// A layer is either a texture (kind 0, in `a`) or a leaf that is still in its
// Vello page (kind 1: Rgba8, sRGB-encoded, straight alpha, drawn over the box
// `place`), which is cut out and converted to linear light inside `bounds` as
// `fs_to_linear` does, and, with a clip (`clipped`), multiplied by the alpha
// of the clip's page (`b`, placed by `clip`) as `fs_mask` does, each rounded
// to half floats as the textures of those passes would be.

const SLOTS: u32 = 7u;

struct Slot {
    // xy: the canvas pixel of `a`'s texel (0, 0). zw: its size in texels.
    place: vec4<i32>,
    // The same for the clip's page `b`.
    clip: vec4<i32>,
    // The canvas pixels the layer can be non-zero in: x0 y0 x1 y1.
    bounds: vec4<i32>,
    opacity: f32,
    mode: u32,
    // 0: a texture. 1: a leaf in a page. 2: a leaf in a page, with a clip.
    kind: u32,
    pad: u32,
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
@group(0) @binding(2) var b0: texture_2d<f32>;
@group(0) @binding(3) var a1: texture_2d<f32>;
@group(0) @binding(4) var b1: texture_2d<f32>;
@group(0) @binding(5) var a2: texture_2d<f32>;
@group(0) @binding(6) var b2: texture_2d<f32>;
@group(0) @binding(7) var a3: texture_2d<f32>;
@group(0) @binding(8) var b3: texture_2d<f32>;
@group(0) @binding(9) var a4: texture_2d<f32>;
@group(0) @binding(10) var b4: texture_2d<f32>;
@group(0) @binding(11) var a5: texture_2d<f32>;
@group(0) @binding(12) var b5: texture_2d<f32>;
@group(0) @binding(13) var a6: texture_2d<f32>;
@group(0) @binding(14) var b6: texture_2d<f32>;
@group(0) @binding(15) var<uniform> params: Params;

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

fn load_b_slot(i: u32, q: vec2<i32>) -> vec4<f32> {
    switch i {
        case 0u: {
            return textureLoad(b0, q, 0);
        }
        case 1u: {
            return textureLoad(b1, q, 0);
        }
        case 2u: {
            return textureLoad(b2, q, 0);
        }
        case 3u: {
            return textureLoad(b3, q, 0);
        }
        case 4u: {
            return textureLoad(b4, q, 0);
        }
        case 5u: {
            return textureLoad(b5, q, 0);
        }
        default: {
            return textureLoad(b6, q, 0);
        }
    }
}

fn inside(q: vec2<i32>, size: vec2<i32>) -> bool {
    return !(any(q < vec2<i32>(0)) || any(q >= size));
}

@fragment
fn fs_blend_many(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = vec2<i32>(p.xy) + params.target_origin.xy;
    var b = vec4<f32>(0.0);
    let cq = xy - params.canvas.xy;
    if inside(cq, params.canvas.zw) {
        b = textureLoad(canvas_tex, cq, 0);
    }
    for (var i = 0u; i < params.count.x; i++) {
        let slot = params.slots[i];
        if any(xy < slot.bounds.xy) || any(xy >= slot.bounds.zw) {
            continue;
        }
        let q = xy - slot.place.xy;
        var layer = vec4<f32>(0.0);
        if inside(q, slot.place.zw) {
            layer = load_a_slot(i, q);
        }
        if slot.kind != 0u {
            // The page's pixel as `fs_to_linear` converts it.
            let linear = vec4<f32>(srgb_to_linear(layer.rgb) * layer.a, layer.a);
            layer = vec4<f32>(
                store_f16(linear.x), store_f16(linear.y), store_f16(linear.z), store_f16(linear.w));
            if slot.kind == 2u {
                // And as `fs_mask` masks it by the clip's alpha.
                var clip = vec4<f32>(0.0);
                let cq2 = xy - slot.clip.xy;
                if inside(cq2, slot.clip.zw) {
                    clip = load_b_slot(i, cq2);
                }
                let masked = layer * clamp(clip.a, 0.0, 1.0);
                layer = vec4<f32>(
                    store_f16(masked.x), store_f16(masked.y), store_f16(masked.z), store_f16(masked.w));
            }
        }
        let s = layer * slot.opacity;
        let mode = slot.mode & 0xffffu;
        let a = s.a + b.a * (1.0 - s.a);
        if (slot.mode >> 16u) == 1u {
            // As `fs_blend` in sRGB (`Scene::blend_space`): the formulas on
            // the encoded colours, then back to linear light.
            if a <= 0.0 {
                b = vec4<f32>(0.0);
                continue;
            }
            let cb = linear_to_srgb(clamp(unpremultiply(b), vec3<f32>(0.0), vec3<f32>(1.0)));
            let cs = linear_to_srgb(clamp(unpremultiply(s), vec3<f32>(0.0), vec3<f32>(1.0)));
            let mixed_e = blend_fn(mode, cb, cs);
            let rgb_e = cs * s.a * (1.0 - b.a) + cb * b.a * (1.0 - s.a) + s.a * b.a * mixed_e;
            let rgb = srgb_to_linear(rgb_e / a) * a;
            b = vec4<f32>(store_f16(rgb.x), store_f16(rgb.y), store_f16(rgb.z), store_f16(a));
            continue;
        }
        let mixed = blend_fn(mode, unpremultiply(b), unpremultiply(s));
        let rgb = s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.a * b.a * mixed;
        b = vec4<f32>(store_f16(rgb.x), store_f16(rgb.y), store_f16(rgb.z), store_f16(a));
    }
    return b;
}
