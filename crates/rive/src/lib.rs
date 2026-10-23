//! Rive files (`.riv`) played to the commands of a `canvas` layer.
//!
//! `Riv` reads a file once; `Riv::frame` plays it to a time and returns what a
//! canvas of the given size draws (packages/cli/skills/kinetograph/references/SCENE.md, "canvas"). Each call starts
//! from a fresh artboard and animation, so a frame is a pure function of the
//! file, the choices and the time, whatever was played before it.

mod recorder;

use std::fmt;
use std::path::Path;
use std::time::Duration;

use rive_rs::renderer::Renderer as _;
use rive_rs::scene::Scene;
use rive_rs::{Artboard, File, Handle, Instantiate, LinearAnimation, StateMachine};
use serde_json::Value;

use recorder::Recorder;

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
}

/// A Rive file, read.
pub struct Riv {
    file: File<Recorder>,
}

impl Riv {
    pub fn open(bytes: &[u8]) -> Result<Riv, Error> {
        File::new(bytes)
            .map(|file| Riv { file })
            .or_else(|e| error(format!("not a Rive file this runtime can read: {e}")))
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
        let time = frame.time.max(0.0) as f32;
        if frame.state_machine.is_some() {
            let mut left = time;
            while left > 0.0 {
                let step = left.min(STATE_MACHINE_STEP);
                scene.advance_and_apply(Duration::from_secs_f32(step));
                left -= step;
            }
        } else {
            scene.advance_and_apply(Duration::from_secs_f32(time));
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
