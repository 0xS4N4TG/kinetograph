//! Renders every blend mode on a grid of colour pairs and compares the GPU
//! result with a CPU transcription of the W3C Compositing and Blending
//! Level 1 formulas.

use std::path::PathBuf;

use kinetograph_core::{Scene, render_still};

type Rgb = [f32; 3];

const MODES: [&str; 16] = [
    "normal",
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "colorDodge",
    "colorBurn",
    "hardLight",
    "softLight",
    "difference",
    "exclusion",
    "hue",
    "saturation",
    "color",
    "luminosity",
];

/// (backdrop rgba, source rgba) as 8-bit sRGB. The corner cases matter:
/// zero and full channels hit the dodge/burn branches, and the saturated
/// pair pushes the non-separable modes into ClipColor.
const PAIRS: [([u8; 4], [u8; 4]); 6] = [
    ([0x80, 0x40, 0xc0, 255], [0x30, 0xd0, 0x70, 0xc0]),
    ([0x10, 0x20, 0x30, 255], [0xf0, 0xe0, 0x90, 0xff]),
    ([0xff, 0x00, 0x80, 255], [0x00, 0xff, 0x40, 0xa0]),
    ([0xf8, 0xf0, 0xe0, 255], [0x20, 0x60, 0xa0, 0xff]),
    ([0xc0, 0x30, 0x30, 0x80], [0x40, 0xc0, 0xff, 0xd0]),
    ([0x00, 0x00, 0x00, 255], [0xff, 0xff, 0xff, 0xff]),
];

const OPACITY: f32 = 0.8;
const CELL: u32 = 8;

fn to_linear(v: u8) -> f32 {
    let v = f32::from(v) / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn to_srgb8(v: f32) -> u8 {
    let v = v.clamp(0.0, 1.0);
    let s = if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    };
    (s * 255.0).round() as u8
}

fn lum(c: Rgb) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

fn clip_color(c: Rgb) -> Rgb {
    let l = lum(c);
    let n = c[0].min(c[1]).min(c[2]);
    let x = c[0].max(c[1]).max(c[2]);
    let mut c = c;
    if n < 0.0 {
        c = c.map(|v| l + (v - l) * l / (l - n));
    }
    if x > 1.0 {
        c = c.map(|v| l + (v - l) * (1.0 - l) / (x - l));
    }
    c
}

fn set_lum(c: Rgb, l: f32) -> Rgb {
    let d = l - lum(c);
    clip_color(c.map(|v| v + d))
}

fn sat(c: Rgb) -> f32 {
    c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2])
}

/// SetSat as the spec writes it: sort the channels, then rescale.
fn set_sat(c: Rgb, s: f32) -> Rgb {
    let mut idx = [0usize, 1, 2];
    idx.sort_by(|&a, &b| c[a].total_cmp(&c[b]));
    let (min, mid, max) = (idx[0], idx[1], idx[2]);
    let mut out = [0.0; 3];
    if c[max] > c[min] {
        out[mid] = (c[mid] - c[min]) * s / (c[max] - c[min]);
        out[max] = s;
    }
    out
}

fn separable(mode: &str, cb: f32, cs: f32) -> f32 {
    let screen = |b: f32, s: f32| b + s - b * s;
    let hard_light = |b: f32, s: f32| {
        if s <= 0.5 {
            b * 2.0 * s
        } else {
            screen(b, 2.0 * s - 1.0)
        }
    };
    match mode {
        "multiply" => cb * cs,
        "screen" => screen(cb, cs),
        "overlay" => hard_light(cs, cb),
        "darken" => cb.min(cs),
        "lighten" => cb.max(cs),
        "colorDodge" => {
            if cb == 0.0 {
                0.0
            } else if cs >= 1.0 {
                1.0
            } else {
                (cb / (1.0 - cs)).min(1.0)
            }
        }
        "colorBurn" => {
            if cb >= 1.0 {
                1.0
            } else if cs <= 0.0 {
                0.0
            } else {
                1.0 - ((1.0 - cb) / cs).min(1.0)
            }
        }
        "hardLight" => hard_light(cb, cs),
        "softLight" => {
            if cs <= 0.5 {
                cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
            } else {
                let d = if cb <= 0.25 {
                    ((16.0 * cb - 12.0) * cb + 4.0) * cb
                } else {
                    cb.sqrt()
                };
                cb + (2.0 * cs - 1.0) * (d - cb)
            }
        }
        "difference" => (cb - cs).abs(),
        "exclusion" => cb + cs - 2.0 * cb * cs,
        _ => cs,
    }
}

/// B(Cb, Cs) on unpremultiplied linear colours.
fn blend_fn(mode: &str, cb: Rgb, cs: Rgb) -> Rgb {
    match mode {
        "hue" => set_lum(set_sat(cs, sat(cb)), lum(cb)),
        "saturation" => set_lum(set_sat(cb, sat(cs)), lum(cb)),
        "color" => set_lum(cs, lum(cb)),
        "luminosity" => set_lum(cb, lum(cs)),
        _ => [0, 1, 2].map(|i| separable(mode, cb[i], cs[i])),
    }
}

/// Composites a straight-alpha source onto a premultiplied backdrop.
fn composite(backdrop: [f32; 4], src: [u8; 4], opacity: f32, mode: &str) -> [f32; 4] {
    let ab = backdrop[3];
    let a_s = f32::from(src[3]) / 255.0 * opacity;
    let cs = [src[0], src[1], src[2]].map(to_linear);
    let cb = if ab > 0.0 {
        [backdrop[0] / ab, backdrop[1] / ab, backdrop[2] / ab]
    } else {
        [0.0; 3]
    };
    let mixed = blend_fn(mode, cb, cs);
    let mut out = [0.0; 4];
    for i in 0..3 {
        out[i] = a_s * cs[i] * (1.0 - ab) + backdrop[i] * (1.0 - a_s) + a_s * ab * mixed[i];
    }
    out[3] = a_s + ab * (1.0 - a_s);
    out
}

fn hex(c: [u8; 4]) -> String {
    format!("#{:02x}{:02x}{:02x}{:02x}", c[0], c[1], c[2], c[3])
}

#[test]
fn all_blend_modes_match_the_spec_formulas() {
    let mut layers = Vec::new();
    for (col, mode) in MODES.iter().enumerate() {
        for (row, (backdrop, source)) in PAIRS.iter().enumerate() {
            let (x, y) = (col as u32 * CELL, row as u32 * CELL);
            let rect = format!(
                r#""transform": {{"x": {x}, "y": {y}}},
                   "shape": {{"kind": "rect", "width": {CELL}, "height": {CELL}}}"#
            );
            layers.push(format!(
                r#"{{"id": "b{col}-{row}", "type": "shape", "fill": "{}", {rect}}}"#,
                hex(*backdrop)
            ));
            layers.push(format!(
                r#"{{"id": "s{col}-{row}", "type": "shape", "fill": "{}", "opacity": {OPACITY},
                    "blendMode": "{mode}", {rect}}}"#,
                hex(*source)
            ));
        }
    }
    let json = format!(
        r#"{{"width": {}, "height": {}, "fps": 30, "durationInFrames": 1,
            "background": "transparent", "layers": [{}]}}"#,
        MODES.len() as u32 * CELL,
        PAIRS.len() as u32 * CELL,
        layers.join(",")
    );
    let frame = render_still(Scene::from_json(&json, PathBuf::new()).unwrap(), 0).unwrap();

    for (col, mode) in MODES.iter().enumerate() {
        for (row, (backdrop, source)) in PAIRS.iter().enumerate() {
            let ab = f32::from(backdrop[3]) / 255.0;
            let lin = [backdrop[0], backdrop[1], backdrop[2]].map(|v| to_linear(v) * ab);
            let start = [lin[0], lin[1], lin[2], ab];
            let want = composite(start, *source, OPACITY, mode);

            let (px, py) = (col as u32 * CELL + CELL / 2, row as u32 * CELL + CELL / 2);
            let i = ((py * frame.width + px) * 4) as usize;
            let got = &frame.rgba[i..i + 4];

            let alpha = (want[3] * 255.0).round() as u8;
            assert!(
                got[3].abs_diff(alpha) <= 1,
                "{mode} pair {row}: alpha {} want {alpha}",
                got[3]
            );
            let straight = [want[0] / want[3], want[1] / want[3], want[2] / want[3]];
            for c in 0..3 {
                let expected = to_srgb8(straight[c]);
                assert!(
                    got[c].abs_diff(expected) <= 2,
                    "{mode} pair {row} channel {c}: got {} want {expected} (pixel {got:?})",
                    got[c]
                );
            }
        }
    }
}
