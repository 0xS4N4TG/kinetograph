//! Encoders the linked ffmpeg lacks, run by a separate `ffmpeg` program.
//!
//! The ffmpeg linked into the addon is LGPL-only and has no libx264 or libx265 (both GPL). Kinetograph's platform
//! packages ship a second, GPL `ffmpeg` executable with them (`scripts/build-ffmpeg-gpl.sh`); like Remotion's, it is
//! only ever run as a child process, never linked. This module finds it, asks it which encoders it has, and drives it:
//! raw pictures in on a pipe, a video-only file out. Audio is muxed afterwards by the linked ffmpeg like any other
//! video (`encode::mux_audio`).
//!
//! Where the program comes from, first match wins: `KINETOGRAPH_FFMPEG`, the path the host gave (`set_path`: the
//! platform package's `bin/ffmpeg`), `ffmpeg` on the `PATH` when it lists libx264.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;

use crate::encode::{self, Pix, Quality, Resolved};

/// Names the program can be found under on the `PATH`.
const PROGRAM: &str = if cfg!(windows) {
    "ffmpeg.exe"
} else {
    "ffmpeg"
};

static CONFIGURED: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Sets the path the host knows (the platform package's `bin/ffmpeg`); `None` forgets it.
pub fn set_path(path: Option<PathBuf>) {
    *CONFIGURED.lock().unwrap_or_else(|e| e.into_inner()) = path;
}

/// What `-encoders` said for one program: the encoder names, or `None` when it did not run.
type Probed = Option<Vec<String>>;

fn probes() -> &'static Mutex<HashMap<PathBuf, Probed>> {
    static PROBES: OnceLock<Mutex<HashMap<PathBuf, Probed>>> = OnceLock::new();
    PROBES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The encoder names in the output of `ffmpeg -encoders`.
fn parse_encoders(listing: &str) -> Vec<String> {
    listing
        .lines()
        .skip_while(|l| !l.trim_start().starts_with("------"))
        .skip(1)
        .filter_map(|l| {
            let mut words = l.split_whitespace();
            let flags = words.next()?;
            // "V....D", "A....D", "S.....": six flag characters, then the name.
            (flags.len() == 6).then(|| words.next().map(str::to_string))?
        })
        .collect()
}

/// The encoders `program` has, asked once per program.
fn encoders_of(program: &Path) -> Probed {
    let mut cache = probes().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(known) = cache.get(program) {
        return known.clone();
    }
    let listed = Command::new(program)
        .args(["-hide_banner", "-loglevel", "error", "-encoders"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_encoders(&String::from_utf8_lossy(&o.stdout)));
    cache.insert(program.to_path_buf(), listed.clone());
    listed
}

/// The ffmpeg program to run and the encoders it has.
fn found() -> Option<(PathBuf, Vec<String>)> {
    let env = std::env::var_os("KINETOGRAPH_FFMPEG").filter(|v| !v.is_empty());
    let configured = CONFIGURED.lock().unwrap_or_else(|e| e.into_inner()).clone();
    for candidate in [env.map(PathBuf::from), configured].into_iter().flatten() {
        if let Some(list) = encoders_of(&candidate) {
            return Some((candidate, list));
        }
    }
    // The PATH's ffmpeg counts only when it has the encoder this exists for.
    let path = PathBuf::from(PROGRAM);
    encoders_of(&path)
        .filter(|list| list.iter().any(|n| n == encode::DEFAULT_ENCODER))
        .map(|list| (path, list))
}

/// Whether the external ffmpeg has an encoder called `name`.
pub fn has_encoder(name: &str) -> bool {
    found().is_some_and(|(_, list)| list.iter().any(|n| n == name))
}

/// The ffmpeg program that has `name`, for a message.
pub fn program_for(name: &str) -> Option<PathBuf> {
    found().and_then(|(p, list)| list.iter().any(|n| n == name).then_some(p))
}

/// The options of `-c:v` for `settings`, the same values the linked encoders get (`encode::encoder_options`).
fn encoder_args(settings: &Resolved, width: u32, height: u32, fps: f64) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let mut push = |k: &str, v: String| {
        a.push(k.to_string());
        a.push(v);
    };
    push("-c:v", settings.encoder.clone());
    match settings.encoder.as_str() {
        "libx264" | "libx265" => {
            let default_crf = if settings.encoder == "libx264" {
                "18"
            } else {
                "28"
            };
            match settings.quality {
                Quality::Bitrate(bits) => push("-b:v", bits.to_string()),
                Quality::Crf(crf) => push("-crf", crf.to_string()),
                Quality::Default => push("-crf", default_crf.into()),
            }
            push("-preset", "medium".into());
            if settings.encoder == "libx265" {
                push("-x265-params", "log-level=error".into());
            }
        }
        "libvpx-vp9" => {
            match settings.quality {
                Quality::Bitrate(bits) => push("-b:v", bits.to_string()),
                Quality::Crf(crf) => {
                    push("-b:v", "0".into());
                    push("-crf", crf.to_string());
                }
                Quality::Default => {
                    push("-b:v", "0".into());
                    push("-crf", "30".into());
                }
            }
            push("-deadline", "good".into());
            push("-cpu-used", "4".into());
            push("-row-mt", "1".into());
        }
        _ => match settings.quality {
            Quality::Bitrate(bits) => push("-b:v", bits.to_string()),
            _ => push("-b:v", encode::bit_rate(width, height, fps).to_string()),
        },
    }
    if settings.codec == encode::Codec::H265 {
        // QuickTime and Safari play HEVC in MP4/MOV only when it is tagged hvc1.
        push("-tag:v", "hvc1".into());
    }
    a
}

/// A running ffmpeg taking raw pictures of one pixel format on its standard input and writing a video-only file.
pub struct ExternalEncoder {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr: Option<thread::JoinHandle<String>>,
    program: PathBuf,
    pix: Pix,
    width: u32,
    height: u32,
    frames: u32,
    /// The last picture sent, for `push_repeat`.
    last: Option<Vec<u8>>,
}

impl ExternalEncoder {
    /// Starts the ffmpeg that has `settings.encoder`, writing `path` (a file of container `settings.container`).
    pub fn create(
        path: &Path,
        width: u32,
        height: u32,
        fps: f64,
        settings: &Resolved,
    ) -> Result<ExternalEncoder, String> {
        if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
            return Err(format!(
                "{width}x{height} has an odd side: video needs an even width and height"
            ));
        }
        if !settings.pix.is_yuv() || settings.pix.name() != settings.pix.file_name() {
            return Err(format!(
                "the external ffmpeg takes planar YUV pictures, not {}",
                settings.pix.name()
            ));
        }
        let (num, den) = encode::fps_rational(fps)?;
        let program = program_for(&settings.encoder).ok_or_else(|| {
            format!(
                "no ffmpeg with the {} encoder was found (set KINETOGRAPH_FFMPEG to one)",
                settings.encoder
            )
        })?;
        let mut args: Vec<OsString> = Vec::new();
        let mut arg = |s: &str| args.push(s.into());
        for s in ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"] {
            arg(s);
        }
        // The pictures are already in the pixel format the file holds, so ffmpeg converts nothing.
        for s in [
            "-f",
            "rawvideo",
            "-pix_fmt",
            settings.pix.name(),
            "-s",
            &format!("{width}x{height}"),
            "-framerate",
            &format!("{num}/{den}"),
            "-i",
            "pipe:0",
            "-an",
        ] {
            arg(s);
        }
        for s in encoder_args(settings, width, height, fps) {
            arg(&s);
        }
        // The same tags the linked encoder puts on the stream (BT.709, limited range).
        for s in [
            "-pix_fmt",
            settings.pix.name(),
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-color_range",
            "tv",
            "-fps_mode",
            "cfr",
        ] {
            arg(s);
        }
        if matches!(settings.container, "mp4" | "mov") {
            arg("-movflags");
            arg("+faststart");
        }
        arg("-f");
        arg(settings.container);
        args.push(path.into());

        let mut child = Command::new(&program)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot run {}: {e}", program.display()))?;
        let stdin = child.stdin.take();
        // Drained on a thread so that a chatty child cannot fill the pipe and stall.
        let mut err = child.stderr.take().ok_or("no stderr on the ffmpeg child")?;
        let stderr = thread::spawn(move || {
            let mut text = String::new();
            let mut raw = Vec::new();
            let _ = err.read_to_end(&mut raw);
            text.push_str(&String::from_utf8_lossy(&raw));
            text
        });
        Ok(ExternalEncoder {
            child,
            stdin,
            stderr: Some(stderr),
            program,
            pix: settings.pix,
            width,
            height,
            frames: 0,
            last: None,
        })
    }

    /// Encodes the next frame: tightly packed RGBA8, converted here exactly as the linked encoder would.
    pub fn push(&mut self, rgba: &[u8]) -> Result<(), String> {
        let planes = encode::rgba_to_planes(rgba, self.width, self.height, self.pix)?;
        self.push_yuv_owned(planes)
    }

    /// Encodes the next frame from planes converted elsewhere (`encode::rgba_to_planes`).
    pub fn push_yuv(&mut self, planes: &[u8]) -> Result<(), String> {
        self.push_yuv_owned(planes.to_vec())
    }

    /// Encodes the last picture again.
    pub fn push_repeat(&mut self) -> Result<(), String> {
        let last = self
            .last
            .take()
            .ok_or("a frame was repeated before any frame was sent")?;
        self.push_yuv_owned(last)
    }

    fn push_yuv_owned(&mut self, planes: Vec<u8>) -> Result<(), String> {
        let expected: usize = self
            .pix
            .planes(self.width as usize, self.height as usize)
            .iter()
            .map(|(row, rows)| row * rows)
            .sum();
        if planes.len() != expected {
            return Err(format!(
                "a converted frame has {} bytes, expected {expected} for {}x{} {}",
                planes.len(),
                self.width,
                self.height,
                self.pix.name()
            ));
        }
        let written = self
            .stdin
            .as_mut()
            .ok_or("the encoder is closed")?
            .write_all(&planes);
        if let Err(e) = written {
            // The child quit early; its own message is the cause.
            return Err(self.failure(&format!("cannot send a frame to ffmpeg: {e}")));
        }
        self.frames += 1;
        self.last = Some(planes);
        Ok(())
    }

    /// Closes the input, waits for ffmpeg and checks it succeeded. Returns the number of frames written.
    pub fn finish(mut self) -> Result<u32, String> {
        drop(self.stdin.take());
        let status = self
            .child
            .wait()
            .map_err(|e| format!("cannot wait for {}: {e}", self.program.display()))?;
        let stderr = self
            .stderr
            .take()
            .and_then(|t| t.join().ok())
            .unwrap_or_default();
        if !status.success() {
            return Err(format!(
                "{} failed ({status}): {}",
                self.program.display(),
                stderr.trim()
            ));
        }
        Ok(self.frames)
    }

    /// An error message with what ffmpeg said, after stopping it.
    fn failure(&mut self, what: &str) -> String {
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
        let stderr = self
            .stderr
            .take()
            .and_then(|t| t.join().ok())
            .unwrap_or_default();
        format!("{what}: {} said: {}", self.program.display(), stderr.trim())
    }
}

impl Drop for ExternalEncoder {
    fn drop(&mut self) {
        // Not finished: stop the child, so none is left running.
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoders_are_read_from_the_listing() {
        let listing = "Encoders:\n V..... = Video\n A..... = Audio\n ------\n V....D libx264              libx264 H.264 (codec h264)\n V....D libx265              libx265 H.265\n A....D aac                  AAC\n";
        assert_eq!(parse_encoders(listing), ["libx264", "libx265", "aac"]);
    }

    /// Encodes `n` pictures into `path` with the external ffmpeg: H.264 by libx264 at CRF 0 in `pix`.
    fn encode_with_external(path: &Path, pix: &str, n: u8) -> u32 {
        let (w, h) = (64_u32, 48_u32);
        let settings = encode::resolve(
            &encode::Settings {
                encoder: Some("libx264".into()),
                crf: Some(0.0),
                pixel_format: Some(pix.into()),
                ..encode::Settings::default()
            },
            path,
            false,
            has_encoder,
        )
        .unwrap();
        let mut encoder = ExternalEncoder::create(path, w, h, 30.0, &settings).unwrap();
        for i in 0..n {
            let rgba: Vec<u8> = (0..w * h)
                .flat_map(|p| {
                    [
                        (((p % w) * 3) as u8).wrapping_add(i * 20),
                        ((p / w) * 4) as u8,
                        90,
                        255,
                    ]
                })
                .collect();
            encoder.push(&rgba).unwrap();
        }
        encoder.push_repeat().unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn an_external_ffmpeg_encodes_h264_deterministically() {
        if !has_encoder("libx264") {
            eprintln!("skipped: no ffmpeg program with libx264 (set KINETOGRAPH_FFMPEG)");
            return;
        }
        let dir = std::env::temp_dir().join(format!("kinetograph-external-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a.mp4"), dir.join("b.mp4"));
        assert_eq!(encode_with_external(&a, "yuv444p", 5), 6);
        assert_eq!(encode_with_external(&b, "yuv444p", 5), 6);
        assert_eq!(std::fs::read(&a).unwrap(), std::fs::read(&b).unwrap());

        encode::init();
        let input = ffmpeg::format::input(&a).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        assert_eq!(stream.parameters().id(), ffmpeg::codec::Id::H264);
        assert_eq!(stream.frames(), 6);
        let decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .video()
            .unwrap();
        assert_eq!((decoder.width(), decoder.height()), (64, 48));
        assert_eq!(decoder.format(), ffmpeg::format::Pixel::YUV444P);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_program_is_not_found() {
        assert!(encoders_of(Path::new("/nonexistent/ffmpeg-for-kinetograph")).is_none());
    }
}
