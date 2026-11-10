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
<div class="w"><svg viewBox="0 0 520 220"><path d="M24 160 C90 28, 188 40, 228 128 S356 234, 494 68" style="stroke-dashoffset: var(--dash)"/></svg></div>
<style>
  .w { width: 560px; padding: 20px; background: #fff; display: grid; place-items: center }
  .w svg { width: 520px; height: 220px; overflow: visible; }
  .w path { fill: none; stroke: #18181b; stroke-width: 12; stroke-dasharray: 900; stroke-dashoffset: var(--dash, 0); }
</style>"##,
        620,
        600,
    );
    // Inside the curve's bow nothing is drawn: the shape is not filled, whether the custom property is declared or
    // read by the element's own `style`.
    assert_eq!(px(&frame, 300, 150), [255, 255, 255, 255]);
    assert_eq!(px(&frame, 300, 150 + 260), [255, 255, 255, 255]);
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

/// Filter Effects 2, `backdrop-filter`: the filters see the backdrop cut to the element's border box, whichever filter
/// comes first. A black strip left of the element does not bleed into it, with `saturate()` before `blur()` too.
#[test]
fn backdrop_filter_reads_only_inside_the_box_with_a_colour_function_before_the_blur() {
    let frame = shoot(
        "backdrop-crop",
        r##"<div style="position:absolute;left:40px;top:0;width:60px;height:100px;background:#000"></div>
<div style="position:absolute;left:100px;top:20px;width:80px;height:60px;backdrop-filter:saturate(0) blur(8px)"></div>"##,
        200,
        100,
    );
    let near_the_strip = px(&frame, 103, 50);
    assert!(near_the_strip[0] > 245, "the strip bleeds into the box: {near_the_strip:?}");
}

/// CSS 2.1 Appendix E, steps 8 and 9, in the layouts a stacking context at z-index 0 sits in: in block flow, as a float,
/// and with a positioned box after it (tree order wins either way); and a descendant at `z-index: -1` of a box that makes
/// a stacking context by its blend mode stays inside it, above the box's own background.
#[test]
fn stacking_contexts_at_z_index_zero_paint_in_tree_order_with_positioned_boxes() {
    let red = [255, 0, 0, 255];
    let blue = [0, 0, 255, 255];
    let green = [0, 128, 0, 255];
    // In a positioned container: an absolute box whose containing block is further up is listed with that block's children
    // by Blitz, after the whole subtree it sits in (a limit of the vendored layout, not tested here).
    let abs = |color: &str| format!(r#"<div style="position:absolute;left:0;top:0;width:100px;height:100px;background:{color}"></div>"#);
    let wrap = |inner: String| format!(r#"<div style="position:relative;width:200px;height:100px">{inner}</div>"#);
    // A transformed block in flow, after an absolute box.
    let f = shoot("order-block", &wrap(format!(r##"{}<div style="width:100px;height:100px;background:#00f;transform:translate(0,0)"></div>"##, abs("#f00"))), 200, 100);
    assert_eq!(px(&f, 50, 50), blue, "block");
    // A transformed float, after an absolute box.
    let f = shoot("order-float", &wrap(format!(r##"{}<div style="float:left;width:100px;height:100px;background:#00f;opacity:0.999"></div>"##, abs("#f00"))), 200, 100);
    let p = px(&f, 50, 50);
    assert!(p[2] > 250 && p[0] < 5, "float: {p:?}");
    // An absolute box after a transformed one is over it.
    let f = shoot("order-later", &wrap(format!(r##"<div style="width:100px;height:100px;background:#00f;transform:translate(0,0)"></div>{}"##, abs("#008000"))), 200, 100);
    assert_eq!(px(&f, 50, 50), green, "later absolute");
    // z-index -1 inside a blend-mode box.
    let f = shoot(
        "order-blend",
        r##"<div style="position:absolute;left:0;top:0;width:100px;height:100px;background:#ff0;mix-blend-mode:multiply"><div style="position:absolute;left:20px;top:20px;width:40px;height:40px;background:#f00;z-index:-1"></div></div>"##,
        200,
        100,
    );
    assert_eq!(px(&f, 40, 40), red, "the z-index -1 child escaped its blend-mode parent");
}

/// CSS 2.1 §12.1: `::before` and `::after` generate boxes, with their own background, in flow or positioned. A
/// `::after` that only carries a background is drawn, in a flat parent and in a `preserve-3d` one alike.
#[test]
fn a_pseudo_element_box_paints_its_background() {
    let frame = shoot(
        "pseudo-box",
        r##"<style>.t{position:absolute;width:120px;height:160px;background:#1d2b4d;top:20px}
.t::after{content:"";position:absolute;inset:18px 14px;background:repeating-linear-gradient(0deg,#ffd48a 0 10px,transparent 10px 34px)}
.f{position:absolute;left:340px;top:20px;width:100px}.f::before{content:"";display:block;height:30px;background:#0f0}
.p{position:absolute;left:170px;top:0;width:150px;height:220px;transform-style:preserve-3d}</style>
<div class="t" style="left:20px"></div>
<div class="p"><div class="t" style="left:0;transform:translateZ(-240px)"></div></div>
<div class="f"></div>"##,
        460,
        220,
    );
    let striped = |x: u32| (0..160).any(|dy| px(&frame, x, 20 + dy)[0] > 200 && px(&frame, x, 20 + dy)[2] < 160);
    assert!(striped(80), "the flat tower has no stripes");
    assert!(striped(230), "the tower in the preserve-3d parent has no stripes");
    assert_eq!(px(&frame, 390, 30), [0, 255, 0, 255], "an in-flow ::before block has no background");
}

/// CSS 2.1 §12.1 and §9.2.2: a `::before` in a line of text is an inline box (or an inline-block) with its own background, drawn once
/// among the line's text. A half-transparent green over white is (127, 255, 127) once and (64, 255, 64) twice.
#[test]
fn an_inline_pseudo_element_in_a_line_of_text_paints_its_background_once() {
    let frame = shoot(
        "pseudo-inline",
        r##"<style>p{margin:0;font-size:16px;line-height:20px;height:40px}
.a::before{content:"";display:inline-block;width:30px;height:20px;background:rgba(0,255,0,.5)}
.b::before{content:"ab";background:rgba(0,255,0,.5)}</style>
<p class="a">text</p><p class="b">text</p>"##,
        200,
        80,
    );
    for (name, at) in [("inline-block", (15, 10)), ("inline", (4, 45))] {
        let p = px(&frame, at.0, at.1);
        assert!(
            (p[0] as i32 - 127).abs() < 3 && p[1] == 255 && (p[2] as i32 - 127).abs() < 3,
            "the {name} ::before is not drawn once at {at:?}: {p:?}"
        );
    }
}
