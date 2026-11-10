//! CSS Masking 1 on SVG elements: `mask-image` is a list of mask layers (an image or a `url(#mask)` reference each),
//! combined by `mask-composite`; a gradient layer maps onto the element's own box (an SVG element has no CSS box:
//! `mask-origin` takes the fill box).

mod common;
mod paintkit;

use kinetograph_core::Frame;

fn px(f: &Frame, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * f.width + x) * 4) as usize;
    [f.rgba[i], f.rgba[i + 1], f.rgba[i + 2], f.rgba[i + 3]]
}

fn shoot(name: &str, rect_style: &str) -> Frame {
    let body = format!(
        r##"<svg width="200" height="100" viewBox="0 0 200 100" style="display:block"><mask id="m"><circle cx="100" cy="50" r="40" fill="#fff"/></mask><rect width="200" height="100" fill="#00c000" style="{rect_style}"/></svg>"##
    );
    let (out, frame) = paintkit::render_body(&body, 200, 100);
    paintkit::save_frame(&frame, &paintkit::out_dir().join(format!("fix-{name}.png")));
    assert!(out.unsupported.is_empty(), "{:?}", out.unsupported);
    frame
}

fn is_green(p: [u8; 4]) -> bool {
    p[0] < 40 && p[1] > 150 && p[2] < 40
}

fn is_white(p: [u8; 4]) -> bool {
    p[0] > 235 && p[1] > 235 && p[2] > 235
}

#[test]
fn a_gradient_mask_image_on_an_svg_element_masks_it() {
    // A property the page's script sets with var(), as GSAP does: resolved when it is computed.
    let f = shoot(
        "svg-mask-gradient",
        "--x:50%;mask-image:linear-gradient(to right,#000 var(--x),transparent var(--x))",
    );
    assert!(is_green(px(&f, 50, 50)), "{:?}", px(&f, 50, 50));
    assert!(is_white(px(&f, 150, 50)), "{:?}", px(&f, 150, 50));
}

#[test]
fn a_url_layer_and_a_gradient_layer_intersect() {
    let f = shoot(
        "svg-mask-list",
        "mask-image:url(#m),linear-gradient(to right,#000 50%,transparent 50%);mask-composite:intersect",
    );
    // The circle spans x 60 to 140: its left half is kept, its right half is not, nothing outside it is.
    assert!(is_green(px(&f, 80, 50)), "{:?}", px(&f, 80, 50));
    assert!(is_white(px(&f, 120, 50)), "{:?}", px(&f, 120, 50));
    assert!(is_white(px(&f, 20, 50)), "{:?}", px(&f, 20, 50));
    assert!(is_white(px(&f, 100, 5)), "{:?}", px(&f, 100, 5));
}

#[test]
fn a_single_url_layer_still_masks_by_the_mask_element() {
    let f = shoot("svg-mask-url", "mask-image:url(#m)");
    assert!(is_green(px(&f, 100, 50)));
    assert!(is_white(px(&f, 20, 50)));
}

/// CSS Masking 1 for an SVG element without a CSS layout box: `mask-origin` is the fill box (7.6), `mask-clip`
/// `border-box` is the stroke box (7.5). The rect's fill box is x 40 to 160; its 20 wide stroke reaches x 30 to 170.
/// The gradient's hard stop at 25% of the fill box is at x 70 (not 65, as it would be on the stroke box), and the mask
/// covers the stroke out to its edge, the gradient's first colour continuing past the fill box.
#[test]
fn a_gradient_mask_layer_is_laid_out_on_the_fill_box_and_covers_the_stroke_box() {
    let body = r##"<svg width="200" height="100" viewBox="0 0 200 100" style="display:block"><rect x="40" y="10" width="120" height="80" fill="#00c000" stroke="#00c000" stroke-width="20" style="mask-image:linear-gradient(to right,#000 25%,transparent 25%)"/></svg>"##;
    let (_, f) = paintkit::render_body(body, 200, 100);
    assert!(is_green(px(&f, 34, 50)), "the stroke's edge is kept: {:?}", px(&f, 34, 50));
    assert!(is_green(px(&f, 67, 50)), "left of the stop at 70: {:?}", px(&f, 67, 50));
    assert!(is_white(px(&f, 73, 50)), "right of the stop at 70: {:?}", px(&f, 73, 50));
}

/// The stroke that widens the mask area is the computed one: a stylesheet rule counts, and so does a stroke the
/// element inherits. A rule that says `stroke: none` is no stroke even under a parent whose attribute strokes. The mask
/// area past the fill box is drawn as one tile, which is reported unless `mask-repeat` is `no-repeat`.
#[test]
fn the_mask_area_reaches_a_stroke_a_rule_or_a_parent_sets() {
    let gradient = "mask-image:linear-gradient(to right,#000 25%,transparent 25%)";
    let page = |inner: &str| {
        format!(
            r##"<style>.s{{stroke:#00c000;stroke-width:20px}}.n{{stroke:none}}</style><svg width="200" height="100" viewBox="0 0 200 100" style="display:block">{inner}</svg>"##
        )
    };
    let rect = |class: &str, style: &str| {
        format!(r##"<rect class="{class}" x="40" y="10" width="120" height="80" fill="#00c000" style="{style}"/>"##)
    };
    let repeat_notes = |out: &kinetograph_dom::IslandOutput| {
        out.unsupported.iter().filter(|u| u.property.as_deref() == Some("mask-repeat")).count()
    };

    // Stroked by a rule on the parent: the mask reaches the stroke's edge, and the repeat is reported.
    let (out, f) = paintkit::render_body(&page(&format!(r##"<g class="s">{}</g>"##, rect("", gradient))), 200, 100);
    assert!(is_green(px(&f, 34, 50)), "{:?}", px(&f, 34, 50));
    assert_eq!(repeat_notes(&out), 1, "{:?}", out.unsupported);

    // `mask-repeat: no-repeat` has nothing to report.
    let (out, _) = paintkit::render_body(
        &page(&format!(r##"<g class="s">{}</g>"##, rect("", &format!("{gradient};mask-repeat:no-repeat")))),
        200,
        100,
    );
    assert_eq!(repeat_notes(&out), 0, "{:?}", out.unsupported);

    // A rule's `stroke: none` under a parent whose attribute strokes: not stroked, so the area stays the fill box.
    let inner = format!(r##"<g stroke="#00c000" stroke-width="20">{}</g>"##, rect("n", gradient));
    let (out, _) = paintkit::render_body(&page(&inner), 200, 100);
    assert_eq!(repeat_notes(&out), 0, "{:?}", out.unsupported);
    // The control: the same parent without the rule strokes it.
    let inner = format!(r##"<g stroke="#00c000" stroke-width="20">{}</g>"##, rect("", gradient));
    let (out, _) = paintkit::render_body(&page(&inner), 200, 100);
    assert_eq!(repeat_notes(&out), 1, "{:?}", out.unsupported);
}
