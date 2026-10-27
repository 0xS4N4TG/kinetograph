//! A video file's frames for the tracker, decoded by the renderer's own FFmpeg path (`kinetograph_core::video`), so
//! frame `n` is the picture a render shows at `n / fps` of the clip.
//!
//! Only a few frames are kept: the first one asked for (the keyframe every step of a "keyframe" match reads), and the
//! last few decoded. Going backwards, frames are decoded forwards in runs ending at the one asked for, so each run
//! costs one seek.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;

use kinetograph_core::video::{VideoDecoder, VideoInfo, probe};
use peniko::ImageData;

use crate::{Clip, Frames, Options, Point, Range, TrackFile, track_points};

/// Bytes of decoded frames a backwards run may hold.
const RUN_BYTES: usize = 128 << 20;
const MAX_RUN: u32 = 16;

pub struct VideoFrames {
    info: Arc<VideoInfo>,
    decoder: VideoDecoder,
    fps: f64,
    count: u32,
    /// The first frame asked for, kept for good.
    first: Option<(u32, ImageData)>,
    /// Recent frames, least recently used first.
    recent: VecDeque<(u32, ImageData)>,
    run: u32,
}

impl VideoFrames {
    pub fn open(path: &Path) -> Result<VideoFrames, String> {
        let info = probe(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let fps = info.fps.filter(|f| *f > 0.0).ok_or_else(|| format!("{}: no frame rate", path.display()))?;
        let count = match info.frames {
            Some(n) => n as u32,
            None => (info.duration * fps).round().max(1.0) as u32,
        };
        let decoder = VideoDecoder::open(path, info.clone()).map_err(|e| format!("{}: {e}", path.display()))?;
        let frame_bytes = info.width as usize * info.height as usize * 4;
        let run = ((RUN_BYTES / frame_bytes.max(1)) as u32).clamp(2, MAX_RUN);
        Ok(VideoFrames { info, decoder, fps, count, first: None, recent: VecDeque::new(), run })
    }

    pub fn fps(&self) -> f64 {
        self.fps
    }

    fn cached(&self, frame: u32) -> Option<&ImageData> {
        if let Some((f, image)) = &self.first
            && *f == frame
        {
            return Some(image);
        }
        self.recent.iter().find(|(f, _)| *f == frame).map(|(_, image)| image)
    }

    fn decode(&mut self, frame: u32) -> Result<(), String> {
        let ts = self.info.media_time(f64::from(frame) / self.fps, self.info.duration).ts;
        let image = self.decoder.picture(ts)?;
        if self.first.is_none() {
            self.first = Some((frame, image.clone()));
        }
        if self.recent.len() as u32 >= self.run + 2 {
            self.recent.pop_front();
        }
        self.recent.push_back((frame, image));
        Ok(())
    }
}

impl Frames for VideoFrames {
    fn width(&self) -> u32 {
        self.info.width
    }

    fn height(&self) -> u32 {
        self.info.height
    }

    fn count(&self) -> u32 {
        self.count
    }

    fn rgba(&mut self, frame: u32, backwards: bool) -> Result<&[u8], String> {
        // Least recently used goes first: the frame matched against stays while a run is decoded.
        if let Some(i) = self.recent.iter().position(|(f, _)| *f == frame) {
            let entry = self.recent.remove(i).expect("found");
            self.recent.push_back(entry);
        } else if self.cached(frame).is_none() {
            let first = if backwards && self.first.is_some() { frame.saturating_sub(self.run - 1) } else { frame };
            for f in first..=frame {
                if self.cached(f).is_none() {
                    self.decode(f)?;
                }
            }
        }
        let image = self.cached(frame).expect("just decoded");
        if image.width != self.info.width || image.height != self.info.height {
            return Err(format!(
                "frame {frame} is {}x{}, not {}x{}",
                image.width, image.height, self.info.width, self.info.height
            ));
        }
        Ok(image.data.data())
    }
}

/// Tracks `points` through the video at `path`, between frame `first` (default 0) and `last` (default the clip's
/// last), backwards from `last` if `backwards`.
pub fn track_video(
    path: &Path,
    points: &[Point],
    options: &Options,
    first: Option<u32>,
    last: Option<u32>,
    backwards: bool,
) -> Result<TrackFile, String> {
    let mut frames = VideoFrames::open(path)?;
    let count = frames.count;
    let range = Range { from: first.unwrap_or(0), to: last.unwrap_or(count.saturating_sub(1)), backwards };
    let tracks = track_points(&mut frames, points, options, range)?;
    Ok(TrackFile {
        version: TrackFile::VERSION,
        clip: Clip { width: frames.info.width, height: frames.info.height, fps: frames.fps, frames: count },
        tracks,
    })
}
