use super::*;
use crate::filter::FilterGraph;
use base64::Engine as _;

/// A 2 x 1 PNG, red then blue, as a `data:` URL.
fn two_colours() -> String {
    let mut png = std::io::Cursor::new(Vec::new());
    let picture = image::RgbaImage::from_fn(2, 1, |x, _| if x == 0 { image::Rgba([255, 0, 0, 255]) } else { image::Rgba([0, 0, 255, 255]) });
    picture.write_to(&mut png, image::ImageFormat::Png).unwrap();
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png.get_ref()))
}

#[test]
fn an_fe_image_fills_its_subregion_on_a_cpu_surface() {
    fills_its_subregion(&two_colours());
}

#[test]
fn an_fe_image_data_url_with_a_line_break_and_an_escape_is_read_as_an_img_reads_it() {
    let url = two_colours();
    // A break inside the base64, and `%2B`-style escapes for its letters, as the DOM lets `<img>` carry them.
    let (head, body) = url.split_at(url.find(',').unwrap() + 1);
    let escaped = body.replacen("iV", "%69V", 1);
    fills_its_subregion(&format!("{head}{}\n{}", &escaped[..10], &escaped[10..]));
}

fn fills_its_subregion(href: &str) {
    let scene = Scene::from_json(r#"{"width": 20, "height": 20, "fps": 30, "durationInFrames": 1, "layers": []}"#, PathBuf::new()).unwrap();
    let mut tr = Translator::new(&scene);
    tr.srgb = true;
    // The picture is stretched over the right half of the 20 x 20 region: red on its left, blue on its right.
    let graph: FilterGraph = serde_json::from_value(serde_json::json!({
        "filterUnits": "userSpaceOnUse", "x": 0, "y": 0, "width": 20, "height": 20,
        "primitives": [{"primitive": "feImage", "href": href, "preserveAspectRatio": "none",
                        "x": 10, "y": 0, "width": 10, "height": 20}]
    }))
    .unwrap();
    let filter = tr.filter_graph(&graph.resolve(0.0), None, 1.0, Some(Rect::new(0.0, 0.0, 20.0, 20.0))).expect("a filter");
    assert!(tr.stats.unsupported.is_empty(), "{:?}", tr.stats.unsupported);
    let mut surface = skia_safe::surfaces::raster_n32_premul((20, 20)).unwrap();
    let mut paint = Paint::default();
    paint.set_color(Color::WHITE);
    paint.set_image_filter(filter);
    surface.canvas().draw_rect(Rect::new(0.0, 0.0, 20.0, 20.0), &paint);
    let info = skia_safe::ImageInfo::new((20, 20), skia_safe::ColorType::RGBA8888, skia_safe::AlphaType::Premul, None);
    let mut buf = vec![0u8; 20 * 20 * 4];
    assert!(surface.read_pixels(&info, &mut buf, 20 * 4, (0, 0)));
    let at = |x: usize, y: usize| <[u8; 4]>::try_from(&buf[(y * 20 + x) * 4..(y * 20 + x) * 4 + 4]).unwrap();
    // Inside the subregion: red, then blue. Outside it: nothing, though the layer was white there.
    let (red, blue) = (at(11, 10), at(18, 10));
    assert!(red[0] > 240 && red[1] < 10 && red[2] < 10 && red[3] == 255, "{red:?}");
    assert!(blue[2] > 240 && blue[0] < 10 && blue[1] < 10 && blue[3] == 255, "{blue:?}");
    assert_eq!(at(5, 10), [0, 0, 0, 0]);
    assert_eq!(at(9, 10), [0, 0, 0, 0]);
}
