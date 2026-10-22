// SVG filter primitives (the `filterGraph` effect, src/filter.rs and
// src/compositor/filter_graph.rs). Textures are Rgba16Float and premultiplied;
// whether the colour in them is linear light or sRGB-encoded is the
// primitive's business (`color-interpolation-filters`), the compositor
// converts between the two (`fs_convert`).
//
// Every pass draws one primitive over its subregion. place.wgsl is put in front
// of this file (and turbulence.wgsl, for `fs_turbulence`) by the compositor.
//
// Positions are in three spaces: the padded canvas (what the textures are
// in), the canvas (the padded one less the margin, which keeps the maths
// the same at any margin) and the layer's (SVG user space: the subregion, the
// noise and the tile are in it). `Params.inv` takes the canvas to the layer
// and `Params.fwd` the layer to the padded canvas.

struct Params {
    // The inverse of the layer matrix on the canvas (margin taken out): its
    // linear part a, b, c, d as kurbo orders them (x' = a x + c y + e).
    inv: vec4<f32>,
    // x, y: the inverse's translation e, f. z: the margin.
    inv_t: vec4<f32>,
    // The layer matrix to the padded canvas: a, b, c, d.
    fwd: vec4<f32>,
    // x, y: its translation e, f.
    fwd_t: vec4<f32>,
    // The primitive subregion in layer space: x0, y0, x1, y1.
    sub: vec4<f32>,
    // What the primitive needs; see the Rust packing in filter_graph.rs.
    v: array<vec4<f32>, 64>,
}

@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var tex_b: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

fn load_b(xy: vec2<i32>) -> vec4<f32> {
    let q = xy - place.b.xy;
    if any(q < vec2<i32>(0)) || any(q >= place.b.zw) {
        return vec4<f32>(0.0);
    }
    return textureLoad(tex_b, q, 0);
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

// The straight colour of a premultiplied pixel (black if it is transparent).
fn straight(c: vec4<f32>) -> vec3<f32> {
    if c.a > 0.0 {
        return c.rgb / c.a;
    }
    return vec3<f32>(0.0);
}

// A straight colour clamped to 0..1, premultiplied.
fn premul(rgb: vec3<f32>, a: f32) -> vec4<f32> {
    let alpha = clamp(a, 0.0, 1.0);
    return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * alpha, alpha);
}

// The fragment's centre on the canvas and in layer space.
fn canvas_centre(p: vec4<f32>) -> vec2<f32> {
    return canvas_pos(p) - vec2<f32>(params.inv_t.z);
}

fn to_layer(c: vec2<f32>) -> vec2<f32> {
    let i = params.inv;
    return vec2<f32>(
        i.x * c.x + i.z * c.y + params.inv_t.x,
        i.y * c.x + i.w * c.y + params.inv_t.y,
    );
}

// A layer point on the padded canvas.
fn to_padded(l: vec2<f32>) -> vec2<f32> {
    let f = params.fwd;
    return vec2<f32>(
        f.x * l.x + f.z * l.y + params.fwd_t.x,
        f.y * l.x + f.w * l.y + params.fwd_t.y,
    );
}

// 1 if the layer point is in the primitive subregion.
fn in_sub(l: vec2<f32>) -> f32 {
    let s = params.sub;
    if l.x >= s.x && l.x < s.z && l.y >= s.y && l.y < s.w {
        return 1.0;
    }
    return 0.0;
}

fn layer_here(p: vec4<f32>) -> vec2<f32> {
    return to_layer(canvas_centre(p));
}

// tex_a at the padded-canvas position `q` (pixel centres at +0.5), read with a
// bilinear filter written out on `textureLoad`, so that the margin cannot move
// the weights.
fn bilerp_a(q: vec2<f32>) -> vec4<f32> {
    let f = q - vec2<f32>(0.5);
    let base = floor(f);
    let t = f - base;
    let xy = vec2<i32>(base);
    let top = mix(load_a(xy), load_a(xy + vec2<i32>(1, 0)), t.x);
    let bottom = mix(load_a(xy + vec2<i32>(0, 1)), load_a(xy + vec2<i32>(1, 1)), t.x);
    return mix(top, bottom, t.y);
}

// Keeps a colour a valid premultiplied one in 0..1.
fn valid(c: vec4<f32>) -> vec4<f32> {
    let a = clamp(c.a, 0.0, 1.0);
    return vec4<f32>(clamp(c.rgb, vec3<f32>(0.0), vec3<f32>(a)), a);
}

// v[0].x = 1: sRGB-encoded -> linear; 0: linear -> sRGB-encoded.
@fragment
fn fs_convert(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = load_a(canvas_xy(p));
    if c.a <= 0.0 {
        return vec4<f32>(0.0);
    }
    let u = clamp(c.rgb / c.a, vec3<f32>(0.0), vec3<f32>(1.0));
    var t: vec3<f32>;
    if params.v[0].x > 0.5 {
        t = srgb_to_linear(u);
    } else {
        t = linear_to_srgb(u);
    }
    return vec4<f32>(t * c.a, c.a);
}

// The input kept inside the subregion.
@fragment
fn fs_copy(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    return load_a(canvas_xy(p)) * in_sub(layer_here(p));
}

@fragment
fn fs_source_alpha(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = load_a(canvas_xy(p));
    return vec4<f32>(0.0, 0.0, 0.0, c.a) * in_sub(layer_here(p));
}

// v[0]: the colour, premultiplied, in the primitive's colour space.
@fragment
fn fs_flood(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    return params.v[0] * in_sub(layer_here(p));
}

// v[0].xy: the offset in canvas pixels.
@fragment
fn fs_offset(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let l = layer_here(p);
    if in_sub(l) == 0.0 {
        return vec4<f32>(0.0);
    }
    return bilerp_a(canvas_pos(p) - params.v[0].xy);
}

// tex_a is `in`, tex_b `in2`. v[0].x: 0 over, 1 in, 2 out, 3 atop, 4 xor, 5
// arithmetic; v[1]: k1 k2 k3 k4.
@fragment
fn fs_composite(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = canvas_xy(p);
    if in_sub(layer_here(p)) == 0.0 {
        return vec4<f32>(0.0);
    }
    let a = load_a(xy);
    let b = load_b(xy);
    let op = u32(params.v[0].x);
    var r: vec4<f32>;
    switch op {
        case 1u: {
            r = a * b.a;
        }
        case 2u: {
            r = a * (1.0 - b.a);
        }
        case 3u: {
            r = a * b.a + b * (1.0 - a.a);
        }
        case 4u: {
            r = a * (1.0 - b.a) + b * (1.0 - a.a);
        }
        case 5u: {
            let k = params.v[1];
            return valid(k.x * a * b + k.y * a + k.z * b + vec4<f32>(k.w));
        }
        default: {
            r = a + b * (1.0 - a.a);
        }
    }
    return r;
}

// v[0..4]: the rows (r, g, b, a coefficients); v[4]: the offsets. Straight
// colour in, straight colour out, as the spec has it.
@fragment
fn fs_color_matrix(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    if in_sub(layer_here(p)) == 0.0 {
        return vec4<f32>(0.0);
    }
    let c = load_a(canvas_xy(p));
    let s = vec4<f32>(straight(c), c.a);
    let o = vec4<f32>(
        dot(params.v[0], s),
        dot(params.v[1], s),
        dot(params.v[2], s),
        dot(params.v[3], s),
    ) + params.v[4];
    return premul(o.rgb, o.a);
}

// One transfer function applied to `c` in 0..1. `base` is the first vec4 of the
// channel's block: (kind, table length, p0, p1), then (p2, ...), then 8 vec4 of
// table.
fn transfer(base: u32, c: f32) -> f32 {
    let head = params.v[base];
    let kind = u32(head.x);
    let n = u32(head.y);
    switch kind {
        case 1u: {
            // table: n values, n - 1 intervals.
            if n == 1u {
                return params.v[base + 2u].x;
            }
            let pos = clamp(c, 0.0, 1.0) * f32(n - 1u);
            let k = min(u32(floor(pos)), n - 2u);
            let a = params.v[base + 2u + k / 4u][k % 4u];
            let b = params.v[base + 2u + (k + 1u) / 4u][(k + 1u) % 4u];
            return a + (pos - f32(k)) * (b - a);
        }
        case 2u: {
            let k = min(u32(floor(clamp(c, 0.0, 1.0) * f32(n))), n - 1u);
            return params.v[base + 2u + k / 4u][k % 4u];
        }
        case 3u: {
            return head.z * c + head.w;
        }
        case 4u: {
            return head.z * pow(max(c, 0.0), head.w) + params.v[base + 1u].x;
        }
        default: {
            return c;
        }
    }
}

// Channels r, g, b, a have their blocks at v[0], v[10], v[20], v[30].
@fragment
fn fs_component_transfer(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    if in_sub(layer_here(p)) == 0.0 {
        return vec4<f32>(0.0);
    }
    let c = load_a(canvas_xy(p));
    let u = straight(c);
    let a = transfer(30u, c.a);
    return premul(
        vec3<f32>(transfer(0u, u.r), transfer(10u, u.g), transfer(20u, u.b)),
        a,
    );
}

// One axis of a minimum (erode) or maximum (dilate) over a window.
// v[0]: x, y: the axis; z: the radius in whole pixels; w: 1 for dilate.
@fragment
fn fs_morph(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = canvas_xy(p);
    let axis = vec2<i32>(params.v[0].xy);
    let radius = i32(params.v[0].z);
    let dilate = params.v[0].w > 0.5;
    var r = load_a(xy);
    for (var i = 1; i <= radius; i++) {
        let a = load_a(xy + axis * i);
        let b = load_a(xy - axis * i);
        if dilate {
            r = max(r, max(a, b));
        } else {
            r = min(r, min(a, b));
        }
    }
    return r * in_sub(layer_here(p));
}

// One axis of a Gaussian blur. v[0]: x, y: the axis; z: the standard
// deviation in canvas pixels; w: the stride in pixels between taps (more than
// 1 for a very wide blur).
@fragment
fn fs_blur(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let xy = canvas_xy(p);
    let axis = vec2<i32>(params.v[0].xy);
    let sigma = params.v[0].z;
    let stride = i32(params.v[0].w);
    let reach = i32(ceil(3.0 * sigma));
    let taps = reach / stride;
    let k = 1.0 / (2.0 * sigma * sigma);
    var sum = load_a(xy);
    var weight = 1.0;
    for (var i = 1; i <= taps; i++) {
        let d = f32(i * stride);
        let w = exp(-d * d * k);
        sum += (load_a(xy + axis * (i * stride)) + load_a(xy - axis * (i * stride))) * w;
        weight += 2.0 * w;
    }
    return sum / weight * in_sub(layer_here(p));
}

// tex_a is `in`, tex_b the map. v[0]: the scale in layer units; v[1]: x, y: the
// channels (0 R .. 3 A). The push is worked out in layer space and moved to the
// canvas through the layer matrix, like `displace`.
@fragment
fn fs_displace(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    if in_sub(layer_here(p)) == 0.0 {
        return vec4<f32>(0.0);
    }
    let m = load_b(canvas_xy(p));
    let u = vec4<f32>(straight(m), m.a);
    let shift = params.v[0].x * vec2<f32>(
        u[u32(params.v[1].x)] - 0.5,
        u[u32(params.v[1].y)] - 0.5,
    );
    let f = params.fwd;
    let moved = vec2<f32>(f.x * shift.x + f.z * shift.y, f.y * shift.x + f.w * shift.y);
    return load_a(vec2<i32>(floor(canvas_pos(p) + moved)));
}

// `fs_copy`, `fs_turbulence` and `fs_displace` in one pass, for a graph of a
// turbulence that is the displacement map of the layer and nothing else: the
// layer is read where it is, as the copy cut to the subregion would be read, and
// the map is the noise at the fragment, rounded to half floats as the texture
// the turbulence pass wrote would be. v[0].x: the scale. v[1].xy: the channels.
// v[4].xy: the base frequency; v[4].z: 1 for fractalNoise; v[4].w: the octaves.
// v[5]: the stitch info. v[6].x: 1 for stitching.
@fragment
fn fs_displace_turbulence(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    if in_sub(layer_here(p)) == 0.0 {
        return vec4<f32>(0.0);
    }
    var m = vec4<f32>(0.0);
    let l = to_layer(canvas_centre(p) + vec2<f32>(0.5));
    if in_sub(l) != 0.0 {
        let frequency = params.v[4].xy;
        let fractal = params.v[4].z > 0.5;
        let octaves = u32(params.v[4].w);
        var c: vec4<f32>;
        if params.v[6].x > 0.5 {
            let st = vec4<i32>(params.v[5]);
            c = vec4<f32>(
                turbulence_value_stitch(0u, l, frequency, octaves, fractal, st),
                turbulence_value_stitch(1u, l, frequency, octaves, fractal, st),
                turbulence_value_stitch(2u, l, frequency, octaves, fractal, st),
                turbulence_value_stitch(3u, l, frequency, octaves, fractal, st),
            );
        } else {
            c = vec4<f32>(
                turbulence_value(0u, l, frequency, octaves, fractal),
                turbulence_value(1u, l, frequency, octaves, fractal),
                turbulence_value(2u, l, frequency, octaves, fractal),
                turbulence_value(3u, l, frequency, octaves, fractal),
            );
        }
        let n = vec4<f32>(c.rgb * c.a, c.a);
        m = vec4<f32>(store_f16(n.x), store_f16(n.y), store_f16(n.z), store_f16(n.w));
    }
    let u = vec4<f32>(straight(m), m.a);
    let shift = params.v[0].x * vec2<f32>(
        u[u32(params.v[1].x)] - 0.5,
        u[u32(params.v[1].y)] - 0.5,
    );
    let f = params.fwd;
    let moved = vec2<f32>(f.x * shift.x + f.z * shift.y, f.y * shift.x + f.w * shift.y);
    let q = vec2<i32>(floor(canvas_pos(p) + moved));
    // The layer's pixel there, if it is in the subregion (`fs_copy`).
    let at = vec2<f32>(q) + vec2<f32>(0.5) - vec2<f32>(params.inv_t.z);
    return load_a(q) * in_sub(to_layer(at));
}

// v[0].xy: the base frequency; v[0].z: 1 for fractalNoise; v[0].w: the octaves.
// v[1]: the stitch info (width, wrap x, height, wrap y), or w = 0 for no
// stitching (v[1].w is then the flag, 1 for stitching).
@fragment
fn fs_turbulence(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    // A browser (Skia) evaluates the noise at whole device positions: the
    // pixel's centre, rounded, which is the pixel's far corner.
    let l = to_layer(canvas_centre(p) + vec2<f32>(0.5));
    if in_sub(l) == 0.0 {
        return vec4<f32>(0.0);
    }
    let frequency = params.v[0].xy;
    let fractal = params.v[0].z > 0.5;
    let octaves = u32(params.v[0].w);
    var c: vec4<f32>;
    if params.v[2].x > 0.5 {
        let st = vec4<i32>(params.v[1]);
        c = vec4<f32>(
            turbulence_value_stitch(0u, l, frequency, octaves, fractal, st),
            turbulence_value_stitch(1u, l, frequency, octaves, fractal, st),
            turbulence_value_stitch(2u, l, frequency, octaves, fractal, st),
            turbulence_value_stitch(3u, l, frequency, octaves, fractal, st),
        );
    } else {
        c = vec4<f32>(
            turbulence_value(0u, l, frequency, octaves, fractal),
            turbulence_value(1u, l, frequency, octaves, fractal),
            turbulence_value(2u, l, frequency, octaves, fractal),
            turbulence_value(3u, l, frequency, octaves, fractal),
        );
    }
    return vec4<f32>(c.rgb * c.a, c.a);
}

// Repeats the input's subregion (v[0]: x0, y0, x1, y1 in layer space) over the
// subregion.
@fragment
fn fs_tile(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let l = layer_here(p);
    if in_sub(l) == 0.0 {
        return vec4<f32>(0.0);
    }
    let r = params.v[0];
    let size = r.zw - r.xy;
    if size.x <= 0.0 || size.y <= 0.0 {
        return vec4<f32>(0.0);
    }
    let d = l - r.xy;
    let t = r.xy + d - size * floor(d / size);
    return bilerp_a(to_padded(t));
}

// feConvolveMatrix. v[0]: order x, y; target x, y. v[1]: divisor, bias, edge
// mode (0 duplicate, 1 wrap, 2 none), preserve alpha. v[2]: the input's
// region in canvas pixels (x0, y0, x1, y1). v[3..19]: the kernel, 64 entries.
fn conv_load(xy: vec2<i32>, r: vec4<i32>, edge: u32) -> vec4<f32> {
    var q = xy;
    if q.x < r.x || q.x >= r.z || q.y < r.y || q.y >= r.w {
        switch edge {
            case 0u: {
                q = clamp(q, r.xy, r.zw - vec2<i32>(1));
            }
            case 1u: {
                let size = r.zw - r.xy;
                q = r.xy + (((q - r.xy) % size) + size) % size;
            }
            default: {
                return vec4<f32>(0.0);
            }
        }
    }
    return load_a(q);
}

@fragment
fn fs_convolve(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    if in_sub(layer_here(p)) == 0.0 {
        return vec4<f32>(0.0);
    }
    let xy = canvas_xy(p);
    let order = vec2<i32>(params.v[0].xy);
    let target_xy = vec2<i32>(params.v[0].zw);
    let divisor = params.v[1].x;
    let bias = params.v[1].y;
    let edge = u32(params.v[1].z);
    let keep_alpha = params.v[1].w > 0.5;
    let region = vec4<i32>(params.v[2]);
    var sum = vec4<f32>(0.0);
    for (var i = 0; i < order.y; i++) {
        for (var j = 0; j < order.x; j++) {
            let n = (order.x - 1 - j) + (order.y - 1 - i) * order.x;
            let k = params.v[3 + n / 4][n % 4];
            var s = conv_load(xy + vec2<i32>(j, i) - target_xy, region, edge);
            if keep_alpha {
                s = vec4<f32>(straight(s), s.a);
            }
            sum += s * k;
        }
    }
    if keep_alpha {
        let a = load_a(xy).a;
        return premul(sum.rgb / divisor + vec3<f32>(bias), a);
    }
    let a = clamp(sum.a / divisor + bias, 0.0, 1.0);
    let rgb = clamp(sum.rgb / divisor + vec3<f32>(bias * a), vec3<f32>(0.0), vec3<f32>(a));
    return vec4<f32>(rgb, a);
}

// feDiffuseLighting / feSpecularLighting. The input's alpha is the height.
// v[0]: surface scale, constant, exponent, 1 for specular. v[1]: the light
// colour (r, g, b) in the primitive's colour space, the light kind (0
// distant, 1 point, 2 spot) in w. v[2]: the light vector (distant) or the
// position in padded canvas pixels (point, spot), and w the cone cosine (-2 for
// none). v[3]: spot only: the unit vector from the light to the point it
// looks at, w the spot exponent.
fn height(xy: vec2<i32>, scale: f32) -> f32 {
    return scale * load_a(xy).a;
}

@fragment
fn fs_lighting(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    if in_sub(layer_here(p)) == 0.0 {
        return vec4<f32>(0.0);
    }
    let xy = canvas_xy(p);
    let scale = params.v[0].x;
    // The surface normal from the Sobel kernels of the spec.
    let a00 = load_a(xy + vec2<i32>(-1, -1)).a;
    let a10 = load_a(xy + vec2<i32>(0, -1)).a;
    let a20 = load_a(xy + vec2<i32>(1, -1)).a;
    let a01 = load_a(xy + vec2<i32>(-1, 0)).a;
    let a21 = load_a(xy + vec2<i32>(1, 0)).a;
    let a02 = load_a(xy + vec2<i32>(-1, 1)).a;
    let a12 = load_a(xy + vec2<i32>(0, 1)).a;
    let a22 = load_a(xy + vec2<i32>(1, 1)).a;
    let nx = -scale * 0.25 * ((a20 + 2.0 * a21 + a22) - (a00 + 2.0 * a01 + a02));
    let ny = -scale * 0.25 * ((a02 + 2.0 * a12 + a22) - (a00 + 2.0 * a10 + a20));
    let n = normalize(vec3<f32>(nx, ny, 1.0));

    var light_vec: vec3<f32>;
    var colour = params.v[1].xyz;
    let kind = u32(params.v[1].w);
    if kind == 0u {
        light_vec = params.v[2].xyz;
    } else {
        let z = height(xy, scale);
        light_vec = normalize(params.v[2].xyz - vec3<f32>(canvas_pos(p), z));
        if kind == 2u {
            let s = params.v[3].xyz;
            let minus_l_dot_s = -dot(light_vec, s);
            // The cone's edge fades over 0.016 of cosine, as in a browser.
            let fade = clamp((minus_l_dot_s - params.v[2].w) / 0.016, 0.0, 1.0);
            if minus_l_dot_s <= 0.0 {
                colour = vec3<f32>(0.0);
            } else {
                colour = colour * pow(minus_l_dot_s, params.v[3].w) * fade;
            }
        }
    }
    let constant = params.v[0].y;
    if params.v[0].w > 0.5 {
        let h = normalize(light_vec + vec3<f32>(0.0, 0.0, 1.0));
        let spec = constant * pow(max(dot(n, h), 0.0), params.v[0].z);
        let rgb = clamp(colour * spec, vec3<f32>(0.0), vec3<f32>(1.0));
        let a = max(rgb.r, max(rgb.g, rgb.b));
        return vec4<f32>(rgb, a);
    }
    let diffuse = constant * max(dot(n, light_vec), 0.0);
    return vec4<f32>(clamp(colour * diffuse, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
