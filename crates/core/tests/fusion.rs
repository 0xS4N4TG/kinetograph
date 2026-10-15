//! The compositor's passes that do the work of several
//! (`Renderer::set_pass_fusion`) draw exactly what the passes they replace
//! draw, byte for byte: same scene, same frames, fusion on and off.

use std::path::Path;

use kinetograph_core::{Renderer, Scene};

fn load(path: &str) -> Scene {
    Scene::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap()
}

/// Renders `frames` in order with fusion `on`, the layer cache as `render`
/// has it, and returns each frame's bytes.
fn render(path: &str, frames: &[u32], on: bool) -> Vec<Vec<u8>> {
    let mut renderer = Renderer::new(load(path)).unwrap();
    renderer.set_pass_fusion(on);
    renderer.set_layer_cache(true);
    frames
        .iter()
        .map(|&f| renderer.render_frame(f).unwrap().rgba)
        .collect()
}

fn same_with_and_without_fusion(path: &str, frames: &[u32]) {
    let duration = load(path).duration_in_frames;
    let frames: Vec<u32> = frames.iter().copied().filter(|&f| f < duration).collect();
    let frames = &frames[..];
    let fused = render(path, frames, true);
    let plain = render(path, frames, false);
    for ((frame, a), b) in frames.iter().zip(&fused).zip(&plain) {
        assert!(a == b, "{path} frame {frame}: fusion changed the pixels");
    }
}

#[test]
fn fused_passes_draw_the_same_pixels() {
    same_with_and_without_fusion("tests/scenes/passes.json", &[0, 1, 2, 7, 15, 22, 29]);
}

#[test]
fn fused_passes_leave_the_other_scenes_alone() {
    // Inset shadows with a blur and a spread, drop shadows, blurs, masks and
    // clips: scenes the fusions must not touch.
    for scene in ["shadows", "mattes", "masks", "camera", "blend-blur"] {
        same_with_and_without_fusion(&format!("tests/scenes/{scene}.json"), &[0, 15]);
    }
}

/// The names of the passes that drawing `frame` of `path` takes, or `None`
/// if this GPU cannot time passes.
fn pass_names(path: &str, frame: u32, fusion: bool) -> Option<Vec<&'static str>> {
    let mut renderer = Renderer::new(load(path)).unwrap();
    renderer.set_pass_fusion(fusion);
    if !renderer.set_pass_timing(true) {
        return None;
    }
    renderer.render_frame(frame).unwrap();
    Some(renderer.take_pass_times().iter().map(|p| p.name).collect())
}

#[test]
fn an_inset_shadow_with_no_blur_or_spread_is_one_pass() {
    let path = "tests/scenes/passes.json";
    let (Some(fused), Some(plain)) = (pass_names(path, 15, true), pass_names(path, 15, false))
    else {
        eprintln!("this GPU cannot time passes; skipped");
        return;
    };
    let count = |names: &[&str], name| names.iter().filter(|n| **n == name).count();
    // Seven layers, each with an inset shadow.
    assert_eq!(count(&plain, "inset shadow"), 7);
    assert_eq!(count(&fused, "inset shadow"), 7);
    assert_eq!(count(&plain, "shadow spread"), 7);
    assert_eq!(count(&fused, "shadow spread"), 0);
}
