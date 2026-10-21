//! Things that used to be refused for their size: thousands of tiles of a
//! gradient (`background-size` small, `repeat`).

mod common;
mod paintkit;

fn px(frame: &kinetograph_core::Frame, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * frame.width + x) * 4) as usize;
    frame.rgba[i..i + 4].try_into().unwrap()
}

fn close(a: [u8; 4], b: [u8; 4]) -> bool {
    a.iter().zip(b).all(|(a, b)| a.abs_diff(b) <= 3)
}

#[test]
fn thousands_of_gradient_tiles_are_one_tile_repeated() {
    // 75 x 50 = 3750 tiles of 8 x 8.
    let body = r#"<div style="position:absolute;left:0;top:0;width:600px;height:400px;
        background:linear-gradient(90deg,#f00,#00f) 0 0/8px 8px repeat"></div>"#;
    let (out, frame) = paintkit::render_body(body, 600, 400);
    assert!(out.unsupported.is_empty(), "{:?}", out.unsupported);
    paintkit::save_frame(&frame, &paintkit::out_dir().join("limits_tiles.png"));
    // Each tile runs red to blue across its 8 pixels, the same in every tile.
    let first = px(&frame, 0, 0);
    let last = px(&frame, 7, 0);
    assert!(first[0] > 200 && first[2] < 60, "{first:?}");
    assert!(last[2] > 200 && last[0] < 60, "{last:?}");
    for (x, y) in [(0, 0), (3, 5), (7, 7)] {
        let base = px(&frame, x, y);
        for (kx, ky) in [(1, 0), (0, 1), (10, 10), (74, 49)] {
            let other = px(&frame, x + 8 * kx, y + 8 * ky);
            assert!(
                close(base, other),
                "({x},{y}) {base:?} vs +({kx},{ky}) {other:?}"
            );
        }
    }
    // Outside the box is untouched.
    assert_eq!(px(&frame, 599, 399)[3], 255);
}

#[test]
fn a_tiled_gradient_repeating_one_way_stays_in_its_band() {
    let body = r#"<div style="position:absolute;left:0;top:0;width:600px;height:100px;
        background:linear-gradient(90deg,#f00,#00f) 0 10px/4px 20px repeat-x"></div>"#;
    let (out, frame) = paintkit::render_body(body, 600, 100);
    assert!(out.unsupported.is_empty(), "{:?}", out.unsupported);
    assert!(px(&frame, 300, 20)[0] > 0 || px(&frame, 300, 20)[2] > 0);
    // Above and below the band: the page's white.
    assert_eq!(px(&frame, 300, 5), [255, 255, 255, 255]);
    assert_eq!(px(&frame, 300, 50), [255, 255, 255, 255]);
}

#[test]
fn an_inset_clip_path_on_a_box_with_no_size_of_its_own_measures_the_laid_out_box() {
    // Sized by its content, and by `inset: 0`.
    for body in [
        r#"<div style="position:absolute;left:10px;top:10px;clip-path:inset(0 0 0 50px);background:#f00"><div style="width:100px;height:50px"></div></div>"#,
        r#"<div style="position:absolute;inset:0;clip-path:inset(0 0 0 50px);background:#f00"></div>"#,
    ] {
        let (out, frame) = paintkit::render_body(body, 200, 100);
        assert!(out.unsupported.is_empty(), "{:?}", out.unsupported);
        assert_eq!(px(&frame, 20, 20), [255, 255, 255, 255], "{body}");
        assert_eq!(px(&frame, 70, 20), [255, 0, 0, 255], "{body}");
    }
}

/// The `boxWidth` of the first text layer under `layers`.
fn box_width(layers: &[serde_json::Value]) -> Option<f64> {
    layers.iter().find_map(|l| {
        if l["type"] == "text" {
            return l["boxWidth"].as_f64();
        }
        l["children"].as_array().and_then(|c| box_width(c))
    })
}

#[test]
fn a_negative_letter_spacing_does_not_shorten_the_text_box_past_its_ink() {
    let text = |ls: &str| {
        let body = format!(
            r#"<div style="position:absolute;left:0;top:0;font-size:40px;letter-spacing:{ls}">HHHH</div>"#
        );
        let out = paintkit::paint_html(&paintkit::page(&body), 300, 100);
        box_width(&out.layers).expect("a text layer")
    };
    let plain = text("0");
    let tight = text("-10px");
    // Four glyphs lose 10px each, but the last one's spacing falls after its ink.
    assert!((plain - tight - 30.0).abs() < 0.5, "{plain} vs {tight}");
}
