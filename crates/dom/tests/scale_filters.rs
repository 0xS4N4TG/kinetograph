//! `render --scale` wraps the scene in a group at the scale on a canvas of the scaled size and sets `renderScale`
//! (`scaleScene` in packages/cli/src/scenes.ts). A scaled render must equal the full render shrunk: the lengths in CSS
//! `filter` functions and in SVG filter primitives scale with everything else (issue #166), on layers Skia draws and on
//! layers the wgpu compositor draws for it.

use std::collections::BTreeMap;
use std::path::PathBuf;

use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use kinetograph_core::{Frame, Scene, render_still};
use kinetograph_dom::request::{DomNode, IslandRequest, Size};
use serde_json::{Value, json};

const WIDTH: u32 = 400;
const HEIGHT: u32 = 160;

/// Four black boxes on white: a CSS `blur()`, a CSS `drop-shadow()`, an SVG `feGaussianBlur` and an SVG `feOffset`.
const PAGE: &str = r##"<html><body style="margin:0;background:#fff">
<div style="position:absolute;left:20px;top:40px;width:60px;height:60px;background:#000;filter:blur(8px)"></div>
<div style="position:absolute;left:120px;top:40px;width:60px;height:60px;background:#000;filter:drop-shadow(24px 24px 0 #00f)"></div>
<svg style="position:absolute;left:0;top:0" width="400" height="160" viewBox="0 0 400 160">
<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter>
<filter id="o" x="-50%" y="-50%" width="200%" height="200%"><feOffset dx="24" dy="16"/></filter>
<rect x="220" y="40" width="60" height="60" fill="#000" filter="url(#b)"/>
<rect x="320" y="40" width="60" height="60" fill="#f00" filter="url(#o)"/>
</svg></body></html>"##;

fn layers() -> Vec<Value> {
    let mut doc: BaseDocument = HtmlDocument::from_html(
        PAGE,
        DocumentConfig {
            viewport: Some(Viewport::new(WIDTH, HEIGHT, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner();
    doc.resolve(0.0);
    let request = IslandRequest {
        root: DomNode::Text {
            text: String::new(),
        },
        stylesheets: Vec::new(),
        viewport: Size {
            width: f64::from(WIDTH),
            height: f64::from(HEIGHT),
        },
        fonts: BTreeMap::new(),
        base_dir: String::new(),
        public_dir: None,
        time: 0.0,
        path: "$0".into(),
        history: Vec::new(),
    };
    let out = kinetograph_dom::paint::paint(&doc, &request);
    assert!(out.unsupported.is_empty(), "{:?}", out.unsupported);
    out.layers
}

/// `layers` at `scale`, as `scaleScene` builds it.
fn render(layers: Vec<Value>, scale: f64) -> Frame {
    let size = |n: u32| (f64::from(n) * scale) as u32;
    let layers = if scale == 1.0 {
        layers
    } else {
        vec![json!({
            "id": "kinetograph-draft", "type": "group",
            "transform": { "scale": scale }, "children": layers,
        })]
    };
    let scene = json!({
        "width": size(WIDTH), "height": size(HEIGHT), "fps": 30, "durationInFrames": 1,
        "background": "#ffffff", "renderScale": scale, "layers": layers,
    });
    render_still(
        Scene::from_json(&scene.to_string(), PathBuf::new()).unwrap(),
        0,
    )
    .unwrap()
}

/// The largest absolute difference of a channel between `full` shrunk by 2 (box filter) and `half`, and the mean.
fn difference(full: &Frame, half: &Frame) -> (u8, f64) {
    assert_eq!((half.width * 2, half.height * 2), (full.width, full.height));
    let at = |f: &Frame, x: u32, y: u32, c: usize| {
        f64::from(f.rgba[((y * f.width + x) * 4) as usize + c])
    };
    let (mut worst, mut sum) = (0.0f64, 0.0f64);
    for y in 0..half.height {
        for x in 0..half.width {
            for c in 0..3 {
                let shrunk = [(0, 0), (1, 0), (0, 1), (1, 1)]
                    .iter()
                    .map(|(dx, dy)| at(full, x * 2 + dx, y * 2 + dy, c))
                    .sum::<f64>()
                    / 4.0;
                let d = (shrunk - at(half, x, y, c)).abs();
                worst = worst.max(d);
                sum += d;
            }
        }
    }
    (worst as u8, sum / f64::from(half.width * half.height * 3))
}

#[test]
fn a_scaled_render_is_the_full_render_shrunk() {
    let (worst, mean) = difference(&render(layers(), 1.0), &render(layers(), 0.5));
    eprintln!("worst {worst}, mean {mean:.3}");
    assert!(worst <= 40 && mean < 0.5, "worst {worst}, mean {mean:.3}");
}

/// Black boxes the wgpu compositor draws: in a preserve3d group, one blurred and one with a drop shadow (drawn in closed
/// form), and outside it one with a chromatic aberration, which only the compositor has.
fn compositor_layers() -> Vec<Value> {
    let rect = |id: &str, x: f64, effect: Value| {
        json!({
            "id": id, "type": "shape", "fill": "#000000", "transform": { "x": x, "y": 40 },
            "shape": { "kind": "rect", "width": 60, "height": 60 }, "effects": [effect],
        })
    };
    vec![
        json!({ "id": "g", "type": "group", "preserve3d": true, "children": [
            rect("blur", 20.0, json!({ "type": "blur", "radius": 8 })),
            rect("shadow", 120.0, json!({ "type": "dropShadow", "x": 24, "y": 16, "blur": 6, "color": "#0000ff" })),
        ]}),
        rect(
            "aberration",
            260.0,
            json!({ "type": "chromaticAberration", "amount": 16 }),
        ),
    ]
}

#[test]
fn a_scaled_render_is_the_full_render_shrunk_on_the_compositor() {
    let (worst, mean) = difference(
        &render(compositor_layers(), 1.0),
        &render(compositor_layers(), 0.5),
    );
    eprintln!("worst {worst}, mean {mean:.3}");
    assert!(worst <= 40 && mean < 0.5, "worst {worst}, mean {mean:.3}");
}

/// Grey boxes with a pattern of cells: grain that Skia draws at x 20..120, grain in a preserve3d group, which the wgpu
/// compositor draws, at x 150..250, and an ordered dither, which only the compositor has, at x 280..380.
fn pattern_layers() -> Vec<Value> {
    let rect = |id: &str, x: f64, effect: Value| {
        json!({
            "id": id, "type": "shape", "fill": "#808080", "transform": { "x": x, "y": 30 },
            "shape": { "kind": "rect", "width": 100, "height": 100 }, "effects": [effect],
        })
    };
    let grain = json!({ "type": "grain", "amount": 0.5, "size": 16, "seed": 3 });
    vec![
        rect("grain", 20.0, grain.clone()),
        json!({ "id": "g", "type": "group", "preserve3d": true, "children": [rect("grain3d", 150.0, grain)] }),
        rect(
            "dither",
            280.0,
            json!({ "type": "dither", "mode": "ordered", "levels": 2, "size": 8 }),
        ),
    ]
}

/// The mean absolute step of the green channel to the right and down neighbours over `x0..x1` x `y0..y1`: cells twice
/// as large step half as often.
fn roughness(at: impl Fn(u32, u32) -> f64, (x0, x1): (u32, u32), (y0, y1): (u32, u32)) -> f64 {
    let mut sum = 0.0;
    for y in y0..y1 {
        for x in x0..x1 {
            sum += (at(x + 1, y) - at(x, y)).abs() + (at(x, y + 1) - at(x, y)).abs();
        }
    }
    sum / f64::from((x1 - x0) * (y1 - y0))
}

#[test]
fn grain_and_dither_cells_shrink_with_the_canvas() {
    let (full, half) = (render(pattern_layers(), 1.0), render(pattern_layers(), 0.5));
    let green = |f: &Frame, x: u32, y: u32| f64::from(f.rgba[((y * f.width + x) * 4) as usize + 1]);
    let shrunk = |x: u32, y: u32| {
        [(0, 0), (1, 0), (0, 1), (1, 1)]
            .iter()
            .map(|(dx, dy)| green(&full, x * 2 + dx, y * 2 + dy))
            .sum::<f64>()
            / 4.0
    };
    // Inside each box, in half-size pixels.
    for (what, xs) in [
        ("grain", (14, 56)),
        ("grain3d", (79, 121)),
        ("dither", (144, 186)),
    ] {
        let want = roughness(shrunk, xs, (19, 61));
        let got = roughness(|x, y| green(&half, x, y), xs, (19, 61));
        eprintln!("{what}: roughness {got:.2}, full render shrunk {want:.2}");
        assert!(want > 1.0, "{what}: no pattern");
        assert!(
            (0.75..1.34).contains(&(got / want)),
            "{what}: roughness {got:.2}, full render shrunk {want:.2}"
        );
    }
}
