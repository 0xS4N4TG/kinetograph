//! SVG 2 gradients: `stop-color` is a presentation property, so a stylesheet rule can set it on a `<stop>`.

mod common;
mod paintkit;

use kinetograph_core::Frame;

fn px(f: &Frame, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * f.width + x) * 4) as usize;
    [f.rgba[i], f.rgba[i + 1], f.rgba[i + 2], f.rgba[i + 3]]
}

/// A stylesheet rule sets `stop-color` on a `<stop>`, and a `var()` in it takes the custom property, or its fallback
/// when none is set.
#[test]
fn a_stylesheet_sets_the_stop_color_of_a_gradient() {
    let body = r##"<style>:root{--b:#00c000}.a{stop-color:var(--b,#f00)}.b{stop-color:var(--nope,#0000c0)}</style>
<svg width="200" height="100" viewBox="0 0 200 100" style="display:block"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="0"><stop class="a" offset="0"/><stop class="b" offset="1"/></linearGradient></defs><rect width="200" height="100" fill="url(#g)"/></svg>"##;
    let (_, f) = paintkit::render_body(body, 200, 100);
    let (left, right) = (px(&f, 4, 50), px(&f, 195, 50));
    assert!(left[1] > 150 && left[0] < 60 && left[2] < 60, "{left:?}");
    assert!(right[2] > 150 && right[0] < 60 && right[1] < 60, "{right:?}");
}
