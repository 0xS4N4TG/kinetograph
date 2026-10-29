//! `<canvas>` (packages/cli/skills/kinetograph/references/SCENE.md, "canvas"): the commands a 2D context drew, put by the TS side in `data-kg-canvas`, are
//! one canvas layer in the painted scene. Each case is a file of Canvas 2D calls (`tests/canvas/<name>.js`) and the
//! commands the recorder made of it (`<name>.json`, `tools/canvas-cases.mjs`). The page has both: Chrome runs the
//! calls, which draw the canvas as Chrome does, and the engine paints the commands. The two pictures are compared
//! (the pictures are in `target/paint-tests`), and ours against its committed golden.

mod paintkit;

use paintkit::compare;
use serde_json::Value;

fn case_file(name: &str, extension: &str) -> String {
    let path = paintkit::repo_root()
        .join("crates/dom/tests/canvas")
        .join(format!("{name}.{extension}"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

/// The case's size, from the first line of its script (`// size: 320 240`).
fn size_of(script: &str) -> (u32, u32) {
    let line = script.lines().next().unwrap_or_default();
    let mut numbers = line
        .strip_prefix("// size: ")
        .unwrap_or_else(|| panic!("the first line is the size, got {line:?}"))
        .split(' ')
        .map(|n| n.parse::<u32>().unwrap());
    (numbers.next().unwrap(), numbers.next().unwrap())
}

/// The page body for a case: a canvas with the commands for the engine and the script for Chrome. `style` goes on
/// the canvas.
fn page(name: &str, style: &str) -> (String, (u32, u32)) {
    let script = case_file(name, "js");
    let commands = case_file(name, "json");
    let (w, h) = size_of(&script);
    assert!(
        !commands.contains('\''),
        "{name}.json has a single quote, which would end its attribute"
    );
    let body = format!(
        "<canvas id=\"c\" width=\"{w}\" height=\"{h}\" data-kg-canvas='{}' style=\"display:block;{style}\"></canvas>\n\
         <script>\n\
         const W = {w}, H = {h};\n\
         const canvas2 = (w, h) => {{ const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }};\n\
         (function (ctx, W, H, canvas2) {{\n{script}\n}})(document.getElementById('c').getContext('2d'), W, H, canvas2);\n\
         </script>",
        commands.trim()
    );
    (body, (w, h))
}

/// Runs a case at the page size `w` x `h`, checks it against its golden and Chrome, and returns the mean difference
/// from Chrome (`None` without Chrome).
fn run(name: &str, style: &str, page_size: Option<(u32, u32)>, limit: f64) -> Option<f64> {
    let (body, (w, h)) = page(name, style);
    let (w, h) = page_size.unwrap_or((w, h));
    let (out, frame, diff) = compare(name, &body, w, h);
    assert!(
        out.unsupported.is_empty(),
        "{name}: unsupported {:?}",
        out.unsupported
    );
    paintkit::check_golden(name, &frame);
    println!("{name}: {diff:?}");
    if let Some(d) = diff {
        assert!(d.mean < limit, "{name}: {d:?}");
    }
    diff.map(|d| d.mean)
}

#[test]
fn canvas_paths() {
    run("canvas_paths", "", None, 3.0);
}

#[test]
fn canvas_paint() {
    // Text differs from Chrome's by design, so the limit is higher than for the paths.
    run("canvas_paint", "", None, 6.0);
}

#[test]
fn canvas_effects() {
    // Shadows (soft, hard, under a transform and a global alpha) and the filter functions, against Chrome's.
    run("canvas_effects", "", None, 3.0);
}

#[test]
fn canvas_patterns() {
    // A pattern of a canvas over 16,000 tiles, in a stroke and in text, and repeating along x under a transform.
    run("canvas_patterns", "", None, 6.0);
}

#[test]
fn canvas_scaled() {
    // The bitmap is 100 x 50; CSS makes it 200 x 100 with rounded corners. Chrome stretches the bitmap, which blurs
    // it; the engine draws the commands at the size of the box, so edges are sharp (hence the higher limit).
    run(
        "canvas_scaled",
        "width:200px;height:100px;border-radius:20px",
        Some((200, 100)),
        4.0,
    );
}

fn layers_of(body: &str, w: u32, h: u32) -> Vec<Value> {
    paintkit::paint_html(&paintkit::page(body), w, h).layers
}

#[test]
fn a_canvas_is_one_layer_at_its_content_box_the_size_of_its_bitmap() {
    let commands =
        r##"[{"op":"fill","path":"M0 0H5V5Z","paint":{"type":"color","color":"#ff0000"}}]"##;
    let body = format!(
        "<div style=\"position:absolute;left:10px;top:20px;padding:4px;border:3px solid #000\">\
         <canvas id=\"c\" width=\"80\" height=\"40\" data-kg-canvas='{commands}' style=\"display:block\"></canvas></div>"
    );
    let layers = layers_of(&body, 200, 100);
    let canvas = find(&layers, "c").expect("a canvas layer");
    assert_eq!(canvas["type"], "canvas");
    assert_eq!(
        (canvas["width"].as_f64(), canvas["height"].as_f64()),
        (Some(80.0), Some(40.0))
    );
    // The border and the padding put it at 10 + 3 + 4, 20 + 3 + 4.
    assert_eq!(
        (
            canvas["transform"]["x"].as_f64(),
            canvas["transform"]["y"].as_f64()
        ),
        (Some(17.0), Some(27.0))
    );
    assert_eq!(canvas["commands"][0]["op"], "fill");
    assert!(
        canvas["transform"].get("matrix").is_none(),
        "a bitmap at its own size is not scaled"
    );
}

#[test]
fn commands_with_a_table_of_pictures_become_the_layers_commands_and_sources() {
    let drawn = r##"{"commands":[{"op":"image","source":{"kind":"ref","index":0},"dx":0,"dy":0,"dw":4,"dh":4}],
        "sources":[{"kind":"canvas","width":4,"height":4,"commands":[{"op":"fill","path":"M0 0H4V4H0Z","paint":{"type":"color","color":"#ff0000"}}]}]}"##
        .replace('\n', "");
    let body = format!("<canvas id=\"c\" width=\"8\" height=\"8\" data-kg-canvas='{drawn}' style=\"display:block\"></canvas>");
    let layers = layers_of(&body, 20, 20);
    let canvas = find(&layers, "c").expect("a canvas layer");
    assert_eq!(canvas["commands"][0]["source"]["kind"], "ref");
    assert_eq!(canvas["sources"][0]["kind"], "canvas");
}

#[test]
fn css_scales_the_bitmap_with_a_flat_matrix() {
    let commands =
        r##"[{"op":"fill","path":"M0 0H5V5Z","paint":{"type":"color","color":"#ff0000"}}]"##;
    let body = format!(
        "<canvas id=\"c\" width=\"50\" height=\"20\" data-kg-canvas='{commands}' style=\"display:block;width:100px;height:60px\"></canvas>"
    );
    let layers = layers_of(&body, 200, 100);
    let canvas = find(&layers, "c").expect("a canvas layer");
    let matrix = canvas["transform"]["matrix"].as_array().expect("a matrix");
    assert_eq!(
        (matrix[0].as_f64(), matrix[5].as_f64()),
        (Some(2.0), Some(3.0))
    );
}

#[test]
fn a_canvas_nothing_was_drawn_on_makes_no_layer_and_is_not_reported() {
    let out = paintkit::paint_html(
        &paintkit::page(
            "<canvas id=\"c\" width=\"50\" height=\"20\" style=\"display:block\"></canvas>",
        ),
        200,
        100,
    );
    assert!(find(&out.layers, "c").is_none());
    assert!(out.unsupported.is_empty(), "{:?}", out.unsupported);
}

#[test]
fn a_canvas_without_a_size_is_300_by_150() {
    let commands =
        r##"[{"op":"fill","path":"M0 0H5V5Z","paint":{"type":"color","color":"#ff0000"}}]"##;
    let body =
        format!("<canvas id=\"c\" data-kg-canvas='{commands}' style=\"display:block\"></canvas>");
    let layers = layers_of(&body, 400, 200);
    let canvas = find(&layers, "c").expect("a canvas layer");
    assert_eq!(
        (canvas["width"].as_f64(), canvas["height"].as_f64()),
        (Some(300.0), Some(150.0))
    );
}

#[test]
fn a_url_filter_on_a_canvas_is_the_pages_filter_or_is_reported() {
    // One on a command, the same on another, one inside a canvas the first draws; the page has only #rough.
    let commands = r##"[
        {"op":"fill","path":"M0 0H5V5Z","paint":{"type":"color","color":"#ff0000"},"filter":[{"type":"url","url":"url(#rough)"}]},
        {"op":"fill","path":"M0 0H5V5Z","paint":{"type":"color","color":"#ff0000"},"filter":[{"type":"url","url":"url(#rough)"}]},
        {"op":"image","source":{"kind":"canvas","width":5,"height":5,"commands":[
          {"op":"fill","path":"M0 0H5V5Z","paint":{"type":"color","color":"#ff0000"},"filter":[{"type":"url","url":"url(#inner)"}]}]},
         "dx":0,"dy":0,"dw":5,"dh":5}]"##
        .replace('\n', "");
    let body = format!(
        "<svg width=\"0\" height=\"0\" style=\"position:absolute\"><filter id=\"rough\"><feGaussianBlur stdDeviation=\"2\"/></filter></svg>\
         <canvas id=\"c\" width=\"50\" height=\"20\" data-kg-canvas='{commands}' style=\"display:block\"></canvas>"
    );
    let out = paintkit::paint_html(&paintkit::page(&body), 200, 100);
    let urls: Vec<_> = out
        .unsupported
        .iter()
        .map(|u| (u.property.as_deref(), u.value.as_deref()))
        .collect();
    assert_eq!(urls, [(Some("filter"), Some("url(#inner)"))]);
    let canvas = find(&out.layers, "c").expect("a canvas layer");
    let filter = &canvas["commands"][0]["filter"][0];
    assert_eq!(filter["type"], "graph");
    assert_eq!(
        filter["graph"]["primitives"][0]["primitive"],
        "feGaussianBlur"
    );
    assert_eq!(
        canvas["commands"][2]["source"]["commands"][0]["filter"][0]["type"],
        "url"
    );
}

#[test]
fn canvas_url_filter() {
    // `ctx.filter = 'url(#id)'` with SVG filters of the page: a blur, a flood in objectBoundingBox units (whose box
    // is the canvas), and a colour matrix after a blur() in one list, against Chrome's.
    let (body, (w, h)) = page("canvas_url_filter", "");
    let svg = "<svg width=\"0\" height=\"0\" style=\"position:absolute\">\
        <filter id=\"soft\"><feGaussianBlur stdDeviation=\"3\"/></filter>\
        <filter id=\"tint\" x=\"0.1\" y=\"0.2\" width=\"0.5\" height=\"0.6\"><feFlood flood-color=\"#2a9d8f\" flood-opacity=\"0.6\"/>\
          <feComposite in2=\"SourceGraphic\" operator=\"over\"/></filter>\
        <filter id=\"swap\" color-interpolation-filters=\"sRGB\"><feColorMatrix type=\"matrix\" \
          values=\"0 0 1 0 0  0 1 0 0 0  1 0 0 0 0  0 0 0 1 0\"/></filter></svg>";
    let body = format!("{svg}{body}");
    let (out, frame, diff) = paintkit::compare("canvas_url_filter", &body, w, h);
    assert!(out.unsupported.is_empty(), "{:?}", out.unsupported);
    paintkit::check_golden("canvas_url_filter", &frame);
    println!("canvas_url_filter: {diff:?}");
    if let Some(d) = diff {
        assert!(d.mean < 3.0, "{d:?}");
    }
}

/// The layer called `id`, anywhere in `layers`.
fn find<'a>(layers: &'a [Value], id: &str) -> Option<&'a Value> {
    for layer in layers {
        if layer["id"] == id
            || layer["id"]
                .as_str()
                .is_some_and(|s| s.starts_with(&format!("{id}.")))
        {
            return Some(layer);
        }
        if let Some(found) = layer["children"].as_array().and_then(|c| find(c, id)) {
            return Some(found);
        }
    }
    None
}

#[test]
fn the_committed_commands_are_what_the_recorder_makes_of_each_case() {
    // The files are made by `node crates/dom/tools/canvas-cases.mjs`; the recorder is TypeScript, so this only checks
    // that every case has its commands and that they parse as the scene format does.
    for name in [
        "canvas_paths",
        "canvas_paint",
        "canvas_effects",
        "canvas_scaled",
    ] {
        let commands: Value = serde_json::from_str(&case_file(name, "json")).unwrap();
        let scene = serde_json::json!({
            "width": 10, "height": 10, "fps": 30, "durationInFrames": 1,
            "layers": [{ "id": "c", "type": "canvas", "width": 10, "height": 10, "commands": commands }],
        });
        kinetograph_core::Scene::from_json(&scene.to_string(), Default::default())
            .unwrap_or_else(|e| panic!("{name}: {e}"));
    }
}
