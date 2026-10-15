//! Images: `<img src>`, `background-image: url()` and `mask-image: url()` are
//! read from local files at layout time, so intrinsic sizes are known.

mod common;

use std::path::{Path, PathBuf};

use blitz_dom::node::{ImageData, Status};
use common::*;
use serde_json::{Value, json};

/// A fresh directory under the system temp dir, removed on drop.
struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Dir {
        let path = std::env::temp_dir().join(format!("kg-dom-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Dir(path)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn png(&self, name: &str, width: u32, height: u32) -> PathBuf {
        let file = self.0.join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        image::RgbaImage::from_pixel(width, height, image::Rgba([200, 30, 30, 255]))
            .save(&file)
            .unwrap();
        file
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn with_dirs(mut req: Value, base: &Dir, public: Option<&Dir>) -> Value {
    req["baseDir"] = json!(base.path());
    if let Some(public) = public {
        req["publicDir"] = json!(public.path());
    }
    req
}

fn img(path: &str, src: &str, style: &str) -> Value {
    el_attrs("img", path, json!({ "src": src }), style, vec![])
}

#[test]
fn img_takes_its_intrinsic_size() {
    let dir = Dir::new("intrinsic");
    dir.png("a.png", 64, 32);
    let root = el(
        "div",
        "$0",
        "",
        vec![img("$0.0", "a.png", "display: block")],
    );
    let island = resolve(&with_dirs(request(root), &dir, None));
    assert_eq!(bounds(&island, "$0.0"), (0.0, 0.0, 64.0, 32.0));
    assert!(island.missing.is_empty(), "{:?}", island.missing);
}

#[test]
fn img_keeps_its_aspect_ratio_for_one_given_side() {
    let dir = Dir::new("ratio");
    dir.png("a.png", 64, 32);
    let root = el(
        "div",
        "$0",
        "",
        vec![
            img("$0.0", "a.png", "display: block; width: 200px"),
            img("$0.1", "a.png", "display: block; height: 10px"),
            img(
                "$0.2",
                "a.png",
                "display: block; width: 50%; aspect-ratio: 1",
            ),
        ],
    );
    let island = resolve(&with_dirs(request(root), &dir, None));
    assert_eq!(bounds(&island, "$0.0"), (0.0, 0.0, 200.0, 100.0));
    assert_eq!(bounds(&island, "$0.1"), (0.0, 100.0, 20.0, 10.0));
    assert_eq!(bounds(&island, "$0.2"), (0.0, 110.0, 500.0, 500.0));
}

#[test]
fn paths_resolve_against_base_dir_then_public_dir() {
    let base = Dir::new("base");
    let public = Dir::new("public");
    base.png("assets/inbase.png", 10, 20);
    public.png("logo.png", 30, 40);
    public.png("assets/inbase.png", 99, 99); // shadowed by baseDir's
    let root = el(
        "div",
        "$0",
        "",
        vec![
            img("$0.0", "assets/inbase.png", "display: block"),
            img("$0.1", "logo.png", "display: block"),
            img("$0.2", "/logo.png", "display: block"),
            img("$0.3", "./logo.png", "display: block"),
        ],
    );
    let island = resolve(&with_dirs(request(root), &base, Some(&public)));
    let size = |p| {
        let (_, _, w, h) = bounds(&island, p);
        (w, h)
    };
    assert_eq!(size("$0.0"), (10.0, 20.0));
    assert_eq!(size("$0.1"), (30.0, 40.0));
    assert_eq!(size("$0.2"), (30.0, 40.0));
    assert_eq!(size("$0.3"), (30.0, 40.0));
    assert!(island.missing.is_empty(), "{:?}", island.missing);
}

#[test]
fn absolute_paths_and_data_urls() {
    let dir = Dir::new("abs");
    let file = dir.png("elsewhere/x.png", 7, 9);
    // 1x1 transparent PNG.
    let data = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    let root = el(
        "div",
        "$0",
        "",
        vec![
            img("$0.0", file.to_str().unwrap(), "display: block"),
            img("$0.1", data, "display: block"),
        ],
    );
    let other = Dir::new("abs-base");
    let island = resolve(&with_dirs(request(root), &other, None));
    assert_eq!(bounds(&island, "$0.0"), (0.0, 0.0, 7.0, 9.0));
    assert_eq!(bounds(&island, "$0.1"), (0.0, 9.0, 1.0, 1.0));
}

#[test]
fn background_and_mask_images_load() {
    let dir = Dir::new("bg");
    dir.png("tile.png", 16, 8);
    let root = el(
        "div",
        "$0",
        "width: 100px; height: 50px; background-image: url(tile.png), url('tile.png'); \
         -webkit-mask-image: url(tile.png); mask-image: url(tile.png)",
        vec![],
    );
    let island = resolve(&with_dirs(request(root), &dir, None));
    let node = island.doc.get_node(island.node("$0").unwrap()).unwrap();
    let element = node.element_data().unwrap();
    assert_eq!(element.background_images.len(), 2);
    for image in element.background_images.iter().chain(&element.mask_images) {
        let image = image.as_ref().expect("an image slot");
        assert_eq!(image.status, Status::Ok);
        match &image.image {
            ImageData::Raster(r) => assert_eq!((r.width, r.height), (16, 8)),
            _ => panic!("not a raster image"),
        }
    }
    assert_eq!(element.mask_images.len(), 1);
    assert!(island.missing.is_empty());
}

#[test]
fn background_image_in_a_stylesheet_loads() {
    let dir = Dir::new("sheet-bg");
    dir.png("img/tile.png", 4, 4);
    let mut req = request(el_attrs(
        "div",
        "$0",
        json!({ "class": "t" }),
        "width: 10px; height: 10px",
        vec![],
    ));
    req["stylesheets"] = json!([".t { background: url(img/tile.png) repeat }"]);
    let island = resolve(&with_dirs(req, &dir, None));
    let node = island.doc.get_node(island.node("$0").unwrap()).unwrap();
    let image = node.element_data().unwrap().background_images[0]
        .as_ref()
        .unwrap();
    assert_eq!(image.status, Status::Ok);
}

#[test]
fn missing_files_and_network_urls_are_reported_not_fetched() {
    let dir = Dir::new("missing");
    let root = el(
        "div",
        "$0",
        "",
        vec![
            img(
                "$0.0",
                "nope.png",
                "display: block; width: 10px; height: 10px",
            ),
            img(
                "$0.1",
                "https://example.com/a.png",
                "display: block; width: 10px; height: 10px",
            ),
        ],
    );
    let island = resolve(&with_dirs(request(root), &dir, None));
    assert_eq!(island.missing.len(), 2, "{:?}", island.missing);
    assert!(island.missing[0].contains("nope.png"));
    assert!(island.missing[1].contains("not available"));
    // Layout still works from the given size.
    assert_eq!(bounds(&island, "$0.0"), (0.0, 0.0, 10.0, 10.0));
}

#[test]
fn svg_files_have_an_intrinsic_size() {
    let dir = Dir::new("svgfile");
    std::fs::write(
        dir.path().join("i.svg"),
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="12"><rect width="30" height="12"/></svg>"#,
    )
    .unwrap();
    let root = el(
        "div",
        "$0",
        "",
        vec![img("$0.0", "i.svg", "display: block")],
    );
    let island = resolve(&with_dirs(request(root), &dir, None));
    assert_eq!(bounds(&island, "$0.0"), (0.0, 0.0, 30.0, 12.0));
}
