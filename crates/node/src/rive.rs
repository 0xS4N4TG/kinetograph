//! `riveFrame`: a Rive file (`.riv`) played to a time, as the commands of a
//! canvas layer (docs/AUTHORING.md §7.6). CPU only: the Rive runtime animates
//! the artboard, and the canvas the commands go into is drawn with Vello like
//! any other.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use kinetograph_rive::{Alignment, Fit, Frame, Riv, Select};
use serde_json::Value;

use crate::error::{Code, Result, error, invalid};

/// A file that has been read, and when it was last changed, so a file that is
/// replaced is read again. Files are read once however many frames play them.
struct Cached {
    modified: Option<SystemTime>,
    riv: Arc<Riv>,
}

static FILES: Mutex<Option<HashMap<PathBuf, Cached>>> = Mutex::new(None);

/// The Rive runtime is one C++ library with its own global state (its text
/// shaping), so frames are played one at a time.
static PLAY: Mutex<()> = Mutex::new(());

/// `{ src, baseDir, artboard, animation, stateMachine, time, width, height,
/// fit, alignment }` as JSON in, the canvas commands as a JSON array out.
pub fn rive_frame(request_json: &str) -> Result<String> {
    let request: Value =
        serde_json::from_str(request_json).map_err(|e| invalid(format!("riveFrame: {e}")))?;
    let src = request["src"]
        .as_str()
        .ok_or_else(|| invalid("riveFrame: src must be the path of a .riv file"))?;
    let base = request["baseDir"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_default();
    let path = base.join(src);
    let riv = open(&path)?;

    let side = |name: &str| {
        request[name]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .ok_or_else(|| invalid(format!("riveFrame: {name} must be a number of pixels")))
    };
    let frame = Frame {
        artboard: select(&request["artboard"], "artboard")?,
        animation: select(&request["animation"], "animation")?,
        state_machine: select(&request["stateMachine"], "stateMachine")?,
        time: request["time"].as_f64().unwrap_or(0.0),
        width: side("width")? as f32,
        height: side("height")? as f32,
        fit: fit(request["fit"].as_str())?,
        alignment: alignment(request["alignment"].as_str())?,
    };
    let _playing = PLAY.lock().unwrap_or_else(|e| e.into_inner());
    let commands = riv
        .frame(&frame, &pictures_dir())
        .map_err(|e| error(Code::Render, format!("{}: {e}", path.display())))?;
    Ok(Value::Array(commands).to_string())
}

fn open(path: &PathBuf) -> Result<Arc<Riv>> {
    let io = |e: std::io::Error| error(Code::Io, format!("{}: {e}", path.display()));
    let modified = fs::metadata(path).map_err(io)?.modified().ok();
    let mut files = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let files = files.get_or_insert_with(HashMap::new);
    if let Some(cached) = files.get(path).filter(|c| c.modified == modified) {
        return Ok(cached.riv.clone());
    }
    let bytes = fs::read(path).map_err(io)?;
    let riv = Arc::new(
        Riv::open(&bytes).map_err(|e| error(Code::Render, format!("{}: {e}", path.display())))?,
    );
    files.insert(
        path.clone(),
        Cached {
            modified,
            riv: riv.clone(),
        },
    );
    Ok(riv)
}

/// Where the pictures embedded in a file are written for the canvas to read.
fn pictures_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    home.join(".cache").join("kinetograph").join("rive")
}

fn select(value: &Value, name: &str) -> Result<Option<Select>> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(Select::Name(text.clone()))),
        other => match other.as_u64() {
            Some(index) => Ok(Some(Select::Index(index as usize))),
            None => Err(invalid(format!(
                "riveFrame: {name} must be a name or a whole number"
            ))),
        },
    }
}

fn fit(name: Option<&str>) -> Result<Fit> {
    Ok(match name {
        None | Some("contain") => Fit::Contain,
        Some("cover") => Fit::Cover,
        Some("fill") => Fit::Fill,
        Some("fit-width") => Fit::FitWidth,
        Some("fit-height") => Fit::FitHeight,
        Some("none") => Fit::None,
        Some("scale-down") => Fit::ScaleDown,
        Some(other) => return Err(invalid(format!("riveFrame: unknown fit {other:?}"))),
    })
}

fn alignment(name: Option<&str>) -> Result<Alignment> {
    let (x, y) = match name {
        None | Some("center") => (0.0, 0.0),
        Some("top-left") => (-1.0, -1.0),
        Some("top-center") => (0.0, -1.0),
        Some("top-right") => (1.0, -1.0),
        Some("center-left") => (-1.0, 0.0),
        Some("center-right") => (1.0, 0.0),
        Some("bottom-left") => (-1.0, 1.0),
        Some("bottom-center") => (0.0, 1.0),
        Some("bottom-right") => (1.0, 1.0),
        Some(other) => return Err(invalid(format!("riveFrame: unknown alignment {other:?}"))),
    };
    Ok(Alignment { x, y })
}
