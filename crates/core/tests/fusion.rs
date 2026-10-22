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
    // And each is cut out of its Vello page by that pass, not another.
    assert_eq!(count(&plain, "to linear"), 7);
    assert_eq!(count(&fused, "to linear"), 0);
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
fn a_leaf_that_stays_the_same_is_cached_from_its_third_frame() {
    // blend-runs.json has plain layers that never change. With fusion a plain
    // leaf goes to the blend from its page without a texture, so the cache
    // learns that it was the same in the second frame and keeps a texture
    // from the third: it has one fewer hit in the second frame than without
    // fusion (its leaves are not cached yet), and as many from the third on.
    let hits = |fusion: bool| {
        let mut renderer = Renderer::new(load("tests/scenes/blend-runs.json")).unwrap();
        renderer.set_pass_fusion(fusion);
        renderer.set_layer_cache(true);
        let mut hits = Vec::new();
        for frame in 0..6 {
            renderer.render_frame(frame).unwrap();
            hits.push(renderer.layer_cache_counts().0);
        }
        hits
    };
    let (on, off) = (hits(true), hits(false));
    let new = |h: &[u64], frame: usize| h[frame] - h[frame - 1];
    assert!(new(&on, 1) < new(&off, 1), "{on:?} {off:?}");
    for frame in 3..6 {
        assert_eq!(new(&on, frame), new(&off, frame), "{on:?} {off:?}");
    }
}

#[test]
fn a_run_of_blends_is_a_few_passes() {
    let path = "tests/scenes/blend-runs.json";
    let (Some(fused), Some(plain)) = (pass_names(path, 15, true), pass_names(path, 15, false))
    else {
        eprintln!("this GPU cannot time passes; skipped");
        return;
    };
    let blends = |names: &[&str]| names.iter().filter(|n| **n == "blend").count();
    assert!(
        blends(&fused) * 2 < blends(&plain),
        "{} blend passes fused, {} not",
        blends(&fused),
        blends(&plain)
    );
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

/// Cards the way the DOM painter makes them: a group of a colour and a
/// grain multiplied over it, and a clipped group of text-like shapes.
fn cards_json(srgb: bool) -> String {
    let mut layers = Vec::new();
    for i in 0..6 {
        let x = 20 + (i % 3) * 100;
        let y = 20 + (i / 3) * 110;
        layers.push(format!(
            r##"{{"id": "card{i}", "type": "group", "transform": {{"x": {x}, "y": {y}}}, "children": [
                {{"id": "bg{i}", "type": "group", "children": [
                    {{"id": "colour{i}", "type": "shape", "shape": {{"kind": "roundedRect", "width": 90, "height": 100, "radius": 8}}, "fill": "#c8a46e"}},
                    {{"id": "grain{i}", "type": "shape", "shape": {{"kind": "roundedRect", "width": 90, "height": 100, "radius": 8}}, "fill": "#8899aa66", "blendMode": "multiply"}}
                ]}},
                {{"id": "content{i}", "type": "group", "clip": {{"kind": "polygon", "points": [[5, 5], [85, 12], [80, 95], [8, 90]]}}, "children": [
                    {{"id": "a{i}", "type": "shape", "shape": {{"kind": "rect", "width": 60, "height": 20}}, "fill": "#224466", "transform": {{"x": 10, "y": 15}}}},
                    {{"id": "b{i}", "type": "shape", "shape": {{"kind": "ellipse", "width": 70, "height": 40}}, "fill": "#aa3322cc", "transform": {{"x": 30, "y": 40, "rotation": 20}}}}
                ]}},
                {{"id": "veil{i}", "type": "group", "opacity": 0.5, "children": [
                    {{"id": "v1{i}", "type": "shape", "shape": {{"kind": "rect", "width": 50, "height": 50}}, "fill": "#ffffff", "transform": {{"x": 5, "y": 5}}}},
                    {{"id": "v2{i}", "type": "shape", "shape": {{"kind": "rect", "width": 50, "height": 50}}, "fill": "#000000", "transform": {{"x": 25, "y": 25}}}}
                ]}}
            ]}}"##
        ));
    }
    format!(
        r##"{{{space}"width": 320, "height": 240, "fps": 30, "durationInFrames": 8, "background": "#303a52",
            "layers": [{}]}}"##,
        layers.join(","),
        space = if srgb { r#""blendSpace": "srgb","# } else { "" }
    )
}

#[test]
fn groups_of_leaves_draw_the_same_pixels_in_fewer_passes() {
    for srgb in [false, true] {
        let json = cards_json(srgb);
        let run = |on: bool| {
            let mut renderer =
                Renderer::new(Scene::from_json(&json, std::path::PathBuf::new()).unwrap()).unwrap();
            renderer.set_pass_fusion(on);
            renderer.set_layer_cache(true);
            let timed = renderer.set_pass_timing(true);
            let mut frames = Vec::new();
            let mut passes = 0;
            for f in 0..6 {
                frames.push(renderer.render_frame(f).unwrap().rgba);
                let taken = renderer.take_pass_times().len();
                if f == 0 {
                    passes = taken;
                }
            }
            (frames, timed.then_some(passes))
        };
        let ((fused, fused_passes), (plain, plain_passes)) = (run(true), run(false));
        for (frame, (a, b)) in fused.iter().zip(&plain).enumerate() {
            assert!(a == b, "srgb {srgb} frame {frame}: fusing groups changed the pixels");
        }
        if let (Some(f), Some(p)) = (fused_passes, plain_passes) {
            assert!(f * 2 < p, "{f} passes fused, {p} not");
        }
    }
}
