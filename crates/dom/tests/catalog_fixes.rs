//! Web-platform behaviours the painter got wrong, one minimal page each: what the CSS or SVG spec says the picture is.

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

/// SVG 2 painting, `stroke-dasharray`: a dash as long as a closed shape's outline (or longer) strokes the whole
/// outline, a ring. A gradient stroke is drawn as an outline we dash ourselves.
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

/// CSS 2.1 Appendix E, step 8: a box that makes a stacking context at z-index 0 (here a transform and an opacity)
/// paints in tree order with the positioned boxes, so over an earlier positioned sibling.
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

/// CSS Masking 1, `mask-composite: exclude`: of two mask layers, what only one of them covers is kept: here the
/// border box minus the padding box, a ring.
#[test]
fn mask_composite_exclude_leaves_a_ring() {
    let frame = shoot(
        "mask-exclude",
        r##"<div style="width:160px;height:160px;border:20px solid transparent;background:#2ad;mask:linear-gradient(#000 0 0) padding-box,linear-gradient(#000 0 0) border-box;-webkit-mask:linear-gradient(#000 0 0) padding-box,linear-gradient(#000 0 0) border-box;mask-composite:exclude;-webkit-mask-composite:xor"></div>"##,
        200,
        200,
    );
    assert_eq!(px(&frame, 100, 100), [255, 255, 255, 255], "the inside of the ring");
    assert_eq!(px(&frame, 10, 100), [34, 170, 221, 255], "the ring");
}

/// Filter Effects 2, `backdrop-filter`: every filter function acts on what is behind the element, not only `blur()`.
/// `saturate(0)` over a red box leaves grey inside the element and the red outside it.
#[test]
fn backdrop_filter_saturate_greys_what_is_behind() {
    let frame = shoot(
        "backdrop-saturate",
        r##"<div style="position:absolute;left:0;top:0;width:200px;height:100px;background:#c86464"></div>
<div style="position:absolute;left:50px;top:20px;width:100px;height:60px;backdrop-filter:saturate(0)"></div>"##,
        200,
        100,
    );
    assert_eq!(px(&frame, 10, 10), [200, 100, 100, 255], "outside");
    // Rec. 709 luma of (200, 100, 100) as the saturate matrix has it: 0.213 * 200 + 0.715 * 100 + 0.072 * 100.
    let inside = px(&frame, 100, 50);
    assert!(inside[0].abs_diff(121) <= 2 && inside[0].abs_diff(inside[1]) <= 1 && inside[0].abs_diff(inside[2]) <= 1, "{inside:?}");
}

/// CSS Custom Properties 1: a custom property in an element's `style` attribute styles nothing by itself and takes
/// nothing away: the rest of the cascade (here a stylesheet rule's `fill: none` and stroke) still applies to the
/// SVG shape, with `var()` read from it.
#[test]
fn a_custom_property_in_the_style_attribute_of_an_svg_shape_leaves_the_cascade_alone() {
    let frame = shoot(
        "custom-property",
        r##"<div class="w"><svg viewBox="0 0 520 220"><path d="M24 160 C90 28, 188 40, 228 128 S356 234, 494 68" style="--dash: 0"/></svg></div>
<style>
  .w { width: 560px; padding: 20px; background: #fff; display: grid; place-items: center }
  .w svg { width: 520px; height: 220px; overflow: visible; }
  .w path { fill: none; stroke: #18181b; stroke-width: 12; stroke-dasharray: 900; stroke-dashoffset: var(--dash, 0); }
</style>"##,
        620,
        300,
    );
    // Inside the curve's bow nothing is drawn: the shape is not filled.
    assert_eq!(px(&frame, 300, 150), [255, 255, 255, 255]);
}

/// CSS Transforms 2: a box whose own corner lies left of and above the origin (a negative margin) and that is moved in
/// 3D under a `perspective` (`translate3d` into the distance) is seen whole, not cut at the origin of its parent. Pushed
/// back by 863 under 5669 of perspective, and halved by the scaled ancestor, a 450 box is about 195 wide round (960, 540).
#[test]
fn a_box_with_a_negative_margin_moved_in_3d_is_not_cut_at_the_origin() {
    let frame = shoot(
        "negative-margin-3d",
        r##"<div style="position:relative;width:1920px;height:1080px;overflow:hidden;background:#fff">
<div style="position:absolute;left:0;top:0;width:3840px;height:2160px;transform-origin:0 0;transform:scale(0.5)">
<div style="position:absolute;inset:0;perspective:5669.2913px;perspective-origin:50% 50%">
<div style="position:absolute;inset:0;transform-style:preserve-3d">
<div style="position:absolute;inset:0;transform-style:preserve-3d">
<div style="position:absolute;left:0;top:0;width:1500px;height:1500px;margin-left:-750px;margin-top:-750px;background:#cc0000;transform:translate3d(1920px,1080px,-863px) scale(0.3)"></div>
</div></div></div></div></div>"##,
        1920,
        1080,
    );
    // The top left quarter of the box, which lies at negative coordinates before the move.
    assert_eq!(px(&frame, 880, 460), [204, 0, 0, 255], "the top left of the box is missing");
    assert_eq!(px(&frame, 1040, 620), [204, 0, 0, 255], "the bottom right");
    assert_eq!(px(&frame, 850, 430), [255, 255, 255, 255], "the box is larger than it should be");
}
