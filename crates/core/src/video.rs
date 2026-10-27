//! Video layers: pictures decoded by FFmpeg.
//!
//! A `video` layer shows one picture of a file per frame, drawn like an image
//! (`render.rs`). Three things live here:
//!
//! - `probe` reads a file's container (size, time base, first timestamp,
//!   duration, streams) without decoding, when a scene loads;
//! - the time rules of `packages/cli/skills/kinetograph/references/SCENE.md` ("video"): `Clip::source_time` turns a
//!   scene frame into a time in the file, and `VideoInfo::media_time` turns
//!   that into the timestamp of the picture to show;
//! - `VideoDecoder`, one per file in a renderer, which produces the RGBA
//!   picture for a timestamp.
//!
//! Purity: the picture for a timestamp is the last one at or before it, and
//! it is the same whatever the decoder decoded before. A decoder keeps its
//! place and decodes forward, and seeks (to the keyframe at or before the
//! timestamp, then decodes forward) when the timestamp is behind it or more
//! than a second of stream time ahead; the pictures it has made lately are
//! kept in a cache bounded in bytes. None of that changes a pixel.

use std::collections::{HashMap, VecDeque};
use std::ffi::{CStr, c_int};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Once};
use std::time::SystemTime;

use ffmpeg::format::{self, Pixel};
use ffmpeg::software::scaling::{self, Flags as ScaleFlags};
use ffmpeg::util::color;
use ffmpeg::{Error as AvError, Packet, codec, frame, media};
use peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};

use crate::datamosh::{Fetched, MotionField, Vector};
use crate::error::{Error, Result};
use crate::scene::{LayerKind, Scene, VideoLayer, walk_layers};

/// Starts FFmpeg once and keeps its own messages down to warnings.
pub fn init() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // A failure shows up as the first call that needs FFmpeg failing.
        let _ = ffmpeg::init();
        ffmpeg::log::set_level(ffmpeg::log::Level::Warning);
    });
}

/// What a video file's container says about its first video stream
/// (`probe`). Nothing is decoded to learn it.
#[derive(Clone, Debug, PartialEq)]
pub struct VideoInfo {
    /// The stream's coded size.
    pub width: u32,
    pub height: u32,
    /// Seconds per tick of the stream's timestamps, as `(numerator,
    /// denominator)`.
    pub time_base: (i32, i32),
    /// The timestamp of the stream's first picture, in ticks. Times in a
    /// clip are measured from it.
    pub start: i64,
    /// Seconds from the first picture to the end of the stream.
    pub duration: f64,
    /// The stream's average frame rate.
    pub fps: Option<f64>,
    /// The container's picture count, when it has one.
    pub frames: Option<u64>,
    pub has_audio: bool,
    /// FFmpeg's name for the codec (`h264`).
    pub video_codec: String,
    pub audio_codec: Option<String>,
}

impl VideoInfo {
    /// Whole ticks for `seconds`, to the nearest.
    fn ticks(&self, seconds: f64) -> i64 {
        let (num, den) = self.time_base;
        (seconds * f64::from(den) / f64::from(num)).round() as i64
    }

    /// A second of stream time, in ticks.
    fn second(&self) -> i64 {
        self.ticks(1.0).max(1)
    }

    /// The picture a clip shows `seconds` after its first picture
    /// (`packages/cli/skills/kinetograph/references/SCENE.md`, "video", rule 5): `seconds` rounded to the nearest
    /// tick and moved to the stream's own timestamps, but never to `end`
    /// (seconds from the first picture) or past it, since the clip shows the
    /// last picture before its end.
    pub fn media_time(&self, seconds: f64, end: f64) -> MediaTime {
        let last = (self.ticks(end) - 1).max(0);
        MediaTime {
            seconds,
            ts: self.start + self.ticks(seconds).clamp(0, last),
        }
    }
}

/// The time a video layer shows, and the picture it picks.
#[derive(Clone, Copy, Debug)]
pub struct MediaTime {
    /// Seconds after the stream's first picture, as the rules in
    /// `packages/cli/skills/kinetograph/references/SCENE.md` give it (not rounded).
    pub seconds: f64,
    /// The timestamp, in the stream's time base, that the picture is the last
    /// one at or before.
    pub ts: i64,
}

/// Two times are equal when they ask for the same timestamp, so they show
/// the same picture of the same file. That is what the layer cache compares
/// (`cache.rs`): the unrounded `seconds` does not matter to a texture, and two
/// times a hair apart do not make it redraw. (Times that fall in the same
/// picture but on different ticks are not equal, so the layer is redrawn; the
/// scene cannot tell which picture a tick is in without decoding.)
impl PartialEq for MediaTime {
    fn eq(&self, other: &MediaTime) -> bool {
        self.ts == other.ts
    }
}

/// The fields of a `video` layer that say which part of the file it shows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Clip {
    pub from: f64,
    pub trim_before: f64,
    pub trim_after: Option<f64>,
    pub playback_rate: f64,
    pub looped: bool,
}

impl From<&VideoLayer> for Clip {
    fn from(v: &VideoLayer) -> Clip {
        Clip {
            from: v.from,
            trim_before: v.trim_before,
            trim_after: v.trim_after,
            playback_rate: v.playback_rate,
            looped: v.looped,
        }
    }
}

impl Clip {
    /// Where the clip ends, in seconds after the first picture: `trimAfter`,
    /// or the stream's end.
    pub fn end(&self, fps: f64, duration: f64) -> f64 {
        self.trim_after.map_or(duration, |frames| frames / fps)
    }

    /// The time in the file, in seconds after its first picture, that scene
    /// frame `frame` shows (`packages/cli/skills/kinetograph/references/SCENE.md`, "video", rules 1 to 4). `fps` is
    /// the scene's and `duration` the stream's, in seconds.
    pub fn source_time(&self, frame: f64, fps: f64, duration: f64) -> f64 {
        // 1. The clip's frame.
        let n = (frame - self.from) * self.playback_rate;
        // 2. The clip's length, in scene frames.
        let length = self.end(fps, duration) * fps - self.trim_before;
        // 3. Wrapped or clamped into the clip.
        let n = if self.looped {
            n.rem_euclid(length)
        } else {
            n.clamp(0.0, length)
        };
        // 4. Seconds from the stream's first picture.
        (self.trim_before + n) / fps
    }
}

/// A file's identity for the probe cache: a changed file is probed again. (The
/// modification time only decides whether to read again; it never reaches a
/// pixel.)
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct FileKey {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

/// What `probe` found for the files it has read. A TSX project hands the
/// renderer one scene per frame, and every scene loads its videos, so a file
/// is probed once instead of once per frame.
static PROBES: Mutex<Option<HashMap<FileKey, Arc<VideoInfo>>>> = Mutex::new(None);

/// Most files whose probes are kept.
const MAX_PROBES: usize = 256;

/// Reads the first video stream of `path` (skipping attached pictures such as
/// cover art) without decoding anything.
pub fn probe(path: &Path) -> std::result::Result<Arc<VideoInfo>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot read: {e}"))?;
    let key = FileKey {
        path: std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()),
        len: meta.len(),
        modified: meta.modified().ok(),
    };
    let mut probes = PROBES.lock().unwrap_or_else(|e| e.into_inner());
    let probes = probes.get_or_insert_with(HashMap::new);
    if let Some(info) = probes.get(&key) {
        return Ok(info.clone());
    }
    let info = Arc::new(probe_file(path)?);
    if probes.len() >= MAX_PROBES {
        probes.clear();
    }
    probes.insert(key, info.clone());
    Ok(info)
}

/// The first video stream that is a video and not a cover picture.
fn video_stream(input: &format::context::Input) -> Option<ffmpeg::Stream<'_>> {
    input.streams().find(|s| {
        s.parameters().medium() == media::Type::Video
            && !s
                .disposition()
                .contains(format::stream::Disposition::ATTACHED_PIC)
    })
}

/// FFmpeg's name for a codec id.
fn codec_name(id: ffmpeg::ffi::AVCodecID) -> String {
    // SAFETY: `avcodec_get_name` returns a static string for any id.
    unsafe { CStr::from_ptr(ffmpeg::ffi::avcodec_get_name(id)) }
        .to_string_lossy()
        .into_owned()
}

fn probe_file(path: &Path) -> std::result::Result<VideoInfo, String> {
    init();
    let mut input = format::input(path).map_err(|e| format!("cannot open: {e}"))?;
    let (index, time_base, stream_start, stream_duration, avg_rate, frames, width, height, codec) = {
        let stream = video_stream(&input).ok_or("it has no video stream")?;
        let params = stream.parameters();
        // SAFETY: the parameters are live for as long as `stream` is.
        let (width, height, id) = unsafe {
            let p = params.as_ptr();
            ((*p).width, (*p).height, (*p).codec_id)
        };
        let rate = stream.avg_frame_rate();
        let rate = if rate.numerator() > 0 && rate.denominator() > 0 {
            Some(f64::from(rate))
        } else {
            let r = stream.rate();
            (r.numerator() > 0 && r.denominator() > 0).then(|| f64::from(r))
        };
        let tb = stream.time_base();
        (
            stream.index(),
            (tb.numerator(), tb.denominator()),
            stream.start_time(),
            stream.duration(),
            rate,
            u64::try_from(stream.frames()).ok().filter(|&n| n > 0),
            u32::try_from(width).unwrap_or(0),
            u32::try_from(height).unwrap_or(0),
            codec_name(id),
        )
    };
    if width == 0 || height == 0 {
        return Err("the video stream does not say how big it is".into());
    }
    if time_base.0 <= 0 || time_base.1 <= 0 {
        return Err("the video stream has no time base".into());
    }
    let tick = f64::from(time_base.0) / f64::from(time_base.1);
    let no_ts = ffmpeg::ffi::AV_NOPTS_VALUE;

    let audio = input
        .streams()
        .find(|s| s.parameters().medium() == media::Type::Audio);
    let (has_audio, audio_codec) = match audio {
        // SAFETY: as above.
        Some(s) => (
            true,
            Some(codec_name(unsafe { (*s.parameters().as_ptr()).codec_id })),
        ),
        None => (false, None),
    };

    // The first picture's timestamp: the stream's start time, or the least
    // timestamp among its first packets (the first in decoding order is not
    // always the first shown).
    let start = if stream_start != no_ts {
        stream_start
    } else {
        first_timestamp(&mut input, index).unwrap_or(0)
    };

    // The end of the stream. A stream's own duration is a length; a
    // container's can be where the last picture ends (Matroska's, so a WebM
    // that starts at half a second says one and a half for a second of
    // video), so without the stream's, the last packets say where it ends.
    let length = if stream_duration != no_ts && stream_duration > 0 {
        stream_duration
    } else if let Some(end) = last_end(&mut input, index, avg_rate, tick) {
        end - start
    } else {
        let container = input.duration();
        if container == no_ts || container <= 0 {
            return Err("it does not say how long it is".into());
        }
        (container as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE) / tick).round() as i64
    };
    if length <= 0 {
        return Err("the video stream is empty".into());
    }

    Ok(VideoInfo {
        width,
        height,
        time_base,
        start,
        duration: length as f64 * tick,
        fps: avg_rate,
        frames,
        has_audio,
        video_codec: codec,
        audio_codec,
    })
}

/// The least timestamp among the first packets of stream `index`.
fn first_timestamp(input: &mut format::context::Input, index: usize) -> Option<i64> {
    let mut least: Option<i64> = None;
    let mut seen = 0;
    while seen < 32 {
        let mut packet = Packet::empty();
        match packet.read(input) {
            Ok(()) if packet.stream() == index => {
                seen += 1;
                if let Some(ts) = packet.pts().or(packet.dts()) {
                    least = Some(least.map_or(ts, |l| l.min(ts)));
                }
            }
            Ok(()) => {}
            Err(AvError::InvalidData) => {}
            Err(_) => break,
        }
    }
    least
}

/// Where the last picture of stream `index` ends, in ticks: found by seeking
/// to the last keyframe and reading the packets after it (no decoding).
fn last_end(
    input: &mut format::context::Input,
    index: usize,
    rate: Option<f64>,
    tick: f64,
) -> Option<i64> {
    // SAFETY: `input` is a live format context.
    let status = unsafe {
        ffmpeg::ffi::av_seek_frame(
            input.as_mut_ptr(),
            index as c_int,
            i64::MAX,
            ffmpeg::ffi::AVSEEK_FLAG_BACKWARD as c_int,
        )
    };
    if status < 0 {
        return None;
    }
    let mut stamps = Vec::new();
    let mut last_duration = 0;
    loop {
        let mut packet = Packet::empty();
        match packet.read(input) {
            Ok(()) if packet.stream() == index => {
                if let Some(ts) = packet.pts().or(packet.dts()) {
                    stamps.push(ts);
                    last_duration = packet.duration();
                }
            }
            Ok(()) => {}
            Err(AvError::InvalidData) => {}
            Err(_) => break,
        }
    }
    stamps.sort_unstable();
    let last = *stamps.last()?;
    let step = if last_duration > 0 {
        last_duration
    } else if stamps.len() >= 2 {
        last - stamps[stamps.len() - 2]
    } else {
        rate.map_or(0, |r| (1.0 / r / tick).round() as i64)
    };
    Some(last + step)
}

/// How many bytes of decoded pictures a decoder keeps (`PictureCache`), though
/// never fewer than `MIN_CACHED` pictures.
const CACHE_BYTES: usize = 64 << 20;
const MIN_CACHED: usize = 4;

/// The pictures a decoder made lately: the last ones used first. Each is the
/// picture for the timestamps from `from` up to (not including) `until`.
#[derive(Default)]
struct PictureCache {
    entries: VecDeque<CachedPicture>,
    bytes: usize,
}

struct CachedPicture {
    from: i64,
    until: i64,
    /// The picture's own timestamp (`from` for every picture but the first, which also lasts back to the start of time).
    pts: i64,
    image: ImageData,
    /// The motion vectors of the picture, when the decoder exports them (`VideoDecoder::open_with_motion`).
    motion: Option<Arc<MotionField>>,
}

fn image_bytes(image: &ImageData) -> usize {
    image.width as usize * image.height as usize * 4
}

impl PictureCache {
    /// The picture for `ts` and the timestamp it lasts until, moved to the front.
    fn find(&mut self, ts: i64) -> Option<(ImageData, i64, Option<Arc<MotionField>>, i64)> {
        let at = self
            .entries
            .iter()
            .position(|e| e.from <= ts && ts < e.until)?;
        let entry = self.entries.remove(at)?;
        let found = (entry.image.clone(), entry.until, entry.motion.clone(), entry.pts);
        self.entries.push_front(entry);
        Some(found)
    }

    fn insert(&mut self, entry: CachedPicture) {
        self.bytes += image_bytes(&entry.image);
        self.entries.push_front(entry);
        while self.entries.len() > MIN_CACHED && self.bytes > CACHE_BYTES {
            if let Some(old) = self.entries.pop_back() {
                self.bytes -= image_bytes(&old.image);
            }
        }
    }
}

/// A decoded picture and its timestamp, not yet converted.
struct Decoded {
    pts: i64,
    frame: frame::Video,
    /// The picture's motion vectors, for a decoder opened with them.
    motion: Option<Arc<MotionField>>,
}

/// swscale's converter for one kind of source picture.
struct Scaler {
    context: scaling::Context,
    /// What it was made for; another kind of picture needs another.
    key: (Pixel, u32, u32, color::Space, color::Range),
    rgba: frame::Video,
}

/// One video file, opened, producing the picture for a timestamp.
pub struct VideoDecoder {
    path: PathBuf,
    info: Arc<VideoInfo>,
    input: format::context::Input,
    stream: usize,
    decoder: ffmpeg::decoder::Video,
    scaler: Option<Scaler>,
    /// The next picture, already decoded: every picture before it has been
    /// used. `None` after a seek or at the end of the stream (`finished`).
    lookahead: Option<Decoded>,
    /// No picture is left in the stream after the last one decoded.
    finished: bool,
    /// The decoder has been told the stream is over.
    draining: bool,
    /// The timestamp of the last picture decoded since the last seek; pictures
    /// that do not come after it are dropped.
    last_pts: Option<i64>,
    cache: PictureCache,
    /// The decoder exports motion vectors and every picture carries them (`open_with_motion`).
    motion: bool,
    /// Where the last picture returned lasts until: the timestamp of the
    /// picture after it. `prefetch` works one picture past this and no more.
    served_until: Option<i64>,
}

// SAFETY: a `VideoDecoder` owns its FFmpeg contexts and frames and is used
// through `&mut` only, so it is never touched by two threads at once. FFmpeg
// keeps no thread-local state for them, so they may move between threads.
unsafe impl Send for VideoDecoder {}

impl VideoDecoder {
    /// Opens `path`, whose `probe` is `info`.
    pub fn open(path: &Path, info: Arc<VideoInfo>) -> std::result::Result<VideoDecoder, String> {
        VideoDecoder::open_as(path, info, false)
    }

    /// What the file's container says about the stream this decoder reads.
    pub fn info(&self) -> &Arc<VideoInfo> {
        &self.info
    }

    /// Opens `path` with the decoder's motion vectors switched on (datamosh):
    /// `picture_motion` gives them with each picture. The pictures are the same
    /// ones `open` gives.
    pub fn open_with_motion(path: &Path, info: Arc<VideoInfo>) -> std::result::Result<VideoDecoder, String> {
        VideoDecoder::open_as(path, info, true)
    }

    fn open_as(path: &Path, info: Arc<VideoInfo>, motion: bool) -> std::result::Result<VideoDecoder, String> {
        let (input, stream, decoder) = open_streams(path, motion)?;
        Ok(VideoDecoder {
            path: path.to_path_buf(),
            info,
            input,
            stream,
            decoder,
            scaler: None,
            lookahead: None,
            finished: false,
            draining: false,
            last_pts: None,
            cache: PictureCache::default(),
            motion,
            served_until: None,
        })
    }

    /// The picture for the timestamp `ts` (`VideoInfo::media_time`): the last
    /// one at or before it, or the first if `ts` is before all of them.
    pub fn picture(&mut self, ts: i64) -> std::result::Result<ImageData, String> {
        self.fetch(ts).map(|(image, _, _)| image)
    }

    /// The picture for `ts` with its motion vectors and its own timestamp
    /// (which says whether two timestamps are one picture). Only on a decoder
    /// opened by `open_with_motion`; a picture without vectors (a keyframe) has
    /// a field in which nothing moves.
    pub fn picture_motion(&mut self, ts: i64) -> std::result::Result<Fetched, String> {
        if !self.motion {
            return Err("the decoder was not opened with motion vectors".into());
        }
        let (image, motion, pts) = self.fetch(ts)?;
        let motion = motion.unwrap_or_else(|| {
            Arc::new(MotionField::still(image.width as usize, image.height as usize))
        });
        Ok(Fetched { image, motion, pts })
    }

    #[allow(clippy::type_complexity)]
    fn fetch(
        &mut self,
        ts: i64,
    ) -> std::result::Result<(ImageData, Option<Arc<MotionField>>, i64), String> {
        if let Some((image, until, motion, pts)) = self.cache.find(ts) {
            self.served_until = Some(until);
            return Ok((image, motion, pts));
        }
        // Decode on from where the decoder is if the picture is not far
        // ahead; otherwise (behind it, far ahead, or nowhere yet) seek.
        let near = self
            .lookahead
            .as_ref()
            .is_some_and(|next| ts >= next.pts && ts - next.pts <= self.info.second());
        if !near {
            self.seek_to(ts)?;
        }
        self.advance(ts)
    }

    /// Decodes forward to the picture for `ts`, keeping the next one, and
    /// converts and caches the one for `ts`.
    #[allow(clippy::type_complexity)]
    fn advance(
        &mut self,
        ts: i64,
    ) -> std::result::Result<(ImageData, Option<Arc<MotionField>>, i64), String> {
        let mut candidate = self.lookahead.take();
        loop {
            let Some(next) = self.next_picture()? else {
                self.finished = true;
                break;
            };
            match &candidate {
                // The picture after the candidate is past `ts`: it stays for
                // the next call.
                Some(_) if next.pts > ts => {
                    self.lookahead = Some(next);
                    break;
                }
                // At or before `ts`, or the first picture there is, which is
                // shown for a `ts` before it.
                _ => candidate = Some(next),
            }
        }
        let picture = candidate.ok_or("it has no pictures")?;
        let until = self.lookahead.as_ref().map_or(i64::MAX, |n| n.pts);
        // Nothing comes before the first picture, so it is the one for every
        // earlier timestamp.
        let from = if picture.pts > ts {
            i64::MIN
        } else {
            picture.pts
        };
        let image = self.convert(&picture.frame)?;
        self.cache.insert(CachedPicture {
            from,
            until,
            pts: picture.pts,
            image: image.clone(),
            motion: picture.motion.clone(),
        });
        self.served_until = Some(until);
        Ok((image, picture.motion, picture.pts))
    }

    /// Makes the picture that follows the one last returned: converts the
    /// decoded one waiting (`lookahead`), decodes the one after it, and caches
    /// the first for its timestamps, as `advance` would when a frame asked
    /// for it. The pictures and the cache hold what they would anyway; only
    /// the time at which they are made moves (to a thread that is idle while
    /// the frame is drawn). Nothing happens unless the picture waiting is the
    /// one right after the last one returned, so a decoder works one picture
    /// ahead and no more.
    fn prefetch(&mut self) {
        let Some(waiting) = self.lookahead.as_ref().map(|d| d.pts) else {
            return;
        };
        if self.served_until != Some(waiting) {
            return;
        }
        let Some(first) = self.lookahead.take() else {
            return;
        };
        let image = match self.convert(&first.frame) {
            Ok(image) => image,
            Err(_) => {
                self.lookahead = Some(first);
                return;
            }
        };
        let until = match self.next_picture() {
            Ok(Some(next)) => {
                let until = next.pts;
                self.lookahead = Some(next);
                until
            }
            Ok(None) => {
                self.finished = true;
                i64::MAX
            }
            Err(_) => {
                // The error comes again when a frame asks for the next picture.
                self.lookahead = Some(first);
                return;
            }
        };
        self.cache.insert(CachedPicture {
            from: first.pts,
            until,
            pts: first.pts,
            image,
            motion: first.motion,
        });
    }

    /// Moves the stream to the keyframe at or before `ts` and starts decoding
    /// from there. A keyframe that turns out to be after `ts` (an index that
    /// is not exact) is tried again from further back.
    fn seek_to(&mut self, ts: i64) -> std::result::Result<(), String> {
        let mut target = ts;
        let mut step = self.info.second();
        for _ in 0..8 {
            self.seek(target)?;
            match self.next_picture()? {
                Some(first)
                    if first.pts > ts && ts >= self.info.start && target > self.info.start =>
                {
                    target = (target - step).max(self.info.start);
                    step = step.saturating_mul(2);
                }
                Some(first) => {
                    self.lookahead = Some(first);
                    return Ok(());
                }
                None => return Err("it has no pictures".into()),
            }
        }
        Err(format!("cannot find a keyframe before timestamp {ts}"))
    }

    /// Seeks the demuxer to the keyframe at or before `target` and resets the
    /// decoder; if the container cannot seek, reopens the file at its start.
    fn seek(&mut self, target: i64) -> std::result::Result<(), String> {
        self.input.clear_eof();
        // SAFETY: `input` is a live format context.
        let status = unsafe {
            ffmpeg::ffi::av_seek_frame(
                self.input.as_mut_ptr(),
                self.stream as c_int,
                target,
                ffmpeg::ffi::AVSEEK_FLAG_BACKWARD as c_int,
            )
        };
        if status < 0 {
            let (input, stream, decoder) = open_streams(&self.path, self.motion)?;
            self.input = input;
            self.stream = stream;
            self.decoder = decoder;
        } else {
            self.decoder.flush();
        }
        self.lookahead = None;
        self.finished = false;
        self.draining = false;
        self.last_pts = None;
        Ok(())
    }

    /// The next picture in presentation order, or `None` at the end of the
    /// stream.
    fn next_picture(&mut self) -> std::result::Result<Option<Decoded>, String> {
        loop {
            let mut frame = frame::Video::empty();
            match self.decoder.receive_frame(&mut frame) {
                Ok(()) => {
                    let Some(pts) = frame.timestamp() else {
                        return Err("a picture has no timestamp".into());
                    };
                    // Never go back: a repeat or an out-of-order picture is
                    // not a picture of its own.
                    if self.last_pts.is_some_and(|last| pts <= last) {
                        continue;
                    }
                    self.last_pts = Some(pts);
                    let motion = self.motion.then(|| Arc::new(motion_field(&frame)));
                    return Ok(Some(Decoded { pts, frame, motion }));
                }
                Err(AvError::Eof) => return Ok(None),
                Err(AvError::Other { errno }) if errno == ffmpeg::error::EAGAIN => {}
                Err(e) => return Err(format!("cannot decode: {e}")),
            }
            if self.draining {
                return Ok(None);
            }
            self.feed()?;
        }
    }

    /// Gives the decoder the next packet of the stream, or the end of it.
    fn feed(&mut self) -> std::result::Result<(), String> {
        loop {
            let mut packet = Packet::empty();
            match packet.read(&mut self.input) {
                Ok(()) if packet.stream() != self.stream => {}
                Ok(()) => match self.decoder.send_packet(&packet) {
                    Ok(()) => return Ok(()),
                    // A packet the decoder cannot use is skipped.
                    Err(AvError::InvalidData) => {}
                    Err(e) => return Err(format!("cannot decode: {e}")),
                },
                Err(AvError::Eof) => {
                    self.draining = true;
                    // A decoder that is already draining says so; nothing to
                    // do about it.
                    let _ = self.decoder.send_eof();
                    return Ok(());
                }
                Err(AvError::InvalidData) => {}
                Err(e) => return Err(format!("cannot read: {e}")),
            }
        }
    }

    /// The picture as straight-alpha sRGB RGBA8 (`packages/cli/skills/kinetograph/references/SCENE.md`, "video",
    /// "Colour").
    fn convert(&mut self, picture: &frame::Video) -> std::result::Result<ImageData, String> {
        let (format, width, height) = (picture.format(), picture.width(), picture.height());
        let key = (
            format,
            width,
            height,
            picture.color_space(),
            picture.color_range(),
        );
        if self.scaler.as_ref().is_none_or(|s| s.key != key) {
            let flags = ScaleFlags::BICUBIC
                | ScaleFlags::ACCURATE_RND
                | ScaleFlags::FULL_CHR_H_INT
                | ScaleFlags::BITEXACT;
            let mut context =
                scaling::Context::get(format, width, height, Pixel::RGBA, width, height, flags)
                    .map_err(|e| format!("cannot convert {format:?} pictures: {e}"))?;
            set_colour(&mut context, key)?;
            self.scaler = Some(Scaler {
                context,
                key,
                rgba: frame::Video::empty(),
            });
        }
        let scaler = self.scaler.as_mut().expect("just made");
        scaler
            .context
            .run(picture, &mut scaler.rgba)
            .map_err(|e| format!("cannot convert a picture: {e}"))?;
        // Rows are padded to FFmpeg's alignment; the image is tightly packed.
        let stride = scaler.rgba.stride(0);
        let data = scaler.rgba.data(0);
        let row = width as usize * 4;
        let mut rgba = Vec::with_capacity(row * height as usize);
        for y in 0..height as usize {
            rgba.extend_from_slice(&data[y * stride..y * stride + row]);
        }
        Ok(ImageData {
            data: Blob::from(rgba),
            format: ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::Alpha,
            width,
            height,
        })
    }
}

/// Opens the container, finds the first video stream and opens its decoder.
fn open_streams(
    path: &Path,
    motion: bool,
) -> std::result::Result<(format::context::Input, usize, ffmpeg::decoder::Video), String> {
    init();
    let input = format::input(path).map_err(|e| format!("cannot open: {e}"))?;
    let stream = video_stream(&input).ok_or("it has no video stream")?;
    let index = stream.index();
    let context = codec::Context::from_parameters(stream.parameters())
        .map_err(|e| format!("cannot set up the decoder: {e}"))?;
    let mut decoder = context.decoder();
    decoder.set_packet_time_base(stream.time_base());
    if motion {
        // SAFETY: the decoder is not open yet, so its flags are still ours to set.
        unsafe {
            (*decoder.as_mut_ptr()).flags2 |= ffmpeg::ffi::AV_CODEC_FLAG2_EXPORT_MVS as c_int;
        }
    }
    let decoder = decoder
        .video()
        .map_err(|e| format!("cannot open the decoder: {e}"))?;
    Ok((input, index, decoder))
}

/// The motion vectors FFmpeg attached to a decoded picture
/// (`AV_FRAME_DATA_MOTION_VECTORS`, there when the decoder was opened with
/// `export_mvs`), as a field. A picture without them (a keyframe) does not move.
fn motion_field(picture: &frame::Video) -> MotionField {
    let (width, height) = (picture.width() as usize, picture.height() as usize);
    let Some(side) = picture.side_data(ffmpeg::frame::side_data::Type::MotionVectors) else {
        return MotionField::still(width, height);
    };
    let data = side.data();
    let size = std::mem::size_of::<ffmpeg::ffi::AVMotionVector>();
    let vectors: Vec<Vector> = (0..data.len() / size)
        .map(|i| {
            // SAFETY: `data` holds `len / size` whole AVMotionVector structs; the read tolerates any alignment.
            let v = unsafe {
                std::ptr::read_unaligned(data.as_ptr().add(i * size).cast::<ffmpeg::ffi::AVMotionVector>())
            };
            Vector {
                source: v.source,
                w: v.w,
                h: v.h,
                dst_x: v.dst_x,
                dst_y: v.dst_y,
                motion_x: v.motion_x,
                motion_y: v.motion_y,
                motion_scale: v.motion_scale,
            }
        })
        .collect();
    MotionField::from_vectors(width, height, &vectors)
}

/// Sets swscale's matrix and ranges for a YUV source: the picture's own
/// matrix and range, and for an untagged one BT.709 from 720 lines up and
/// BT.601 below, and limited range (`packages/cli/skills/kinetograph/references/SCENE.md`, "video", "Colour").
fn set_colour(
    context: &mut scaling::Context,
    (format, _, height, space, range): (Pixel, u32, u32, color::Space, color::Range),
) -> std::result::Result<(), String> {
    use ffmpeg::ffi::{
        SWS_CS_BT2020, SWS_CS_FCC, SWS_CS_ITU601, SWS_CS_ITU709, SWS_CS_SMPTE240M,
        sws_getCoefficients, sws_setColorspaceDetails,
    };
    let Some(descriptor) = format.descriptor() else {
        return Ok(());
    };
    // SAFETY: the descriptor is static.
    let flags = unsafe { (*descriptor.as_ptr()).flags };
    if flags & (ffmpeg::ffi::AV_PIX_FMT_FLAG_RGB as u64) != 0 {
        // RGB in, RGB out: no matrix is involved.
        return Ok(());
    }
    let matrix = match space {
        color::Space::BT709 => SWS_CS_ITU709,
        color::Space::FCC => SWS_CS_FCC,
        color::Space::BT470BG | color::Space::SMPTE170M => SWS_CS_ITU601,
        color::Space::SMPTE240M => SWS_CS_SMPTE240M,
        color::Space::BT2020NCL | color::Space::BT2020CL => SWS_CS_BT2020,
        _ if height >= 720 => SWS_CS_ITU709,
        _ => SWS_CS_ITU601,
    };
    let full_range = match range {
        color::Range::JPEG => true,
        color::Range::MPEG => false,
        // The deprecated `yuvj` formats say full range themselves.
        color::Range::Unspecified => matches!(
            format,
            Pixel::YUVJ420P | Pixel::YUVJ422P | Pixel::YUVJ444P | Pixel::YUVJ440P
        ),
    };
    // SAFETY: `context` is a live swscale context and the table comes from
    // swscale itself; both outlive the call. The table is for whichever side
    // is YUV, so it is given for both.
    let status = unsafe {
        let table = sws_getCoefficients(matrix as c_int);
        sws_setColorspaceDetails(
            context.as_mut_ptr(),
            table,
            c_int::from(full_range),
            table,
            1,
            0,
            1 << 16,
            1 << 16,
        )
    };
    // A source with fewer than three components (grey) has no matrix to set.
    if status < 0 && descriptor.nb_components() >= 3 {
        return Err("swscale cannot set the colour matrix for this conversion".into());
    }
    Ok(())
}

/// Every video file of a scene, opened, by `src`.
#[derive(Default)]
pub struct Videos {
    decoders: HashMap<String, Arc<Mutex<VideoDecoder>>>,
    /// The thread that makes the next picture of a decoder while the frame
    /// that used the last one is drawn (`VideoDecoder::prefetch`).
    ahead: Option<std::sync::mpsc::Sender<Arc<Mutex<VideoDecoder>>>>,
}

/// Whether pictures are made ahead of the frame that asks for them
/// (`KINETOGRAPH_NO_PREFETCH=1` turns it off).
fn prefetching() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("KINETOGRAPH_NO_PREFETCH").is_none())
}

impl Videos {
    pub fn is_empty(&self) -> bool {
        self.decoders.is_empty()
    }

    /// Keeps `decoder` as the one `src` names, replacing one of the same name.
    pub(crate) fn insert(&mut self, src: String, decoder: VideoDecoder) {
        self.decoders.insert(src, Arc::new(Mutex::new(decoder)));
    }

    /// The picture file `src` shows at `time`, as an image to draw. The same
    /// picture twice is the same `ImageData` (and so the same image
    /// for Skia), while it is among the decoder's recent ones.
    pub fn image(&mut self, src: &str, time: MediaTime) -> Result<ImageData> {
        let decoder = self
            .decoders
            .get(src)
            .ok_or_else(|| Error::Render(format!("video {src:?} was not loaded")))?
            .clone();
        let image = decoder
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .picture(time.ts)
            .map_err(|e| Error::Render(format!("video {src:?} at {:.3} s: {e}", time.seconds)))?;
        if prefetching() {
            self.prefetch(decoder);
        }
        Ok(image)
    }

    /// Asks the prefetch thread (started on the first call) for the picture
    /// after the one `decoder` just returned.
    fn prefetch(&mut self, decoder: Arc<Mutex<VideoDecoder>>) {
        let ahead = self.ahead.get_or_insert_with(|| {
            let (sender, jobs) = std::sync::mpsc::channel::<Arc<Mutex<VideoDecoder>>>();
            std::thread::Builder::new()
                .name("kinetograph-video".to_string())
                .spawn(move || {
                    for decoder in jobs {
                        decoder.lock().unwrap_or_else(|e| e.into_inner()).prefetch();
                    }
                })
                .expect("cannot start the video thread");
            sender
        });
        let _ = ahead.send(decoder);
    }
}

/// The `(layer id, src)` of every video layer in the scene, motion-blur copies
/// included, in order of use. One used twice is listed twice.
pub(crate) fn video_sources(scene: &Scene) -> Vec<(String, String)> {
    let mut sources = Vec::new();
    walk_layers(&scene.layers, &mut |layer| {
        if let LayerKind::Video(v) = &layer.kind {
            sources.push((layer.id.clone(), v.src.clone()));
        }
    });
    sources
}

/// Opens the video `src` of layer `id`, relative to `base_dir`; the error
/// names the layer and the file.
pub(crate) fn open_video(base_dir: &Path, id: &str, src: &str) -> Result<VideoDecoder> {
    let path = base_dir.join(src);
    let fail = |e: String| Error::Render(format!("layer {id:?}: video {}: {e}", path.display()));
    let info = probe(&path).map_err(fail)?;
    VideoDecoder::open(&path, info).map_err(fail)
}

/// Opens every video the scene refers to. The renderer opens them a file at a
/// time (`render::read_assets`); this is for the test that every committed
/// scene's files load.
#[cfg(test)]
pub(crate) fn load_videos(scene: &Scene) -> Result<Videos> {
    let mut videos = Videos::default();
    for (id, src) in video_sources(scene) {
        if videos.decoders.contains_key(&src) {
            continue;
        }
        let decoder = open_video(&scene.base_dir, &id, &src)?;
        videos.insert(src, decoder);
    }
    Ok(videos)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media_path(file: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/scenes/media")
            .join(file)
    }

    fn decoder(file: &str) -> VideoDecoder {
        let path = media_path(file);
        let info = probe(&path).unwrap_or_else(|e| panic!("{file}: {e}"));
        VideoDecoder::open(&path, info).unwrap()
    }

    /// The RGBA bytes of an image.
    fn bytes(image: &ImageData) -> Vec<u8> {
        image.data.as_ref().to_vec()
    }

    fn px(image: &ImageData, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * image.width + x) * 4) as usize;
        let d = image.data.as_ref();
        [d[i], d[i + 1], d[i + 2], d[i + 3]]
    }

    // --- The time rules (packages/cli/skills/kinetograph/references/SCENE.md, "video"). -----------------------------

    fn clip(from: f64, before: f64, after: Option<f64>, rate: f64, looped: bool) -> Clip {
        Clip {
            from,
            trim_before: before,
            trim_after: after,
            playback_rate: rate,
            looped,
        }
    }

    /// A clip with no trims, from frame 0, at the scene's pace: a 30 fps scene
    /// and a 2 second file.
    fn plain() -> Clip {
        clip(0.0, 0.0, None, 1.0, false)
    }

    #[test]
    fn the_source_time_follows_the_frame_and_the_rate() {
        // Frame 15 of a 30 fps scene is half a second in.
        assert_eq!(plain().source_time(15.0, 30.0, 2.0), 0.5);
        // `from` delays the clip: its frame 0 falls on scene frame 10.
        let late = clip(10.0, 0.0, None, 1.0, false);
        assert_eq!(late.source_time(10.0, 30.0, 2.0), 0.0);
        assert_eq!(late.source_time(25.0, 30.0, 2.0), 0.5);
        // Before `from` the first picture is held.
        assert_eq!(late.source_time(3.0, 30.0, 2.0), 0.0);
        // A rate of 2 covers the file twice as fast; of 0.5 half as fast.
        assert_eq!(
            clip(0.0, 0.0, None, 2.0, false).source_time(15.0, 30.0, 4.0),
            1.0
        );
        assert_eq!(
            clip(0.0, 0.0, None, 0.5, false).source_time(15.0, 30.0, 4.0),
            0.25
        );
        // Fractional frames (motion blur sub-frames) are their own times.
        assert_eq!(plain().source_time(14.75, 30.0, 2.0), 14.75 / 30.0);
    }

    #[test]
    fn trims_skip_the_start_and_end_the_clip_early() {
        // trimBefore 15 frames skips half a second of the file.
        let trimmed = clip(0.0, 15.0, None, 1.0, false);
        assert_eq!(trimmed.source_time(0.0, 30.0, 2.0), 0.5);
        assert_eq!(trimmed.source_time(15.0, 30.0, 2.0), 1.0);
        // The clip ends at the end of the file, 60 frames from its start: 45
        // frames after `trimBefore`.
        assert_eq!(trimmed.source_time(45.0, 30.0, 2.0), 2.0);
        assert_eq!(trimmed.source_time(90.0, 30.0, 2.0), 2.0);
        // trimAfter ends it sooner, in frames from the start of the file.
        let cut = clip(0.0, 15.0, Some(45.0), 1.0, false);
        assert_eq!(cut.end(30.0, 2.0), 1.5);
        assert_eq!(cut.source_time(30.0, 30.0, 2.0), 1.5);
        assert_eq!(cut.source_time(1000.0, 30.0, 2.0), 1.5);
    }

    #[test]
    fn a_loop_starts_again_at_trim_before() {
        let looped = clip(0.0, 15.0, Some(45.0), 1.0, true);
        // The clip is 30 frames long (file frames 15 to 45).
        assert_eq!(looped.source_time(0.0, 30.0, 2.0), 0.5);
        assert_eq!(looped.source_time(15.0, 30.0, 2.0), 1.0);
        assert_eq!(looped.source_time(30.0, 30.0, 2.0), 0.5);
        assert_eq!(looped.source_time(45.0, 30.0, 2.0), 1.0);
        // Frames before `from` wrap too.
        let late = clip(10.0, 0.0, None, 1.0, true);
        assert_eq!(late.source_time(0.0, 30.0, 2.0), 50.0 / 30.0);
        // The rate applies before the wrap.
        let fast = clip(0.0, 0.0, None, 2.0, true);
        assert_eq!(fast.source_time(45.0, 30.0, 2.0), 30.0 / 30.0);
    }

    #[test]
    fn the_picture_is_the_last_one_at_or_before_the_time() {
        let info = VideoInfo {
            width: 4,
            height: 4,
            time_base: (1, 1000),
            start: 480,
            duration: 2.0,
            fps: None,
            frames: None,
            has_audio: false,
            video_codec: "h264".into(),
            audio_codec: None,
        };
        // Times are from the first picture, whose timestamp is 480.
        assert_eq!(info.media_time(0.0, 2.0).ts, 480);
        assert_eq!(info.media_time(0.5, 2.0).ts, 980);
        // Rounded to the nearest tick.
        assert_eq!(info.media_time(0.0004, 2.0).ts, 480);
        assert_eq!(info.media_time(0.0006, 2.0).ts, 481);
        // At or past the end, the last picture before it.
        assert_eq!(info.media_time(2.0, 2.0).ts, 480 + 1999);
        assert_eq!(info.media_time(9.0, 2.0).ts, 480 + 1999);
        assert_eq!(info.media_time(1.5, 1.5).ts, 480 + 1499);
        // Before the first picture, the first.
        assert_eq!(info.media_time(-1.0, 2.0).ts, 480);
        // The time keeps its exact value, and two times that pick the same
        // picture are equal.
        assert_eq!(info.media_time(0.25, 2.0).seconds, 0.25);
        assert_eq!(info.media_time(0.0004, 2.0), info.media_time(0.0, 2.0));
        assert_ne!(info.media_time(0.0006, 2.0), info.media_time(0.0, 2.0));
    }

    // --- Probing. ---------------------------------------------------------------

    #[test]
    fn probe_reads_the_container_without_decoding() {
        let clip = probe(&media_path("clip.mp4")).unwrap();
        assert_eq!((clip.width, clip.height), (64, 36));
        assert_eq!(clip.video_codec, "h264");
        assert_eq!(clip.fps, Some(24.0));
        assert_eq!(clip.frames, Some(48));
        assert!(!clip.has_audio && clip.audio_codec.is_none());
        assert_eq!(clip.start, 0);
        assert!((clip.duration - 2.0).abs() < 1e-6, "{}", clip.duration);

        // A WebM that starts at 0.48 s: the start is that, and the duration
        // is the video's length (1.2 s), not where it ends (1.68 s).
        let offset = probe(&media_path("offset.webm")).unwrap();
        assert_eq!((offset.width, offset.height), (48, 28));
        assert_eq!(offset.video_codec, "vp9");
        assert_eq!(offset.time_base, (1, 1000));
        assert_eq!(offset.start, 480);
        assert!((offset.duration - 1.2).abs() < 0.05, "{}", offset.duration);

        let audio = probe(&media_path("with-audio.mp4")).unwrap();
        assert!(audio.has_audio);
        assert_eq!(audio.audio_codec.as_deref(), Some("aac"));
    }

    #[test]
    fn probe_says_what_is_wrong_with_a_file() {
        let missing = probe(&media_path("nope.mp4")).unwrap_err();
        assert!(missing.contains("cannot read"), "{missing}");
        // A WAV has no video stream.
        let sound = probe(&media_path("tone-mono.wav")).unwrap_err();
        assert!(sound.contains("no video stream"), "{sound}");
        // Something that is not media at all.
        let script = probe(&media_path("make_gif.py")).unwrap_err();
        assert!(script.contains("cannot open"), "{script}");
    }

    // --- Decoding. --------------------------------------------------------------

    /// The timestamp of picture `n` of clip.mp4 (24 fps, time base 1/12288).
    fn mp4_ts(n: i64) -> i64 {
        n * 512
    }

    #[test]
    fn pictures_move_with_time_and_hold_between_frames() {
        let mut clip = decoder("clip.mp4");
        let first = clip.picture(mp4_ts(0)).unwrap();
        assert_eq!((first.width, first.height), (64, 36));
        assert_eq!(first.alpha_type, ImageAlphaType::Alpha);
        let second = clip.picture(mp4_ts(1)).unwrap();
        assert_ne!(bytes(&first), bytes(&second), "testsrc2 moves");
        // Anywhere from one picture's timestamp to just before the next is
        // that picture.
        assert_eq!(
            bytes(&clip.picture(mp4_ts(1) + 511).unwrap()),
            bytes(&second)
        );
        assert_eq!(
            bytes(&clip.picture(mp4_ts(1) + 100).unwrap()),
            bytes(&second)
        );
        // Before the first picture, the first.
        assert_eq!(bytes(&clip.picture(-5000).unwrap()), bytes(&first));
        // Past the last, the last.
        let last = clip.picture(mp4_ts(47)).unwrap();
        assert_eq!(
            bytes(&clip.picture(mp4_ts(47) + 100_000).unwrap()),
            bytes(&last)
        );
        // Opaque, and in the picture's own colours: testsrc2 has no alpha.
        assert!(bytes(&last).chunks(4).all(|p| p[3] == 255));
    }

    /// Pictures 0 to 47 of clip.mp4 asked for in `order`, each by a decoder
    /// that has only ever been asked what `order` says.
    fn pictures_in_order(file: &str, stamps: &[i64], order: &[usize]) -> Vec<Vec<u8>> {
        let mut decoder = decoder(file);
        let mut out = vec![Vec::new(); stamps.len()];
        for &i in order {
            out[i] = bytes(&decoder.picture(stamps[i]).unwrap());
        }
        out
    }

    #[test]
    fn a_picture_does_not_depend_on_what_was_decoded_before() {
        let stamps: Vec<i64> = (0..48).map(mp4_ts).collect();
        let in_order: Vec<usize> = (0..48).collect();
        let reference = pictures_in_order("clip.mp4", &stamps, &in_order);

        // Backwards: every step is a jump back, so every picture is a seek.
        let backwards: Vec<usize> = (0..48).rev().collect();
        // Jumps forward and back, over several keyframes (every 12 pictures).
        let mut jumps: Vec<usize> = Vec::new();
        for i in 0..48 {
            jumps.push((i * 17) % 48);
        }
        // Skipping ahead by more than a second (24 pictures) and back.
        let skips = vec![0, 40, 3, 47, 11, 12, 13, 30, 29, 5];
        for order in [backwards, jumps, skips] {
            let got = pictures_in_order("clip.mp4", &stamps, &order);
            for &i in &order {
                assert_eq!(got[i], reference[i], "picture {i} of order {order:?}");
            }
        }

        // The same on one decoder, in order and then out of order, with the
        // cache holding nothing it could be served from.
        let mut decoder = decoder("clip.mp4");
        for i in 0..48 {
            assert_eq!(bytes(&decoder.picture(stamps[i]).unwrap()), reference[i]);
        }
        for i in [47, 0, 24, 23, 36, 1, 35, 2] {
            decoder.cache = PictureCache::default();
            assert_eq!(
                bytes(&decoder.picture(stamps[i]).unwrap()),
                reference[i],
                "{i}"
            );
        }
        // Different pictures differ, so the comparison above means something.
        assert_ne!(reference[0], reference[1]);
        assert_ne!(reference[12], reference[13]);
    }

    #[test]
    fn a_stream_that_starts_late_is_measured_from_its_first_picture() {
        let info = probe(&media_path("offset.webm")).unwrap();
        let mut decoder = decoder("offset.webm");
        // The first picture is at 480 ticks; time 0 of the clip is there, and
        // so is everything before it.
        let first = decoder.picture(info.start).unwrap();
        assert_eq!(bytes(&decoder.picture(0).unwrap()), bytes(&first));
        assert_eq!(
            bytes(
                &decoder
                    .picture(info.media_time(0.0, info.duration).ts)
                    .unwrap()
            ),
            bytes(&first)
        );
        // 25 fps: picture 10 is 0.4 s on.
        let tenth = decoder
            .picture(info.media_time(0.4, info.duration).ts)
            .unwrap();
        assert_ne!(bytes(&tenth), bytes(&first));
        // Order does not matter here either (a keyframe every 10 pictures).
        let stamps: Vec<i64> = (0..30).map(|n| info.start + n * 40).collect();
        let forwards: Vec<usize> = (0..30).collect();
        let reference = pictures_in_order("offset.webm", &stamps, &forwards);
        let shuffled: Vec<usize> = (0..30).map(|i| (i * 7) % 30).collect();
        let got = pictures_in_order("offset.webm", &stamps, &shuffled);
        for &i in &shuffled {
            assert_eq!(got[i], reference[i], "picture {i}");
        }
    }

    #[test]
    fn colours_are_read_with_the_untagged_defaults() {
        // clip.mp4 is untagged and 36 lines tall: BT.601, limited range. The
        // expected pixels are what the ffmpeg command line gives for its first
        // picture with the same scaler flags and no tags:
        //   ffmpeg -i clip.mp4 -frames:v 1 -vf scale=flags=bicubic+accurate_rnd+full_chroma_int+bitexact,format=rgba -f rawvideo -
        let mut decoder = decoder("clip.mp4");
        let picture = decoder.picture(0).unwrap();
        for ((x, y), want) in [
            ((1, 1), [110, 8, 241, 255]),
            ((62, 1), [49, 240, 238, 255]),
            ((10, 18), [74, 2, 10, 255]),
            ((32, 30), [7, 1, 40, 255]),
            ((50, 34), [62, 0, 55, 255]),
        ] {
            assert_eq!(px(&picture, x, y), want, "({x}, {y})");
        }
    }

    // --- Motion vectors (datamosh). -------------------------------------------

    /// Both codecs the engine moshes are exercised: H.264 (quarter-pixel vectors) and
    /// MPEG-4 part 2 (half-pixel). Each file is 96 x 54, 24 pictures, one keyframe.
    const MOTION_FILES: [&str; 2] = ["mosh-h264.mp4", "mosh-mpeg4.mp4"];

    #[test]
    fn a_decoder_with_motion_gives_vectors_and_the_same_pictures() {
        for file in MOTION_FILES {
            let path = media_path(file);
            let info = probe(&path).unwrap();
            assert!(crate::datamosh::exports_vectors(&info.video_codec), "{file}");
            let tick = info.second() / 24;
            let mut with = VideoDecoder::open_with_motion(&path, info.clone()).unwrap();
            let mut plain = VideoDecoder::open(&path, info).unwrap();
            let mut moving = 0;
            for i in 0..24 {
                let got = with.picture_motion(i * tick).unwrap();
                let want = plain.picture(i * tick).unwrap();
                // The vectors change no pixel.
                assert_eq!(bytes(&got.image), bytes(&want), "{file} picture {i}");
                assert_eq!((got.motion.width, got.motion.height), (96, 54));
                if i == 0 {
                    // A keyframe has no vectors: nothing moves.
                    assert!(got.motion.is_still(), "{file}: the keyframe moved");
                } else if !got.motion.is_still() {
                    moving += 1;
                }
            }
            assert!(moving >= 3, "{file}: only {moving} pictures had motion");
            // A picture asked for again, or after a seek back, has the same vectors.
            let again = with.picture_motion(5 * tick).unwrap();
            let back = with.picture_motion(5 * tick).unwrap();
            assert_eq!(again.motion, back.motion);
            assert_eq!(again.pts, 5 * tick);
            let mut fresh = VideoDecoder::open_with_motion(&path, probe(&path).unwrap()).unwrap();
            assert_eq!(fresh.picture_motion(5 * tick).unwrap().motion, again.motion, "{file}");
        }
    }

    #[test]
    fn a_decoder_without_motion_says_so() {
        let mut plain = decoder("mosh-h264.mp4");
        let err = plain.picture_motion(0).err().unwrap();
        assert!(err.contains("motion vectors"), "{err}");
    }

    #[test]
    fn the_picture_cache_is_bounded() {
        let mut cache = PictureCache::default();
        let big = |from, until| CachedPicture {
            from,
            until,
            pts: from,
            motion: None,
            image: ImageData {
                data: Blob::from(vec![0_u8; 32 << 20]),
                format: ImageFormat::Rgba8,
                alpha_type: ImageAlphaType::Alpha,
                width: 4096,
                height: 2048,
            },
        };
        for i in 0..20 {
            cache.insert(big(i, i + 1));
        }
        // 32 MiB each: the budget holds two, and the floor of four applies.
        assert_eq!(cache.entries.len(), MIN_CACHED);
        assert!(cache.bytes <= MIN_CACHED * (32 << 20));
        // The most recent are kept, and found by timestamp.
        assert!(cache.find(19).is_some());
        assert!(cache.find(0).is_none());
    }

    #[test]
    fn a_missing_picture_is_an_error_naming_the_file() {
        let mut videos = Videos::default();
        let time = MediaTime {
            seconds: 0.0,
            ts: 0,
        };
        let err = videos.image("nope.mp4", time).unwrap_err().to_string();
        assert!(err.contains("nope.mp4"), "{err}");
        let err = open_video(Path::new("."), "clip", "nope.mp4")
            .err()
            .unwrap()
            .to_string();
        assert!(
            err.contains("\"clip\"") && err.contains("nope.mp4"),
            "{err}"
        );
    }
}
