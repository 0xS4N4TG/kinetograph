//! The `lut` effect's two interpolations, against a CPU reference and, when an
//! `ffmpeg` is on the PATH, against ffmpeg's `lut3d` (`interp=trilinear` and
//! `interp=tetrahedral`). The table is small and strongly non-linear (a
//! rotation-ish matrix, then a curve), so the two interpolations differ.

use std::path::{Path, PathBuf};
use std::process::Command;

use kinetograph_core::{Frame, Scene, render_still};

const SIZE: usize = 5;
const W: u32 = 64;

/// The table's value at a grid point: a mixing matrix with negative terms,
/// clamped, then a gamma.
fn table_at(r: f32, g: f32, b: f32) -> [f32; 3] {
    let m = [[0.6, 0.5, -0.1], [-0.2, 0.5, 0.7], [0.7, -0.3, 0.6]];
    let v = [r, g, b];
    m.map(|row| {
        let w: f32 = row.iter().zip(v).map(|(a, b)| a * b).sum();
        w.clamp(0.0, 1.0).powf(0.6)
    })
}

fn table() -> Vec<[f32; 3]> {
    let step = 1.0 / (SIZE - 1) as f32;
    let mut rgb = Vec::new();
    for b in 0..SIZE {
        for g in 0..SIZE {
            for r in 0..SIZE {
                rgb.push(table_at(r as f32 * step, g as f32 * step, b as f32 * step));
            }
        }
    }
    rgb
}

fn cube_text() -> String {
    let mut text = format!("LUT_3D_SIZE {SIZE}\n");
    for [r, g, b] in table() {
        text += &format!("{r:.7} {g:.7} {b:.7}\n");
    }
    text
}

/// The CPU reference. `tetra` picks the interpolation.
fn lookup(table: &[[f32; 3]], rgb: [f32; 3], tetra: bool) -> [f32; 3] {
    let n = SIZE as f32 - 1.0;
    let at = rgb.map(|c| c.clamp(0.0, 1.0) * n);
    let base = at.map(|a| (a.floor() as usize).min(SIZE - 2));
    let f = [0, 1, 2].map(|i| at[i] - base[i] as f32);
    let grid = |dx: usize, dy: usize, dz: usize| {
        table[(base[0] + dx) + SIZE * ((base[1] + dy) + SIZE * (base[2] + dz))]
    };
    let mut out = [0.0; 3];
    for c in 0..3 {
        out[c] = if tetra {
            let (p1, p2, w) = if f[0] > f[1] {
                if f[1] > f[2] {
                    (grid(1, 0, 0), grid(1, 1, 0), [f[0], f[1], f[2]])
                } else if f[0] > f[2] {
                    (grid(1, 0, 0), grid(1, 0, 1), [f[0], f[2], f[1]])
                } else {
                    (grid(0, 0, 1), grid(1, 0, 1), [f[2], f[0], f[1]])
                }
            } else if f[2] > f[1] {
                (grid(0, 0, 1), grid(0, 1, 1), [f[2], f[1], f[0]])
            } else if f[2] > f[0] {
                (grid(0, 1, 0), grid(0, 1, 1), [f[1], f[2], f[0]])
            } else {
                (grid(0, 1, 0), grid(1, 1, 0), [f[1], f[0], f[2]])
            };
            grid(0, 0, 0)[c] * (1.0 - w[0])
                + p1[c] * (w[0] - w[1])
                + p2[c] * (w[1] - w[2])
                + grid(1, 1, 1)[c] * w[2]
        } else {
            let mix = |a: f32, b: f32, t: f32| a + (b - a) * t;
            let x = |y, z| mix(grid(0, y, z)[c], grid(1, y, z)[c], f[0]);
            mix(
                mix(x(0, 0), x(1, 0), f[1]),
                mix(x(0, 1), x(1, 1), f[1]),
                f[2],
            )
        };
    }
    out.map(|v| v.clamp(0.0, 1.0))
}

/// 64 x 64 opaque pixels of pseudo-random colour.
fn input() -> Vec<[u8; 3]> {
    let mut state = 0x2545_f491_u32;
    let mut next = || {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (state >> 24) as u8
    };
    (0..W * W).map(|_| [next(), next(), next()]).collect()
}

fn work_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kinetograph-lut-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_png(path: &Path, pixels: &[[u8; 3]]) {
    let flat: Vec<u8> = pixels.iter().flatten().copied().collect();
    image::save_buffer(path, &flat, W, W, image::ExtendedColorType::Rgb8).unwrap();
}

fn render(dir: &Path, interpolation: &str) -> Frame {
    let json = format!(
        r##"{{"width": {W}, "height": {W}, "fps": 30, "durationInFrames": 1, "background": "#000000",
            "layers": [{{"id": "p", "type": "image", "src": "in.png", "width": {W}, "height": {W},
              "effects": [{{"type": "lut", "src": "look.cube", "interpolation": "{interpolation}"}}]}}]}}"##
    );
    render_still(Scene::from_json(&json, dir.to_path_buf()).unwrap(), 0).unwrap()
}

/// Max and mean absolute difference, in 8-bit levels, over the colour channels.
fn diff(a: &[[u8; 3]], b: &[[u8; 3]]) -> (i32, f64) {
    let mut max = 0;
    let mut sum = 0;
    for (p, q) in a.iter().zip(b) {
        for c in 0..3 {
            let d = (i32::from(p[c]) - i32::from(q[c])).abs();
            max = max.max(d);
            sum += d;
        }
    }
    (max, f64::from(sum) / (a.len() * 3) as f64)
}

fn rgb_of(frame: &Frame) -> Vec<[u8; 3]> {
    frame
        .rgba
        .as_chunks::<4>()
        .0
        .iter()
        .map(|p| [p[0], p[1], p[2]])
        .collect()
}

fn reference(pixels: &[[u8; 3]], tetra: bool) -> Vec<[u8; 3]> {
    let table = table();
    pixels
        .iter()
        .map(|p| {
            let out = lookup(&table, p.map(|c| f32::from(c) / 255.0), tetra);
            out.map(|v| (v * 255.0 + 0.5) as u8)
        })
        .collect()
}

fn ffmpeg(dir: &Path, interp: &str) -> Option<Vec<[u8; 3]>> {
    let out = dir.join(format!("ffmpeg-{interp}.png"));
    let status = Command::new("ffmpeg")
        .current_dir(dir)
        .args(["-v", "error", "-y", "-i", "in.png", "-vf"])
        .arg(format!("lut3d=file=look.cube:interp={interp}"))
        .arg(&out)
        .status()
        .ok()?;
    status.success().then(|| {
        let img = image::open(&out).unwrap().to_rgb8();
        img.pixels().map(|p| p.0).collect()
    })
}

#[test]
fn both_interpolations_match_a_cpu_reference_and_ffmpeg() {
    let dir = work_dir();
    let pixels = input();
    write_png(&dir.join("in.png"), &pixels);
    std::fs::write(dir.join("look.cube"), cube_text()).unwrap();

    let trilinear = rgb_of(&render(&dir, "trilinear"));
    let tetrahedral = rgb_of(&render(&dir, "tetrahedral"));

    let (max_tri, mean_tri) = diff(&trilinear, &reference(&pixels, false));
    let (max_tet, mean_tet) = diff(&tetrahedral, &reference(&pixels, true));
    let (max_modes, mean_modes) = diff(&trilinear, &tetrahedral);
    eprintln!(
        "vs CPU: trilinear max {max_tri} mean {mean_tri:.4}; tetrahedral max {max_tet} mean {mean_tet:.4}"
    );
    eprintln!("trilinear vs tetrahedral: max {max_modes} mean {mean_modes:.4}");
    assert!(
        max_tri <= 2 && max_tet <= 2,
        "GPU differs from the CPU reference"
    );
    assert!(
        mean_modes > 0.5,
        "the two modes should differ on this table ({mean_modes})"
    );

    match (ffmpeg(&dir, "trilinear"), ffmpeg(&dir, "tetrahedral")) {
        (Some(ff_tri), Some(ff_tet)) => {
            let (max_a, mean_a) = diff(&trilinear, &ff_tri);
            let (max_b, mean_b) = diff(&tetrahedral, &ff_tet);
            let (max_c, mean_c) = diff(&trilinear, &ff_tet);
            eprintln!(
                "vs ffmpeg: trilinear max {max_a} mean {mean_a:.4}; tetrahedral max {max_b} mean {mean_b:.4}"
            );
            eprintln!(
                "trilinear vs ffmpeg tetrahedral (should be worse): max {max_c} mean {mean_c:.4}"
            );
            assert!(max_a <= 2 && max_b <= 2, "differs from ffmpeg lut3d");
            assert!(
                mean_c > mean_b,
                "tetrahedral should match ffmpeg's tetrahedral better"
            );
        }
        _ => eprintln!("no ffmpeg on the PATH: skipped the ffmpeg oracle"),
    }
    std::fs::remove_dir_all(&dir).ok();
}
