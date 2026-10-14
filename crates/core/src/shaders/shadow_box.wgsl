// The drop shadow of a rounded rectangle (a rectangle is one with radius 0) or
// an ellipse, filled with one colour, in closed form: the Gaussian blur of the
// shape is worked out for each pixel from a formula, not by blurring a
// texture. Textures are Rgba16Float, linear, premultiplied. place.wgsl is put
// in front of this file by the compositor. See box_shadow.rs for which shapes
// get this pass and for the maths.
//
//   fs_drop_box: the layer composited over the shadow, as fs_drop in
//                shadow.wgsl does: the shadow of the shape at the pixel, minus
//                the offset, tinted by the colour.
//
// The shape is symmetric about its centre, so everything is worked out from
// q, the position relative to the centre in the shape's own units (the
// canvas pixels turned back by the layer's rotation and scale). A Gaussian
// blur separates into the two axes, so the blurred shape at q is a sum over
// the rows t of the shape of
//
//   g(q.y - t) * (the Gaussian's mass between the row's two ends, along x)
//
// where g is the Gaussian along y. A rectangle's rows all end at the same x,
// so the sum is two erf differences multiplied: exact. In the other shapes
// the row's half width c(t) changes along the arcs (the corners, or the
// whole ellipse). Each arc is summed on its own, its samples spaced evenly in
// the angle phi of the arc (t = centre + radius * sin(phi), c = base +
// amplitude * cos(phi)), which keeps them off the square-root edge that c has
// where the arc meets the bounding box. The samples' weights are scaled to
// the exact mass of the Gaussian over the arc's rows, so a stretch where c
// hardly changes comes out exact too.

struct Params {
    // xy: the canvas position of the shape's centre, with the shadow's
    // offset added.
    centre: vec4<f32>,
    // The canvas-to-shape matrix without its translation, row by row:
    // q = (m.x * d.x + m.y * d.y, m.z * d.x + m.w * d.y) for d the pixel
    // centre minus `centre`.
    inverse: vec4<f32>,
    // xy: half the shape's width and height. z: the corner radius, at most
    // the smaller half. w: the Gaussian's standard deviation.
    shape: vec4<f32>,
    // x: 1 for an ellipse. y: how opaque the shape's fill is (the shadow is
    // made from its alpha).
    misc: vec4<f32>,
    // linear premultiplied shadow colour
    color: vec4<f32>,
}

// tex_a: the layer. tex_b is bound but unused (the compositor's shared layout).
@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var tex_b: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

// How far the sum reaches either side of q.y, in standard deviations, and
// how many samples each arc takes. box_shadow.rs has the same two.
const REACH: f32 = 4.0;
const SAMPLES: i32 = 12;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

// The error function, by Abramowitz and Stegun 7.1.26: within 1.5e-7.
fn erf(x: f32) -> f32 {
    let a = abs(x);
    let t = 1.0 / (1.0 + 0.3275911 * a);
    let poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    let r = 1.0 - poly * exp(-a * a);
    return select(-r, r, x >= 0.0);
}

// The mass of a standard Gaussian between a and b.
fn mass(a: f32, b: f32) -> f32 {
    return 0.5 * (erf(b * 0.70710678) - erf(a * 0.70710678));
}

// The blurred shape's mass from the rows t0 to t1, which lie on an arc:
// t = centre + radius * sin(phi), and the row's half width is base +
// amplitude * cos(phi). q is the position being worked out.
fn arc(q: vec2<f32>, sigma: f32, centre: f32, radius: f32, base: f32, amplitude: f32, t0: f32, t1: f32) -> f32 {
    if t1 <= t0 {
        return 0.0;
    }
    let phi0 = asin(clamp((t0 - centre) / radius, -1.0, 1.0));
    let phi1 = asin(clamp((t1 - centre) / radius, -1.0, 1.0));
    let delta = (phi1 - phi0) / f32(SAMPLES);
    var weights = 0.0;
    var sum = 0.0;
    for (var i = 0; i < SAMPLES; i++) {
        let phi = phi0 + delta * (f32(i) + 0.5);
        let z = (centre + radius * sin(phi) - q.y) / sigma;
        // The Gaussian of the row, times the length of arc it stands for.
        let w = exp(-0.5 * z * z) * cos(phi);
        let c = base + amplitude * cos(phi);
        weights += w;
        sum += w * mass((-c - q.x) / sigma, (c - q.x) / sigma);
    }
    if weights <= 0.0 {
        return 0.0;
    }
    return mass((t0 - q.y) / sigma, (t1 - q.y) / sigma) * sum / weights;
}

// The blurred shape at `rel`, a position relative to its centre.
fn blurred(rel: vec2<f32>) -> f32 {
    let sigma = max(params.shape.w, 0.001);
    let radius = params.shape.z;
    let ellipse = params.misc.x > 0.5;
    var q = abs(rel);
    var half_size = params.shape.xy;
    // Rows are summed along y, which suits a boundary that runs up and down
    // near q and not one that runs across: there the rows' ends move faster
    // than the samples can follow. So the shape is turned a quarter if the
    // boundary nearest q (it faces away from the middle of the nearest
    // corner's arc, or of the ellipse) is more level than upright. The shape
    // is symmetric about both axes, so a quarter turn is a swap.
    var turn: bool;
    if ellipse {
        turn = q.y / (half_size.y * half_size.y) > q.x / (half_size.x * half_size.x);
    } else {
        turn = q.y - (half_size.y - radius) > q.x - (half_size.x - radius);
    }
    if turn {
        q = q.yx;
        half_size = half_size.yx;
    }
    let lo = q.y - REACH * sigma;
    let hi = q.y + REACH * sigma;
    if ellipse {
        return arc(q, sigma, 0.0, half_size.y, 0.0, half_size.x, max(lo, -half_size.y), min(hi, half_size.y));
    }
    // The straight sides: every row is as wide as the shape.
    let straight = half_size.y - radius;
    var result = 0.0;
    let mid0 = max(lo, -straight);
    let mid1 = min(hi, straight);
    if mid1 > mid0 {
        result = mass((-half_size.x - q.x) / sigma, (half_size.x - q.x) / sigma) * mass((mid0 - q.y) / sigma, (mid1 - q.y) / sigma);
    }
    if radius > 0.0 {
        // The corners: the arcs at the top, and, mirrored, at the bottom.
        let base = half_size.x - radius;
        result += arc(q, sigma, straight, radius, base, radius, max(lo, straight), min(hi, half_size.y));
        let mirrored = vec2<f32>(q.x, -q.y);
        result += arc(mirrored, sigma, straight, radius, base, radius, max(mirrored.y - REACH * sigma, straight), min(mirrored.y + REACH * sigma, half_size.y));
    }
    return result;
}

@fragment
fn fs_drop_box(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let layer = load_a(canvas_xy(p));
    let d = canvas_pos(p) - params.centre.xy;
    let q = vec2<f32>(
        params.inverse.x * d.x + params.inverse.y * d.y,
        params.inverse.z * d.x + params.inverse.w * d.y,
    );
    let shadow = params.color * (params.misc.y * blurred(q));
    return layer + shadow * (1.0 - layer.a);
}
