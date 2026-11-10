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

/// The electron template: a flex `AbsoluteFill` holds a full-size positioned backdrop and then a flex item that
/// has a transform and an opacity (a stacking context at z-index 0, in tree order with the positioned backdrop).
#[test]
fn a_transformed_element_paints_over_an_earlier_positioned_sibling() {
    let frame = shoot(
        "order",
        r##"<div style="position:absolute;left:0;top:0;width:300px;height:200px;display:flex;flex-direction:column;overflow:hidden;background:#222">
<div style="position:absolute;inset:0;background:#ff0000"></div>
<div style="width:100%;height:100%;display:flex;transform:translateY(10px) scale(1);opacity:0.99;padding:20px"><div style="width:200px;height:100px;background:#0000ff"></div></div></div>"##,
        300,
        200,
    );
    let p = px(&frame, 100, 100);
    assert!(p[2] > 200 && p[0] < 60, "the blue box is under the red backdrop: {p:?}");
}

/// CSS Masking 1, `mask-type`: set by a stylesheet rule on a `<mask>` (not only as an attribute), `alpha` keeps what
/// the mask's content covers instead of its luminance, which for black content would hide the masked box whole.
#[test]
fn an_svg_mask_with_mask_type_alpha_from_a_class_masks_by_alpha() {
    let frame = shoot(
        "mask-type",
        r##"<style>.\[mask-type\:alpha\]{mask-type:alpha}</style>
<svg width="200" height="100" viewBox="0 0 200 100" style="display:block"><mask id="m" class="[mask-type:alpha]"><circle cx="50" cy="50" r="40" fill="#000"/></mask><rect width="200" height="100" fill="#00c000" mask="url(#m)"/></svg>"##,
        200,
        100,
    );
    assert_eq!(px(&frame, 50, 50), [0, 192, 0, 255], "inside the circle");
    assert_eq!(px(&frame, 150, 50), [255, 255, 255, 255], "outside it");
}

/// CSS Backgrounds 4, `background-clip: text`: the background of an inline element is cut to the glyphs of its text.
#[test]
fn background_clip_text_on_an_inline_span_shows_the_gradient_in_the_glyphs() {
    let frame = shoot(
        "clip-text-inline",
        r##"<div style="font-size:60px;font-weight:700;padding:10px 20px"><span style="background:linear-gradient(to right, red, blue);-webkit-background-clip:text;-webkit-text-fill-color:transparent">Heading</span></div>"##,
        400,
        100,
    );
    let inked = frame.rgba.chunks(4).filter(|p| p[0] != 255 || p[1] != 255 || p[2] != 255).count();
    // The glyphs, not the span's whole box (about 330 x 70 pixels).
    assert!(inked > 1500, "no gradient in the glyphs: {inked}");
    assert!(inked < 330 * 70 / 2, "the whole box is filled: {inked}");
}
