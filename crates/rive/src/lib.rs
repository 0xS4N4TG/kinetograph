//! Rive files (`.riv`) played to the commands of a `canvas` layer.
//!
//! `Riv` reads a file once; `Riv::frame` plays it to a time and returns what a
//! canvas of the given size draws (packages/cli/skills/kinetograph/references/SCENE.md, "canvas"). Each call starts
//! from a fresh artboard and animation, so a frame is a pure function of the
//! file, the choices, the state machine inputs given for each time, and the
//! time, whatever was played before it.
//!
//! A file's assets outside it (referenced pictures and fonts) are given when it
//! is read (`Riv::open_with`); `Riv::info` lists the artboards, animations,
//! state machines with their inputs, and the assets.

mod recorder;

use std::fmt;
use std::path::Path;
use std::time::Duration;

use rive_rs::renderer::Renderer as _;
use rive_rs::scene::Scene;
use rive_rs::{Artboard, File, Handle, Instantiate, LinearAnimation, StateMachine};
use serde_json::{Value, json};

use recorder::Recorder;
pub use rive_rs::{AssetKind, AssetRequest};

/// The longest step a state machine is advanced by when it is played up to a
/// time: a machine reacts to the steps it is given, so playing it in one jump
/// would skip its transitions.
const STATE_MACHINE_STEP: f32 = 1.0 / 60.0;

#[derive(Debug)]
pub struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

fn error<T>(message: impl Into<String>) -> Result<T, Error> {
    Err(Error(message.into()))
}

/// An artboard, animation or state machine of a file, by position or name.
#[derive(Clone, Debug, PartialEq)]
pub enum Select {
    Index(usize),
    Name(String),
}

impl Select {
    fn handle(&self) -> Handle {
        match self {
            Select::Index(index) => Handle::Index(*index),
            Select::Name(name) => Handle::Name(name.clone().into()),
        }
    }

    fn describe(&self) -> String {
        match self {
            Select::Index(index) => format!("number {index}"),
            Select::Name(name) => format!("{name:?}"),
        }
    }
}

/// How the artboard is fitted into the canvas (Rive's `Fit`, as `object-fit`).
/// The numbers are the runtime's own (`rive::Fit`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(u8)]
pub enum Fit {
    Fill = 0,
    #[default]
    Contain = 1,
    Cover = 2,
    FitWidth = 3,
    FitHeight = 4,
    None = 5,
    ScaleDown = 6,
}

/// Where the artboard sits when it does not fill the canvas: `-1` is left (or
/// top), `0` the middle, `1` right (or bottom).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Alignment {
    pub x: f32,
    pub y: f32,
}

impl Default for Alignment {
    fn default() -> Alignment {
        Alignment { x: 0.0, y: 0.0 }
    }
}

/// A value a state machine input takes.
#[derive(Clone, Debug, PartialEq)]
pub enum InputValue {
    Bool(bool),
    Number(f32),
    /// A trigger fires.
    Fire,
}

/// A state machine input set to a value at a time (seconds from the start).
#[derive(Clone, Debug, PartialEq)]
pub struct InputChange {
    pub time: f64,
    pub name: String,
    pub value: InputValue,
}

/// What to play and where.
#[derive(Clone, Debug)]
pub struct Frame {
    /// The default artboard when left out.
    pub artboard: Option<Select>,
    /// A linear animation. When neither this nor `state_machine` is given, the
    /// artboard's first animation, else its default state machine, else the
    /// artboard as it stands.
    pub animation: Option<Select>,
    pub state_machine: Option<Select>,
    /// Seconds into the animation.
    pub time: f64,
    /// The canvas, in pixels.
    pub width: f32,
    pub height: f32,
    pub fit: Fit,
    pub alignment: Alignment,
    /// The state machine's inputs, set as the machine is played up to `time`,
    /// in the order of their times; the rest keep their defaults.
    pub inputs: Vec<InputChange>,
}

/// An asset a file names, and whether its contents were found.
#[derive(Clone, Debug, PartialEq)]
pub struct Asset {
    /// `image`, `font`, `audio` or `other`.
    pub kind: &'static str,
    pub name: String,
    /// `name-id.ext`: the file the Rive editor writes a referenced asset to.
    pub unique_filename: String,
    pub extension: String,
    /// The asset's id on Rive's CDN, empty when it has none.
    pub cdn_uuid: String,
    /// In the file itself.
    pub embedded: bool,
    /// Given from outside the file (by `open_with`'s loader).
    pub supplied: bool,
}

impl Asset {
    /// Neither in the file nor given: what uses it is drawn without it.
    pub fn missing(&self) -> bool {
        !self.embedded && !self.supplied
    }
}

/// A Rive file, read.
pub struct Riv {
    file: File<Recorder>,
    assets: Vec<Asset>,
}

impl Riv {
    pub fn open(bytes: &[u8]) -> Result<Riv, Error> {
        Riv::open_with(bytes, &mut |_| None)
    }

    /// Reads a file; `load` is asked for the contents of each asset (with its
    /// in-band bytes, empty for one outside the file) and answers bytes to use
    /// instead, or `None` to keep what the file has.
    pub fn open_with(
        bytes: &[u8],
        load: &mut dyn FnMut(&AssetRequest<'_>) -> Option<Vec<u8>>,
    ) -> Result<Riv, Error> {
        let mut assets = Vec::new();
        let file = File::new_with_assets(bytes, &mut |request| {
            let given = load(request);
            assets.push(Asset {
                kind: match request.kind {
                    AssetKind::Image => "image",
                    AssetKind::Font => "font",
                    AssetKind::Audio => "audio",
                    AssetKind::Other => "other",
                },
                name: request.name.to_string(),
                unique_filename: request.unique_filename.to_string(),
                extension: request.extension.to_string(),
                cdn_uuid: request.cdn_uuid.to_string(),
                embedded: !request.in_band.is_empty(),
                supplied: given.is_some(),
            });
            given
        })
        .or_else(|e| error(format!("not a Rive file this runtime can read: {e}")))?;
        Ok(Riv { file, assets })
    }

    /// The assets the file names, in the file's order.
    pub fn assets(&self) -> &[Asset] {
        &self.assets
    }

    /// `{ artboards: [{ name, width, height, animations: [{ name, fps, duration, ... }], stateMachines: [{ name,
    /// inputs: [{ name, type, value }] }] }], assets: [{ type, name, uniqueFilename, ... }] }`.
    pub fn info(&self) -> Value {
        let mut info: Value = serde_json::from_str(&self.file.describe())
            .unwrap_or_else(|_| json!({ "artboards": [] }));
        info["assets"] = self
            .assets
            .iter()
            .map(|a| {
                json!({
                    "type": a.kind,
                    "name": a.name,
                    "uniqueFilename": a.unique_filename,
                    "fileExtension": a.extension,
                    "cdnUuid": a.cdn_uuid,
                    "embedded": a.embedded,
                    "supplied": a.supplied,
                })
            })
            .collect();
        info
    }

    /// The commands of a canvas `frame.width` by `frame.height` that show the
    /// file at `frame.time`. Pictures of the file are written to `pictures`
    /// (a directory) for the commands to name.
    pub fn frame(&self, frame: &Frame, pictures: &Path) -> Result<Vec<Value>, Error> {
        let handle = frame
            .artboard
            .as_ref()
            .map_or(Handle::Default, Select::handle);
        let Some(artboard) = Artboard::<Recorder>::instantiate(&self.file, handle) else {
            return error(match &frame.artboard {
                Some(select) => format!("the file has no artboard {}", select.describe()),
                None => "the file has no artboard".to_string(),
            });
        };
        let mut scene = self.scene(&artboard, frame)?;
        let time = frame.time.max(0.0);
        let machine = scene
            .as_any()
            .downcast_ref::<StateMachine<Recorder>>()
            .is_some();
        if !frame.inputs.is_empty() && !machine {
            return error("state machine inputs need a state machine to play: give stateMachine");
        }
        if frame.state_machine.is_some() || !frame.inputs.is_empty() {
            // Played in steps, each input set at its time, so the machine meets the
            // values in the order they come, as a player does.
            let mut changes = frame.inputs.iter().peekable();
            let mut at = 0.0f64;
            loop {
                while let Some(change) = changes.next_if(|c| c.time <= at) {
                    set_input(scene.as_ref(), change)?;
                }
                if at >= time {
                    break;
                }
                let next = changes.peek().map_or(time, |c| c.time.min(time));
                let until = next.min(at + f64::from(STATE_MACHINE_STEP)).max(at);
                scene.advance_and_apply(Duration::from_secs_f64(until - at));
                at = until;
            }
            // What was set at the frame's own time takes effect in what it shows.
            if frame.inputs.iter().any(|c| c.time == time && time > 0.0) {
                scene.advance_and_apply(Duration::ZERO);
            }
        } else {
            scene.advance_and_apply(Duration::from_secs_f64(time));
        }

        let mut recorder = Recorder::new(pictures.to_path_buf());
        let fit = scene.view_transform(
            frame.fit as u8,
            [frame.alignment.x, frame.alignment.y],
            frame.width,
            frame.height,
        );
        recorder.state_push();
        recorder.transform(&fit);
        scene.draw(&mut recorder);
        recorder.state_pop();
        match recorder.failure {
            Some(failure) => error(format!(
                "a picture of the file could not be written: {failure}"
            )),
            None => Ok(recorder.commands),
        }
    }

    fn scene(
        &self,
        artboard: &Artboard<Recorder>,
        frame: &Frame,
    ) -> Result<Box<dyn Scene<Recorder>>, Error> {
        let missing = |what: &str, select: &Select| {
            error(format!("the artboard has no {what} {}", select.describe()))
        };
        if let Some(select) = &frame.state_machine {
            return match StateMachine::<Recorder>::instantiate(artboard, select.handle()) {
                Some(machine) => Ok(Box::new(machine)),
                None => missing("state machine", select),
            };
        }
        if let Some(select) = &frame.animation {
            return match LinearAnimation::<Recorder>::instantiate(artboard, select.handle()) {
                Some(animation) => Ok(Box::new(animation)),
                None => missing("animation", select),
            };
        }
        // Remotion plays the first animation; a file with only state machines
        // plays its default one.
        if let Some(animation) =
            LinearAnimation::<Recorder>::instantiate(artboard, Handle::Index(0))
        {
            return Ok(Box::new(animation));
        }
        match <Box<dyn Scene<Recorder>>>::instantiate(artboard, Handle::Default) {
            Some(scene) => Ok(scene),
            None => error("the artboard has no animation or state machine to play"),
        }
    }
}

/// Sets one input of the state machine `scene` plays.
fn set_input(scene: &dyn Scene<Recorder>, change: &InputChange) -> Result<(), Error> {
    let Some(machine) = scene.as_any().downcast_ref::<StateMachine<Recorder>>() else {
        return error("state machine inputs need a state machine to play");
    };
    let name = change.name.as_str();
    match &change.value {
        InputValue::Bool(on) => match machine.get_bool(name) {
            Some(mut input) => input.set(*on),
            None => return error(format!("the state machine has no boolean input {name:?}")),
        },
        InputValue::Number(n) => match machine.get_number(name) {
            Some(mut input) => input.set(*n),
            None => return error(format!("the state machine has no number input {name:?}")),
        },
        InputValue::Fire => match machine.get_trigger(name) {
            Some(mut input) => input.fire(),
            None => return error(format!("the state machine has no trigger {name:?}")),
        },
    }
    Ok(())
}
