// Colour grade pass (HyperFrames' `data-color-grading`). Textures are Rgba16Float, linear, premultiplied.
//
//   fs_grade: grades the layer's straight sRGB colour in one pass, in the order HyperFrames' shader does: the primary
//             grade (exposure, shadows, highlights, blacks and whites, temperature and tint, contrast, vibrance,
//             saturation), the three tonal wheels, the RGB curves, the hue curves, the secondaries, then the look-up
//             table; the result is mixed with the source by `intensity`. Film grain and the vignette follow. The look
//             effects (`effects`, at the end of this file) read the picture before the grade and draw over it after
//             it. Alpha is the picture's at the point the effects read; fully transparent pixels stay empty.
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
    // The layer matrix (canvas <- layer): a, b, c, d as kurbo orders them.
    forward: vec4<f32>,
    // x, y: the matrix's translation e, f. z: the time in seconds. w: how many palette colours there are.
    forward2: vec4<f32>,
    // The blur, Kuwahara and bloom textures: the canvas pixel of texel (0, 0), then the size in texels.
    blur_place: vec4<f32>,
    kuwahara_place: vec4<f32>,
    bloom_place: vec4<f32>,
    // x: 1 when the blur texture holds the blur, y: the bloom, z: the Kuwahara pass.
    ready: vec4<f32>,
    palette: array<vec4<f32>, 6>,
    // The 64 effect controls, in the order of `grade::EFFECT_KEYS`.
    fx: array<vec4<f32>, 16>,
}

@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var tex_b: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@group(1) @binding(0) var advanced: texture_2d<f32>;
@group(1) @binding(1) var lut: texture_3d<f32>;
// What the blur, bloom and Kuwahara passes made (grade_prepass.wgsl), in straight sRGB colour; a 1 x 1 blank when off.
@group(1) @binding(2) var blur_tex: texture_2d<f32>;
@group(1) @binding(3) var kuwahara_tex: texture_2d<f32>;
@group(1) @binding(4) var bloom_tex: texture_2d<f32>;

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

// ---- the look effects (HyperFrames' `effects`) ----
//
// The shader of HyperFrames' runtime ports as it is: the effects that move or smear the picture (pixelate, tape
// damage, chroma bleed, channel separation, digital glitch, CRT warp, blur and Kuwahara through their own passes) change
// how the picture is read; the grade, the grain and the film artifacts follow; then the print and drawing effects
// (mono screen, engraving, crosshatch, halftone, two-ink, dither, ascii), the bloom, the scanlines, the vignette and
// the CRT mask. Apache-2.0, heygen-com/hyperframes, packages/core/src/runtime/colorGrading.ts.
//
// The picture is read through `sample_media(uv)`, `uv` running over the graded box with rows counting up (HyperFrames'
// `v_uv`): the layer's texture is read at the canvas pixel the box point lands on, with the bilinear filter by hand, in
// straight sRGB colour. Positions the effects take from `gl_FragCoord` come from `g_frag`, the pixel's place in the box.

const E_BLUR = 0u;
const E_PIXELATE = 1u;
const E_CHROMA_BLEED = 2u;
const E_TAPE = 3u;
const E_TAPE_TRACKING = 4u;
const E_TAPE_NOISE = 5u;
const E_TAPE_SPEED = 6u;
const E_FILM = 7u;
const E_HALFTONE = 8u;
const E_HALFTONE_SIZE = 9u;
const E_TWO_INK = 10u;
const E_TWO_INK_SIZE = 11u;
const E_ASCII = 12u;
const E_ASCII_SIZE = 13u;
const E_ASCII_INVERT = 14u;
const E_ASCII_STYLE = 15u;
const E_ASCII_COLOR = 16u;
const E_ASCII_ROTATION = 17u;
const E_DITHER = 18u;
const E_DITHER_SIZE = 19u;
const E_BLOOM = 20u;
const E_MONO = 22u;
const E_MONO_SIZE = 23u;
const E_MONO_ANGLE = 24u;
const E_MONO_SPREAD = 25u;
const E_MONO_SHAPE = 26u;
const E_MONO_INVERT = 27u;
const E_SCAN = 28u;
const E_SCAN_COUNT = 29u;
const E_SCAN_SOFT = 30u;
const E_CHROMATIC = 31u;
const E_CHROMATIC_ANGLE = 32u;
const E_CRT = 33u;
const E_GLITCH = 34u;
const E_GL_SPLIT = 35u;
const E_GL_TEAR = 36u;
const E_GL_PIXELATE = 37u;
const E_GL_BLOCKS = 38u;
const E_GL_DISP = 39u;
const E_GL_OPACITY = 40u;
const E_GL_SPEED = 41u;
const E_ENGRAVING = 42u;
const E_EN_SPACING = 43u;
const E_EN_MIN = 44u;
const E_EN_MAX = 45u;
const E_EN_ANGLE = 46u;
const E_EN_CONTRAST = 47u;
const E_EN_SHARP = 48u;
const E_EN_WAVE = 49u;
const E_EN_WAVE_FREQ = 50u;
const E_CROSS = 51u;
const E_CH_SPACING = 52u;
const E_CH_THICK = 53u;
const E_CH_ANGLE = 54u;
const E_CH_CONTRAST = 55u;
const E_CH_EDGES = 56u;
const E_CH_WEIGHT = 57u;
const E_CH_WAVE = 58u;
const E_CH_WAVE_FREQ = 59u;
const E_KUWAHARA = 60u;

const PI = 3.14159265359;

// The graded box's size in layer pixels (`u_resolution`), the output pixel's place in it (`gl_FragCoord`), and its
// uv (`v_uv`, rows counting up).
var<private> g_size: vec2<f32>;
var<private> g_frag: vec2<f32>;

fn fx(i: u32) -> f32 {
    return params.fx[i >> 2u][i & 3u];
}

fn gl_mod2(x: vec2<f32>, y: f32) -> vec2<f32> {
    return x - y * floor(x / y);
}

fn bt601_luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

fn digital_hash(p: vec2<f32>) -> f32 {
    let q = gl_mod2(floor(p), 251.0);
    let x = gl_mod(q.x * q.x * 157.0 + q.x * 89.0, 251.0);
    let y = gl_mod(q.y * q.y * 113.0 + q.y * 47.0, 251.0);
    let xy = gl_mod(q.x * q.y * 71.0, 251.0);
    return gl_mod(x + y + xy + 19.0, 251.0) / 251.0;
}

fn b2f(v: bool) -> f32 {
    return select(0.0, 1.0, v);
}

fn clamp_uv(uv: vec2<f32>) -> vec2<f32> {
    return clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
}

fn apply_crt_warp(uv: vec2<f32>) -> vec2<f32> {
    var centered = uv * 2.0 - vec2<f32>(1.0);
    let curvature = clamp(fx(E_CRT), 0.0, 1.0) * 0.5;
    let dist = dot(centered, centered);
    centered *= 1.0 + curvature * dist;
    return centered * 0.5 + vec2<f32>(0.5);
}

// ---- reading the picture ----

// The canvas pixel (continuous, texel centres at +0.5) of the point `uv` of the graded box.
fn canvas_of_uv(uv: vec2<f32>) -> vec2<f32> {
    let layer = params.box_rect.xy + vec2<f32>(uv.x, 1.0 - uv.y) * g_size;
    let m = params.forward;
    let t = params.forward2.xy;
    return vec2<f32>(m.x * layer.x + m.z * layer.y + t.x, m.y * layer.x + m.w * layer.y + t.y);
}

// A uv held a half texel inside the box: the filter then never reads past the picture (clamp to edge).
fn edge_uv(uv: vec2<f32>) -> vec2<f32> {
    let h = vec2<f32>(0.5) / g_size;
    return clamp(uv, h, vec2<f32>(1.0) - h);
}

fn decode_texel(c: vec4<f32>) -> vec4<f32> {
    if c.a <= 0.0 {
        return vec4<f32>(0.0);
    }
    return vec4<f32>(linear_to_srgb(clamp(c.rgb / c.a, vec3<f32>(0.0), vec3<f32>(1.0))), c.a);
}

fn src_texel(xy: vec2<i32>) -> vec4<f32> {
    return decode_texel(load_a(xy));
}

fn src_bilinear(pos: vec2<f32>) -> vec4<f32> {
    let q = pos - vec2<f32>(0.5);
    let i = floor(q);
    let f = q - i;
    let xy = vec2<i32>(i);
    let a = src_texel(xy);
    let b = src_texel(xy + vec2<i32>(1, 0));
    let c = src_texel(xy + vec2<i32>(0, 1));
    let d = src_texel(xy + vec2<i32>(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

fn extra_texel(t: texture_2d<f32>, place: vec4<f32>, xy: vec2<i32>) -> vec4<f32> {
    let q = xy - vec2<i32>(place.xy);
    let size = vec2<i32>(place.zw);
    if any(q < vec2<i32>(0)) || any(q >= size) {
        return vec4<f32>(0.0);
    }
    return textureLoad(t, q, 0);
}

fn extra_bilinear(t: texture_2d<f32>, place: vec4<f32>, pos: vec2<f32>) -> vec4<f32> {
    let q = pos - vec2<f32>(0.5);
    let i = floor(q);
    let f = q - i;
    let xy = vec2<i32>(i);
    let a = extra_texel(t, place, xy);
    let b = extra_texel(t, place, xy + vec2<i32>(1, 0));
    let c = extra_texel(t, place, xy + vec2<i32>(0, 1));
    let d = extra_texel(t, place, xy + vec2<i32>(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

fn sample_source(uv: vec2<f32>) -> vec4<f32> {
    return src_bilinear(canvas_of_uv(edge_uv(clamp_uv(uv))));
}

fn sample_blur(uv: vec2<f32>) -> vec4<f32> {
    return extra_bilinear(blur_tex, params.blur_place, canvas_of_uv(edge_uv(clamp_uv(uv))));
}

fn sample_kuwahara(uv: vec2<f32>) -> vec3<f32> {
    return extra_bilinear(kuwahara_tex, params.kuwahara_place, canvas_of_uv(edge_uv(clamp_uv(uv)))).rgb;
}

// The bloom texture is half size (grade_prepass.wgsl): texel i covers canvas pixels 2i and 2i + 1 from its origin. It is
// read clamped to its edge, as HyperFrames reads its bloom framebuffer.
fn bloom_texel(xy: vec2<i32>) -> vec4<f32> {
    return textureLoad(bloom_tex, clamp(xy, vec2<i32>(0), vec2<i32>(params.bloom_place.zw) - vec2<i32>(1)), 0);
}

fn sample_bloom(uv: vec2<f32>) -> vec3<f32> {
    let q = (canvas_of_uv(edge_uv(clamp_uv(uv))) - params.bloom_place.xy) * 0.5 - vec2<f32>(0.5);
    let i = floor(q);
    let f = q - i;
    let xy = vec2<i32>(i);
    let a = bloom_texel(xy);
    let b = bloom_texel(xy + vec2<i32>(1, 0));
    let c = bloom_texel(xy + vec2<i32>(0, 1));
    let d = bloom_texel(xy + vec2<i32>(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y).rgb;
}

fn sample_prepared(uv: vec2<f32>) -> vec4<f32> {
    var base = sample_source(uv);
    let blur = clamp(fx(E_BLUR), 0.0, 1.0);
    if blur > 0.0 && params.ready.x > 0.5 {
        base = mix(base, sample_blur(uv), blur);
    }
    let kuwahara = clamp(fx(E_KUWAHARA), 0.0, 1.0);
    if kuwahara > 0.0 && params.ready.z > 0.5 {
        base = vec4<f32>(mix(base.rgb, sample_kuwahara(uv), kuwahara), base.a);
    }
    return base;
}

fn tape_tracking_band(y: f32, center: f32, width: f32) -> f32 {
    let offset = gl_fract(y - center + 0.5) - 0.5;
    let triangle = max(0.0, 1.0 - abs(offset) / max(width, 0.0001));
    return triangle * triangle * (3.0 - 2.0 * triangle);
}

fn sample_media(uv: vec2<f32>) -> vec4<f32> {
    let pixel = clamp(fx(E_PIXELATE), 0.0, 1.0);
    var sample_uv = uv;
    if pixel > 0.0 {
        let block_size = mix(1.0, 48.0, pixel);
        let cells = max(g_size / block_size, vec2<f32>(1.0));
        sample_uv = (floor(clamp(uv, vec2<f32>(0.0), vec2<f32>(0.999999)) * cells) + vec2<f32>(0.5)) / cells;
    }
    let tape_damage = clamp(fx(E_TAPE), 0.0, 1.0);
    let tape_tracking = clamp(fx(E_TAPE_TRACKING), 0.0, 1.0);
    let tape_noise = clamp(fx(E_TAPE_NOISE), 0.0, 1.0);
    let tape_time = params.forward2.z * mix(0.0, 2.0, clamp(fx(E_TAPE_SPEED), 0.0, 1.0));
    let tape_frame = floor(tape_time * 60.0);
    let tape_line = floor(sample_uv.y * g_size.y * 0.5);
    var tape_shift = 0.0;
    if tape_damage > 0.0 {
        let line_jitter = (digital_hash(vec2<f32>(tape_line, floor(tape_frame * 0.5))) - 0.5) * 1.8 * tape_noise;
        let slow_wobble = sin(sample_uv.y * 32.0 + tape_time * 2.6) * 0.55;
        let head_switch = smoothstep(0.88, 1.0, sample_uv.y) * sin(sample_uv.y * 240.0 + tape_time * 8.0) * 4.0;
        var tracking_shift = tape_tracking_band(sample_uv.y, gl_fract(0.08 + tape_time * 0.083), 0.035);
        tracking_shift -= tape_tracking_band(sample_uv.y, gl_fract(0.28 + tape_time * 0.061), 0.03) * 0.8;
        tracking_shift += tape_tracking_band(sample_uv.y, gl_fract(0.5 + tape_time * 0.047), 0.04) * 0.75;
        tracking_shift -= tape_tracking_band(sample_uv.y, gl_fract(0.72 + tape_time * 0.037), 0.028) * 0.65;
        tracking_shift += tape_tracking_band(sample_uv.y, gl_fract(0.89 + tape_time * 0.029), 0.032) * 0.55;
        tracking_shift *= tape_tracking * 48.0;
        tape_shift = (line_jitter + slow_wobble + head_switch + tracking_shift) * tape_damage;
    }
    let texel_x = 1.0 / max(g_size.x, 1.0);
    let tape_uv = sample_uv + vec2<f32>(tape_shift * texel_x, 0.0);
    var base = sample_prepared(tape_uv);
    if tape_damage > 0.0 {
        let luma_step = vec2<f32>(texel_x * mix(1.0, 3.5, tape_damage), 0.0);
        let left_tape = sample_prepared(tape_uv - luma_step).rgb;
        let right_tape = sample_prepared(tape_uv + luma_step).rgb;
        let tape_luma = (bt601_luma(left_tape) + bt601_luma(base.rgb) * 2.0 + bt601_luma(right_tape)) * 0.25;
        let center_chroma = base.rgb - vec3<f32>(bt601_luma(base.rgb));
        var tape_color = vec3<f32>(tape_luma) + center_chroma;
        let ghost = sample_prepared(tape_uv - vec2<f32>(texel_x * 12.0, 0.0)).rgb;
        tape_color = mix(tape_color, ghost, 0.045 * tape_damage);
        let fine_noise = digital_hash(floor(g_frag) + vec2<f32>(tape_frame * 17.0, tape_frame * 3.0)) - 0.5;
        let band = digital_hash(vec2<f32>(floor(sample_uv.y * 92.0), floor(tape_frame / 3.0)));
        let dropout = smoothstep(0.985, 1.0, band) * (digital_hash(vec2<f32>(floor(sample_uv.x * 18.0), tape_line)) - 0.5);
        tape_color += (fine_noise * 0.035 + dropout * 0.12) * tape_damage * tape_noise;
        base = vec4<f32>(mix(base.rgb, clamp(tape_color, vec3<f32>(0.0), vec3<f32>(1.0)), tape_damage), base.a);
    }
    let chroma_bleed = clamp(fx(E_CHROMA_BLEED), 0.0, 1.0);
    if chroma_bleed > 0.0 {
        let radius = mix(1.0, 4.0, chroma_bleed);
        let step_uv = vec2<f32>(texel_x * radius, 0.0);
        let c0 = base.rgb;
        let c1 = sample_prepared(tape_uv - step_uv).rgb;
        let c2 = sample_prepared(tape_uv + step_uv).rgb;
        let c3 = sample_prepared(tape_uv - step_uv * 2.0).rgb;
        let c4 = sample_prepared(tape_uv + step_uv * 2.0).rgb;
        let center_luma = luma_of(base.rgb);
        let blurred_chroma = ((c0 - vec3<f32>(luma_of(c0))) * 6.0 + (c1 - vec3<f32>(luma_of(c1))) * 4.0
            + (c2 - vec3<f32>(luma_of(c2))) * 4.0 + (c3 - vec3<f32>(luma_of(c3))) + (c4 - vec3<f32>(luma_of(c4)))) / 16.0;
        base = vec4<f32>(
            mix(base.rgb, clamp(vec3<f32>(center_luma) + blurred_chroma, vec3<f32>(0.0), vec3<f32>(1.0)), chroma_bleed),
            base.a,
        );
    }
    return base;
}

fn sample_chromatic_media(uv: vec2<f32>, center: vec4<f32>) -> vec4<f32> {
    let amount = clamp(fx(E_CHROMATIC), 0.0, 1.0);
    if amount <= 0.0 {
        return center;
    }
    let angle = clamp(fx(E_CHROMATIC_ANGLE), 0.0, 1.0) * PI * 2.0;
    let offset = vec2<f32>(cos(angle), sin(angle)) * amount * 0.02;
    let positive = sample_media(uv + offset);
    let negative = sample_media(uv - offset);
    return vec4<f32>(positive.r, center.g, negative.b, center.a);
}

fn sample_digital_split(uv: vec2<f32>, block: vec2<f32>, time: f32, amount: f32) -> vec3<f32> {
    let split = amount * 0.06;
    let direction = digital_hash(block * 0.4 + vec2<f32>(floor(time * 3.7), floor(time * 5.3)));
    var axis = vec2<f32>(0.7071);
    if direction > 0.66 {
        axis = vec2<f32>(1.0, 0.0);
    } else if direction > 0.33 {
        axis = vec2<f32>(0.0, 1.0);
    }
    let center = sample_media(uv);
    return vec3<f32>(sample_media(uv + axis * split).r, center.g, sample_media(uv - axis * split).b);
}

fn apply_digital_glitch(uv: vec2<f32>, source: vec3<f32>) -> vec3<f32> {
    let amount = clamp(fx(E_GLITCH), 0.0, 1.0);
    if amount <= 0.0 {
        return source;
    }
    let color_split = clamp(fx(E_GL_SPLIT), 0.0, 1.0) * 2.0;
    let line_tear = clamp(fx(E_GL_TEAR), 0.0, 1.0) * 2.0;
    let pixelate = clamp(fx(E_GL_PIXELATE), 0.0, 1.0) * 2.0;
    let block_amount = clamp(fx(E_GL_BLOCKS), 0.0, 1.0);
    let block_displacement = clamp(fx(E_GL_DISP), 0.0, 1.0) * 2.0;
    let block_opacity = clamp(fx(E_GL_OPACITY), 0.0, 1.0);
    let speed = clamp(fx(E_GL_SPEED), 0.0, 1.0) * 2.0;
    let time = params.forward2.z * speed;
    let block_count = 8.0 + block_amount * 60.0;
    let block = floor(uv * block_count);
    let random_a = digital_hash(block + vec2<f32>(floor(time * 7.3), floor(time * 11.1)));
    let random_b = digital_hash(block * 0.7 + vec2<f32>(17.3 + floor(time * 6.6), 29.1));
    let random_c = digital_hash(block + vec2<f32>(floor(time * 5.7) * 13.0, 41.0));
    let random_d = digital_hash(block * 1.3 + vec2<f32>(7.0, floor(time * 3.2) * 7.0));
    var displaced = uv;
    if block_displacement > 0.0 && block_opacity > 0.0 {
        let threshold = 1.0 - block_displacement * 0.4;
        if random_a > threshold {
            displaced += vec2<f32>((random_b - 0.5) * block_displacement * 0.5, (random_c - 0.5) * block_displacement * 0.3);
        }
        if random_d > 0.92 && block_displacement > 0.5 {
            displaced.x += (digital_hash(vec2<f32>(block.y, floor(time * 8.0))) - 0.5) * block_displacement;
        }
        displaced = mix(uv, displaced, block_opacity);
    }
    if line_tear > 0.0 {
        let row = floor(uv.y * (50.0 + line_tear * 150.0));
        let tear_a = digital_hash(vec2<f32>(row * 7.3 + floor(time * 12.0 + row * 0.1) * 3.7, 13.0));
        let tear_b = digital_hash(vec2<f32>(row * 13.7 + floor(time * 8.3) * 5.1, 31.0));
        if tear_a > 1.0 - line_tear * 0.5 {
            displaced.x += (tear_b - 0.5) * line_tear * 0.4;
        }
        if tear_b > 0.95 && line_tear > 0.3 {
            displaced.x += (tear_a - 0.5) * line_tear * 0.8;
        }
    }
    if pixelate > 0.0 {
        let pixel_random = digital_hash(block * 0.5 + vec2<f32>(floor(time * 4.9), 53.0));
        if pixel_random > 1.0 - pixelate * 0.35 {
            let cells = 4.0 + (1.0 - pixel_random) * pixelate * 40.0;
            displaced = (floor(clamp_uv(displaced) * cells) + vec2<f32>(0.5)) / cells;
        }
    }
    displaced = clamp_uv(displaced);
    var glitch = sample_digital_split(displaced, block, time, color_split);
    if block_displacement > 0.2 && block_opacity > 0.0 {
        let corruption = digital_hash(block * 1.1 + vec2<f32>(floor(time * 11.9), 67.0));
        var changed = glitch;
        if corruption > 0.9 {
            changed = vec3<f32>(1.0) - glitch;
        } else if corruption > 0.85 {
            if corruption > 0.875 {
                changed = glitch.gbr;
            } else {
                changed = glitch.brg;
            }
        } else if corruption > 0.8 {
            let channel = digital_hash(block + vec2<f32>(73.0));
            if channel > 0.66 {
                changed.r = min(changed.r * 2.0, 1.0);
            } else if channel > 0.33 {
                changed.g = min(changed.g * 2.0, 1.0);
            } else {
                changed.b = min(changed.b * 2.0, 1.0);
            }
        }
        glitch = mix(glitch, changed, block_opacity);
    }
    if block_opacity > 0.0 {
        let flash = digital_hash(block * 0.8 + vec2<f32>(floor(time * 14.7), 83.0));
        var flashed = glitch;
        if flash > 0.97 {
            flashed = min(glitch * 1.8, vec3<f32>(1.0));
        } else if flash > 0.94 {
            flashed = glitch * 0.3;
        }
        glitch = mix(glitch, flashed, block_opacity * 0.6);
    }
    if line_tear > 0.1 {
        let interference = pow(sin(uv.y * (300.0 + random_a * 200.0) + time * 30.0) * 0.5 + 0.5, 6.0);
        glitch -= vec3<f32>(interference * 0.08 * line_tear);
    }
    return mix(source, clamp(glitch, vec3<f32>(0.0), vec3<f32>(1.0)), amount);
}

fn dust_mask(uv: vec2<f32>, frame_bucket: f32) -> f32 {
    let grid = vec2<f32>(128.0, 72.0);
    let cell = floor(uv * grid);
    let local = gl_fract2(uv * grid) - vec2<f32>(0.5);
    let chance = grain_noise(cell + vec2<f32>(frame_bucket * 19.13));
    let radius = mix(0.05, 0.34, grain_noise(cell + vec2<f32>(7.1)));
    return step(0.9975, chance) * (1.0 - smoothstep(radius, radius + 0.08, length(local)));
}

fn gl_fract2(x: vec2<f32>) -> vec2<f32> {
    return x - floor(x);
}

fn screen_dot(p: vec2<f32>, ink: f32, angle: f32, sharpness: f32) -> f32 {
    let c = cos(angle);
    let s = sin(angle);
    let q = vec2<f32>(c * p.x + s * p.y, -s * p.x + c * p.y);
    let d = gl_fract2(q) - vec2<f32>(0.5);
    let radius = sqrt(clamp(ink, 0.0, 1.0)) * 0.68;
    let edge = mix(0.16, 0.025, sharpness);
    return 1.0 - smoothstep(radius - edge, radius + edge, length(d));
}

fn palette_color(index: f32) -> vec3<f32> {
    if index < 0.5 {
        return params.palette[0].xyz;
    }
    if index < 1.5 {
        return params.palette[1].xyz;
    }
    if index < 2.5 {
        return params.palette[2].xyz;
    }
    if index < 3.5 {
        return params.palette[3].xyz;
    }
    if index < 4.5 {
        return params.palette[4].xyz;
    }
    return params.palette[5].xyz;
}

fn palette_size() -> f32 {
    return params.forward2.w;
}

fn mono_screen_mask(local: vec2<f32>, radius: f32, shape: f32, softness: f32) -> f32 {
    let centered = local - vec2<f32>(0.5);
    var distance_to_ink = length(centered);
    if shape > 0.5 && shape < 1.5 {
        distance_to_ink = max(abs(centered.x), abs(centered.y));
    }
    if shape > 1.5 && shape < 2.5 {
        distance_to_ink = abs(centered.x) + abs(centered.y);
    }
    if shape > 2.5 && shape < 3.5 {
        distance_to_ink = max(abs(centered.x) * 0.86 + centered.y * 0.5, -centered.y);
    }
    if shape > 3.5 {
        distance_to_ink = abs(centered.y);
    }
    var shape_radius = radius;
    if shape > 3.5 {
        shape_radius = radius * 0.45;
    }
    return 1.0 - smoothstep(shape_radius, shape_radius + softness, distance_to_ink);
}

fn apply_mono_screen(source: vec3<f32>, amount: f32) -> vec3<f32> {
    if amount <= 0.0 {
        return source;
    }
    let invert = step(0.5, fx(E_MONO_INVERT));
    var coverage = mix(1.0 - luma_of(source), luma_of(source), invert);
    coverage = pow(clamp(coverage, 0.0, 1.0), mix(1.7, 0.58, clamp(fx(E_MONO_SPREAD), 0.0, 1.0)));
    let scale = max(min(g_size.x, g_size.y) / 540.0, 0.25);
    let cell_px = mix(4.0, 18.0, clamp(fx(E_MONO_SIZE), 0.0, 1.0)) * scale;
    let angle = clamp(fx(E_MONO_ANGLE), 0.0, 1.0) * PI * 0.5;
    let cosine = cos(angle);
    let sine = sin(angle);
    let rotated = vec2<f32>(cosine * g_frag.x + sine * g_frag.y, -sine * g_frag.x + cosine * g_frag.y);
    let point = rotated / max(cell_px, 1.0);
    let radius = sqrt(coverage) * 0.68;
    let ink_mask = mono_screen_mask(gl_fract2(point), radius, floor(fx(E_MONO_SHAPE) + 0.5), 0.035);
    let ink = palette_color(0.0);
    let paper = palette_color(max(palette_size() - 1.0, 1.0));
    return mix(source, mix(paper, ink, ink_mask), amount);
}

fn apply_engraving(source: vec3<f32>, amount: f32) -> vec3<f32> {
    if amount <= 0.0 {
        return source;
    }
    let spacing = mix(3.0, 20.0, clamp(fx(E_EN_SPACING), 0.0, 1.0));
    let min_thickness = mix(0.0, 2.0, clamp(fx(E_EN_MIN), 0.0, 1.0));
    let max_thickness = mix(1.0, 8.0, clamp(fx(E_EN_MAX), 0.0, 1.0));
    let angle = clamp(fx(E_EN_ANGLE), 0.0, 1.0) * PI;
    let along_axis = vec2<f32>(cos(angle), sin(angle));
    let across_axis = vec2<f32>(-along_axis.y, along_axis.x);
    let along = dot(g_frag, along_axis);
    var across = dot(g_frag, across_axis);
    let frequency = mix(1.0, 10.0, clamp(fx(E_EN_WAVE_FREQ), 0.0, 1.0));
    let wave = sin(along * frequency * 0.01);
    across += wave * clamp(fx(E_EN_WAVE), 0.0, 1.0) * 3.0;
    let line_index = floor(across / max(spacing, 1.0));
    let line_distance = abs(gl_fract(across / max(spacing, 1.0)) - 0.5) * spacing;
    let contrast = mix(0.5, 2.0, clamp(fx(E_EN_CONTRAST), 0.0, 1.0));
    let darkness = 1.0 - pow(clamp(luma_of(source), 0.0, 1.0), contrast);
    let variation = mix(0.88, 1.12, digital_hash(vec2<f32>(line_index, 73.0)));
    let thickness = mix(min_thickness, max_thickness, darkness) * variation;
    let edge = mix(1.0, 0.3, clamp(fx(E_EN_SHARP), 0.0, 1.0));
    var ink_mask = 1.0 - smoothstep(max(thickness * 0.5 - edge, 0.0), thickness * 0.5 + edge, line_distance);
    ink_mask *= smoothstep(0.015, 0.12, darkness);
    let ink = palette_color(0.0);
    let paper = palette_color(max(palette_size() - 1.0, 1.0));
    return mix(source, mix(paper, ink, ink_mask), amount);
}

fn crosshatch_line(pixel: vec2<f32>, angle: f32, spacing: f32, thickness: f32, seed: f32) -> f32 {
    let along_axis = vec2<f32>(cos(angle), sin(angle));
    let across_axis = vec2<f32>(-along_axis.y, along_axis.x);
    let along = dot(pixel, along_axis);
    var across = dot(pixel, across_axis);
    let frequency = mix(1.0, 10.0, clamp(fx(E_CH_WAVE_FREQ), 0.0, 1.0));
    across += sin(along * frequency * 0.02 + params.forward2.z + seed) * clamp(fx(E_CH_WAVE), 0.0, 1.0) * 5.0;
    let line_index = floor(across / max(spacing, 1.0));
    let distance_to_line = abs(gl_fract(across / max(spacing, 1.0)) - 0.5) * spacing;
    let variation = mix(1.0, 0.5 + digital_hash(vec2<f32>(line_index, seed)), clamp(fx(E_CH_WEIGHT), 0.0, 1.0));
    let half_width = thickness * variation * 0.5;
    return 1.0 - smoothstep(max(half_width - 0.5, 0.0), half_width + 0.5, distance_to_line);
}

fn crosshatch_edge(uv: vec2<f32>) -> f32 {
    let texel = vec2<f32>(1.0) / max(g_size, vec2<f32>(1.0));
    let tl = luma_of(sample_media(uv + texel * vec2<f32>(-1.0, -1.0)).rgb);
    let tc = luma_of(sample_media(uv + texel * vec2<f32>(0.0, -1.0)).rgb);
    let tr = luma_of(sample_media(uv + texel * vec2<f32>(1.0, -1.0)).rgb);
    let ml = luma_of(sample_media(uv + texel * vec2<f32>(-1.0, 0.0)).rgb);
    let mr = luma_of(sample_media(uv + texel * vec2<f32>(1.0, 0.0)).rgb);
    let bl = luma_of(sample_media(uv + texel * vec2<f32>(-1.0, 1.0)).rgb);
    let bc = luma_of(sample_media(uv + texel * vec2<f32>(0.0, 1.0)).rgb);
    let br = luma_of(sample_media(uv + texel * vec2<f32>(1.0, 1.0)).rgb);
    let gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
    let gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
    return length(vec2<f32>(gx, gy));
}

fn apply_crosshatch(uv: vec2<f32>, source: vec3<f32>, amount: f32) -> vec3<f32> {
    if amount <= 0.0 {
        return source;
    }
    let spacing = mix(5.0, 30.0, clamp(fx(E_CH_SPACING), 0.0, 1.0));
    let thickness = mix(1.0, 5.0, clamp(fx(E_CH_THICK), 0.0, 1.0));
    let base_angle = -clamp(fx(E_CH_ANGLE), 0.0, 1.0) * PI;
    let contrast = mix(0.5, 2.0, clamp(fx(E_CH_CONTRAST), 0.0, 1.0));
    let darkness = 1.0 - pow(clamp(luma_of(source), 0.0, 1.0), contrast);
    let ink = palette_color(0.0);
    let paper = palette_color(max(palette_size() - 1.0, 1.0));
    var result = paper;
    var layer = crosshatch_line(g_frag, base_angle, spacing, thickness, 1.0) * smoothstep(0.2, 0.4, darkness);
    result = mix(result, ink, layer);
    layer = crosshatch_line(g_frag, base_angle + PI * 0.5, spacing * 0.95, thickness * 0.9, 2.0) * smoothstep(0.4, 0.6, darkness);
    result = mix(result, ink, layer);
    layer = crosshatch_line(g_frag, base_angle + PI * 0.25, spacing * 0.9, thickness * 0.8, 3.0) * smoothstep(0.6, 0.8, darkness);
    result = mix(result, ink, layer);
    layer = crosshatch_line(g_frag, base_angle - PI * 0.25, spacing * 0.85, thickness * 0.7, 4.0) * smoothstep(0.75, 0.9, darkness);
    result = mix(result, ink, layer);
    result = mix(result, ink, smoothstep(0.9, 1.0, darkness) * 0.8);
    let edge_strength = mix(0.0, 2.0, clamp(fx(E_CH_EDGES), 0.0, 1.0));
    let edge = smoothstep(0.1, 0.3, crosshatch_edge(uv)) * edge_strength;
    result = mix(result, ink, clamp(edge, 0.0, 1.0));
    return mix(source, result, amount);
}

fn apply_halftone(source: vec3<f32>, amount: f32) -> vec3<f32> {
    if amount <= 0.0 {
        return source;
    }
    let cmy = vec3<f32>(1.0) - source;
    let k = min(cmy.r, min(cmy.g, cmy.b));
    let inks = max(cmy - vec3<f32>(k * 0.72), vec3<f32>(0.0));
    let scale = min(g_size.x, g_size.y) / 540.0;
    let cell_px = mix(5.0, 14.0, clamp(fx(E_HALFTONE_SIZE), 0.0, 1.0)) * max(scale, 0.25);
    let p = g_frag / max(cell_px, 1.0);
    let cyan = screen_dot(p, inks.r, 0.261799, 0.78);
    let magenta = screen_dot(p, inks.g, 1.308997, 0.78);
    let yellow = screen_dot(p, inks.b, 0.0, 0.78);
    let black_ink = screen_dot(p, k, 0.785398, 0.82);
    var print_color = vec3<f32>(0.975, 0.962, 0.925);
    print_color *= mix(vec3<f32>(1.0), vec3<f32>(0.05, 0.79, 0.86), cyan);
    print_color *= mix(vec3<f32>(1.0), vec3<f32>(0.91, 0.08, 0.48), magenta);
    print_color *= mix(vec3<f32>(1.0), vec3<f32>(0.98, 0.83, 0.08), yellow);
    print_color *= mix(vec3<f32>(1.0), vec3<f32>(0.035), black_ink * 0.92);
    return mix(source, print_color, amount);
}

fn apply_two_ink_print(source: vec3<f32>, amount: f32) -> vec3<f32> {
    if amount <= 0.0 {
        return source;
    }
    let source_luma = luma_of(source);
    let darkness = 1.0 - source_luma;
    let warm_bias = clamp(source.r - (source.g + source.b) * 0.5, -0.35, 0.35);
    let cool_bias = clamp((source.g + source.b) * 0.5 - source.r, -0.35, 0.35);
    let red_tone = smoothstep(0.08, 0.72, darkness) * (1.0 - 0.68 * smoothstep(0.66, 1.0, darkness));
    let teal_tone = smoothstep(0.30, 0.92, darkness);
    let red_coverage = clamp(red_tone + warm_bias * 1.35 - cool_bias * 0.35, 0.0, 1.0);
    let teal_coverage = clamp(teal_tone + cool_bias * 1.1 - warm_bias * 0.45, 0.0, 1.0);
    let scale = min(g_size.x, g_size.y) / 540.0;
    let cell_px = mix(4.5, 12.0, clamp(fx(E_TWO_INK_SIZE), 0.0, 1.0)) * max(scale, 0.25);
    let p = g_frag / max(cell_px, 1.0);
    let red_dot = screen_dot(p, red_coverage, 0.261799, 0.84);
    let teal_dot = screen_dot(p + vec2<f32>(0.12, -0.08), teal_coverage, 1.308997, 0.84);
    let paper_noise = grain_noise(floor(g_frag * 0.5)) - 0.5;
    let paper = vec3<f32>(0.955, 0.910, 0.795) + vec3<f32>(paper_noise * 0.018);
    let vermilion = vec3<f32>(0.88, 0.13, 0.075);
    let teal = vec3<f32>(0.035, 0.285, 0.355);
    let overprint = vec3<f32>(0.045, 0.055, 0.052);
    var print_color = paper * (1.0 - red_dot) * (1.0 - teal_dot);
    print_color += vermilion * red_dot * (1.0 - teal_dot);
    print_color += teal * (1.0 - red_dot) * teal_dot;
    print_color += overprint * red_dot * teal_dot;
    return mix(source, clamp(print_color, vec3<f32>(0.0), vec3<f32>(1.0)), amount);
}

fn bayer4(point: vec2<f32>) -> f32 {
    let cell = gl_mod2(floor(point), 4.0);
    if cell.y < 0.5 {
        if cell.x < 0.5 { return 0.5 / 16.0; }
        if cell.x < 1.5 { return 8.5 / 16.0; }
        if cell.x < 2.5 { return 2.5 / 16.0; }
        return 10.5 / 16.0;
    }
    if cell.y < 1.5 {
        if cell.x < 0.5 { return 12.5 / 16.0; }
        if cell.x < 1.5 { return 4.5 / 16.0; }
        if cell.x < 2.5 { return 14.5 / 16.0; }
        return 6.5 / 16.0;
    }
    if cell.y < 2.5 {
        if cell.x < 0.5 { return 3.5 / 16.0; }
        if cell.x < 1.5 { return 11.5 / 16.0; }
        if cell.x < 2.5 { return 1.5 / 16.0; }
        return 9.5 / 16.0;
    }
    if cell.x < 0.5 { return 15.5 / 16.0; }
    if cell.x < 1.5 { return 7.5 / 16.0; }
    if cell.x < 2.5 { return 13.5 / 16.0; }
    return 5.5 / 16.0;
}

fn apply_dither(source: vec3<f32>, amount: f32) -> vec3<f32> {
    if amount <= 0.0 {
        return source;
    }
    let scale = max(min(g_size.x, g_size.y) / 540.0, 0.25);
    let pixel_size = mix(1.0, 5.0, clamp(fx(E_DITHER_SIZE), 0.0, 1.0)) * scale;
    let block = floor(g_frag / max(pixel_size, 1.0));
    let levels = clamp(palette_size(), 2.0, 6.0);
    let index = floor(clamp(luma_of(source) * (levels - 1.0) + bayer4(block), 0.0, levels - 1.0));
    return mix(source, palette_color(index), amount);
}

fn standard_ascii_sample(brightness: f32, grid: vec2<f32>) -> f32 {
    if brightness < 0.1 {
        return 0.0;
    }
    if brightness < 0.2 {
        return b2f(grid.x == 2.0 && grid.y == 5.0);
    }
    if brightness < 0.3 {
        return b2f(grid.x == 2.0 && (grid.y == 2.0 || grid.y == 4.0));
    }
    if brightness < 0.4 {
        return b2f((grid.y == 2.0 || grid.y == 4.0) && grid.x >= 1.0 && grid.x <= 3.0);
    }
    if brightness < 0.5 {
        let cross_shape = (grid.x == 2.0 && grid.y >= 2.0 && grid.y <= 4.0) || (grid.y == 3.0 && grid.x >= 1.0 && grid.x <= 3.0);
        let diagonals = (grid.x == 1.0 || grid.x == 3.0) && (grid.y == 2.0 || grid.y == 4.0);
        return b2f(cross_shape || diagonals);
    }
    if brightness < 0.6 {
        let ring = ((grid.y == 2.0 || grid.y == 4.0) && grid.x >= 1.0 && grid.x <= 3.0) || ((grid.x == 1.0 || grid.x == 3.0) && grid.y == 3.0);
        return b2f(ring);
    }
    let outline = ((grid.y == 1.0 || grid.y == 5.0) && grid.x >= 1.0 && grid.x <= 3.0)
        || ((grid.x == 0.0 || grid.x == 4.0) && grid.y >= 2.0 && grid.y <= 4.0)
        || ((grid.x == 1.0 || grid.x == 3.0) && grid.y >= 1.0 && grid.y <= 5.0);
    if brightness < 0.7 {
        return b2f(outline);
    }
    if brightness < 0.8 {
        let slash = abs(grid.x - 2.0) == abs(grid.y - 3.0) && grid.x >= 1.0 && grid.x <= 3.0;
        return b2f(outline || slash);
    }
    if brightness < 0.9 {
        let loops = ((grid.y == 1.0 || grid.y == 3.0 || grid.y == 5.0) && grid.x >= 1.0 && grid.x <= 3.0)
            || ((grid.x == 1.0 || grid.x == 3.0) && (grid.y == 2.0 || grid.y == 4.0));
        return b2f(loops);
    }
    return 1.0;
}

fn ascii_style_sample(style: f32, brightness: f32, uv: vec2<f32>) -> f32 {
    let grid = floor(uv * vec2<f32>(5.0, 7.0));
    if style < 0.5 {
        return standard_ascii_sample(brightness, grid);
    }
    if style < 1.5 {
        let checker = gl_mod(grid.x + grid.y, 2.0);
        let ruled = b2f(gl_mod(grid.x, 2.0) == 0.0 || gl_mod(grid.y, 2.0) == 0.0);
        if brightness < 0.125 { return 0.0; }
        if brightness < 0.25 { return select(0.0, 0.5, checker == 0.0); }
        if brightness < 0.375 { return ruled * 0.6; }
        if brightness < 0.5 { return b2f(checker == 0.0); }
        if brightness < 0.625 { return select(0.3, 1.0, ruled > 0.5); }
        if brightness < 0.75 { return select(0.7, 1.0, checker == 0.0); }
        if brightness < 0.875 { return select(0.85, 1.0, ruled > 0.5); }
        return 1.0;
    }
    if style < 2.5 {
        if brightness < 0.14 { return 0.0; }
        if brightness < 0.28 { return b2f(grid.x == 2.0 && grid.y == 1.0); }
        if brightness < 0.42 { return b2f(grid.x == 2.0 && grid.y == 5.0); }
        if brightness < 0.56 { return b2f(grid.y == 3.0 && grid.x >= 1.0 && grid.x <= 3.0); }
        if brightness < 0.7 {
            return b2f((grid.x == 2.0 && grid.y >= 2.0 && grid.y <= 4.0) || (grid.y == 3.0 && grid.x >= 1.0 && grid.x <= 3.0));
        }
        if brightness < 0.84 { return b2f(abs(grid.x - 2.0) == abs(grid.y - 3.0) && grid.y >= 2.0 && grid.y <= 4.0); }
        return b2f(grid.x == 1.0 || grid.x == 3.0 || grid.y == 2.0 || grid.y == 4.0);
    }
    if style < 3.5 {
        return b2f(grid.y >= 6.0 - brightness * 7.0);
    }
    if style < 4.5 {
        let dots = floor(uv * vec2<f32>(2.0, 4.0));
        if brightness < 0.125 { return 0.0; }
        if brightness < 0.25 { return b2f(dots.y == 3.0); }
        if brightness < 0.375 { return b2f(dots.y >= 2.0); }
        if brightness < 0.5 { return b2f(dots.y >= 1.0); }
        if brightness < 0.625 { return b2f(dots.y >= 1.0 || dots.x == 1.0); }
        if brightness < 0.75 { return 1.0; }
        if brightness < 0.875 { return select(0.7, 1.0, gl_mod(grid.x + grid.y, 2.0) < 1.5); }
        return 1.0;
    }
    if style < 5.5 {
        if brightness < 0.125 { return 0.0; }
        if brightness < 0.25 { return b2f(grid.x == 2.0 && grid.y == 3.0); }
        if brightness < 0.375 { return b2f(grid.y == 3.0 && grid.x >= 1.0 && grid.x <= 3.0); }
        if brightness < 0.5 { return b2f(grid.x + grid.y == 5.0 || grid.x + grid.y == 6.0); }
        if brightness < 0.625 { return b2f(grid.x == 2.0); }
        if brightness < 0.75 { return b2f(abs(grid.x - grid.y / 1.4) < 0.7 && grid.x >= 1.0 && grid.x <= 3.0); }
        if brightness < 0.875 { return b2f(grid.x == 2.0 || grid.y == 3.0); }
        return b2f(grid.x == 1.0 || grid.x == 3.0 || grid.y == 2.0 || grid.y == 4.0);
    }
    if style < 6.5 {
        let top = grid.y == 0.0 && grid.x >= 1.0 && grid.x <= 3.0;
        let top_left = grid.x == 1.0 && grid.y <= 3.0;
        let top_right = grid.x == 3.0 && grid.y <= 3.0;
        let middle = grid.y == 3.0 && grid.x >= 1.0 && grid.x <= 3.0;
        let bottom_left = grid.x == 1.0 && grid.y >= 3.0;
        let bottom_right = grid.x == 3.0 && grid.y >= 3.0;
        let bottom = grid.y == 6.0 && grid.x >= 1.0 && grid.x <= 3.0;
        if brightness < 0.1 { return 0.0; }
        if brightness < 0.2 { return b2f(top_right || bottom_right); }
        if brightness < 0.3 { return b2f(top || top_right || middle || bottom_left || bottom); }
        if brightness < 0.4 { return b2f(top || top_right || middle || bottom_right || bottom); }
        if brightness < 0.5 { return b2f(top_left || middle || top_right || bottom_right); }
        if brightness < 0.6 { return b2f(top || top_left || middle || bottom_right || bottom); }
        if brightness < 0.7 { return b2f(top || top_left || middle || bottom_left || bottom_right || bottom); }
        if brightness < 0.8 { return b2f(top || top_right || bottom_right); }
        if brightness < 0.9 { return b2f(top || top_left || top_right || middle || bottom_left || bottom_right || bottom); }
        return b2f(top || top_left || top_right || middle || bottom_right || bottom);
    }
    let slash = grid.x - grid.y;
    let backslash = grid.x + grid.y;
    if brightness < 0.16 { return 0.0; }
    if brightness < 0.33 { return b2f(gl_mod(slash, 3.0) < 0.5); }
    if brightness < 0.5 { return b2f(gl_mod(slash, 2.0) < 0.5); }
    let diagonal_a = gl_mod(slash, 2.0) < 0.5;
    let diagonal_b = gl_mod(backslash, 2.0) < 0.5;
    if brightness < 0.66 { return b2f(diagonal_a || diagonal_b); }
    if brightness < 0.83 { return select(0.2, 1.0, gl_mod(slash, 1.5) < 0.5 || gl_mod(backslash, 1.5) < 0.5); }
    return select(0.5, 1.0, gl_mod(slash, 1.0) < 0.6 || gl_mod(backslash, 1.0) < 0.6);
}

fn ascii_edge_direction(uv: vec2<f32>, step_uv: vec2<f32>) -> vec2<f32> {
    let top_left = bt601_luma(sample_media(uv + vec2<f32>(-step_uv.x, -step_uv.y)).rgb);
    let top = bt601_luma(sample_media(uv + vec2<f32>(0.0, -step_uv.y)).rgb);
    let top_right = bt601_luma(sample_media(uv + vec2<f32>(step_uv.x, -step_uv.y)).rgb);
    let left = bt601_luma(sample_media(uv + vec2<f32>(-step_uv.x, 0.0)).rgb);
    let right = bt601_luma(sample_media(uv + vec2<f32>(step_uv.x, 0.0)).rgb);
    let bottom_left = bt601_luma(sample_media(uv + vec2<f32>(-step_uv.x, step_uv.y)).rgb);
    let bottom = bt601_luma(sample_media(uv + vec2<f32>(0.0, step_uv.y)).rgb);
    let bottom_right = bt601_luma(sample_media(uv + step_uv).rgb);
    let x = -top_left - 2.0 * left - bottom_left + top_right + 2.0 * right + bottom_right;
    let y = -top_left - 2.0 * top - top_right + bottom_left + 2.0 * bottom + bottom_right;
    return vec2<f32>(x, y);
}

fn rotate_ascii_uv(uv: vec2<f32>, angle: f32) -> vec2<f32> {
    let cosine = cos(angle);
    let sine = sin(angle);
    let centered = uv - vec2<f32>(0.5);
    return vec2<f32>(centered.x * cosine - centered.y * sine, centered.x * sine + centered.y * cosine) + vec2<f32>(0.5);
}

fn apply_ascii(source: vec3<f32>, amount: f32) -> vec3<f32> {
    if amount <= 0.0 {
        return source;
    }
    let scale = max(min(g_size.x, g_size.y) / 540.0, 0.25);
    let cell_height = mix(4.0, 80.0, clamp(fx(E_ASCII_SIZE), 0.0, 1.0)) * scale;
    let cell_size = vec2<f32>(cell_height);
    let cell = floor(g_frag / cell_size);
    let cell_vuv = (cell + vec2<f32>(0.5)) * cell_size / max(g_size, vec2<f32>(1.0));
    let cell_uv = apply_crt_warp(cell_vuv);
    let cell_color = apply_color_grade(sample_media(cell_uv).rgb);
    var brightness = bt601_luma(cell_color);
    let invert = step(0.5, fx(E_ASCII_INVERT));
    brightness = mix(brightness, 1.0 - brightness, invert);
    var glyph_uv = gl_fract2(g_frag / cell_size);
    let rotation = clamp(fx(E_ASCII_ROTATION), 0.0, 1.0);
    if rotation > 0.0 {
        let cell_step_uv = cell_size / max(g_size, vec2<f32>(1.0));
        let edge = ascii_edge_direction(cell_uv, cell_step_uv);
        if length(edge) > 0.1 {
            glyph_uv = mix(glyph_uv, rotate_ascii_uv(glyph_uv, atan2(edge.y, edge.x)), rotation);
        }
    }
    let ink = ascii_style_sample(floor(fx(E_ASCII_STYLE) + 0.5), brightness, glyph_uv);
    let background = palette_color(0.0);
    let ink_color = mix(palette_color(max(palette_size() - 1.0, 1.0)), cell_color, clamp(fx(E_ASCII_COLOR), 0.0, 1.0));
    let ascii_color = mix(background, ink_color, ink);
    return mix(source, ascii_color, amount);
}

fn apply_scanlines(source: vec3<f32>, amount: f32, v: vec2<f32>) -> vec3<f32> {
    if amount <= 0.0 {
        return source;
    }
    let count = mix(50.0, 500.0, clamp(fx(E_SCAN_COUNT), 0.0, 1.0));
    let softness = clamp(fx(E_SCAN_SOFT), 0.0, 1.0);
    let wave = 0.5 + 0.5 * sin(v.y * count * PI);
    let line = mix(1.0 - wave, pow(1.0 - wave, 2.2), softness);
    return source * (1.0 - line * amount);
}

@fragment
fn fs_grade(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
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
    g_size = size;
    g_frag = uv * size;
    let frag = g_frag;

    // Outside the graded box (the corners of a rotated or skewed layer's bounds) nothing is drawn, as outside the
    // canvas a browser draws the element on; a pixel's reach past the edge fades the picture out over that pixel.
    let past = max(max(-(layer.x - params.box_rect.x), layer.x - params.box_rect.x - size.x),
        max(-(layer.y - params.box_rect.y), layer.y - params.box_rect.y - size.y));
    let fwd = params.forward;
    let scale = sqrt(abs(fwd.x * fwd.w - fwd.y * fwd.z));
    let inside = clamp(0.5 - max(past, 0.0) * scale + select(0.5, 0.0, past > 0.0), 0.0, 1.0);

    let uv_warped = apply_crt_warp(uv);
    var display_mask = 1.0;
    if fx(E_CRT) > 0.0 {
        let edge = smoothstep(vec2<f32>(0.0), vec2<f32>(0.006), uv_warped)
            * (vec2<f32>(1.0) - smoothstep(vec2<f32>(0.994), vec2<f32>(1.0), uv_warped));
        display_mask = edge.x * edge.y;
    }
    var sample_color = sample_media(uv_warped);
    sample_color = sample_chromatic_media(uv_warped, sample_color);
    sample_color.a *= inside;
    if sample_color.a <= 0.0 {
        return vec4<f32>(0.0);
    }
    var color = apply_digital_glitch(uv_warped, sample_color.rgb);
    color = mix(color, apply_color_grade(color), params.offset.z);

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

    let film = clamp(fx(E_FILM), 0.0, 1.0);
    if film > 0.0 {
        let film_frame = floor(params.grain.w);
        let dust = dust_mask(uv, floor(film_frame / 3.0));
        let dust_tone = grain_noise(vec2<f32>(floor(film_frame / 3.0), 8.0));
        color = mix(color, vec3<f32>(select(0.02, 0.95, dust_tone > 0.5)), dust * 0.72 * film);
        let scratch_bucket = floor(film_frame / 12.0);
        let scratch_x = grain_noise(vec2<f32>(scratch_bucket, 4.2));
        let scratch_life = step(0.78, grain_noise(vec2<f32>(scratch_bucket, 8.4)));
        let scratch = (1.0 - smoothstep(0.0, 1.4 / max(size.x, 1.0), abs(uv.x - scratch_x))) * scratch_life;
        color = mix(color, vec3<f32>(0.94, 0.88, 0.76), scratch * 0.28 * film);
    }

    let zero = vec3<f32>(0.0);
    let one = vec3<f32>(1.0);
    color = apply_mono_screen(clamp(color, zero, one), clamp(fx(E_MONO), 0.0, 1.0));
    color = apply_engraving(clamp(color, zero, one), clamp(fx(E_ENGRAVING), 0.0, 1.0));
    color = apply_crosshatch(uv_warped, clamp(color, zero, one), clamp(fx(E_CROSS), 0.0, 1.0));
    color = apply_halftone(clamp(color, zero, one), clamp(fx(E_HALFTONE), 0.0, 1.0));
    color = apply_two_ink_print(clamp(color, zero, one), clamp(fx(E_TWO_INK), 0.0, 1.0));
    color = apply_dither(clamp(color, zero, one), clamp(fx(E_DITHER), 0.0, 1.0));
    color = apply_ascii(clamp(color, zero, one), clamp(fx(E_ASCII), 0.0, 1.0));
    if params.ready.y > 0.5 && fx(E_BLOOM) > 0.0 {
        color += sample_bloom(uv_warped) * fx(E_BLOOM);
    }
    color = apply_scanlines(clamp(color, zero, one), clamp(fx(E_SCAN), 0.0, 1.0), uv);

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

    if fx(E_CRT) > 0.0001 {
        color *= display_mask;
    }

    let graded = clamp(color, zero, one);
    return vec4<f32>(srgb_to_linear(graded) * sample_color.a, sample_color.a);
}
