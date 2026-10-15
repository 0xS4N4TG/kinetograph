mod common;

#[test]
fn probe() {
    let out = common::paint_html(
        &common::page(r#"<div style="font-size:18px">a<span id="s" style="padding:0 20px;border:3px solid red;margin:0 10px;background:#fc0">bc</span>d</div>"#),
        300,
        100,
    );
    println!("{}", serde_json::to_string_pretty(&out.layers).unwrap());
}
