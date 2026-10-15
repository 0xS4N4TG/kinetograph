mod common;

use common::compare;

#[test]
fn box_with_background_border_radius_and_text() {
    let (out, _frame, diff) = compare(
        "box-basic",
        r#"<div style="margin:20px;width:160px;padding:10px;border:3px solid #234;border-radius:14px;background:#fc6;color:#123">Hello world, a line of text that wraps</div>"#,
        240,
        140,
    );
    assert!(out.unsupported.is_empty(), "{:?}", out.unsupported);
    if let Some(d) = diff {
        println!("box-basic: {d:?}");
    }
}
