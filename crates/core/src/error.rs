use std::fmt;
use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    /// The scene file is malformed or inconsistent.
    Scene(String),
    /// A file could not be read.
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    /// The requested frame is outside `0..durationInFrames`.
    FrameOutOfRange { frame: u32, duration: u32 },
    /// A GPU, font or image failure while rendering.
    Render(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Scene(msg) => write!(f, "invalid scene: {msg}"),
            Error::Io { path, source } => write!(f, "cannot read {}: {source}", path.display()),
            Error::FrameOutOfRange { frame, duration } => write!(
                f,
                "frame {frame} is out of range (scene has {duration} frames, valid frames are 0..={})",
                duration.saturating_sub(1)
            ),
            Error::Render(msg) => write!(f, "render failed: {msg}"),
        }
    }
}

impl std::error::Error for Error {}
