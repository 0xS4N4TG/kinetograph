//! Shared helpers for the painter's tests: build a styled, laid-out Blitz
//! document from HTML, paint it, render the scene on the GPU, and compare the
//! picture with Chrome's.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use blitz_dom::{BaseDocument, DocumentConfig, FontContext};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use image::{ExtendedColorType, ImageEncoder, RgbaImage, codecs::png};
use kinetograph_core::{Frame, Scene, render_still};
use kinetograph_dom::paint::paint;
use kinetograph_dom::request::{IslandOutput, IslandRequest};
use parley::fontique::{Blob, Collection, CollectionOptions, FontInfoOverride, SourceCache};
use serde_json::{Value, json};

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn font_path() -> PathBuf {
    repo_root().join("assets/fonts/DMSans-Medium.ttf")
}

/// A font context holding only DM Sans, registered as "DM Sans" and as the
/// fallback of every generic family.
pub fn font_ctx() -> FontContext {
    let mut ctx = FontContext {
        collection: Collection::new(CollectionOptions {
            shared: false,
            system_fonts: false,
        }),
        source_cache: SourceCache::default(),
    };
    let data = std::fs::read(font_path()).unwrap();
    let registered = ctx.collection.register_fonts(
        Blob::new(Arc::new(data) as _),
        Some(FontInfoOverride {
            family_name: Some("DM Sans"),
            ..Default::default()
        }),
    );
    let ids: Vec<_> = registered.iter().map(|(id, _)| *id).collect();
    for generic in [
        parley::fontique::GenericFamily::SansSerif,
        parley::fontique::GenericFamily::Serif,
        parley::fontique::GenericFamily::Monospace,
        parley::fontique::GenericFamily::SystemUi,
    ] {
        ctx.collection
            .append_generic_families(generic, ids.iter().copied());
    }
    ctx
}

pub fn document(html: &str, width: u32, height: u32) -> BaseDocument {
    let config = DocumentConfig {
        viewport: Some(Viewport::new(width, height, 1.0, ColorScheme::Light)),
        font_ctx: Some(font_ctx()),
        ..Default::default()
    };
    let mut doc = HtmlDocument::from_html(html, config).into_inner();
    doc.resolve(0.0);
    doc
}

/// A page around `body`: no margin, DM Sans, white.
pub fn page(body: &str) -> String {
    format!(
        "<html><head><style>body{{margin:0;font-family:'DM Sans';font-size:16px}}</style></head><body>{body}</body></html>"
    )
}

pub fn request(w: u32, h: u32) -> IslandRequest {
    serde_json::from_value(json!({
        "root": { "kind": "text", "text": "" },
        "viewport": { "width": w, "height": h },
        "fonts": { "DM Sans:500:normal": font_path().to_string_lossy() },
        "baseDir": repo_root().join("crates/dom/tests/assets").to_string_lossy(),
        "path": "$0",
    }))
    .unwrap()
}

/// Paints an HTML page of `w` x `h`.
pub fn paint_html(html: &str, w: u32, h: u32) -> IslandOutput {
    let doc = document(html, w, h);
    paint(&doc, &request(w, h))
}

/// The scene JSON for an island's output on a white canvas.
pub fn scene_json(out: &IslandOutput, w: u32, h: u32) -> Value {
    let mut scene = json!({
        "width": w, "height": h, "fps": 30, "durationInFrames": 1,
        "background": "#ffffff",
        "layers": out.layers,
    });
    if let Some(camera) = &out.camera {
        scene["camera"] = camera.clone();
    }
    if let Some(m) = out.margin {
        scene["margin"] = json!(m);
    }
    scene
}

pub fn render_output(out: &IslandOutput, w: u32, h: u32) -> Frame {
    let json = scene_json(out, w, h).to_string();
    let scene = Scene::from_json(&json, repo_root().join("crates/dom/tests/assets"))
        .unwrap_or_else(|e| panic!("scene rejected: {e}\n{json}"));
    render_still(scene, 0).unwrap()
}

/// Paints `body` and renders it.
pub fn render_body(body: &str, w: u32, h: u32) -> (IslandOutput, Frame) {
    let out = paint_html(&page(body), w, h);
    let frame = render_output(&out, w, h);
    (out, frame)
}

pub fn save_frame(frame: &Frame, path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let file = std::fs::File::create(path).unwrap();
    png::PngEncoder::new_with_quality(file, png::CompressionType::Best, png::FilterType::Adaptive)
        .write_image(&frame.rgba, frame.width, frame.height, ExtendedColorType::Rgba8)
        .unwrap();
}

pub fn frame_image(frame: &Frame) -> RgbaImage {
    RgbaImage::from_raw(frame.width, frame.height, frame.rgba.clone()).unwrap()
}

fn chrome_binary() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("KINETOGRAPH_CHROME") {
        return Some(PathBuf::from(p));
    }
    let root = PathBuf::from(std::env::var("HOME").ok()?).join(".cache/kinetograph/chrome/chrome");
    for entry in std::fs::read_dir(root).ok()? {
        let dir = entry.ok()?.path();
        let app = dir
            .join("chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
        if app.exists() {
            return Some(app);
        }
        let linux = dir.join("chrome-linux64/chrome");
        if linux.exists() {
            return Some(linux);
        }
    }
    None
}

/// Where the pictures of a test go (`target/paint-tests`).
pub fn out_dir() -> PathBuf {
    let target = std::env::var("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root().join("target"));
    target.join("paint-tests")
}

/// Chrome's rendering of `html` at `w` x `h`, a test oracle only. `None` when
/// there is no Chrome for Testing on this machine.
pub fn chrome(name: &str, body: &str, w: u32, h: u32) -> Option<RgbaImage> {
    let bin = chrome_binary()?;
    let dir = out_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let html_path = dir.join(format!("{name}.html"));
    let png_path = dir.join(format!("{name}-chrome.png"));
    let font = font_path();
    let html = format!(
        "<html><head><style>@font-face{{font-family:'DM Sans';src:url('file://{}')}}body{{margin:0;font-family:'DM Sans';font-size:16px}}</style></head><body>{body}</body></html>",
        font.canonicalize().ok()?.display()
    );
    std::fs::write(&html_path, html).ok()?;
    let _ = std::fs::remove_file(&png_path);
    let _ = std::process::Command::new(bin)
        .arg("--headless=new")
        .arg(format!("--screenshot={}", png_path.display()))
        .arg(format!("--window-size={w},{h}"))
        .arg("--hide-scrollbars")
        .arg("--force-device-scale-factor=1")
        .arg("--default-background-color=ffffffff")
        .arg("--disable-gpu")
        .arg(format!("file://{}", html_path.canonicalize().ok()?.display()))
        .output()
        .ok()?;
    let img = image::open(&png_path).ok()?.to_rgba8();
    // The screenshot may be taller than asked on some builds; crop.
    let img = image::imageops::crop_imm(&img, 0, 0, w.min(img.width()), h.min(img.height())).to_image();
    Some(img)
}

/// How different two pictures are.
#[derive(Debug, Clone, Copy)]
pub struct Diff {
    /// The largest difference of any channel of any pixel, 0..255.
    pub max: u8,
    /// The mean of the per-pixel largest channel difference.
    pub mean: f64,
    /// The share of pixels whose largest channel difference is above 32.
    pub bad_share: f64,
}

pub fn diff(a: &RgbaImage, b: &RgbaImage) -> Diff {
    assert_eq!(a.dimensions(), b.dimensions(), "sizes differ");
    let mut max = 0u8;
    let mut sum = 0u64;
    let mut bad = 0u64;
    let n = u64::from(a.width()) * u64::from(a.height());
    for (pa, pb) in a.pixels().zip(b.pixels()) {
        let d = pa
            .0
            .iter()
            .zip(pb.0.iter())
            .map(|(x, y)| x.abs_diff(*y))
            .max()
            .unwrap();
        max = max.max(d);
        sum += u64::from(d);
        if d > 32 {
            bad += 1;
        }
    }
    Diff {
        max,
        mean: sum as f64 / n as f64,
        bad_share: bad as f64 / n as f64,
    }
}

/// A picture of where `a` and `b` differ, for looking at.
pub fn diff_image(a: &RgbaImage, b: &RgbaImage) -> RgbaImage {
    let mut out = RgbaImage::new(a.width(), a.height());
    for (x, y, p) in out.enumerate_pixels_mut() {
        let (pa, pb) = (a.get_pixel(x, y), b.get_pixel(x, y));
        let d = pa.0.iter().zip(pb.0.iter()).map(|(x, y)| x.abs_diff(*y)).max().unwrap();
        *p = image::Rgba([d.saturating_mul(4), d.saturating_mul(4), d.saturating_mul(4), 255]);
    }
    out
}

/// Renders `body` and compares it with Chrome's rendering of the same page.
/// Writes `<name>-ours.png`, `-chrome.png` and `-diff.png` to
/// `target/paint-tests`. Returns the painted output, our frame and the
/// difference (`None` without Chrome).
pub fn compare(name: &str, body: &str, w: u32, h: u32) -> (IslandOutput, Frame, Option<Diff>) {
    let (out, frame) = render_body(body, w, h);
    let dir = out_dir();
    save_frame(&frame, &dir.join(format!("{name}-ours.png")));
    std::fs::write(
        dir.join(format!("{name}-scene.json")),
        serde_json::to_string_pretty(&scene_json(&out, w, h)).unwrap(),
    )
    .unwrap();
    let diff_result = chrome(name, body, w, h).map(|reference| {
        let ours = frame_image(&frame);
        let d = diff(&ours, &reference);
        diff_image(&ours, &reference)
            .save(dir.join(format!("{name}-diff.png")))
            .unwrap();
        d
    });
    (out, frame, diff_result)
}
