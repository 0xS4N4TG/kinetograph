// Colour grade pass (HyperFrames' `data-color-grading`). Textures are Rgba16Float, linear, premultiplied.
//
//   fs_grade: grades the layer's straight sRGB colour in one pass, in the order HyperFrames' shader does: the primary
//             grade (exposure, shadows, highlights, blacks and whites, temperature and tint, contrast, vibrance,
//             saturation), the three tonal wheels, the RGB curves, the hue curves, the secondaries, then the look-up
//             table; the result is mixed with the source by `intensity`. Film grain and the vignette follow. Alpha is
//             unchanged and fully transparent pixels stay empty.
//
// The grade runs on the colour as it is stored in the picture (sRGB encoded, 0..1), as the original does; none of it
// is gamma aware. The curves, hue curves and secondaries are read from `advanced`, an Rgba8 table of 1024 x 3 texels
// that is built on the CPU the way HyperFrames builds it (`ResolvedColorGrade::advanced`), 8-bit rounding included:
//   row 0: red, green, blue and master curve at x / 1023.
//   row 1: hue vs hue, hue vs saturation, hue vs luma at x / 1024 of the hue circle, stored as (v * 127 + 128) / 255.
//   row 2: up to four secondaries, five texels each.
// The look-up table is the scene's `.cube` file as a 3D texture (a 2 x 2 x 2 dummy when there is none), read with
// `textureLoad` and trilinear interpolation by hand, as `lut.wgsl` does.
//
// The vignette and the grain are laid out on the graded box (`box`, in layer space), the picture's own canvas in
// HyperFrames: `v_uv` runs from the bottom left corner of the box, and the grain is hashed from the pixel in a canvas
// whose rows count up from the bottom (`gl_FragCoord`). place.wgsl is put in front of this file by the compositor.

struct Params {
    // The inverse of the layer matrix (canvas texel -> layer): its linear part a, b, c, d as kurbo orders it.
    inverse: vec4<f32>,
    // x, y: the inverse's translation e, f. z: intensity. w: LUT intensity.
    offset: vec4<f32>,
    // The graded box in layer space: x, y, width, height.
    box_rect: vec4<f32>,
    // exposure, contrast, highlights, shadows
    adjust0: vec4<f32>,
    // whites, blacks, temperature, tint
    adjust1: vec4<f32>,
    // vibrance, saturation, LUT points per axis, 1 when there is a LUT
    adjust2: vec4<f32>,
    // Each wheel: hue / 360, amount, level.
    wheel_shadows: vec4<f32>,
    wheel_midtones: vec4<f32>,
    wheel_highlights: vec4<f32>,
    // x: 1 for RGB curves, y: 1 for hue curves, z: the number of secondaries.
    flags: vec4<f32>,
    lut_min: vec4<f32>,
    lut_max: vec4<f32>,
    // vignette: amount, midpoint, roundness, feather
    vignette: vec4<f32>,
    // grain: amount, size, roughness, seed
    grain: vec4<f32>,
}

@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var tex_b: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var advanced: texture_2d<f32>;
@group(1) @binding(1) var lut: texture_3d<f32>;

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

// GLSL's mod and fract: the remainder takes the sign of the divisor.
fn gl_mod(x: f32, y: f32) -> f32 {
    return x - y * floor(x / y);
}

fn gl_fract(x: f32) -> f32 {
    return x - floor(x);
}

fn luma_of(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn grain_noise(p: vec2<f32>) -> f32 {
    return gl_fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453123);
}

fn color_saturation(c: vec3<f32>) -> f32 {
    return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
}

fn rgb_to_hsv(color: vec3<f32>) -> vec3<f32> {
    let maximum = max(max(color.r, color.g), color.b);
    let minimum = min(min(color.r, color.g), color.b);
    let delta = maximum - minimum;
    var hue = 0.0;
    if delta > 0.00001 {
        if maximum == color.r {
            hue = gl_mod((color.g - color.b) / delta, 6.0);
        } else if maximum == color.g {
            hue = (color.b - color.r) / delta + 2.0;
        } else {
            hue = (color.r - color.g) / delta + 4.0;
        }
        hue = gl_fract(hue / 6.0);
    }
    var sat = 0.0;
    if maximum > 0.00001 {
        sat = delta / maximum;
    }
    return vec3<f32>(hue, sat, maximum);
}

fn hsv_to_rgb(color: vec3<f32>) -> vec3<f32> {
    let h = vec3<f32>(color.x) + vec3<f32>(0.0, 0.6666667, 0.3333333);
    let bands = abs((h - floor(h)) * 6.0 - 3.0);
    return color.z * mix(vec3<f32>(1.0), clamp(bands - 1.0, vec3<f32>(0.0), vec3<f32>(1.0)), color.y);
}

// ---- the table of curves, hue curves and secondaries ----

fn advanced_texel(x: f32, row: i32) -> vec4<f32> {
    return textureLoad(advanced, vec2<i32>(i32(x), row), 0);
}

fn sample_curve(coordinate: f32) -> vec4<f32> {
    let position = clamp(coordinate, 0.0, 1.0) * 1023.0;
    let lower = floor(position);
    let upper = min(lower + 1.0, 1023.0);
    return mix(advanced_texel(lower, 0), advanced_texel(upper, 0), position - lower);
}

fn sample_hue_curve(coordinate: f32) -> vec4<f32> {
    let position = gl_fract(coordinate) * 1024.0;
    let lower = floor(position);
    let upper = gl_mod(lower + 1.0, 1024.0);
    return mix(advanced_texel(lower, 1), advanced_texel(upper, 1), position - lower);
}

fn advanced_config(index: f32) -> vec4<f32> {
    return advanced_texel(index, 2);
}

fn decode_signed(value: f32) -> f32 {
    return (value * 255.0 - 128.0) / 127.0;
}

// ---- the grade ----

fn wheel_direction(hue: f32) -> vec3<f32> {
    var direction = hsv_to_rgb(vec3<f32>(gl_fract(hue), 1.0, 1.0));
    direction = direction - vec3<f32>(luma_of(direction));
    return direction / max(max(max(abs(direction.r), abs(direction.g)), abs(direction.b)), 0.0001);
}

fn apply_tonal_wheels(color_in: vec3<f32>) -> vec3<f32> {
    var color = color_in;
    let luma = luma_of(color);
    let shadows = 1.0 - smoothstep(0.0, 0.6, luma);
    let highlights = smoothstep(0.4, 1.0, luma);
    let midtones = max(0.0, 1.0 - shadows - highlights);
    let total = max(shadows + midtones + highlights, 0.0001);
    let weights = vec3<f32>(shadows, midtones, highlights) / total;
    let ws = params.wheel_shadows;
    let wm = params.wheel_midtones;
    let wh = params.wheel_highlights;
    color += wheel_direction(ws.x) * ws.y * weights.x * 0.18;
    color += wheel_direction(wm.x) * wm.y * weights.y * 0.18;
    color += wheel_direction(wh.x) * wh.y * weights.z * 0.18;
    color += ws.z * weights.x * 0.25;
    color += wm.z * weights.y * 0.25;
    color += wh.z * weights.z * 0.25;
    return color;
}

fn apply_rgb_curves(color: vec3<f32>) -> vec3<f32> {
    if params.flags.x < 0.5 {
        return color;
    }
    let master = vec3<f32>(sample_curve(color.r).a, sample_curve(color.g).a, sample_curve(color.b).a);
    return vec3<f32>(sample_curve(master.r).r, sample_curve(master.g).g, sample_curve(master.b).b);
}

fn apply_hue_curves(color: vec3<f32>) -> vec3<f32> {
    if params.flags.y < 0.5 {
        return color;
    }
    var hsv = rgb_to_hsv(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)));
    let curves = sample_hue_curve(hsv.x).rgb;
    let original_luma = luma_of(color);
    hsv.x = gl_fract(hsv.x + decode_signed(curves.r) * 0.5);
    hsv.y = clamp(hsv.y * max(0.0, 1.0 + decode_signed(curves.g)), 0.0, 1.0);
    var shifted = hsv_to_rgb(hsv);
    shifted += vec3<f32>(original_luma - luma_of(shifted) + decode_signed(curves.b));
    return shifted;
}

fn soft_range_mask(value: f32, minimum: f32, maximum: f32, softness: f32) -> f32 {
    if value < minimum {
        if softness <= 0.0 {
            return 0.0;
        }
        return smoothstep(minimum - softness, minimum, value);
    }
    if value > maximum {
        if softness <= 0.0 {
            return 0.0;
        }
        return 1.0 - smoothstep(maximum, maximum + softness, value);
    }
    return 1.0;
}

fn hue_range_mask(hue: f32, saturation: f32, key: vec3<f32>) -> f32 {
    let dist = abs(gl_fract(hue - key.x + 0.5) - 0.5) * 360.0;
    let range = key.y * 180.0;
    let softness = key.z * 180.0;
    if range < 179.999 && saturation < 0.001 {
        return 0.0;
    }
    if dist <= range {
        return 1.0;
    }
    if softness <= 0.0 {
        return 0.0;
    }
    return 1.0 - smoothstep(range, range + softness, dist);
}

fn apply_secondary(color: vec3<f32>, index: f32) -> vec3<f32> {
    let base = index * 5.0;
    let hue_key = advanced_config(base);
    let saturation_key = advanced_config(base + 1.0);
    let luma_key = advanced_config(base + 2.0);
    let correction = advanced_config(base + 3.0);
    let tint_correction = advanced_config(base + 4.0);
    var hsv = rgb_to_hsv(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)));
    let luma = luma_of(color);
    var mask = hue_range_mask(hsv.x, hsv.y, hue_key.rgb);
    mask *= soft_range_mask(hsv.y, saturation_key.x, saturation_key.y, saturation_key.z * 0.5);
    mask *= soft_range_mask(luma, luma_key.x, luma_key.y, luma_key.z * 0.5);
    if mask <= 0.0 {
        return color;
    }
    hsv.x = gl_fract(hsv.x + decode_signed(correction.x) * 0.5);
    var corrected = hsv_to_rgb(hsv);
    let corrected_luma = luma_of(corrected);
    corrected = mix(vec3<f32>(corrected_luma), corrected, max(0.0, 1.0 + decode_signed(correction.y)));
    corrected += vec3<f32>(decode_signed(correction.z));
    let temperature = decode_signed(correction.w);
    let tint = decode_signed(tint_correction.x);
    corrected.r += temperature * 0.08 + tint * 0.04;
    corrected.b -= temperature * 0.08 - tint * 0.04;
    corrected.g -= tint * 0.08;
    return mix(color, corrected, mask);
}

fn apply_advanced_grade(color_in: vec3<f32>) -> vec3<f32> {
    var color = apply_tonal_wheels(color_in);
    color = apply_rgb_curves(color);
    color = apply_hue_curves(color);
    if params.flags.z > 0.5 {
        color = apply_secondary(color, 0.0);
    }
    if params.flags.z > 1.5 {
        color = apply_secondary(color, 1.0);
    }
    if params.flags.z > 2.5 {
        color = apply_secondary(color, 2.0);
    }
    if params.flags.z > 3.5 {
        color = apply_secondary(color, 3.0);
    }
    return color;
}

fn lut_grid(r: i32, g: i32, b: i32) -> vec3<f32> {
    return textureLoad(lut, vec3<i32>(r, g, b), 0).rgb;
}

fn apply_lut(color: vec3<f32>) -> vec3<f32> {
    if params.adjust2.w < 0.5 {
        return color;
    }
    let size = max(params.adjust2.z, 2.0);
    let span = max(params.lut_max.xyz - params.lut_min.xyz, vec3<f32>(0.00001));
    let scaled = clamp((color - params.lut_min.xyz) / span, vec3<f32>(0.0), vec3<f32>(1.0)) * (size - 1.0);
    let lo = floor(scaled);
    let hi = min(lo + 1.0, vec3<f32>(size - 1.0));
    let f = scaled - lo;
    let l = vec3<i32>(lo);
    let h = vec3<i32>(hi);
    let c000 = lut_grid(l.x, l.y, l.z);
    let c100 = lut_grid(h.x, l.y, l.z);
    let c010 = lut_grid(l.x, h.y, l.z);
    let c110 = lut_grid(h.x, h.y, l.z);
    let c001 = lut_grid(l.x, l.y, h.z);
    let c101 = lut_grid(h.x, l.y, h.z);
    let c011 = lut_grid(l.x, h.y, h.z);
    let c111 = lut_grid(h.x, h.y, h.z);
    let c00 = mix(c000, c100, f.x);
    let c10 = mix(c010, c110, f.x);
    let c01 = mix(c001, c101, f.x);
    let c11 = mix(c011, c111, f.x);
    let c0 = mix(c00, c10, f.y);
    let c1 = mix(c01, c11, f.y);
    let lut_color = mix(c0, c1, f.z);
    return mix(color, lut_color, clamp(params.offset.w, 0.0, 1.0));
}

fn apply_primary_grade(color_in: vec3<f32>) -> vec3<f32> {
    var color = color_in;
    let exposure = params.adjust0.x;
    let contrast = params.adjust0.y;
    let highlights = params.adjust0.z;
    let shadows = params.adjust0.w;
    let whites = params.adjust1.x;
    let blacks = params.adjust1.y;
    let temperature = params.adjust1.z;
    let tint = params.adjust1.w;
    let vibrance = params.adjust2.x;
    let saturation = params.adjust2.y;
    color *= pow(2.0, exposure);
    let y = luma_of(color);
    let shadow_mask = 1.0 - smoothstep(0.0, 0.65, y);
    let highlight_mask = smoothstep(0.35, 1.0, y);
    color += shadows * 0.35 * shadow_mask;
    color += highlights * 0.35 * highlight_mask;
    let black_point = clamp(blacks * 0.18, -0.18, 0.18);
    let white_point = clamp(1.0 - whites * 0.18, 0.82, 1.18);
    color = (color - black_point) / max(white_point - black_point, 0.2);
    color.r += temperature * 0.08 + tint * 0.04;
    color.b -= temperature * 0.08 - tint * 0.04;
    color.g -= tint * 0.08;
    color = (color - vec3<f32>(0.5)) * max(0.0, 1.0 + contrast) + vec3<f32>(0.5);
    let sat_luma = luma_of(color);
    let current_sat = clamp(color_saturation(color), 0.0, 1.0);
    let skin_like = smoothstep(0.02, 0.18, color.r - color.g)
        * smoothstep(0.0, 0.16, color.g - color.b)
        * smoothstep(0.18, 0.82, sat_luma);
    let vibrance_weight = (1.0 - current_sat * 0.72) * mix(1.0, 0.55, skin_like);
    color = mix(vec3<f32>(sat_luma), color, max(0.0, 1.0 + vibrance * vibrance_weight));
    color = mix(vec3<f32>(sat_luma), color, max(0.0, 1.0 + saturation));
    return color;
}

fn apply_color_grade(color_in: vec3<f32>) -> vec3<f32> {
    var color = apply_primary_grade(color_in);
    color = apply_advanced_grade(color);
    return clamp(apply_lut(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0))), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_grade(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = load_a(canvas_xy(p));
    if c.a <= 0.0 {
        return vec4<f32>(0.0);
    }
    let source = linear_to_srgb(clamp(c.rgb / c.a, vec3<f32>(0.0), vec3<f32>(1.0)));
    var color = mix(source, apply_color_grade(source), params.offset.z);

    // The pixel's centre in layer space, then in the graded box: `size` is the canvas of HyperFrames' shader, `uv`
    // its `v_uv` (rows counting up) and `frag` its `gl_FragCoord`.
    let pos = canvas_pos(p);
    let inv = params.inverse;
    let layer = vec2<f32>(
        inv.x * pos.x + inv.z * pos.y + params.offset.x,
        inv.y * pos.x + inv.w * pos.y + params.offset.y,
    );
    let size = max(params.box_rect.zw, vec2<f32>(1.0));
    let down = (layer - params.box_rect.xy) / size;
    let uv = vec2<f32>(down.x, 1.0 - down.y);
    let frag = uv * size;

    let grain_amount = clamp(params.grain.x, 0.0, 1.0);
    if grain_amount > 0.0 {
        let seed = params.grain.w;
        let pixel_size = mix(1.0, 6.0, clamp(params.grain.y, 0.0, 1.0));
        let coord = floor(frag / pixel_size) + vec2<f32>(seed, seed * 1.37);
        let base = grain_noise(coord) - grain_noise(coord + vec2<f32>(19.19, 73.31));
        let fine = grain_noise(frag + vec2<f32>(seed * 2.11, seed * 0.71)) - 0.5;
        let g = mix(base * 0.7, base + fine * 0.35, clamp(params.grain.z, 0.0, 1.0));
        let grain_luma = luma_of(color);
        let grain_mask = smoothstep(0.02, 0.55, grain_luma) * (1.0 - smoothstep(0.88, 1.0, grain_luma));
        color += g * grain_amount * mix(0.025, 0.08, grain_mask);
    }

    let vignette_amount = clamp(params.vignette.x, 0.0, 1.0);
    if vignette_amount > 0.0 {
        var aspect = vec2<f32>(1.0, size.y / max(size.x, 1.0));
        if size.x > size.y {
            aspect = vec2<f32>(size.x / max(size.y, 1.0), 1.0);
        }
        let vignette_uv = abs((uv - vec2<f32>(0.5)) * 2.0) * aspect;
        let power = mix(8.0, 1.8, clamp(params.vignette.z * 0.5 + 0.5, 0.0, 1.0));
        let dist = pow(pow(vignette_uv.x, power) + pow(vignette_uv.y, power), 1.0 / power);
        let midpoint = mix(0.22, 1.08, clamp(params.vignette.y, 0.0, 1.0));
        let feather = mix(0.08, 0.72, clamp(params.vignette.w, 0.0, 1.0));
        let mask = smoothstep(midpoint, midpoint + feather, dist);
        color *= 1.0 - mask * vignette_amount * 0.75;
    }

    let graded = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
    return vec4<f32>(srgb_to_linear(graded) * c.a, c.a);
}
