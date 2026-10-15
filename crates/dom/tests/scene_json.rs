//! What the painter writes for small HTML cases, checked on the scene JSON
//! (no GPU): the layers, their ids, their order and their fields.

mod paintkit;

use serde_json::Value;

fn paint(body: &str, w: u32, h: u32) -> kinetograph_dom::IslandOutput {
    paintkit::paint_html(&paintkit::page(body), w, h)
}

/// Every layer in paint order, nested ones after their group.
fn flat(layers: &[Value]) -> Vec<&Value> {
    let mut out = Vec::new();
    for l in layers {
        out.push(l);
        if let Some(c) = l.get("children").and_then(Value::as_array) {
            out.extend(flat(c));
        }
    }
    out
}

fn find<'a>(layers: &'a [Value], id: &str) -> &'a Value {
    flat(layers)
        .into_iter()
        .find(|l| l["id"] == id)
        .unwrap_or_else(|| {
            let ids: Vec<_> = flat(layers)
                .iter()
                .map(|l| l["id"].as_str().unwrap_or("?"))
                .collect();
            panic!("no layer {id}; have {ids:?}")
        })
}

fn pos(l: &Value) -> (f64, f64) {
    let t = &l["transform"];
    (
        t["x"].as_f64().unwrap_or(0.0),
        t["y"].as_f64().unwrap_or(0.0),
    )
}

fn index_of(layers: &[Value], id: &str) -> usize {
    flat(layers)
        .iter()
        .position(|l| l["id"] == id)
        .unwrap_or_else(|| panic!("no layer {id}"))
}

#[test]
fn a_rounded_background_is_a_rounded_rect_at_its_place() {
    let out = paint(
        r#"<div id="a" style="position:absolute;left:10px;top:20px;width:100px;height:50px;background:#f00;border-radius:12px"></div>"#,
        200,
        100,
    );
    let l = find(&out.layers, "a.bg.color");
    assert_eq!(l["shape"]["kind"], "roundedRect");
    assert_eq!(l["shape"]["radius"], 12);
    assert_eq!(l["fill"], "#ff0000");
    assert_eq!(pos(l), (10.0, 20.0));
    assert_eq!(out.blend_space, "srgb");
}

#[test]
fn elliptical_and_unequal_corners_are_a_path() {
    let out = paint(
        r#"<div id="a" style="width:100px;height:50px;background:#00f;border-radius:20px/10px 30px"></div>"#,
        200,
        100,
    );
    assert_eq!(find(&out.layers, "a.bg.color")["shape"]["kind"], "path");
}

#[test]
fn a_radial_ellipse_that_is_not_the_box_squashes_a_circle() {
    let out = paint(
        r#"<div id="a" style="width:200px;height:100px;background:radial-gradient(ellipse 40px 20px at 50% 50%,#fff,#000)"></div>"#,
        300,
        200,
    );
    let fill = &find(&out.layers, "a.bg.0")["fill"];
    assert_eq!(fill["type"], "radial");
    assert_eq!(fill["r"], 40);
    let m = fill["transform"]
        .as_array()
        .expect("an ellipse has a transform");
    assert_eq!(m[3], 0.5);
}

#[test]
fn a_repeating_picture_is_an_image_paint_that_repeats() {
    let tile = paintkit::repo_root()
        .join("crates/dom/tests/assets/tile.png")
        .canonicalize()
        .unwrap();
    let out = paint(
        &format!(
            r#"<div id="a" style="width:100px;height:80px;background:url(file://{})"></div>"#,
            tile.display()
        ),
        200,
        100,
    );
    let fill = &find(&out.layers, "a.bg.0")["fill"];
    assert_eq!(fill["type"], "image");
    assert_eq!(
        (fill["width"].as_f64(), fill["height"].as_f64()),
        (Some(32.0), Some(32.0))
    );
    assert_eq!(
        (fill["repeatX"].as_bool(), fill["repeatY"].as_bool()),
        (Some(true), Some(true))
    );
}

#[test]
fn background_blend_mode_makes_an_isolated_group() {
    let out = paint(
        r#"<div id="a" style="width:60px;height:40px;background-color:#c33;background-image:linear-gradient(#fff,#000);background-blend-mode:multiply"></div>"#,
        100,
        100,
    );
    let g = find(&out.layers, "a.bg");
    assert_eq!(g["type"], "group");
    assert_eq!(find(&out.layers, "a.bg.0")["blendMode"], "multiply");
}

#[test]
fn mix_blend_mode_and_opacity_make_a_group_of_the_element() {
    let out = paint(
        r#"<div id="a" style="width:60px;height:40px;background:#c33;mix-blend-mode:screen;opacity:.5"></div>"#,
        100,
        100,
    );
    // The group of one shape is the shape itself, with the group's fields.
    let g = find(&out.layers, "a");
    assert_eq!(g["type"], "shape");
    assert_eq!(g["blendMode"], "screen");
    assert_eq!(g["opacity"], 0.5);
}

#[test]
fn an_outer_shadow_is_a_blurred_shape_cut_to_the_outside() {
    let out = paint(
        r#"<div id="a" style="margin:30px;width:60px;height:40px;background:#fff;border-radius:8px;box-shadow:2px 6px 12px 3px rgba(0,0,0,.5)"></div>"#,
        200,
        150,
    );
    let s = find(&out.layers, "a.shadow0");
    assert_eq!(s["fill"], "#00000080");
    assert_eq!(s["effects"][0]["type"], "blur");
    assert_eq!(
        s["effects"][0]["radius"], 6,
        "a CSS blur of 12px is a standard deviation of 6"
    );
    assert_eq!(s["clip"]["kind"], "path");
    // Under the background.
    assert!(index_of(&out.layers, "a.shadow0") < index_of(&out.layers, "a.bg.color"));
    assert!(out.margin.unwrap() >= 18);
}

#[test]
fn an_inset_shadow_goes_over_the_background_and_under_the_border() {
    let out = paint(
        r#"<div id="a" style="width:60px;height:40px;background:#fff;border:4px solid #333;box-shadow:inset 0 4px 8px #000"></div>"#,
        100,
        100,
    );
    let (bg, sh, border) = (
        index_of(&out.layers, "a.bg.color"),
        index_of(&out.layers, "a.insetshadow0"),
        index_of(&out.layers, "a.border"),
    );
    assert!(bg < sh && sh < border);
}

#[test]
fn a_uniform_border_is_one_ring_and_a_mixed_one_is_four_sides() {
    let out = paint(
        r#"<div id="a" style="width:40px;height:30px;border:3px solid #123"></div>
<div id="b" style="width:40px;height:30px;border:3px solid;border-color:#f00 #0f0 #00f #ff0"></div>"#,
        200,
        100,
    );
    let ring = find(&out.layers, "a.border");
    assert!(
        ring["shape"]["d"].as_str().unwrap().matches('M').count() == 2,
        "outer and inner outline"
    );
    for side in ["top", "right", "bottom", "left"] {
        let l = find(&out.layers, &format!("b.border.{side}"));
        assert_eq!(l["clip"]["kind"], "polygon");
    }
}

#[test]
fn transform_properties_become_one_matrix_about_the_origin() {
    let out = paint(
        r#"<div id="a" style="position:absolute;left:10px;top:20px;width:100px;height:40px;background:#000;rotate:90deg;translate:5px 0"></div>"#,
        200,
        200,
    );
    let t = &find(&out.layers, "a")["transform"];
    assert_eq!(
        (t["x"].as_f64(), t["y"].as_f64()),
        (Some(60.0), Some(40.0)),
        "the origin (centre) of the box in its parent"
    );
    assert_eq!(
        (t["anchorX"].as_f64(), t["anchorY"].as_f64()),
        (Some(50.0), Some(20.0))
    );
    let m: Vec<f64> = t["matrix"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    // translate then rotate: a quarter turn with a 5px shift along the turned x.
    assert!((m[0]).abs() < 1e-3 && (m[1] - 1.0).abs() < 1e-3, "{m:?}");
    assert!((m[12] - 5.0).abs() < 1e-3 && m[13].abs() < 1e-3, "{m:?}");
}

#[test]
fn a_parents_perspective_makes_the_childs_matrix_a_perspective_one() {
    let out = paint(
        r#"<div style="position:absolute;left:0;top:0;width:200px;height:100px;perspective:400px"><div id="c" style="width:100px;height:80px;background:#000;transform:rotateY(30deg)"></div></div>"#,
        300,
        200,
    );
    let m: Vec<f64> = find(&out.layers, "c")["transform"]["matrix"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    assert!(
        m[3].abs() > 1e-6 || m[7].abs() > 1e-6 || m[11].abs() > 1e-6,
        "a w component: {m:?}"
    );
}

#[test]
fn the_perspective_terms_of_a_matrix_keep_their_precision() {
    // A distant camera: the w the x axis gains is sin(30deg) / 20000 = 2.5e-5,
    // which four decimals turn into 0 (and 4e-5 into 1e-4: a slope 2.5 times too steep).
    let out = paint(
        r#"<div style="position:absolute;left:0;top:0;width:200px;height:100px;perspective:20000px"><div id="c" style="width:100px;height:80px;background:#000;transform:rotateY(30deg)"></div></div>"#,
        300,
        200,
    );
    let m: Vec<f64> = find(&out.layers, "c")["transform"]["matrix"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    assert!((m[3].abs() - 2.5e-5).abs() < 1e-8, "{m:?}");
}

#[test]
fn backface_and_preserve_3d_reach_the_layer() {
    let out = paint(
        r#"<div id="a" style="transform-style:preserve-3d;width:50px;height:50px"><div id="b" style="width:30px;height:30px;background:#000;transform:rotateY(180deg);backface-visibility:hidden"></div></div>"#,
        100,
        100,
    );
    assert_eq!(find(&out.layers, "a")["preserve3d"], true);
    assert_eq!(find(&out.layers, "b")["transform"]["backfaceHidden"], true);
}

#[test]
fn overflow_hidden_cuts_the_content_to_the_padding_box() {
    let out = paint(
        r#"<div id="a" style="width:60px;height:40px;border:5px solid #000;border-radius:10px;overflow:hidden"><div style="width:200px;height:200px;background:#f00"></div></div>"#,
        200,
        200,
    );
    let g = find(&out.layers, "a.content");
    assert_eq!(g["type"], "group");
    assert_eq!(g["clip"]["kind"], "path");
}

#[test]
fn z_index_orders_stacking_contexts_and_floats_sit_between_blocks_and_inline() {
    let out = paint(
        r#"<div style="position:relative;height:100px">
<div id="hi" style="position:absolute;z-index:2;width:10px;height:10px;background:red"></div>
<div id="lo" style="position:absolute;z-index:-1;width:10px;height:10px;background:blue"></div>
<div id="flow" style="height:20px;background:green"></div>
<div id="fl" style="float:left;width:10px;height:10px;background:orange"></div>
<div id="pos" style="position:absolute;width:10px;height:10px;background:purple"></div></div>"#,
        200,
        200,
    );
    let i = |id: &str| index_of(&out.layers, id);
    assert!(
        i("lo.bg.color") < i("flow.bg.color"),
        "negative z-index under in-flow blocks"
    );
    assert!(i("flow.bg.color") < i("fl.bg.color"), "floats over blocks");
    assert!(
        i("fl.bg.color") < i("pos.bg.color"),
        "positioned over floats"
    );
    assert!(i("pos.bg.color") < i("hi.bg.color"), "z-index 2 on top");
}

#[test]
fn letter_spacing_and_text_shadow_are_in_the_glyph_runs_and_layers() {
    let plain = paint(r#"<div id="t" style="font-size:20px">abcd</div>"#, 200, 50);
    let spaced = paint(
        r#"<div id="t" style="font-size:20px;letter-spacing:5px;text-shadow:2px 3px 4px #00000080">abcd</div>"#,
        200,
        50,
    );
    let last_x = |o: &kinetograph_dom::IslandOutput| {
        let l = find(&o.layers, "t.text");
        l["runs"][0]["glyphs"].as_array().unwrap().last().unwrap()[1]
            .as_f64()
            .unwrap()
    };
    assert!(
        (last_x(&spaced) - last_x(&plain) - 15.0).abs() < 0.01,
        "three gaps of 5px"
    );
    let shadow = find(&spaced.layers, "t.shadow0");
    assert_eq!(shadow["color"], "#00000080");
    assert_eq!(shadow["effects"][0]["radius"], 2);
    assert!(index_of(&spaced.layers, "t.shadow0") < index_of(&spaced.layers, "t.text"));
}

#[test]
fn an_underline_is_a_shape_under_the_text_colour() {
    let out = paint(
        r#"<div id="t" style="font-size:20px;color:#336;text-decoration:underline">abcd</div>"#,
        200,
        50,
    );
    let l = flat(&out.layers)
        .into_iter()
        .find(|l| l["id"].as_str().unwrap().contains("deco"))
        .expect("a decoration layer");
    assert_eq!(l["fill"], "#333366");
    assert!(l["shape"]["height"].as_f64().unwrap() >= 1.0);
}

#[test]
fn an_image_with_object_fit_cover_is_cut_to_its_box() {
    let photo = paintkit::repo_root()
        .join("crates/dom/tests/assets/photo.png")
        .canonicalize()
        .unwrap();
    let out = paint(
        &format!(
            r#"<img id="i" src="file://{}" style="width:100px;height:30px;object-fit:cover;object-position:0 0">"#,
            photo.display()
        ),
        200,
        100,
    );
    let l = find(&out.layers, "i.img");
    assert_eq!(l["type"], "image");
    // 64x48 covering 100x30: scaled by 100/64 to 100 x 75.
    assert_eq!(
        (l["width"].as_f64(), l["height"].as_f64()),
        (Some(100.0), Some(75.0))
    );
    assert!(l["clip"].is_object());
}

#[test]
fn clip_path_shapes_resolve_calc_against_the_reference_box() {
    let out = paint(
        r#"<div id="a" style="width:100px;height:50px;background:#000;clip-path:polygon(calc(50% - 10px) 0,100% 100%,0 calc(100% - 5px))"></div>
<div id="b" style="width:100px;height:50px;background:#000;clip-path:circle(30px at 25% 50%)"></div>"#,
        200,
        200,
    );
    let a = &find(&out.layers, "a")["clip"];
    assert_eq!(a["kind"], "polygon");
    assert_eq!(a["points"][0], serde_json::json!([40, 0]));
    assert_eq!(a["points"][2], serde_json::json!([0, 45]));
    let b = &find(&out.layers, "b")["clip"];
    assert_eq!(
        (b["cx"].as_f64(), b["cy"].as_f64(), b["rx"].as_f64()),
        (Some(25.0), Some(25.0), Some(30.0))
    );
}

#[test]
fn what_cannot_be_drawn_is_reported_not_drawn_wrong() {
    let out = paint(
        r#"<div id="a" style="width:100px;height:50px;background:#000;clip-path:polygon(evenodd,0 0,100% 0,50% 100%)"></div>
<div id="b" style="width:100px;height:50px;background:conic-gradient(in oklch,red,blue)"></div>"#,
        200,
        200,
    );
    let props: Vec<_> = out
        .unsupported
        .iter()
        .filter_map(|u| u.property.clone())
        .collect();
    assert!(
        props.contains(&"clip-path".to_string()),
        "{:?}",
        out.unsupported
    );
    assert!(
        out.unsupported
            .iter()
            .all(|u| u.path.contains(' ') && !u.reason.is_empty())
    );
}

#[test]
fn filters_become_effects_in_order_and_opacity_folds_into_the_group() {
    let out = paint(
        r#"<div id="a" style="width:60px;height:40px;background:#c33;filter:blur(3px) saturate(1.5) drop-shadow(2px 4px 6px #000) opacity(.5)"></div>"#,
        200,
        200,
    );
    let g = find(&out.layers, "a");
    let types: Vec<_> = g["effects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["type"].as_str().unwrap())
        .collect();
    assert_eq!(types, ["blur", "saturate", "dropShadow"]);
    assert_eq!(g["effects"][2]["blur"], 3);
    assert_eq!(g["opacity"], 0.5);
}

#[test]
fn a_border_image_with_a_tiny_tile_stretches_instead_of_allocating() {
    let tile = paintkit::repo_root()
        .join("crates/dom/tests/assets/tile.png")
        .canonicalize()
        .unwrap();
    // A 0.0001px border-image-width makes tiles 0.0001px long along 300px.
    let out = paint(
        &format!(
            r#"<div id="a" style="width:300px;height:100px;border:4px solid;border-image:url(file://{}) 8 / 0.0001px repeat"></div>"#,
            tile.display()
        ),
        400,
        200,
    );
    assert!(
        out.unsupported
            .iter()
            .any(|u| u.property.as_deref() == Some("border-image-repeat")),
        "{:?}",
        out.unsupported
    );
    assert!(flat(&out.layers).len() < 1000);
}

/// Layer counts for a busy page (280 before the layer-merging pass, 200
/// after): 60 cards, each a transformed stacking
/// context holding a box with a background, border and radius and a line of
/// text, and 20 plain bordered boxes.
#[test]
fn a_busy_page_stays_within_a_layer_budget() {
    let mut body = String::new();
    for i in 0..60 {
        body += &format!(
            r#"<div style="position:absolute;left:{}px;top:{}px;width:90px;height:40px;transform:rotate(2deg);opacity:.95"><div style="background:#fc6;border:2px solid #432;border-radius:8px;padding:4px;font-size:12px">card {i}</div></div>"#,
            (i % 10) * 100,
            (i / 10) * 60
        );
    }
    for i in 0..20 {
        body += &format!(
            r#"<div style="position:absolute;left:{}px;top:380px;width:40px;height:20px;background:#9cf;border:1px solid #036"></div>"#,
            i * 45
        );
    }
    let out = paint(&body, 1000, 420);
    let n = paintkit::count_layers(&out.layers);
    println!("busy page: {n} layers");
    assert!(n <= 220, "{n} layers");
}

#[test]
fn list_markers_follow_chromes_sizes() {
    let out = paint(
        r#"<ul style="margin:0;padding-left:60px;font-size:48px"><li id="l">Disc</li></ul>"#,
        200,
        100,
    );
    let m = find(&out.layers, "l.marker");
    assert_eq!(m["shape"]["kind"], "ellipse");
    assert_eq!(m["shape"]["width"], 16, "a third of the ascent");
}
