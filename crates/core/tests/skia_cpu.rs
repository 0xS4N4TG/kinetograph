//! Skia's CPU backend against its GPU one: the same scenes drawn with `KINETOGRAPH_SKIA_CPU=1` (Skia's raster surfaces,
//! uploaded to the textures the GPU path draws into) and without. The two run different rasterisers, so they are
//! compared within a tolerance, not byte for byte: the mean difference over all channels, and the share of channels that
//! differ by a lot (an anti-aliased edge or a gradient step may differ a little; a layer that is missing or misplaced
//! differs everywhere).
//!
//! Where no GPU backend of Skia can start (a runner with no usable GPU) both runs are CPU runs and the test only checks
//! that they agree.

use std::path::Path;

use kinetograph_core::{Scene, render_still};

fn scene(relative: &str) -> Scene {
    Scene::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)).unwrap()
}

/// (mean level difference, share of channels more than 48 levels apart)
fn difference(a: &[u8], b: &[u8]) -> (f64, f64) {
    assert_eq!(a.len(), b.len());
    let (mut sum, mut far) = (0u64, 0u64);
    for (x, y) in a.iter().zip(b) {
        let d = x.abs_diff(*y);
        sum += u64::from(d);
        far += u64::from(d > 48);
    }
    (sum as f64 / a.len() as f64, far as f64 / a.len() as f64)
}

#[test]
fn cpu_backend_matches_gpu_backend() {
    // Layer kinds and passes that reach every place the CPU path differs: the frame itself, the layers the wgpu path asks
    // Skia for (leaves, clips, masks, canvas passes) and the layers Skia asks the wgpu path for (effects, 3D).
    let scenes: &[(&str, u32)] = &[
        ("../../examples/papercut-card.json", 30),
        ("tests/scenes/blend-blur.json", 0),
        ("tests/scenes/clip-paths.json", 15),
        ("tests/scenes/masks.json", 15),
        ("tests/scenes/mattes.json", 15),
        ("tests/scenes/canvas.json", 0),
        ("tests/scenes/canvas-effects.json", 0),
        ("tests/scenes/shadows.json", 15),
        ("tests/scenes/colour-filters.json", 15),
        ("tests/scenes/glow.json", 15),
        ("tests/scenes/image-fit.json", 15),
        ("tests/scenes/glyph-text.json", 15),
        ("tests/scenes/gradient-fills.json", 15),
        ("tests/scenes/backdrop-blur.json", 15),
        ("tests/scenes/motion-blur.json", 15),
        ("tests/scenes/scene3d-primitives.json", 15),
        ("tests/scenes/camera.json", 15),
        ("tests/scenes/video.json", 20),
        ("tests/scenes/transition-ripple.json", 0),
        ("tests/scenes/effect-chain.json", 0),
    ];
    let mut failures = Vec::new();
    for (path, frame) in scenes {
        // SAFETY: this is the only test in the binary, so nothing else reads the environment while it changes.
        unsafe { std::env::remove_var("KINETOGRAPH_SKIA_CPU") };
        let gpu = render_still(scene(path), *frame).unwrap();
        unsafe { std::env::set_var("KINETOGRAPH_SKIA_CPU", "1") };
        let cpu = render_still(scene(path), *frame).unwrap();
        unsafe { std::env::remove_var("KINETOGRAPH_SKIA_CPU") };
        assert_eq!((gpu.width, gpu.height), (cpu.width, cpu.height), "{path}");
        let (mean, far) = difference(&gpu.rgba, &cpu.rgba);
        println!("SKIA_CPU {path} f{frame}: mean {mean:.3} levels, {:.4}% of channels over 48", far * 100.0);
        if let Some(dir) = std::env::var_os("SKIA_CPU_OUT") {
            let name = Path::new(path).file_stem().unwrap().to_string_lossy().into_owned();
            for (tag, f) in [("gpu", &gpu), ("cpu", &cpu)] {
                let _ = image::save_buffer(Path::new(&dir).join(format!("{name}-{tag}.png")), &f.rgba, f.width, f.height, image::ColorType::Rgba8);
            }
        }
        if mean > 2.0 || far > 0.01 {
            failures.push(format!("{path} f{frame}: mean {mean:.3}, {:.3}% far", far * 100.0));
        }
    }
    assert!(failures.is_empty(), "the CPU backend differs from the GPU one:\n{}", failures.join("\n"));
}
