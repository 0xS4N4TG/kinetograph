//! The errors JavaScript sees: an `Error` whose `code` is one of `Code` and
//! whose `message` is the Rust error's text (`packages/cli/skills/kinetograph/references/AUTHORING.md` §3).

use kinetograph_cli::render::RenderError;
use kinetograph_core::Error as CoreError;

/// `Error.code`. napi-rs takes the code from the status type's string.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    SceneInvalid,
    Io,
    FrameOutOfRange,
    Render,
    Encode,
    InvalidArg,
}

impl AsRef<str> for Code {
    fn as_ref(&self) -> &str {
        match self {
            Code::SceneInvalid => "SCENE_INVALID",
            Code::Io => "IO",
            Code::FrameOutOfRange => "FRAME_OUT_OF_RANGE",
            Code::Render => "RENDER",
            Code::Encode => "ENCODE",
            Code::InvalidArg => "INVALID_ARG",
        }
    }
}

pub type Error = napi::Error<Code>;
pub type Result<T> = std::result::Result<T, Error>;

pub fn error(code: Code, message: impl Into<String>) -> Error {
    Error::new(code, message.into())
}

pub fn invalid(message: impl Into<String>) -> Error {
    error(Code::InvalidArg, message)
}

fn core_code(e: &CoreError) -> Code {
    match e {
        CoreError::Scene(_) => Code::SceneInvalid,
        CoreError::Io { .. } => Code::Io,
        CoreError::FrameOutOfRange { .. } => Code::FrameOutOfRange,
        CoreError::Render(_) => Code::Render,
    }
}

pub fn from_core(e: CoreError) -> Error {
    error(core_code(&e), e.to_string())
}

pub fn from_render(e: RenderError) -> Error {
    let code = match &e {
        RenderError::Invalid(_) => Code::InvalidArg,
        RenderError::Core(e) | RenderError::Frame(_, e) => core_code(e),
        RenderError::Encode(_) => Code::Encode,
    };
    error(code, e.to_string())
}

/// A frame, count or size from JavaScript: a whole number from 0 to
/// `u32::MAX`. (`u32` parameters would turn -1 into 4294967295.)
pub fn count(what: &str, value: f64) -> Result<u32> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= f64::from(u32::MAX) {
        Ok(value as u32)
    } else {
        Err(invalid(format!(
            "{what} must be a whole number from 0 to {}, got {value}",
            u32::MAX
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_the_documented_strings() {
        let all = [
            (Code::SceneInvalid, "SCENE_INVALID"),
            (Code::Io, "IO"),
            (Code::FrameOutOfRange, "FRAME_OUT_OF_RANGE"),
            (Code::Render, "RENDER"),
            (Code::Encode, "ENCODE"),
            (Code::InvalidArg, "INVALID_ARG"),
        ];
        for (code, text) in all {
            assert_eq!(code.as_ref(), text);
        }
    }

    #[test]
    fn core_errors_keep_their_text_and_pick_a_code() {
        let scene = from_core(CoreError::Scene("layer \"a\": bad".into()));
        assert_eq!(scene.status, Code::SceneInvalid);
        assert_eq!(scene.reason, "invalid scene: layer \"a\": bad");
        let range = from_core(CoreError::FrameOutOfRange {
            frame: 9,
            duration: 3,
        });
        assert_eq!(range.status, Code::FrameOutOfRange);
        assert!(range.reason.contains("frame 9"));
        let io = from_core(CoreError::Io {
            path: "x.png".into(),
            source: std::io::Error::other("nope"),
        });
        assert_eq!(io.status, Code::Io);
        assert_eq!(
            from_core(CoreError::Render("gpu".into())).status,
            Code::Render
        );
    }

    #[test]
    fn render_errors_pick_a_code_and_keep_the_frame() {
        let e = from_render(RenderError::Frame(4, CoreError::Render("boom".into())));
        assert_eq!(e.status, Code::Render);
        assert_eq!(e.reason, "frame 4: render failed: boom");
        assert_eq!(
            from_render(RenderError::Invalid("x".into())).status,
            Code::InvalidArg
        );
        assert_eq!(
            from_render(RenderError::Encode("x".into())).status,
            Code::Encode
        );
        assert_eq!(
            from_render(RenderError::Core(CoreError::Scene("x".into()))).status,
            Code::SceneInvalid
        );
    }

    #[test]
    fn counts_are_whole_non_negative_numbers() {
        assert_eq!(count("frame", 0.0).unwrap(), 0);
        assert_eq!(count("frame", 4_294_967_295.0).unwrap(), u32::MAX);
        for bad in [-1.0, 1.5, f64::NAN, f64::INFINITY, 4_294_967_296.0] {
            let e = count("frame", bad).unwrap_err();
            assert_eq!(e.status, Code::InvalidArg);
            assert!(e.reason.starts_with("frame must be"), "{}", e.reason);
        }
    }
}
