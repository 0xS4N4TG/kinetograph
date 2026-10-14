// Halftone pass. Textures are Rgba16Float, linear, premultiplied.
//
//   fs_halftone: replaces the layer with a halftone screen. The screen is a
//                grid of square cells `size` layer pixels wide, rotated by
//                `angle` degrees, so it moves, scales and rotates with the
//                layer. Each cell reads the layer once, at the cell's centre
//                (bilinear), and draws one dot there: value v = luminance x
//                alpha (or (1 - luminance) x alpha when inverted), with the
//                luminance Rec. 709 of the straight sRGB colour, as the colour
//                filters use it. The dot's area is the fraction v of the cell:
//
//                  circle  radius size * sqrt(v / pi); the dots touch at
//                          v = pi/4, and past that the part of the circle
//                          inside the cell has area v, so v = 1 is solid
//                  square  side size * sqrt(v)
//                  line    thickness size * v, along the grid's x axis
//
//                The dot is the colour sampled at the centre (straight, full
//                alpha), or the given colour with its alpha scaling the dot.
//                Edges fade over one canvas pixel; a dot never leaves its cell.
//                A cell whose centre lies outside the texture is empty.

struct Params {
    // The inverse of the layer matrix (texel -> layer): its linear part
    // a, b, c, d as kurbo orders them (x' = a x + c y + e, y' = b x + d y + f).
    inverse: vec4<f32>,
    // x, y: the inverse's translation e, f. z: the cell size. w: the angle in
    // radians.
    offset: vec4<f32>,
    // The layer matrix's linear part (layer -> texel).
    forward: vec4<f32>,
    // x: 0 circle, 1 square, 2 line. y: 1 when inverted. z: 1 to use `tint`.
    options: vec4<f32>,
    // The dot colour: linear straight rgb, then its alpha.
    tint: vec4<f32>,
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

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}

const PI: f32 = 3.14159265;

// The circle's radius for the area fraction `v` of a cell `size` wide. Up to
// v = pi/4 the circle fits in the cell, with area pi r^2. Past that it is
// clipped by the cell's four sides, so the area is pi r^2 minus four circular
// segments, which has no closed-form inverse; the radius is bisected (10
// halvings, an error under 0.0002 of the cell, always on the high side so
// v = 1 reaches exactly the half diagonal, where the cell is solid).
fn circle_radius(v: f32, size: f32) -> f32 {
    if v <= PI / 4.0 {
        return size * sqrt(v / PI);
    }
    var lo = 0.5;
    var hi = 0.70710678;
    for (var i = 0; i < 10; i++) {
        let r = 0.5 * (lo + hi);
        let area = PI * r * r - 4.0 * (r * r * acos(0.5 / r) - 0.5 * sqrt(r * r - 0.25));
        if area < v {
            lo = r;
        } else {
            hi = r;
        }
    }
    return size * hi;
}

// Coverage of a pixel `aa` wide whose centre is `dist` from the centre of a
// dot of half-size `r` (the edge fades over one pixel). A dot narrower than
// half a pixel fades out with its width instead of staying a half-lit speck.
fn coverage(dist: f32, r: f32, aa: f32) -> f32 {
    return clamp((r - dist) / aa + 0.5, 0.0, 1.0) * clamp(2.0 * r / aa, 0.0, 1.0);
}

@fragment
fn fs_halftone(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let size = params.offset.z;
    let inv = params.inverse;
    // The pixel's centre in layer space, and how long a pixel is there (the
    // layer matrix is a rotation and a uniform scale, so one number).
    let layer = vec2<f32>(
        inv.x * p.x + inv.z * p.y + params.offset.x,
        inv.y * p.x + inv.w * p.y + params.offset.y,
    );
    let aa = max(sqrt(abs(inv.x * inv.w - inv.y * inv.z)), 0.000001);

    // The grid's axes, and the pixel in the grid's own coordinates.
    let s = sin(params.offset.w);
    let c = cos(params.offset.w);
    let u = vec2<f32>(c, s);
    let w = vec2<f32>(-s, c);
    let q = vec2<f32>(dot(layer, u), dot(layer, w));
    let cell = floor(q / size);
    let centre_q = (cell + vec2<f32>(0.5)) * size;
    let inside = q - centre_q;

    // Where that cell's centre is on the texture.
    let centre = centre_q.x * u + centre_q.y * w;
    let d = centre - layer;
    let f = params.forward;
    let texel = p.xy + vec2<f32>(f.x * d.x + f.z * d.y, f.y * d.x + f.w * d.y);
    let dims = vec2<f32>(textureDimensions(tex));
    if any(texel < vec2<f32>(0.0)) || any(texel > dims) {
        return vec4<f32>(0.0);
    }
    let seen = textureSampleLevel(tex, samp, texel / dims, 0.0);
    if seen.a <= 0.0 {
        return vec4<f32>(0.0);
    }
    let straight = clamp(seen.rgb / seen.a, vec3<f32>(0.0), vec3<f32>(1.0));
    let l = dot(linear_to_srgb(straight), vec3<f32>(0.2126, 0.7152, 0.0722));
    let v = clamp(select(l, 1.0 - l, params.options.y > 0.5) * seen.a, 0.0, 1.0);

    // Each shape grows by half a pixel at v = 1, so its antialiased edge lies
    // beyond the cell's corners and the screen is exactly solid there.
    let grow = 0.5 * aa * v;
    var cov: f32;
    if params.options.x < 0.5 {
        cov = coverage(length(inside), circle_radius(v, size) + grow, aa);
    } else if params.options.x < 1.5 {
        cov = coverage(max(abs(inside.x), abs(inside.y)), 0.5 * size * sqrt(v) + grow, aa);
    } else {
        cov = coverage(abs(inside.y), 0.5 * size * v + grow, aa);
    }

    var color = straight;
    if params.options.z > 0.5 {
        color = params.tint.rgb;
        cov = cov * params.tint.a;
    }
    return vec4<f32>(color * cov, cov);
}
