//! `renderCanvas`: a Canvas 2D context's commands drawn on a transparent
//! canvas, for `getImageData` and `toDataURL` (packages/cli/skills/kinetograph/references/SCENE.md, "canvas"). It
//! draws the same layer a frame does, so what is read back is what is drawn.
//! The GPU device, the pipelines and the Skia context are made by the
//! first call and kept for the next ones (`set_scene`); only a canvas of a
//! new size makes its textures again.

use std::path::PathBuf;
use std::sync::Mutex;

use napi::bindgen_prelude::Buffer;
use serde_json::{Value, json};

use crate::error::{Result, from_core, invalid};
use kinetograph_core::canvas::CanvasOp;
use kinetograph_core::picture_read::{PictureReader, ReadRect};
use kinetograph_core::{Renderer, Scene};

/// The renderer every call draws with. A call that fails leaves it as it was
/// (`Renderer::set_scene`), and a frame is the same as a new renderer's.
static RENDERER: Mutex<Option<Renderer>> = Mutex::new(None);

/// `{ width, height, commands, fonts, baseDir, format }` as JSON in; straight
/// alpha RGBA, or a PNG with `format: "png"`, out.
pub fn render_canvas(request_json: &str) -> Result<Buffer> {
    let request: Value =
        serde_json::from_str(request_json).map_err(|e| invalid(format!("renderCanvas: {e}")))?;
    let side = |name: &str| {
        request[name]
            .as_u64()
            .filter(|v| (1..=8192).contains(v))
            .ok_or_else(|| invalid(format!("renderCanvas: {name} must be 1 to 8192")))
    };
    let (width, height) = (side("width")?, side("height")?);
    let scene = json!({
        "width": width, "height": height, "fps": 30, "durationInFrames": 1,
        "background": "#00000000",
        "fonts": request.get("fonts").cloned().unwrap_or_else(|| json!({})),
        "layers": [{
            "id": "canvas", "type": "canvas", "width": width, "height": height,
            "commands": request.get("commands").cloned().unwrap_or_else(|| json!([])),
        }],
    });
    let base_dir = request["baseDir"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_default();
    let scene = Scene::from_json(&scene.to_string(), base_dir).map_err(from_core)?;
    let resolved = scene.resolve(0).map_err(from_core)?;
    let frame = {
        let mut held = RENDERER.lock().unwrap_or_else(|e| e.into_inner());
        match held.as_mut() {
            Some(renderer) => {
                renderer.set_scene(scene).map_err(from_core)?;
                renderer.render_resolved(&resolved).map_err(from_core)?
            }
            None => {
                let mut renderer = Renderer::new(scene).map_err(from_core)?;
                let frame = renderer.render_resolved(&resolved).map_err(from_core)?;
                *held = Some(renderer);
                frame
            }
        }
    };
    match request["format"].as_str() {
        Some("png") => Ok(Buffer::from(frame.encode_png().map_err(from_core)?)),
        Some("rgba") | None => Ok(Buffer::from(frame.rgba)),
        Some(other) => Err(invalid(format!(
            "renderCanvas: format must be \"rgba\" or \"png\", got {other:?}"
        ))),
    }
}

/// The decoders and pictures `read_canvas_picture` keeps from one call to the next.
static PICTURES: Mutex<Option<PictureReader>> = Mutex::new(None);

/// `{ width, height, commands, baseDir, rect: { x, y, width, height } }` as JSON in; the straight-alpha RGBA of
/// `rect` when the commands are one plain `drawImage` of a picture file or a video frame (read on the CPU, from the
/// decoder's cache), `null` when only the renderer can draw them (`render_canvas`).
pub fn read_canvas_picture(request_json: &str) -> Result<Option<Buffer>> {
    let request: Value = serde_json::from_str(request_json)
        .map_err(|e| invalid(format!("readCanvasPicture: {e}")))?;
    let side = |value: &Value, name: &str| {
        value[name]
            .as_u64()
            .filter(|v| (1..=16384).contains(v))
            .map(|v| v as u32)
            .ok_or_else(|| invalid(format!("readCanvasPicture: {name} must be 1 to 16384")))
    };
    let canvas = (side(&request, "width")?, side(&request, "height")?);
    let rect = &request["rect"];
    let rect = ReadRect {
        x: rect["x"]
            .as_i64()
            .ok_or_else(|| invalid("readCanvasPicture: rect.x must be an integer"))?,
        y: rect["y"]
            .as_i64()
            .ok_or_else(|| invalid("readCanvasPicture: rect.y must be an integer"))?,
        width: side(rect, "width")?,
        height: side(rect, "height")?,
    };
    let ops: Vec<CanvasOp> = serde_json::from_value(
        request
            .get("commands")
            .cloned()
            .unwrap_or_else(|| json!([])),
    )
    .map_err(|e| invalid(format!("readCanvasPicture: commands: {e}")))?;
    let base_dir = request["baseDir"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut held = PICTURES.lock().unwrap_or_else(|e| e.into_inner());
    let reader = held.get_or_insert_with(PictureReader::default);
    let pixels = reader.read(&base_dir, &ops, canvas, rect).map_err(|e| {
        crate::error::error(
            crate::error::Code::Render,
            format!("readCanvasPicture: {e}"),
        )
    })?;
    Ok(pixels.map(Buffer::from))
}
