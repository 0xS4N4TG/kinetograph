//! `renderCanvas`: a Canvas 2D context's commands drawn on a transparent
//! canvas, for `getImageData` and `toDataURL` (docs/SCENE.md, "canvas"). It
//! draws the same layer a frame does, so what is read back is what is drawn.
//! The GPU device, the pipelines and the Vello renderers are made by the
//! first call and kept for the next ones (`set_scene`); only a canvas of a
//! new size makes its textures again.

use std::path::PathBuf;
use std::sync::Mutex;

use napi::bindgen_prelude::Buffer;
use serde_json::{Value, json};

use crate::error::{Result, from_core, invalid};
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
