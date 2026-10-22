//! The pass timer (`Renderer::set_pass_timing`) records the compositing
//! passes and never changes what is drawn.

mod common;

use std::path::Path;

use kinetograph_core::{Renderer, Scene};

fn load(path: &str) -> Scene {
    Scene::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap()
}

#[test]
fn timing_passes_draws_the_same_pixels_and_names_them() {
    common::pin_vello();
    // Blur, shadows and blends, so most kinds of pass run.
    let scene = load("tests/scenes/shadows.json");
    let mut renderer = Renderer::new(scene).unwrap();
    let plain = renderer.render_frame(15).unwrap();

    if !renderer.set_pass_timing(true) {
        eprintln!("this GPU cannot time passes; skipped");
        return;
    }
    let timed = renderer.render_frame(15).unwrap();
    assert!(timed.rgba == plain.rgba, "timing changed the pixels");

    let times = renderer.take_pass_times();
    assert!(!times.is_empty());
    assert!(times.iter().any(|t| t.name == "blend" || t.name == "blend many"));
    assert!(times.iter().all(|t| t.ms >= 0.0 && t.ms.is_finite()));
    // Taken: the next call has nothing until another frame is drawn.
    assert!(renderer.take_pass_times().is_empty());

    // The same frame records the same passes.
    renderer.render_frame(15).unwrap();
    let again = renderer.take_pass_times();
    let names =
        |t: &[kinetograph_core::pass_timer::PassTime]| t.iter().map(|p| p.name).collect::<Vec<_>>();
    assert_eq!(names(&again), names(&times));

    // Off again: nothing is recorded.
    renderer.set_pass_timing(false);
    renderer.render_frame(15).unwrap();
    assert!(renderer.take_pass_times().is_empty());
}
