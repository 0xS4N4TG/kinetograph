//! `Atlas`, `Patch`, `Glyphs`, `TextBlob`, `Picture` and `ImageSVG`: what each leaves in the pixels.

use std::path::PathBuf;

use kinetograph_skia::{Assets, Output, render};
use serde_json::{Value, json};
use skia_safe::{AlphaType, ColorType, Data, ImageInfo, images, png_encoder};

fn base() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn draw(nodes: Value) -> Output {
    render(
        32,
        32,
        nodes.as_array().unwrap(),
        &mut Assets::default(),
        base(),
    )
    .unwrap()
}

fn px(out: &Output, x: usize, y: usize) -> [u8; 4] {
    let i = (y * out.width as usize + x) * 4;
    out.rgba[i..i + 4].try_into().unwrap()
}

fn assert_px(out: &Output, x: usize, y: usize, expected: [u8; 4]) {
    let got = px(out, x, y);
    assert!(
        got.iter()
            .zip(&expected)
            .all(|(a, b)| (i32::from(*a) - i32::from(*b)).abs() <= 3),
        "({x}, {y}) is {got:?}, expected {expected:?}"
    );
}

fn node(kind: &str, props: Value) -> Value {
    json!({ "type": kind, "props": props, "children": [] })
}

fn font(size: u32) -> Value {
    json!({ "file": "assets/fonts/DMSans-Medium.ttf", "size": size })
}

fn opaque_pixels(out: &Output) -> usize {
    out.rgba.chunks(4).filter(|p| p[3] > 200).count()
}

/// A 2 x 2 solid blue PNG in the target directory.
fn blue_png() -> String {
    let rgba = [0u8, 0, 255, 255].repeat(4);
    let info = ImageInfo::new((2, 2), ColorType::RGBA8888, AlphaType::Unpremul, None);
    let image = images::raster_from_data(&info, Data::new_copy(&rgba), 8).unwrap();
    let png = png_encoder::encode_image(None, &image, &png_encoder::Options::default()).unwrap();
    let path = std::env::temp_dir().join("kinetograph-skia-blue.png");
    std::fs::write(&path, png.as_bytes()).unwrap();
    path.to_string_lossy().into_owned()
}

#[test]
fn an_atlas_draws_each_sprite_with_its_transform() {
    let out = draw(json!([node(
        "Atlas",
        json!({
            "image": { "src": blue_png() },
            "sprites": [{ "x": 0, "y": 0, "width": 2, "height": 2 }, { "x": 0, "y": 0, "width": 2, "height": 2 }],
            "transforms": [
                { "scos": 4, "ssin": 0, "tx": 2, "ty": 2 },
                { "scos": 2, "ssin": 0, "tx": 20, "ty": 20 }
            ],
        })
    )]));
    assert_px(&out, 5, 5, [0, 0, 255, 255]);
    assert_px(&out, 22, 22, [0, 0, 255, 255]);
    assert_px(&out, 14, 14, [0, 0, 0, 0]);
    assert!(out.unsupported.is_empty());
}

#[test]
fn an_atlas_tints_sprites_with_colors() {
    // The sprite is the source and its colour the destination: `dst` shows the colour alone, `src` the sprite alone.
    let out = draw(json!([node(
        "Atlas",
        json!({
            "image": { "src": blue_png() },
            "sprites": [{ "x": 0, "y": 0, "width": 2, "height": 2 }],
            "transforms": [{ "scos": 8, "ssin": 0, "tx": 0, "ty": 0 }],
            "colors": [[1, 0, 0, 1]],
            "colorBlendMode": "dst",
        })
    )]));
    assert_px(&out, 8, 8, [255, 0, 0, 255]);
}

#[test]
fn a_patch_blends_its_corner_colors() {
    let (w, h) = (32.0, 32.0);
    let corner = |x: f32, y: f32, c1: (f32, f32), c2: (f32, f32)| json!({ "pos": { "x": x, "y": y }, "c1": { "x": c1.0, "y": c1.1 }, "c2": { "x": c2.0, "y": c2.1 } });
    let out = draw(json!([node(
        "Patch",
        json!({
            "patch": [
                corner(0.0, 0.0, (0.0, h / 3.0), (w / 3.0, 0.0)),
                corner(w, 0.0, (2.0 * w / 3.0, 0.0), (w, h / 3.0)),
                corner(w, h, (w, 2.0 * h / 3.0), (2.0 * w / 3.0, h)),
                corner(0.0, h, (w / 3.0, h), (0.0, 2.0 * h / 3.0)),
            ],
            "colors": [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1], [1, 1, 0, 1]],
        })
    )]));
    let at = |x, y| px(&out, x, y);
    assert!(
        at(2, 2)[0] > 200 && at(2, 2)[1] < 60,
        "top left is red: {:?}",
        at(2, 2)
    );
    assert!(
        at(29, 2)[1] > 200 && at(29, 2)[0] < 60,
        "top right is green: {:?}",
        at(29, 2)
    );
    assert!(
        at(29, 29)[2] > 200 && at(29, 29)[0] < 60,
        "bottom right is blue: {:?}",
        at(29, 29)
    );
    assert!(
        at(2, 29)[0] > 200 && at(2, 29)[1] > 200,
        "bottom left is yellow: {:?}",
        at(2, 29)
    );
}

#[test]
fn a_text_blob_draws_its_text_at_x_and_y() {
    let out = draw(json!([node(
        "TextBlob",
        json!({ "blob": { "text": "H", "font": font(24) }, "x": 2, "y": 24, "color": [1, 0, 0, 1] })
    )]));
    assert!(
        opaque_pixels(&out) > 30,
        "{} pixels of H",
        opaque_pixels(&out)
    );
    let plain = draw(json!([node(
        "Text",
        json!({ "x": 2, "y": 24, "text": "H", "font": font(24), "color": [1, 0, 0, 1] })
    )]));
    assert_eq!(out.rgba, plain.rgba, "a blob of a text is the text");
}

#[test]
fn a_text_blob_with_transforms_places_each_glyph() {
    let out = draw(json!([node(
        "TextBlob",
        json!({
            "blob": { "text": "H", "font": font(12),
                      "xforms": [{ "scos": 2, "ssin": 0, "tx": 4, "ty": 28 }] },
            "color": [0, 0, 1, 1]
        })
    )]));
    // Scaled by two: more ink than the 12 point H alone.
    let small = draw(json!([node(
        "TextBlob",
        json!({ "blob": { "text": "H", "font": font(12) }, "x": 4, "y": 28, "color": [0, 0, 1, 1] })
    )]));
    assert!(opaque_pixels(&out) > opaque_pixels(&small) * 2);
}

#[test]
fn glyphs_draw_each_id_at_its_position() {
    let font = font(24);
    // A glyph id from the font: measure through a one-glyph blob to find the id of "H" by drawing both ways.
    let blob = |ids: Value| {
        draw(json!([node(
            "TextBlob",
            json!({ "blob": { "glyphs": ids, "font": font }, "x": 2, "y": 24, "color": [1, 0, 0, 1] })
        )]))
    };
    // DMSans glyph 43 is some letter: whatever it is, Glyphs and a blob of the same id must agree.
    let by_blob = blob(json!([43]));
    let by_glyphs = draw(json!([node(
        "Glyphs",
        json!({ "glyphs": [{ "id": 43, "pos": { "x": 0, "y": 0 } }], "x": 2, "y": 24, "font": font, "color": [1, 0, 0, 1] })
    )]));
    assert!(opaque_pixels(&by_glyphs) > 10);
    assert_eq!(by_blob.rgba, by_glyphs.rgba);
}

#[test]
fn a_picture_replays_what_was_recorded() {
    let rect = |x: i32, color: [i32; 4]| {
        json!({ "op": "drawRect", "rect": { "x": x, "y": 0, "width": 10, "height": 10 },
                "paint": { "type": "Paint", "props": { "color": color }, "children": [] } })
    };
    let out = draw(json!([node(
        "Picture",
        json!({ "picture": { "ops": [
            { "op": "save" },
            { "op": "translate", "x": 0, "y": 8 },
            rect(0, [1, 0, 0, 1]),
            { "op": "restore" },
            rect(16, [0, 1, 0, 1]),
        ] } })
    )]));
    assert_px(&out, 5, 13, [255, 0, 0, 255]);
    assert_px(&out, 5, 5, [0, 0, 0, 0]);
    assert_px(&out, 20, 5, [0, 255, 0, 255]);
}

#[test]
fn a_picture_is_drawn_once_whatever_paints_are_declared() {
    let tree = json!([{
        "type": "Group", "props": {}, "children": [
            { "type": "Paint", "props": { "color": [0, 0, 1, 1] }, "children": [] },
            node("Picture", json!({ "picture": { "ops": [
                { "op": "drawCircle", "x": 16, "y": 16, "r": 8,
                  "paint": { "type": "Paint", "props": { "color": [1, 0, 0, 1], "opacity": 0.5 }, "children": [] } }
            ] } })),
        ]
    }]);
    let out = draw(tree);
    assert_px(&out, 16, 16, [255, 0, 0, 128]);
}

#[test]
fn an_svg_is_drawn_into_its_rectangle() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/></svg>"##;
    let out = draw(json!([node(
        "ImageSVG",
        json!({ "svg": { "svg": svg }, "x": 4, "y": 4, "width": 20, "height": 20 })
    )]));
    assert_px(&out, 6, 6, [255, 0, 0, 255]);
    assert_px(&out, 22, 22, [255, 0, 0, 255]);
    assert_px(&out, 2, 2, [0, 0, 0, 0]);
    assert_px(&out, 26, 26, [0, 0, 0, 0]);
}

#[test]
fn an_svg_with_text_is_drawn_without_it_and_says_so() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text x="0" y="8">A</text></svg>"##;
    let out = draw(json!([node("ImageSVG", json!({ "svg": { "svg": svg } }))]));
    assert_eq!(out.unsupported.len(), 1);
    assert_eq!(out.unsupported[0].element, "ImageSVG");
}
