// Dot matrix reveal pass. Textures are Rgba16Float, linear, premultiplied.
//
//   fs_dot_matrix: shows the layer through a grid of dots. The grid is made of
//                  square cells `size` layer pixels wide, axis-aligned in layer
//                  space, so it moves, scales and rotates with the layer. Each
//                  cell holds one dot, centred in it, that grows from nothing
//                  to more than the whole cell as `progress` runs from 0 to 1.
//                  The layer's pixels are multiplied by the dots' coverage, so
//                  at progress 1 the result is the layer itself, untouched.
//
//                  A cell starts growing after its delay d in 0..stagger:
//                  random per cell (a hash of the seed and the cell), or, for
//                  a sweep, by how far along `angle` the cell's centre lies
//                  across the layer's box. It then reaches full size when
//                  progress is d + (1 - stagger), so the last cell is done
//                  exactly at progress 1:
//
//                    grown = clamp((progress - d) / (1 - stagger), 0, 1)
//
//                  The dot's radius (a circle) or half side (a square) is
//                  `grown` times the distance to the cell's farthest corner
//                  (or side), plus half a pixel, so grown = 1 is exactly solid
//                  everywhere in the cell. Edges fade over one canvas pixel.
//                  hash.wgsl is put in front of this file by the compositor.

struct Params {
    // The inverse of the layer matrix (texel -> layer): its linear part
    // a, b, c, d as kurbo orders them (x' = a x + c y + e, y' = b x + d y + f).
    inverse: vec4<f32>,
    // x, y: the inverse's translation e, f. z: the cell size.
    offset: vec4<f32>,
    // x: progress. y: stagger. z: 0 circle, 1 square. w: 0 random, 1 sweep.
    options: vec4<f32>,
    // For a sweep: the direction (cos, sin), the position of the box's
    // nearest corner along it, and 1 / the box's extent along it (0 if the
    // box has none).
    sweep: vec4<f32>,
    // x: seed.
    seed: vec4<u32>,
}

// tex_a: the layer. tex_b is bound but unused (the compositor's shared layout).
@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var tex_b: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

// Coverage of a pixel `aa` wide whose centre is `dist` from the centre of a
// dot of half-size `r` (the edge fades over one pixel). A dot narrower than
// half a pixel fades out with its width instead of staying a half-lit speck.
fn coverage(dist: f32, r: f32, aa: f32) -> f32 {
    return clamp((r - dist) / aa + 0.5, 0.0, 1.0) * clamp(2.0 * r / aa, 0.0, 1.0);
}

@fragment
fn fs_dot_matrix(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = textureLoad(tex_a, vec2<i32>(p.xy), 0);
    let size = params.offset.z;
    let inv = params.inverse;
    // The pixel's centre in layer space, and how long a pixel is there (the
    // layer matrix is a rotation and a uniform scale, so one number).
    let layer = vec2<f32>(
        inv.x * p.x + inv.z * p.y + params.offset.x,
        inv.y * p.x + inv.w * p.y + params.offset.y,
    );
    let aa = max(sqrt(abs(inv.x * inv.w - inv.y * inv.z)), 0.000001);

    let cell = floor(layer / size);
    let centre = (cell + vec2<f32>(0.5)) * size;
    let inside = layer - centre;

    var unit: f32;
    if params.options.w < 0.5 {
        unit = unit_float(cell_hash(params.seed.x, bitcast<u32>(i32(cell.x)), bitcast<u32>(i32(cell.y)), 0u));
    } else {
        let along = dot(centre, params.sweep.xy);
        unit = clamp((along - params.sweep.z) * params.sweep.w, 0.0, 1.0);
    }
    let delay = params.options.y * unit;
    let grown = clamp((params.options.x - delay) / (1.0 - params.options.y), 0.0, 1.0);

    var cov: f32;
    if params.options.z < 0.5 {
        let r = grown * (0.5 * size * sqrt(2.0) + 0.5 * aa);
        cov = coverage(length(inside), r, aa);
    } else {
        let r = grown * (0.5 * size + 0.5 * aa);
        cov = coverage(max(abs(inside.x), abs(inside.y)), r, aa);
    }
    return c * cov;
}
