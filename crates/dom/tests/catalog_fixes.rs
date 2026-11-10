//! Constructs the Remotion and HyperFrames template catalogs drew wrong, one small page each.

mod common;
mod paintkit;

use kinetograph_core::Frame;

fn px(f: &Frame, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * f.width + x) * 4) as usize;
    [f.rgba[i], f.rgba[i + 1], f.rgba[i + 2], f.rgba[i + 3]]
}

fn shoot(name: &str, body: &str, w: u32, h: u32) -> Frame {
    let (_, frame) = paintkit::render_body(body, w, h);
    paintkit::save_frame(&frame, &paintkit::out_dir().join(format!("fix-{name}.png")));
    frame
}

/// An ellipse stroked with a gradient (an outline, dashed by kurbo) whose one dash covers the whole outline, as
/// Remotion's hello-world arc does once its progress reaches 1.
#[test]
fn a_dashed_gradient_ellipse_under_a_css_rotation_is_a_whole_ring() {
    let svg = |ellipse: &str| {
        format!(
            r##"<svg viewBox="0 0 400 400" style="position:absolute;left:0;top:0;width:400px;height:400px;rotate:20deg"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><ellipse {ellipse} fill="none" stroke="url(#g)" stroke-dashoffset="0" stroke-linecap="round" stroke-width="20"/></svg>"##
        )
    };
    // A dash longer than the outline (about 714).
    let frame = shoot("dash", &svg(r#"cx="200" cy="200" rx="70" ry="150" stroke-dasharray="943""#), 400, 400);
    // The point of the outline 45 degrees above its right end, turned 20 degrees about the centre.
    let on_the_arc = px(&frame, 283, 117);
    assert!(on_the_arc[1] < 100, "the arc is missing at (283, 117): {on_the_arc:?}");
    // A chord from the right end to the top would cut the inside of the ring, not the middle of it.
    assert_eq!(px(&frame, 200, 200), [255, 255, 255, 255]);
    // A dash as long as the outline, as the page measured it: a circle of radius 100, 2 pi r.
    let frame = shoot("dash-equal", &svg(r#"cx="200" cy="200" rx="100" ry="100" stroke-dasharray="628.3185""#), 400, 400);
    // The same point of the circle: (270.7, 129.3) turned 20 degrees about the centre.
    let on_the_arc = px(&frame, 291, 158);
    assert!(on_the_arc[1] < 100, "the circle is missing its arc at (291, 158): {on_the_arc:?}");
    assert_eq!(px(&frame, 200, 200), [255, 255, 255, 255]);
}
