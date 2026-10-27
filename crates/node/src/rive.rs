//! `riveFrame`: a Rive file (`.riv`) played to a time, as the commands of a
//! canvas layer (packages/cli/skills/kinetograph/references/AUTHORING.md §7.6). CPU only: the Rive runtime animates
//! the artboard, and the canvas the commands go into is drawn with Skia like
//! any other. `riveInfo` describes a file: its artboards, animations, state
//! machines with their inputs, and its assets.
//!
//! An asset outside the file (a referenced picture or font) is the bytes the
//! request gives for it (`assets`, by its file name, base64), else the file of
//! that name beside the `.riv` (`name-id.ext`, as the Rive editor exports it,
//! or the asset's own name).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use kinetograph_rive::{Alignment, AssetRequest, Fit, Frame, InputChange, InputValue, Riv, Select};
use serde_json::Value;

use crate::error::{Code, Result, error, invalid};

/// A file that has been read, and when it was last changed, so a file that is
/// replaced is read again. Files are read once however many frames play them.
struct Cached {
    modified: Option<SystemTime>,
    /// The assets the request gave, by name and a hash of their bytes.
    given: Vec<(String, u64)>,
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
    let riv = open(&path, &given_assets(&request["assets"])?)?;

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
        inputs: inputs(&request["inputs"])?,
    };
    let _playing = PLAY.lock().unwrap_or_else(|e| e.into_inner());
    let commands = riv
        .frame(&frame, &pictures_dir())
        .map_err(|e| error(Code::Render, format!("{}: {e}", path.display())))?;
    Ok(Value::Array(commands).to_string())
}

/// `{ src, baseDir, assets }` in; `{ artboards, assets }` out (`Riv::info`): what the file holds, and for each asset
/// whether it is in the file, given, or missing.
pub fn rive_info(request_json: &str) -> Result<String> {
    let request: Value =
        serde_json::from_str(request_json).map_err(|e| invalid(format!("riveInfo: {e}")))?;
    let src = request["src"]
        .as_str()
        .ok_or_else(|| invalid("riveInfo: src must be the path of a .riv file"))?;
    let base = request["baseDir"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_default();
    let riv = open(&base.join(src), &given_assets(&request["assets"])?)?;
    Ok(riv.info().to_string())
}

/// The bytes a request gives for assets: `{ "name-id.png": "<base64>" }`.
fn given_assets(value: &Value) -> Result<Vec<(String, Vec<u8>)>> {
    let Some(map) = value.as_object() else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (name, data) in map {
        let text = data
            .as_str()
            .ok_or_else(|| invalid(format!("riveFrame: the asset {name:?} must be base64")))?;
        let bytes = base64(text)
            .ok_or_else(|| invalid(format!("riveFrame: the asset {name:?} is not base64")))?;
        out.push((name.clone(), bytes));
    }
    out.sort();
    Ok(out)
}

/// Standard base64, with or without padding.
fn base64(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in text
        .bytes()
        .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
    {
        acc = (acc << 6) | u32::from(value(c)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

fn hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

fn open(path: &PathBuf, given: &[(String, Vec<u8>)]) -> Result<Arc<Riv>> {
    let io = |e: std::io::Error| error(Code::Io, format!("{}: {e}", path.display()));
    let modified = fs::metadata(path).map_err(io)?.modified().ok();
    let key: Vec<(String, u64)> = given.iter().map(|(n, b)| (n.clone(), hash(b))).collect();
    let mut files = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let files = files.get_or_insert_with(HashMap::new);
    if let Some(cached) = files
        .get(path)
        .filter(|c| c.modified == modified && c.given == key)
    {
        return Ok(cached.riv.clone());
    }
    let bytes = fs::read(path).map_err(io)?;
    let folder = path.parent().map(PathBuf::from).unwrap_or_default();
    let mut load = |request: &AssetRequest<'_>| -> Option<Vec<u8>> {
        for name in [request.unique_filename, request.name] {
            if let Some((_, bytes)) = given.iter().find(|(n, _)| n == name) {
                return Some(bytes.clone());
            }
        }
        if !request.in_band.is_empty() {
            return None;
        }
        // Beside the file, as the Rive editor exports referenced assets.
        let own = if request.name.contains('.') {
            request.name.to_string()
        } else {
            format!("{}.{}", request.name, request.extension)
        };
        [request.unique_filename.to_string(), own]
            .iter()
            .filter(|n| !n.is_empty() && !n.contains('/') && !n.contains('\\'))
            .find_map(|n| fs::read(folder.join(n)).ok())
    };
    let riv = Arc::new(
        Riv::open_with(&bytes, &mut load)
            .map_err(|e| error(Code::Render, format!("{}: {e}", path.display())))?,
    );
    files.insert(
        path.clone(),
        Cached {
            modified,
            given: key,
            riv: riv.clone(),
        },
    );
    Ok(riv)
}

/// `[{ time, name, value }]`: a value is true or false (a boolean input), a number, or `"fire"` (a trigger).
fn inputs(value: &Value) -> Result<Vec<InputChange>> {
    let Some(list) = value.as_array() else {
        return Ok(Vec::new());
    };
    let mut out = Vec::with_capacity(list.len());
    for item in list {
        let name = item["name"]
            .as_str()
            .ok_or_else(|| invalid("riveFrame: an input needs a name"))?;
        let time = item["time"].as_f64().unwrap_or(0.0);
        let value = match &item["value"] {
            Value::Bool(on) => InputValue::Bool(*on),
            Value::String(s) if s == "fire" => InputValue::Fire,
            other => InputValue::Number(other.as_f64().ok_or_else(|| {
                invalid(format!(
                    "riveFrame: the input {name:?} must be true, false, a number or \"fire\""
                ))
            })? as f32),
        };
        out.push(InputChange {
            time,
            name: name.to_string(),
            value,
        });
    }
    out.sort_by(|a, b| a.time.total_cmp(&b.time));
    Ok(out)
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
