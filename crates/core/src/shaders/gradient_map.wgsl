// Gradient map pass. Textures are Rgba16Float, linear, premultiplied.
//
//   fs_gradient_map: replaces the layer's colours with colours looked up by
//                    luminance in a list of stops, then cross-fades from the
//                    original to that by `amount`. Like the colour filters it
//                    works on the straight colour in sRGB encoding, and the
//                    luminance is Rec. 709 of that encoded colour (what a
//                    grayscale filter would give). Stops are interpolated in
//                    sRGB with straight alpha; a luminance outside the first
//                    and last offsets takes the end stop. The graded alpha is
//                    the layer's alpha times the stop's. Fully transparent
//                    pixels stay empty. place.wgsl is put in front of this
//                    file by the compositor.

struct Params {
    // x: number of stops, y: amount
    header: vec4<f32>,
    // The stop offsets, four to a vec4 (a uniform array needs 16-byte
    // elements).
    offsets: array<vec4<f32>, 4>,
    // The stop colours: straight sRGB r, g, b, a in 0..1.
    colors: array<vec4<f32>, 16>,
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

fn stop_offset(i: u32) -> f32 {
    return params.offsets[i / 4u][i % 4u];
}

// The colour of the map at luminance `l`.
fn gradient_color(l: f32) -> vec4<f32> {
    let count = u32(params.header.x);
    if l <= stop_offset(0u) {
        return params.colors[0];
    }
    for (var i = 1u; i < count; i++) {
        let hi = stop_offset(i);
        if l <= hi {
            // Here l is above the previous offset, so the span is not empty.
            let lo = stop_offset(i - 1u);
            return mix(params.colors[i - 1u], params.colors[i], (l - lo) / (hi - lo));
        }
    }
    return params.colors[count - 1u];
}

@fragment
fn fs_gradient_map(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = load_a(canvas_xy(p));
    if c.a <= 0.0 {
        return vec4<f32>(0.0);
    }
    let straight = clamp(c.rgb / c.a, vec3<f32>(0.0), vec3<f32>(1.0));
    let original = linear_to_srgb(straight);
    let l = dot(original, vec3<f32>(0.2126, 0.7152, 0.0722));
    let g = gradient_color(l);
    let graded = vec4<f32>(g.rgb, c.a * g.a);
    let out = mix(vec4<f32>(original, c.a), graded, params.header.y);
    return vec4<f32>(srgb_to_linear(out.rgb) * out.a, out.a);
}
