//! The shadow check of edited DOM islands (`KINETOGRAPH_DOM_VERIFY=1`): each render and readback that used a kept
//! document is done again from scratch, and the two must agree, layer for layer and box for box. On a difference both
//! are written to a directory (`KINETOGRAPH_DOM_VERIFY_DIR`, else `kinetograph-dom-verify` in the system temp
//! directory) and the render fails. Slow; for testing the incremental paths only.

use std::sync::OnceLock;

use kinetograph_dom::document::{IslandCache, IslandDocument};
use kinetograph_dom::readback;
use kinetograph_dom::request::{IslandOutput, IslandRequest};
use serde_json::{Value, json};

use crate::error::Code;

type Failure = (Code, String);

pub fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("KINETOGRAPH_DOM_VERIFY").is_ok_and(|v| v == "1"))
}

/// The island of `request` resolved and painted from scratch.
fn fresh(request: &IslandRequest) -> Result<(IslandOutput, Value, Vec<String>), Failure> {
    let mut resolved = IslandCache::default()
        .resolve(request, None)
        .map_err(|e| (Code::Render, e.to_string()))?;
    let output = resolved.paint(request);
    let boxes = json!(readback::layout_boxes(&resolved.island));
    Ok((output, boxes, resolved.island.missing.clone()))
}

/// Checks a render: `output` (before the missing files are added to it) painted from `island`.
pub fn check_render(
    json: &str,
    request: &IslandRequest,
    island: &IslandDocument,
    output: &IslandOutput,
) -> Result<(), Failure> {
    let (want, want_boxes, want_missing) = fresh(request)?;
    let got = json!({ "output": output, "boxes": readback::layout_boxes(island), "missing": island.missing });
    let want = json!({ "output": want, "boxes": want_boxes, "missing": want_missing });
    compare(json, request, "render", got, want)
}

/// Checks a readback's document: its boxes.
pub fn check_readback(
    json: &str,
    request: &IslandRequest,
    island: &IslandDocument,
) -> Result<(), Failure> {
    let (_, want_boxes, _) = fresh(request)?;
    let got = json!({ "boxes": readback::layout_boxes(island) });
    compare(
        json,
        request,
        "readback",
        got,
        json!({ "boxes": want_boxes }),
    )
}

fn compare(
    json: &str,
    request: &IslandRequest,
    what: &str,
    got: Value,
    want: Value,
) -> Result<(), Failure> {
    if got == want {
        return Ok(());
    }
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let base = std::env::var_os("KINETOGRAPH_DOM_VERIFY_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("kinetograph-dom-verify"));
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = base.join(format!("{}-{n}-{what}", std::process::id()));
    let write = |name: &str, text: &str| std::fs::write(dir.join(name), text);
    let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap_or_default();
    let written = std::fs::create_dir_all(&dir)
        .and_then(|_| write("request.json", json))
        .and_then(|_| write("incremental.json", &pretty(&got)))
        .and_then(|_| write("fresh.json", &pretty(&want)));
    let place = match written {
        Ok(()) => format!("written to {}", dir.display()),
        Err(e) => format!("could not be written to {}: {e}", dir.display()),
    };
    Err((
        Code::Render,
        format!(
            "KINETOGRAPH_DOM_VERIFY: the edited document of island {:?} at time {} ({what}) differs from a fresh one; \
             both {place}",
            request.path, request.time
        ),
    ))
}
