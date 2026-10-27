//! The objects a project makes with `Skia.*` rather than with JSX: pictures from data, pixels, surfaces and drawn
//! elements, frames of animated pictures, fonts from data, the text of an SVG, paragraph measurements, path
//! interpolation and the image filters of `Skia.ImageFilter.MakeShader` / `MakeColorFilter`.

use std::path::PathBuf;

use kinetograph_skia::{Assets, Output, image_call, measure_paragraph, path_call, render};
use serde_json::{Value, json};
use skia_safe::{AlphaType, ColorType, Data, ImageInfo, images, png_encoder};

fn base() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

const FONT: &str = "assets/fonts/DMSans-Medium.ttf";

fn draw_with(assets: &mut Assets, nodes: Value) -> Output {
    render(32, 32, nodes.as_array().unwrap(), assets, base()).unwrap()
}

fn draw(nodes: Value) -> Output {
    draw_with(&mut Assets::default(), nodes)
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

fn with_children(kind: &str, props: Value, children: Vec<Value>) -> Value {
    json!({ "type": kind, "props": props, "children": children })
}

fn image_node(image: Value) -> Value {
    node(
        "Image",
        json!({ "image": image, "x": 0, "y": 0, "width": 32, "height": 32, "fit": "fill" }),
    )
}

fn inked(out: &Output) -> usize {
    out.rgba.chunks(4).filter(|p| p[3] > 100).count()
}

fn png_of(rgba: &[u8], w: i32, h: i32) -> Vec<u8> {
    let info = ImageInfo::new((w, h), ColorType::RGBA8888, AlphaType::Unpremul, None);
    let image = images::raster_from_data(&info, Data::new_copy(rgba), w as usize * 4).unwrap();
    png_encoder::encode_image(None, &image, &png_encoder::Options::default())
        .unwrap()
        .as_bytes()
        .to_vec()
}

/// A 2 x 2 GIF with one frame per colour, each solid and shown `delay_cs` hundredths of a second. Its LZW data is a
/// clear code before every pixel, which a decoder must accept and which needs no compressor.
fn gif(colors: &[[u8; 3]], delay_cs: u16) -> Vec<u8> {
    assert!(colors.len() <= 4);
    let mut out = b"GIF89a".to_vec();
    out.extend([2, 0, 2, 0, 0x81, 0, 0]);
    for i in 0..4 {
        out.extend(colors.get(i).copied().unwrap_or([0, 0, 0]));
    }
    // Loop forever.
    out.extend([0x21, 0xff, 11]);
    out.extend(b"NETSCAPE2.0");
    out.extend([3, 1, 0, 0, 0]);
    for (index, _) in colors.iter().enumerate() {
        out.extend([
            0x21,
            0xf9,
            4,
            0x04,
            (delay_cs & 255) as u8,
            (delay_cs >> 8) as u8,
            0,
            0,
        ]);
        out.extend([0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0]);
        // Minimum code size 2: codes are 3 bits, clear is 4, end is 5.
        let mut codes = Vec::new();
        for _ in 0..4 {
            codes.push(4u32);
            codes.push(index as u32);
        }
        codes.push(5);
        let mut bytes = Vec::new();
        let (mut acc, mut bits) = (0u32, 0);
        for code in codes {
            acc |= code << bits;
            bits += 3;
            while bits >= 8 {
                bytes.push((acc & 255) as u8);
                acc >>= 8;
                bits -= 8;
            }
        }
        if bits > 0 {
            bytes.push(acc as u8);
        }
        out.push(2);
        out.push(bytes.len() as u8);
        out.extend(&bytes);
        out.push(0);
    }
    out.push(0x3b);
    out
}

#[test]
fn a_picture_from_encoded_data_is_drawn() {
    let mut assets = Assets::default();
    let id = assets.put_data(&png_of(&[0, 0, 255, 255].repeat(4), 2, 2));
    assert_eq!(
        id,
        assets.put_data(&png_of(&[0, 0, 255, 255].repeat(4), 2, 2))
    );
    let out = draw_with(&mut assets, json!([image_node(json!({ "data": id }))]));
    assert_px(&out, 16, 16, [0, 0, 255, 255]);
    let size = image_call(&mut assets, base(), &json!({ "image": { "data": id } })).unwrap();
    assert_eq!(size, json!({ "width": 2, "height": 2 }));
}

#[test]
fn raw_pixels_are_drawn_with_their_layout() {
    let mut assets = Assets::default();
    let id = assets.put_data(&[255, 0, 0, 255].repeat(4));
    let red = json!({ "pixels": id, "width": 2, "height": 2, "colorType": "rgba8888", "alphaType": "unpremul" });
    assert_px(
        &draw_with(&mut assets, json!([image_node(red)])),
        8,
        8,
        [255, 0, 0, 255],
    );
    let bgra = json!({ "pixels": id, "width": 2, "height": 2, "colorType": "bgra8888", "alphaType": "unpremul" });
    assert_px(
        &draw_with(&mut assets, json!([image_node(bgra)])),
        8,
        8,
        [0, 0, 255, 255],
    );
    let short = json!({ "pixels": id, "width": 4, "height": 4 });
    assert!(render(32, 32, &[image_node(short)], &mut assets, base()).is_err());
}

#[test]
fn a_surface_snapshot_and_a_drawn_element_are_pictures() {
    let red = json!({ "type": "Paint", "props": { "color": [1, 0, 0, 1] }, "children": [] });
    let snapshot = json!({
        "picture": { "ops": [{ "op": "drawRect", "rect": { "x": 0, "y": 0, "width": 8, "height": 16 }, "paint": red }] },
        "width": 16,
        "height": 16,
    });
    let out = draw(json!([image_node(snapshot)]));
    assert_px(&out, 4, 16, [255, 0, 0, 255]);
    assert_px(&out, 28, 16, [0, 0, 0, 0]);

    let element = json!({
        "nodes": [node("Circle", json!({ "cx": 8, "cy": 8, "r": 8, "color": [0, 1, 0, 1] }))],
        "width": 16,
        "height": 16,
    });
    let out = draw(json!([image_node(element)]));
    assert_px(&out, 16, 16, [0, 255, 0, 255]);
    assert_px(&out, 1, 1, [0, 0, 0, 0]);

    // drawAsPicture: the element recorded into a picture.
    let picture = json!({ "ops": [{ "op": "drawNodes", "nodes": [node("Rect", json!({ "x": 0, "y": 0, "width": 4, "height": 4, "color": [0, 0, 1, 1] }))] }] });
    let out = draw(json!([node("Picture", json!({ "picture": picture }))]));
    assert_px(&out, 2, 2, [0, 0, 255, 255]);
}

#[test]
fn an_animated_picture_shows_the_frame_for_its_time_and_loops() {
    let mut assets = Assets::default();
    let id = assets.put_data(&gif(&[[255, 0, 0], [0, 255, 0], [0, 0, 255]], 10));
    let frames = image_call(
        &mut assets,
        base(),
        &json!({ "image": { "data": id }, "call": "frames" }),
    )
    .unwrap();
    assert_eq!(frames, json!({ "count": 3, "durations": [100, 100, 100] }));
    let at = |assets: &mut Assets, ms: u32| {
        px(
            &draw_with(
                assets,
                json!([image_node(json!({ "data": id, "time": ms }))]),
            ),
            16,
            16,
        )
    };
    assert_eq!(at(&mut assets, 0), [255, 0, 0, 255]);
    assert_eq!(at(&mut assets, 99), [255, 0, 0, 255]);
    assert_eq!(at(&mut assets, 100), [0, 255, 0, 255]);
    assert_eq!(at(&mut assets, 250), [0, 0, 255, 255]);
    assert_eq!(at(&mut assets, 300), [255, 0, 0, 255]);
    let second = draw_with(
        &mut assets,
        json!([image_node(json!({ "data": id, "frame": 1 }))]),
    );
    assert_eq!(px(&second, 16, 16), [0, 255, 0, 255]);
}

#[test]
fn a_font_from_data_draws_as_the_file_does() {
    let mut assets = Assets::default();
    let id = assets.put_data(&std::fs::read(base().join(FONT)).unwrap());
    let text = |font: Value| {
        node(
            "Text",
            json!({ "text": "Hi", "x": 2, "y": 24, "font": font, "color": [1, 1, 1, 1] }),
        )
    };
    let from_data = draw_with(
        &mut assets,
        json!([text(json!({ "data": id, "size": 20 }))]),
    );
    let from_file = draw_with(
        &mut assets,
        json!([text(json!({ "file": FONT, "size": 20 }))]),
    );
    assert!(inked(&from_data) > 20);
    assert_eq!(from_data.rgba, from_file.rgba);
}

fn svg_text(family: &str) -> Value {
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><text x="1" y="24" font-size="20" font-family="{family}" fill="#ffffff">HH</text></svg>"##
    );
    json!({ "svg": svg, "fonts": [{ "family": "DM Sans", "file": FONT }] })
}

#[test]
fn an_svg_draws_its_text_in_the_registered_font() {
    let out = draw(json!([node(
        "ImageSVG",
        json!({ "svg": svg_text("DM Sans") })
    )]));
    assert!(inked(&out) > 40, "the text is drawn");
    assert!(out.unsupported.is_empty(), "{:?}", out.unsupported);
    let generic = draw(json!([node(
        "ImageSVG",
        json!({ "svg": svg_text("sans-serif") })
    )]));
    assert!(inked(&generic) > 40);
    assert!(
        generic.unsupported.is_empty(),
        "a generic family is not a warning"
    );
    // The first family of the list that is registered is used, as CSS does.
    let listed = draw(json!([node(
        "ImageSVG",
        json!({ "svg": svg_text("Inter, DM Sans, serif") })
    )]));
    assert_eq!(listed.rgba, out.rgba);
    assert!(listed.unsupported.is_empty());
}

#[test]
fn an_svg_text_in_an_unregistered_font_is_drawn_in_the_fallback_and_reported() {
    let out = draw(json!([node(
        "ImageSVG",
        json!({ "svg": svg_text("Nope Sans") })
    )]));
    assert!(inked(&out) > 40);
    assert_eq!(out.unsupported.len(), 1);
    assert!(out.unsupported[0].reason.contains("Nope Sans"));
}

#[test]
fn an_svg_text_with_no_font_at_all_is_left_out_and_reported() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text x="0" y="8">A</text></svg>"##;
    let out = draw(json!([node("ImageSVG", json!({ "svg": { "svg": svg } }))]));
    assert_eq!(inked(&out), 0);
    assert_eq!(out.unsupported.len(), 1);
}

fn paragraph(text: &str) -> Value {
    json!({
        "fonts": [{ "family": "DM Sans", "file": FONT }],
        "style": { "textStyle": { "fontSize": 20, "color": [1, 1, 1, 1] } },
        "ops": [{ "type": "addText", "text": text }],
    })
}

#[test]
fn a_paragraph_is_measured_at_the_width_it_is_laid_out_at() {
    let mut assets = Assets::default();
    let measure = |assets: &mut Assets, width: f32| {
        measure_paragraph(
            assets,
            &base(),
            &json!({ "paragraph": paragraph("one two three four five six"), "width": width, "ranges": [[0, 3]], "points": [{ "x": 1, "y": 5 }] }),
        )
        .unwrap()
    };
    let wide = measure(&mut assets, 1000.0);
    let narrow = measure(&mut assets, 80.0);
    assert_eq!(wide["lines"].as_array().unwrap().len(), 1);
    assert!(narrow["lines"].as_array().unwrap().len() > 2);
    assert!(narrow["height"].as_f64().unwrap() > wide["height"].as_f64().unwrap() * 2.0);
    assert!(narrow["longestLine"].as_f64().unwrap() <= 80.0);
    assert!(wide["maxIntrinsicWidth"].as_f64().unwrap() > 150.0);
    let first = &wide["ranges"][0][0];
    assert!(first["width"].as_f64().unwrap() > 10.0);
    assert_eq!(wide["points"][0]["position"], json!(0));
    assert_eq!(wide["lines"][0]["lineNumber"], json!(0));
}

#[test]
fn a_recorded_paragraph_paints_like_the_node() {
    let as_node = draw(json!([node(
        "Paragraph",
        json!({ "paragraph": paragraph("Hi"), "x": 2, "y": 2, "width": 30 })
    )]));
    let recorded = draw(json!([node(
        "Picture",
        json!({ "picture": { "ops": [{ "op": "drawParagraph", "paragraph": paragraph("Hi"), "x": 2, "y": 2, "width": 30 }] } })
    )]));
    assert!(inked(&as_node) > 20);
    assert_eq!(as_node.rgba, recorded.rgba);
}

#[test]
fn paths_interpolate_as_skia_does() {
    let a = json!({ "d": "M0 0L10 0", "fillType": "winding" });
    let b = json!({ "d": "M0 20L30 20", "fillType": "winding" });
    let can = path_call(&json!({ "call": "interpolatable", "path": a, "other": b })).unwrap();
    assert_eq!(can["interpolatable"], json!(true));
    // Weight 1 is the path itself, 0 the other.
    let mid =
        path_call(&json!({ "call": "interpolate", "path": a, "other": b, "weight": 0.5 })).unwrap();
    assert_eq!(
        mid["bounds"],
        json!({ "x": 0.0, "y": 10.0, "width": 20.0, "height": 0.0 })
    );
    let other = json!({ "d": "M0 0L1 1L2 2", "fillType": "winding" });
    let cannot =
        path_call(&json!({ "call": "interpolatable", "path": a, "other": other })).unwrap();
    assert_eq!(cannot["interpolatable"], json!(false));
}

#[test]
fn image_filters_of_a_shader_and_of_a_colour_filter() {
    let swap = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0];
    let filtered = with_children(
        "Rect",
        json!({ "x": 0, "y": 0, "width": 32, "height": 32, "color": [1, 0, 0, 1] }),
        vec![with_children(
            "ColorFilterImageFilter",
            json!({}),
            vec![node("MatrixColorFilter", json!({ "matrix": swap }))],
        )],
    );
    assert_px(&draw(json!([filtered])), 16, 16, [0, 0, 255, 255]);
    let shaded = with_children(
        "Rect",
        json!({ "x": 0, "y": 0, "width": 32, "height": 32, "color": [1, 0, 0, 1] }),
        vec![with_children(
            "ShaderImageFilter",
            json!({}),
            vec![node("ColorShader", json!({ "color": [0, 1, 0, 1] }))],
        )],
    );
    assert_px(&draw(json!([shaded])), 16, 16, [0, 255, 0, 255]);
}

#[test]
fn a_paint_object_carries_its_shader_and_filters() {
    let paint = with_children(
        "Paint",
        json!({ "color": [1, 0, 0, 1] }),
        vec![node(
            "LinearGradient",
            json!({ "start": { "x": 0, "y": 0 }, "end": { "x": 32, "y": 0 }, "colors": [[1, 0, 0, 1], [0, 0, 1, 1]] }),
        )],
    );
    let out = draw(json!([node(
        "Rect",
        json!({ "x": 0, "y": 0, "width": 32, "height": 32, "paint": paint })
    )]));
    assert!(px(&out, 1, 16)[0] > 230);
    assert!(px(&out, 30, 16)[2] > 230);
}

#[test]
fn kept_data_is_bounded_by_bytes_and_video_pictures_by_count() {
    let mut assets = Assets::default();
    assets.set_data_budget(1000);
    let first = assets.put_data(&[1u8; 400]);
    let second = assets.put_data(&[2u8; 400]);
    // Using the first makes the second the least recently used.
    assets.data(&first).unwrap();
    assets.put_data(&[3u8; 400]);
    assert_eq!(assets.kept().0, 800);
    assert!(assets.data(&first).is_ok());
    assert!(
        assets
            .data(&second)
            .unwrap_err()
            .to_string()
            .contains("no data is kept")
    );

    let ids: Vec<String> = (0..100u8)
        .map(|i| assets.put_frame_data(&[i; 64]))
        .collect();
    assert_eq!(assets.kept().2, kinetograph_skia::FRAME_KEEP);
    assert!(assets.data(&ids[99]).is_ok());
    assert!(assets.data(&ids[0]).is_err());
}
