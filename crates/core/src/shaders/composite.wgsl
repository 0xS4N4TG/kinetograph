// Compositor passes. All intermediate textures are Rgba16Float, linear light,
// premultiplied alpha. Every pass draws one full-screen triangle and reads its
// inputs with textureLoad, so no samplers or filtering are involved.

struct Params {
    opacity: f32,
    mode: u32,
    pad0: u32,
    pad1: u32,
}

// Pass-specific meaning:
//   to_linear: tex_a = Vello output (Rgba8, sRGB-encoded, straight alpha)
//   blend:     tex_a = backdrop, tex_b = source
//   encode:    tex_a = linear premultiplied image
//   mask:      tex_a = layer (linear premultiplied), tex_b = Vello output
//              (Rgba8, sRGB-encoded, straight alpha) that says what to keep
//   accumulate: tex_a = running sum, tex_b = sample; `opacity` is its weight
//   matte:     tex_a = layer, tex_b = matte source (linear premultiplied);
//              `opacity` is the source layer's opacity
// Unused bindings are bound to the same texture as tex_a.
@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var tex_b: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
    return select(hi, lo, c <= vec3<f32>(0.04045));
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}

fn unpremultiply(c: vec4<f32>) -> vec3<f32> {
    if c.a > 0.0 {
        return c.rgb / c.a;
    }
    return vec3<f32>(0.0);
}

// Blend functions from the W3C Compositing and Blending Level 1 spec. They
// take unpremultiplied linear colours in 0..1.

fn screen(cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
    return cb + cs - cb * cs;
}

fn hard_light(cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
    return select(screen(cb, 2.0 * cs - vec3<f32>(1.0)), cb * 2.0 * cs, cs <= vec3<f32>(0.5));
}

fn color_dodge1(cb: f32, cs: f32) -> f32 {
    if cb == 0.0 {
        return 0.0;
    }
    if cs >= 1.0 {
        return 1.0;
    }
    return min(1.0, cb / (1.0 - cs));
}

fn color_burn1(cb: f32, cs: f32) -> f32 {
    if cb >= 1.0 {
        return 1.0;
    }
    if cs <= 0.0 {
        return 0.0;
    }
    return 1.0 - min(1.0, (1.0 - cb) / cs);
}

fn soft_light1(cb: f32, cs: f32) -> f32 {
    if cs <= 0.5 {
        return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
    }
    var d: f32;
    if cb <= 0.25 {
        d = ((16.0 * cb - 12.0) * cb + 4.0) * cb;
    } else {
        d = sqrt(cb);
    }
    return cb + (2.0 * cs - 1.0) * (d - cb);
}

fn lum(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.3, 0.59, 0.11));
}

fn clip_color(c: vec3<f32>) -> vec3<f32> {
    let l = lum(c);
    let n = min(c.r, min(c.g, c.b));
    let x = max(c.r, max(c.g, c.b));
    var out = c;
    if n < 0.0 {
        out = l + (out - l) * l / (l - n);
    }
    if x > 1.0 {
        out = l + (out - l) * (1.0 - l) / (x - l);
    }
    return out;
}

fn set_lum(c: vec3<f32>, l: f32) -> vec3<f32> {
    return clip_color(c + (l - lum(c)));
}

fn sat(c: vec3<f32>) -> f32 {
    return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
}

// Spec SetSat: the largest component becomes s, the smallest 0, the middle
// one is scaled between them.
fn set_sat(c: vec3<f32>, s: f32) -> vec3<f32> {
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    if mx > mn {
        return (c - vec3<f32>(mn)) * s / (mx - mn);
    }
    return vec3<f32>(0.0);
}

// B(backdrop, source). Mode numbers match `mode_index` in compositor.rs.
fn blend_fn(mode: u32, cb: vec3<f32>, cs: vec3<f32>) -> vec3<f32> {
    switch mode {
        // 1: multiply
        case 1u: {
            return cb * cs;
        }
        // 2: screen
        case 2u: {
            return screen(cb, cs);
        }
        // 3: overlay
        case 3u: {
            return hard_light(cs, cb);
        }
        // 4: darken
        case 4u: {
            return min(cb, cs);
        }
        // 5: lighten
        case 5u: {
            return max(cb, cs);
        }
        // 6: color-dodge
        case 6u: {
            return vec3<f32>(
                color_dodge1(cb.r, cs.r), color_dodge1(cb.g, cs.g), color_dodge1(cb.b, cs.b));
        }
        // 7: color-burn
        case 7u: {
            return vec3<f32>(
                color_burn1(cb.r, cs.r), color_burn1(cb.g, cs.g), color_burn1(cb.b, cs.b));
        }
        // 8: hard-light
        case 8u: {
            return hard_light(cb, cs);
        }
        // 9: soft-light
        case 9u: {
            return vec3<f32>(
                soft_light1(cb.r, cs.r), soft_light1(cb.g, cs.g), soft_light1(cb.b, cs.b));
        }
        // 10: difference
        case 10u: {
            return abs(cb - cs);
        }
        // 11: exclusion
        case 11u: {
            return cb + cs - 2.0 * cb * cs;
        }
        // 12: hue
        case 12u: {
            return set_lum(set_sat(cs, sat(cb)), lum(cb));
        }
        // 13: saturation
        case 13u: {
            return set_lum(set_sat(cb, sat(cs)), lum(cb));
        }
        // 14: color
        case 14u: {
            return set_lum(cs, lum(cb));
        }
        // 15: luminosity
        case 15u: {
            return set_lum(cb, lum(cs));
        }
        // 0: normal
        default: {
            return cs;
        }
    }
}

@fragment
fn fs_to_linear(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = textureLoad(tex_a, vec2<i32>(p.xy), 0);
    return vec4<f32>(srgb_to_linear(c.rgb) * c.a, c.a);
}

// W3C compositing and blending with premultiplied inputs:
//   co = cs*(1 - ab) + cb*(1 - as) + as*ab*B(Cb, Cs)
// `opacity` scales the source before compositing.
@fragment
fn fs_blend(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = vec2<i32>(p.xy);
    let b = textureLoad(tex_a, xy, 0);
    let s = textureLoad(tex_b, xy, 0) * params.opacity;
    let mixed = blend_fn(params.mode, unpremultiply(b), unpremultiply(s));
    let rgb = s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.a * b.a * mixed;
    let a = s.a + b.a * (1.0 - s.a);
    return vec4<f32>(rgb, a);
}

// How much of the layer a mask colour keeps. `m` is linear premultiplied.
// Modes: 0 alpha, 1 alpha inverted, 2 luminance (Rec. 709 on the linear
// colour; because `m` is premultiplied this is already times alpha), 3
// luminance inverted.
fn coverage(m: vec4<f32>, mode: u32) -> f32 {
    var c = m.a;
    if mode >= 2u {
        c = dot(m.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    }
    if mode % 2u == 1u {
        c = 1.0 - c;
    }
    return clamp(c, 0.0, 1.0);
}

// Multiplies the layer by what a Vello output keeps. A clip shape is drawn in
// opaque white, so its alpha is the anti-aliased coverage; a gradient mask
// is read by `mode`.
@fragment
fn fs_mask(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = vec2<i32>(p.xy);
    let v = textureLoad(tex_b, xy, 0);
    let m = vec4<f32>(srgb_to_linear(v.rgb) * v.a, v.a);
    return textureLoad(tex_a, xy, 0) * coverage(m, params.mode);
}

// Multiplies the layer by what a matte source (another layer, already
// rendered) keeps. The source's opacity counts, so a half-opaque source keeps
// half.
@fragment
fn fs_matte(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = vec2<i32>(p.xy);
    let m = textureLoad(tex_b, xy, 0) * params.opacity;
    return textureLoad(tex_a, xy, 0) * coverage(m, params.mode);
}

// Adds one sample of an average. The sum is premultiplied linear light, so a
// weighted sum of premultiplied pixels is the premultiplied average.
@fragment
fn fs_accumulate(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = vec2<i32>(p.xy);
    return textureLoad(tex_a, xy, 0) + textureLoad(tex_b, xy, 0) * params.opacity;
}

// Linear premultiplied -> sRGB-encoded, straight alpha, for readback.
@fragment
fn fs_encode(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = textureLoad(tex_a, vec2<i32>(p.xy), 0);
    let rgb = clamp(unpremultiply(c), vec3<f32>(0.0), vec3<f32>(1.0));
    return vec4<f32>(linear_to_srgb(rgb), clamp(c.a, 0.0, 1.0));
}
