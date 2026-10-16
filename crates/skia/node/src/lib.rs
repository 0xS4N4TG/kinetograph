//! `@kinetograph/skia`: the optional addon that draws React Native Skia scene
//! trees with Skia's CPU rasteriser (docs/AUTHORING.md §7.7). It is separate from
//! `@kinetograph/native` so that nothing else links Skia. Every call is
//! synchronous and takes and returns JSON strings.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};

use kinetograph_skia::{Assets, Error as SkiaError};
use napi::{Error, Result};
use napi_derive::napi;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use skia_safe::{AlphaType, ColorType, Data, ImageInfo, images, png_encoder};

thread_local! {
    /// Fonts and pictures read for one frame are kept for the next.
    static ASSETS: RefCell<Assets> = RefCell::new(Assets::default());
}

fn failed(error: impl std::fmt::Display) -> Error {
    Error::from_reason(error.to_string())
}

fn parse(json: &str, call: &str) -> Result<Value> {
    serde_json::from_str(json).map_err(|e| failed(format!("{call}: {e}")))
}

/// `{ width, height, nodes, baseDir, outDir }` in; the nodes drawn into a PNG file under `outDir` named by its pixels'
/// hash, and `{ path, width, height, unsupported }` out. A frame is a pure function of the tree and the files it names.
#[napi]
pub fn render_skia(request_json: String) -> Result<String> {
    let request = parse(&request_json, "renderSkia")?;
    let side = |key: &str| {
        request[key]
            .as_u64()
            .filter(|n| (1..=16384).contains(n))
            .map(|n| n as u32)
            .ok_or_else(|| {
                failed(format!(
                    "renderSkia: {key} must be a whole number of pixels"
                ))
            })
    };
    let (width, height) = (side("width")?, side("height")?);
    let nodes = request["nodes"]
        .as_array()
        .ok_or_else(|| failed("renderSkia: nodes must be a list"))?;
    let base_dir = PathBuf::from(request["baseDir"].as_str().unwrap_or_default());
    let out_dir = request["outDir"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| failed("renderSkia: outDir is required"))?;

    let output = ASSETS
        .with(|assets| {
            kinetograph_skia::render(width, height, nodes, &mut assets.borrow_mut(), base_dir)
        })
        .map_err(failed)?;
    let path = write_png(&output.rgba, width, height, &out_dir)?;
    let unsupported: Vec<Value> = output
        .unsupported
        .iter()
        .map(|u| json!({ "element": u.element, "property": u.property, "reason": u.reason }))
        .collect();
    Ok(
        json!({ "path": path, "width": width, "height": height, "unsupported": unsupported })
            .to_string(),
    )
}

/// The picture as a PNG named by the hash of its pixels, so equal frames share a file and a file never changes.
/// Written with the cheapest compression: it is read back once, by the compositor.
fn write_png(rgba: &[u8], width: u32, height: u32, dir: &Path) -> Result<String> {
    let mut hash = Sha256::new();
    hash.update(width.to_le_bytes());
    hash.update(height.to_le_bytes());
    hash.update(rgba);
    let name: String = hash
        .finalize()
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect();
    let path = dir.join(format!("{name}.png"));
    if !path.exists() {
        let info = ImageInfo::new(
            (width as i32, height as i32),
            ColorType::RGBA8888,
            AlphaType::Unpremul,
            None,
        );
        let image = images::raster_from_data(&info, Data::new_copy(rgba), width as usize * 4)
            .ok_or_else(|| failed("renderSkia: the picture could not be wrapped"))?;
        let mut options = png_encoder::Options::default();
        options.z_lib_level = 1;
        options.filter_flags = png_encoder::FilterFlag::NONE;
        let png = png_encoder::encode_image(None, &image, &options)
            .ok_or_else(|| failed("renderSkia: the picture could not be encoded"))?;
        fs::create_dir_all(dir).map_err(|e| failed(format!("{}: {e}", dir.display())))?;
        // Written under another name and renamed, so that a render running in parallel never reads half a file.
        let partial = dir.join(format!("{name}.{}.part", std::process::id()));
        fs::write(&partial, png.as_bytes())
            .map_err(|e| failed(format!("{}: {e}", partial.display())))?;
        fs::rename(&partial, &path).map_err(|e| failed(format!("{}: {e}", path.display())))?;
        prune(dir);
    }
    Ok(path.to_string_lossy().into_owned())
}

/// The pictures kept: a frame's file is read once, when its scene loads, so only the newest are worth keeping. Past
/// `KEEP_MAX` files the oldest are removed down to `KEEP_MIN`; the one just written is the newest and stays.
const KEEP_MAX: usize = 600;
const KEEP_MIN: usize = 400;

fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let files: Vec<_> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "png"))
        .collect();
    if files.len() <= KEEP_MAX {
        return;
    }
    let mut dated: Vec<_> = files
        .iter()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    dated.sort();
    for (_, path) in dated.iter().take(dated.len().saturating_sub(KEEP_MIN)) {
        let _ = fs::remove_file(path);
    }
}

/// What `Skia.RuntimeEffect.Make` tells a project about SkSL: `{ uniforms: [[name, floats]], children: [name] }`, or an
/// error with Skia's message.
#[napi]
pub fn compile_effect(sksl: String) -> Result<String> {
    let info = kinetograph_skia::compile_effect(&sksl).map_err(failed)?;
    Ok(json!({ "uniforms": info.uniforms, "children": info.children }).to_string())
}

/// `{ font: { file, size }, text, baseDir }` in; `{ width, bounds, metrics, glyphIds, glyphWidths }` out.
#[napi]
pub fn measure_text(request_json: String) -> Result<String> {
    let request = parse(&request_json, "measureText")?;
    let base = PathBuf::from(request["baseDir"].as_str().unwrap_or_default());
    let text = request["text"].as_str().unwrap_or_default();
    let measured = ASSETS
        .with(|assets| {
            kinetograph_skia::measure_text(&mut assets.borrow_mut(), &base, &request["font"], text)
        })
        .map_err(|e: SkiaError| failed(e))?;
    Ok(json!({
        "width": measured.width,
        "bounds": measured.bounds,
        "metrics": { "ascent": measured.metrics.ascent, "descent": measured.metrics.descent, "leading": measured.metrics.leading },
        "glyphIds": measured.glyph_ids,
        "glyphWidths": measured.glyph_widths,
    })
    .to_string())
}

/// `{ call, path, ... }` in (see `paths.rs`); `{ d, fillType, bounds }` out.
#[napi]
pub fn path_call(request_json: String) -> Result<String> {
    let request = parse(&request_json, "pathCall")?;
    Ok(kinetograph_skia::path_call(&request)
        .map_err(failed)?
        .to_string())
}

/// `{ src, baseDir }` in; the picture's `{ width, height }` out (what `useImage` reports).
#[napi]
pub fn image_size(request_json: String) -> Result<String> {
    let request = parse(&request_json, "imageSize")?;
    let base = PathBuf::from(request["baseDir"].as_str().unwrap_or_default());
    let src = request["src"]
        .as_str()
        .ok_or_else(|| failed("imageSize: src is required"))?;
    let image = ASSETS
        .with(|assets| assets.borrow_mut().image(&base.join(src)))
        .map_err(failed)?;
    Ok(json!({ "width": image.width(), "height": image.height() }).to_string())
}
