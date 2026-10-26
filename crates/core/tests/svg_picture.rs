//! SVG files drawn as pictures: an `image` layer (and an image paint) whose `src` is an SVG file is painted at the size
//! it is drawn at, and sized from the file's `width`, `height` and `viewBox`.

use std::path::{Path, PathBuf};

use kinetograph_core::{Frame, Scene, render_still};

/// A fresh directory holding `files`.
fn project(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kinetograph-svg-picture-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for (file, text) in files {
        std::fs::write(dir.join(file), text).unwrap();
    }
    dir
}

fn scene(dir: &Path, width: u32, height: u32, layers: &str) -> Result<Scene, kinetograph_core::Error> {
    let json = format!(
        r##"{{"width": {width}, "height": {height}, "fps": 30, "durationInFrames": 1,
              "background": "white", "layers": {layers}}}"##
    );
    Scene::from_json(&json, dir.to_path_buf())
}

fn render(dir: &Path, width: u32, height: u32, layers: &str) -> Frame {
    render_still(scene(dir, width, height, layers).unwrap(), 0).unwrap()
}

fn px(frame: &Frame, x: usize, y: usize) -> [u8; 4] {
    let i = (y * frame.width as usize + x) * 4;
    frame.rgba[i..i + 4].try_into().unwrap()
}

const BLUE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#3366ff"/></svg>"##;
const DOT: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="5" fill="#ff0000"/></svg>"##;

/// The repro of issue #30: a 200 x 100 blue rectangle at height 100, centred on white.
#[test]
fn the_issue_repro_draws_a_blue_rectangle_on_white() {
    let dir = project("issue", &[("shape.svg", BLUE)]);
    // Neither size given: the picture's own, 200 x 100.
    let f = render(
        &dir,
        640,
        360,
        r#"[{"id": "pic", "type": "image", "src": "shape.svg", "transform": {"x": 220, "y": 130}}]"#,
    );
    assert_eq!(px(&f, 10, 10), [255, 255, 255, 255]);
    assert_eq!(px(&f, 320, 180), [0x33, 0x66, 0xff, 255]);
    assert_eq!(px(&f, 221, 131), [0x33, 0x66, 0xff, 255]);
    assert_eq!(px(&f, 419, 229), [0x33, 0x66, 0xff, 255]);
    assert_eq!(px(&f, 218, 180), [255, 255, 255, 255]);
    assert_eq!(px(&f, 422, 180), [255, 255, 255, 255]);
}

#[test]
fn a_picture_is_painted_at_the_size_it_is_drawn_not_stretched_from_its_natural_size() {
    let dir = project("sharp", &[("dot.svg", DOT)]);
    // A 10 x 10 circle drawn 200 x 200: a circle of radius 100 with a crisp edge. Stretched from 10 pixels, the edge
    // would be a 20 pixel smear.
    let f = render(
        &dir,
        200,
        200,
        r#"[{"id": "dot", "type": "image", "src": "dot.svg", "width": 200, "height": 200}]"#,
    );
    // Distance from the centre (100, 100): 98 inside, 106 outside.
    assert_eq!(px(&f, 100 + 69, 100 + 69), [255, 0, 0, 255]);
    assert_eq!(px(&f, 100 + 75, 100 + 75), [255, 255, 255, 255]);
    assert_eq!(px(&f, 100, 100), [255, 0, 0, 255]);
}

#[test]
fn a_scaled_layer_paints_the_picture_at_the_scale() {
    let dir = project("scaled", &[("dot.svg", DOT)]);
    let f = render(
        &dir,
        200,
        200,
        r#"[{"id": "dot", "type": "image", "src": "dot.svg", "width": 10, "height": 10, "transform": {"scale": 20}}]"#,
    );
    assert_eq!(px(&f, 100 + 69, 100 + 69), [255, 0, 0, 255]);
    assert_eq!(px(&f, 100 + 75, 100 + 75), [255, 255, 255, 255]);
}

#[test]
fn a_file_with_no_size_is_300_by_150() {
    let dir = project(
        "default",
        &[("bare.svg", r##"<svg xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="1000" fill="#00ff00"/></svg>"##)],
    );
    let scene = scene(&dir, 400, 200, r#"[{"id": "p", "type": "image", "src": "bare.svg"}]"#).unwrap();
    let f = render_still(scene, 0).unwrap();
    // Unscaled and cut at its 300 x 150 box.
    assert_eq!(px(&f, 299, 149), [0, 255, 0, 255]);
    assert_eq!(px(&f, 301, 100), [255, 255, 255, 255]);
    assert_eq!(px(&f, 100, 151), [255, 255, 255, 255]);
}

#[test]
fn fit_contain_keeps_the_aspect_ratio() {
    let dir = project("contain", &[("shape.svg", BLUE)]);
    let f = render(
        &dir,
        200,
        200,
        r#"[{"id": "p", "type": "image", "src": "shape.svg", "width": 200, "height": 200, "fit": "contain"}]"#,
    );
    // 200 x 100 in a 200 x 200 box: a band across the middle.
    assert_eq!(px(&f, 100, 100), [0x33, 0x66, 0xff, 255]);
    assert_eq!(px(&f, 100, 40), [255, 255, 255, 255]);
    assert_eq!(px(&f, 100, 160), [255, 255, 255, 255]);
}

#[test]
fn an_svg_data_url_draws() {
    let url = format!("data:image/svg+xml;utf8,{}", BLUE.replace('#', "%23").replace('"', "%22"));
    let layers = format!(r#"[{{"id": "p", "type": "image", "src": "{url}", "width": 100, "height": 50}}]"#);
    let f = render(Path::new("/nowhere"), 100, 50, &layers);
    assert_eq!(px(&f, 50, 25), [0x33, 0x66, 0xff, 255]);
}

#[test]
fn a_broken_svg_is_an_error_naming_the_file() {
    let dir = project("broken", &[("bad.svg", "this is not an svg")]);
    let err = scene(&dir, 100, 100, r#"[{"id": "p", "type": "image", "src": "bad.svg"}]"#).unwrap_err();
    let message = err.to_string();
    assert!(message.contains("bad.svg") && message.contains("cannot read the SVG"), "{message}");
}
