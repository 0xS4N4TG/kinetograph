// 3D LUT pass. The layer is Rgba16Float, linear, premultiplied.
//
//   fs_lut: looks the layer's straight sRGB colour up in a 3D table, with
//           trilinear interpolation done by hand from eight exact
//           `textureLoad`s (no sampler, so no filterable-format question and
//           the result is the same on every GPU), then cross-fades from the
//           original to that by `amount` in sRGB straight space. Alpha is
//           unchanged and fully transparent pixels stay empty. place.wgsl is
//           put in front of this file by the compositor (the layer is
//           `tex_a`, at binding 0; the table and the parameters sit at 1 and
//           2 as before, and the placement at 3).
//
// The table is an Rgba32Float 3D texture with the file's order: x is the red
// index, y green, z blue. Inputs are mapped from [domain_min, domain_max] to
// the grid and clamped to it; outputs are used as they are, clamped to 0..1.

struct Params {
    domain_min: vec4<f32>,
    domain_max: vec4<f32>,
    // x: points per axis, y: amount, z: 1 for tetrahedral, 0 for trilinear
    info: vec4<f32>,
}

@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var lut: texture_3d<f32>;
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

fn grid(base: vec3<i32>, offset: vec3<i32>) -> vec3<f32> {
    return textureLoad(lut, base + offset, 0).rgb;
}

// Four corners of the cell, walked from (0,0,0) to (1,1,1) in the order of
// the fractions, largest first: one of the six tetrahedra that share that
// diagonal. The weights are 1 - the largest, the gaps between the sorted
// fractions, and the smallest.
fn tetrahedral(base: vec3<i32>, f: vec3<f32>) -> vec3<f32> {
    let c000 = grid(base, vec3<i32>(0, 0, 0));
    let c111 = grid(base, vec3<i32>(1, 1, 1));
    var p1: vec3<f32>;
    var p2: vec3<f32>;
    var w: vec3<f32>;
    if f.x > f.y {
        if f.y > f.z {
            p1 = grid(base, vec3<i32>(1, 0, 0));
            p2 = grid(base, vec3<i32>(1, 1, 0));
            w = vec3<f32>(f.x, f.y, f.z);
        } else if f.x > f.z {
            p1 = grid(base, vec3<i32>(1, 0, 0));
            p2 = grid(base, vec3<i32>(1, 0, 1));
            w = vec3<f32>(f.x, f.z, f.y);
        } else {
            p1 = grid(base, vec3<i32>(0, 0, 1));
            p2 = grid(base, vec3<i32>(1, 0, 1));
            w = vec3<f32>(f.z, f.x, f.y);
        }
    } else {
        if f.z > f.y {
            p1 = grid(base, vec3<i32>(0, 0, 1));
            p2 = grid(base, vec3<i32>(0, 1, 1));
            w = vec3<f32>(f.z, f.y, f.x);
        } else if f.z > f.x {
            p1 = grid(base, vec3<i32>(0, 1, 0));
            p2 = grid(base, vec3<i32>(0, 1, 1));
            w = vec3<f32>(f.y, f.z, f.x);
        } else {
            p1 = grid(base, vec3<i32>(0, 1, 0));
            p2 = grid(base, vec3<i32>(1, 1, 0));
            w = vec3<f32>(f.y, f.x, f.z);
        }
    }
    // w is the fractions sorted, largest first.
    return c000 * (1.0 - w.x) + p1 * (w.x - w.y) + p2 * (w.y - w.z) + c111 * w.z;
}

fn lookup(rgb: vec3<f32>) -> vec3<f32> {
    let size = i32(params.info.x);
    let unit = clamp(
        (rgb - params.domain_min.xyz) / (params.domain_max.xyz - params.domain_min.xyz),
        vec3<f32>(0.0),
        vec3<f32>(1.0),
    );
    let at = unit * f32(size - 1);
    // The cell's lower corner. The last grid point is the top of the last
    // cell, so the corner never leaves the table.
    let base = min(vec3<i32>(floor(at)), vec3<i32>(size - 2));
    let f = at - vec3<f32>(base);
    if params.info.z > 0.5 {
        return clamp(tetrahedral(base, f), vec3<f32>(0.0), vec3<f32>(1.0));
    }
    let c00 = mix(grid(base, vec3<i32>(0, 0, 0)), grid(base, vec3<i32>(1, 0, 0)), f.x);
    let c10 = mix(grid(base, vec3<i32>(0, 1, 0)), grid(base, vec3<i32>(1, 1, 0)), f.x);
    let c01 = mix(grid(base, vec3<i32>(0, 0, 1)), grid(base, vec3<i32>(1, 0, 1)), f.x);
    let c11 = mix(grid(base, vec3<i32>(0, 1, 1)), grid(base, vec3<i32>(1, 1, 1)), f.x);
    return clamp(mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_lut(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = load_a(canvas_xy(p));
    if c.a <= 0.0 {
        return vec4<f32>(0.0);
    }
    let straight = clamp(c.rgb / c.a, vec3<f32>(0.0), vec3<f32>(1.0));
    let original = linear_to_srgb(straight);
    let graded = lookup(original);
    return vec4<f32>(srgb_to_linear(mix(original, graded, params.info.y)) * c.a, c.a);
}
