//! The Chrome fallback's addon call (docs/COMPAT.md §6.2): `videoFrame`, the
//! picture a video layer shows, decoded on the CPU. (The other half,
//! `VideoWriter.pushRgba`, is in `lib.rs` over `kinetograph_cli::render`.)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use kinetograph_core::video::{self, VideoDecoder};
use napi::bindgen_prelude::Buffer;

use crate::RgbaFrame;
use crate::error::{Code, Result, error, invalid};

/// How many files keep an open decoder. A page asks for the same few clips
/// frame after frame; a decoder that stays open decodes forward instead of
/// seeking.
const MAX_DECODERS: usize = 8;

static DECODERS: Mutex<Option<HashMap<PathBuf, VideoDecoder>>> = Mutex::new(None);

/// The picture a video layer shows `time` seconds after the stream's first
/// picture, by the rule of docs/SCENE.md "video": the last picture at or
/// before `time` (rounded to the nearest tick), the first for a `time`
/// before it, and the last picture before the stream's end for one at or past
/// it. The result depends on (file, time) only, never on earlier calls.
pub fn video_frame(path: &Path, time: f64) -> Result<RgbaFrame> {
    if !time.is_finite() {
        return Err(invalid(format!("time must be a number, got {time}")));
    }
    std::fs::metadata(path)
        .map_err(|e| error(Code::Io, format!("cannot read {}: {e}", path.display())))?;
    let bad = |what: String| invalid(format!("{}: {what}", path.display()));
    let info = video::probe(path).map_err(bad)?;
    let target = info.media_time(time, info.duration);

    let key = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut guard = DECODERS.lock().unwrap_or_else(|e| e.into_inner());
    let decoders = guard.get_or_insert_with(HashMap::new);
    if !decoders.contains_key(&key) {
        let decoder = VideoDecoder::open(path, info.clone())
            .map_err(|e| error(Code::Render, format!("{}: {e}", path.display())))?;
        if decoders.len() >= MAX_DECODERS {
            decoders.clear();
        }
        decoders.insert(key.clone(), decoder);
    }
    let decoder = decoders
        .get_mut(&key)
        .expect("the decoder was just inserted");
    // A file changed on disk since the decoder opened has another probe:
    // start over rather than seek a stream that is no longer there.
    let image = match decoder.picture(target.ts) {
        Ok(image) => image,
        Err(e) => {
            decoders.remove(&key);
            return Err(error(
                Code::Render,
                format!("{} at {time:.3} s: {e}", path.display()),
            ));
        }
    };
    Ok(RgbaFrame {
        width: image.width,
        height: image.height,
        data: Buffer::from(image.data.as_ref().to_vec()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../core/tests/scenes/media/clip.mp4")
    }

    fn at(time: f64) -> Vec<u8> {
        video_frame(&clip(), time).unwrap().data.to_vec()
    }

    #[test]
    fn a_picture_is_straight_rgba_of_the_streams_size() {
        let frame = video_frame(&clip(), 0.0).unwrap();
        assert_eq!((frame.width, frame.height), (64, 36));
        assert_eq!(frame.data.len(), 64 * 36 * 4);
        // The clip is opaque.
        assert!(frame.data.chunks(4).all(|p| p[3] == 255));
    }

    #[test]
    fn a_picture_does_not_depend_on_the_calls_before_it() {
        let times = [0.0, 0.5, 1.0, 1.5, 1.9];
        let forward: Vec<_> = times.iter().map(|&t| at(t)).collect();
        // Backwards, and with a decoder opened afresh each time.
        for (i, &t) in times.iter().enumerate().rev() {
            assert_eq!(at(t), forward[i], "time {t}");
        }
        DECODERS.lock().unwrap().take();
        assert_eq!(at(1.0), forward[2]);
        // The pictures differ along the clip, so the check means something.
        assert_ne!(forward[0], forward[4]);
    }

    #[test]
    fn times_outside_the_stream_hold_its_first_and_last_picture() {
        assert_eq!(at(-3.0), at(0.0));
        assert_eq!(at(2.0), at(50.0));
        assert_ne!(at(2.0), at(0.0));
    }

    #[test]
    fn bad_arguments_and_files_have_codes() {
        let e = video_frame(&clip(), f64::NAN).err().expect("an error");
        assert_eq!(e.status, Code::InvalidArg);
        let e = video_frame(Path::new("/no/such/clip.mp4"), 0.0)
            .err()
            .expect("an error");
        assert_eq!(e.status, Code::Io);
        // A file that is not a video.
        let e = video_frame(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("Cargo.toml")
                .as_path(),
            0.0,
        )
        .err()
        .expect("an error");
        assert_eq!(e.status, Code::InvalidArg);
    }
}
