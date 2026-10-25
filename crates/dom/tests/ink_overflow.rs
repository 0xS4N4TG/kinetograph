//! Ink that overflows an element's box (a descender under `line-height: 1`) is drawn whole when the element has a
//! `filter`, a `transform` or an `opacity`: the layer is sized to the ink, not the box. Chrome draws it.

mod paintkit;

use paintkit::{compare, render_body};

/// Within a seventh: a layer composites its edges in another colour space, so its anti-aliased pixels differ a little
/// (a cut descender loses over a third).
fn same(a: usize, b: usize) -> bool {
    a.abs_diff(b) * 7 <= b
}

/// Dark pixels in the rows `from..to` of the 300x200 render.
fn dark_rows(style: &str, from: usize, to: usize) -> usize {
    let body = format!(
        r#"<div style="position:absolute;left:10px;top:20px;font-size:80px;line-height:1;color:#000;{style}">gggg<span style="color:#d22">g</span></div>"#
    );
    let (out, frame) = render_body(&body, 300, 200);
    assert!(out.unsupported.is_empty(), "{:?}", out.unsupported);
    let mut n = 0;
    for y in from..to {
        for x in 0..300 {
            let i = (y * 300 + x) * 4;
            if frame.rgba[i + 1] < 128 {
                n += 1;
            }
        }
    }
    n
}

// The box is 20..100; DM Sans's "g" hangs about 15px below it at 80px with line-height 1.
const BELOW: (usize, usize) = (101, 125);

#[test]
fn a_plain_element_draws_its_descenders() {
    assert!(dark_rows("", BELOW.0, BELOW.1) > 100);
}

#[test]
fn a_blur_of_zero_does_not_cut_descenders() {
    let plain = dark_rows("", BELOW.0, BELOW.1);
    assert!(same(dark_rows("filter:blur(0px)", BELOW.0, BELOW.1), plain));
}

#[test]
fn a_blur_does_not_cut_descenders() {
    // A 4px blur softens them but still reaches below the box.
    assert!(dark_rows("filter:blur(4px)", BELOW.0, BELOW.1) > 100);
}

#[test]
fn a_transform_does_not_cut_descenders() {
    let plain = dark_rows("", BELOW.0, BELOW.1);
    assert!(same(dark_rows("transform:scale(1)", BELOW.0, BELOW.1), plain));
    assert!(same(dark_rows("transform:scale(1);filter:blur(0px)", BELOW.0, BELOW.1), plain));
}

#[test]
fn an_opacity_does_not_cut_descenders() {
    let plain = dark_rows("", BELOW.0, BELOW.1);
    assert!(same(dark_rows("opacity:0.999", BELOW.0, BELOW.1), plain));
}

#[test]
fn shadows_past_the_box_are_not_cut_either() {
    for shadow in ["text-shadow:0 30px 0 #000", "box-shadow:0 30px 0 #000"] {
        let plain = dark_rows(shadow, 101, 160);
        assert!(plain > 100, "{shadow}");
        for layer in ["opacity:0.999", "filter:blur(0px)", "transform:scale(1)"] {
            let got = dark_rows(&format!("{shadow};{layer}"), 101, 160);
            assert!(same(got, plain), "{shadow} {layer}: {got} vs {plain}");
        }
    }
}

#[test]
fn a_filtered_scaled_wordmark_matches_chrome() {
    // The launch film's end card: line-height 1, a transform and a blur, with the descenders of "g" and "p" past the box.
    let body = r#"<div style="margin:20px 0 0 10px;font-size:80px;line-height:1;transform:scale(1);filter:blur(0px)">kinetograph<span style="color:#d22">.</span></div>"#;
    let (out, frame, _) = compare("ink-overflow-wordmark", body, 480, 160);
    assert!(out.unsupported.is_empty(), "{:?}", out.unsupported);
    let Some(chrome) = paintkit::chrome("ink-overflow-wordmark", body, 480, 160) else { return };
    // The box ends at y = 100: count the dark pixels below it, where the descenders are.
    let below = |img: &image::RgbaImage| img.enumerate_pixels().filter(|(_, y, p)| *y > 100 && p.0[1] < 128).count();
    let (ours, theirs) = (below(&paintkit::frame_image(&frame)), below(&chrome));
    assert!(theirs > 100 && same(ours, theirs), "ours {ours}, Chrome {theirs}");
}
