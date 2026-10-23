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
    for scene in ["shadows", "mattes", "masks", "camera", "blend-blur", "filter-graph"] {
        same_with_and_without_fusion(&format!("tests/scenes/{scene}.json"), &[0, 15]);
    }
}

#[test]
fn runs_of_blends_draw_the_same_pixels() {
    // Thirty overlapping shapes at opacities and in every kind of blend mode,
    // spread-out small ones, a hue and a luminosity blend among the others, a
    // backdrop blur between runs, groups without a buffer, nested, and layers
    // that stay the same from frame to frame (the layer cache). Frames in
    // order, so the cache has something to supply.
    same_with_and_without_fusion(
        "tests/scenes/blend-runs.json",
        &[0, 1, 2, 3, 4, 5, 6, 15, 16, 29],
    );
}

/// A scene of `count` random shapes (rectangles, rounded rectangles,
/// ellipses and triangles, at random colours, alphas and angles), some with a
/// stroke, some with a sharp inset shadow, in groups and out of them, at
/// opacities and in blend modes. All from `seed`.
fn random_scene(seed: u64, count: usize, srgb: bool) -> Scene {
    let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    let mut next = move |n: u64| {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 33) % n
    };
    let mut layers = Vec::new();
    for i in 0..count {
        let shape = match next(4) {
            0 => r#"{"kind": "rect", "width": W, "height": H}"#.to_string(),
            1 => r#"{"kind": "roundedRect", "width": W, "height": H, "radius": 7}"#.to_string(),
            2 => r#"{"kind": "ellipse", "width": W, "height": H}"#.to_string(),
            _ => r#"{"kind": "path", "d": "M0 0 L W 6 L 9 H Z"}"#.to_string(),
        }
        .replace('W', &(10 + next(70)).to_string())
        .replace('H', &(10 + next(60)).to_string());
        let colour = format!(
            "#{:02x}{:02x}{:02x}{:02x}",
            next(256),
            next(256),
            next(256),
            [255, 255, 255, 200, 90, 30, 3][next(7) as usize]
        );
        let stroke = if next(3) == 0 {
            format!(
                r##", "stroke": {{"color": "#{:06x}", "width": {}}}"##,
                next(1 << 24),
                1 + next(4)
            )
        } else {
            String::new()
        };
        let inset = if next(2) == 0 {
            format!(
                r##", "effects": [{{"type": "insetShadow", "x": {}, "y": {}, "blur": 0, "color": "#{:02x}{:02x}{:02x}{:02x}"}}]"##,
                next(9) as f64 / 2.0 - 2.0,
                next(9) as f64 / 2.0 - 2.0,
                next(256),
                next(256),
                next(256),
                next(256)
            )
        } else {
            String::new()
        };
        let mode = [
            "normal", "normal", "normal", "multiply", "screen", "overlay",
        ][next(6) as usize];
        let opacity = [1.0, 1.0, 0.7, 0.35][next(4) as usize];
        // A quarter of them clipped, to a triangle or a quadrilateral.
        let clip = if next(4) == 0 {
            let mut at = |n| next(n) as f64 + 0.25 * next(4) as f64;
            format!(
                r#", "clip": {{"kind": "polygon", "points": [[{}, {}], [{}, {}], [{}, {}], [{}, {}]]}}"#,
                at(10),
                at(10),
                at(80),
                at(15),
                at(70),
                at(60),
                at(15),
                at(70)
            )
        } else {
            String::new()
        };
        layers.push(format!(
            r#"{{"id": "s{i}", "type": "shape", "shape": {shape}, "fill": "{colour}"{stroke}{inset}{clip},
               "blendMode": "{mode}", "opacity": {opacity},
               "transform": {{"x": [{{"frame": 0, "value": {x}}}, {{"frame": 9, "value": {x2}}}], "y": {y}, "rotation": {r}}}}}"#,
            x = next(260),
            x2 = next(260),
            y = next(200),
            r = next(360)
        ));
    }
    // Layers go into groups of three to five, so there are groups without a
    // buffer, groups with one, clipped groups, groups that blend, and groups
    // too big for one pass.
    let mut grouped = Vec::new();
    let mut rest = &layers[..];
    let mut g = 0;
    while !rest.is_empty() {
        let size = [3, 5, 2, 9, 4][g % 5].min(rest.len());
        let (chunk, tail) = rest.split_at(size);
        rest = tail;
        let effects = if g % 4 == 3 {
            r##", "effects": [{"type": "dropShadow", "x": 2, "y": 2, "blur": 3, "color": "#00000080"}]"##
        } else {
            ""
        };
        let opacity = if g % 5 == 4 { 0.8 } else { 1.0 };
        let clip = if g % 3 == 1 {
            r#", "clip": {"kind": "polygon", "points": [[0, 0], [320, 10], [300, 230], [20, 240]]}"#
        } else {
            ""
        };
        let mode = ["normal", "normal", "multiply", "normal", "screen", "normal", "normal"][g % 7];
        grouped.push(format!(
            r#"{{"id": "g{g}", "type": "group", "opacity": {opacity}, "blendMode": "{mode}", "children": [{}]{effects}{clip}}}"#,
            chunk.join(",")
        ));
        g += 1;
    }
    let json = format!(
        r##"{{{space}"width": 320, "height": 240, "fps": 30, "durationInFrames": 10, "background": "#303a52",
            "layers": [{}]}}"##,
        grouped.join(","),
        space = if srgb { r#""blendSpace": "srgb","# } else { "" }
    );
    Scene::from_json(&json, std::path::PathBuf::new()).unwrap()
}

#[test]
fn random_scenes_draw_the_same_pixels() {
    for seed in 1..=12 {
        // Half of them composite in sRGB, as every DOM island does.
        let srgb = seed % 2 == 0;
        let frames = [0, 1, 2, 3];
        let run = |on: bool| {
            let mut renderer = Renderer::new(random_scene(seed, 150, srgb)).unwrap();
            renderer.set_pass_fusion(on);
            renderer.set_layer_cache(true);
            frames
                .iter()
                .map(|&f| renderer.render_frame(f).unwrap().rgba)
                .collect::<Vec<_>>()
        };
        let (fused, plain) = (run(true), run(false));
        for (frame, (a, b)) in fused.iter().zip(&plain).enumerate() {
            assert!(
                a == b,
                "seed {seed} frame {frame}: fusion changed the pixels"
            );
        }
    }
}

#[test]
fn runs_of_blends_draw_the_same_pixels_in_srgb() {
    // blend-runs.json with `blendSpace: "srgb"`, as every DOM island is: the
    // fused blends must composite on the encoded colours too.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes");
    let json = std::fs::read_to_string(dir.join("blend-runs.json")).unwrap();
    let json = json.replacen('{', r#"{"blendSpace": "srgb","#, 1);
    let frames = [0, 1, 2, 3, 15, 29];
    let run = |on: bool| {
        let mut renderer = Renderer::new(Scene::from_json(&json, dir.clone()).unwrap()).unwrap();
        renderer.set_pass_fusion(on);
        renderer.set_layer_cache(true);
        frames
            .iter()
            .map(|&f| renderer.render_frame(f).unwrap().rgba)
            .collect::<Vec<_>>()
    };
    let (fused, plain) = (run(true), run(false));
    for (frame, (a, b)) in frames.iter().zip(fused.iter().zip(&plain)) {
        assert!(a == b, "frame {frame}: fusion changed the pixels in sRGB");
    }
}
