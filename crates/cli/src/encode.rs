//! Writes RGBA frames to a video file with FFmpeg: H.264 (the default),
//! H.265, ProRes, VP9 or GIF (`Settings`, `resolve`).
//!
//! Frames are converted to the output pixel format (`yuv420p` unless asked
//! otherwise) by swscale with BT.709 coefficients and the stream is tagged
//! BT.709, limited ("TV") range. The alpha channel is
//! dropped, not composited: a scene whose background is transparent shows
//! its straight colours where it is clear (black, for the empty pixels the
//! renderer writes). Give the scene an opaque `background` for video.

use std::ffi::c_int;
use std::path::Path;
use std::sync::{Mutex, Once, OnceLock};

use crate::external::{self, ExternalEncoder};
use ffmpeg::codec::{self, Flags as CodecFlags};
use ffmpeg::format::{self, Pixel};
use ffmpeg::software::scaling::{self, Flags as ScaleFlags};
use ffmpeg::util::color;
use ffmpeg::{Dictionary, Packet, Rational, encoder, frame};

/// The encoder `render` uses when `--encoder` is not given and the machine
/// has no hardware one.
pub const DEFAULT_ENCODER: &str = "libx264";

/// The macOS hardware H.264 encoder, preferred there when ffmpeg has it.
pub const VIDEOTOOLBOX: &str = "h264_videotoolbox";

/// Bits per pixel per frame for the encoders that are given a bit rate
/// rather than a quality (`bit_rate`).
const BITS_PER_PIXEL: f64 = 0.2;

/// Starts ffmpeg once and keeps its own messages down to warnings.
pub fn init() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // A failure shows up as the first call that needs ffmpeg failing.
        let _ = ffmpeg::init();
        ffmpeg::log::set_level(ffmpeg::log::Level::Warning);
    });
}

/// The H.264 encoders tried, in this order, when none is asked for and VideoToolbox is not there. `libx264` is GPL: the
/// ffmpeg that ships with Kinetograph is LGPL-only and has none, so there it is the first of the rest that exists:
/// `libopenh264` (BSD, software, macOS and Linux), `h264_mf` (Windows Media Foundation), `h264_nvenc` and `h264_amf`
/// (the GPU's, loaded at run time). All take yuv420p.
const H264_FALLBACKS: [&str; 5] = [
    DEFAULT_ENCODER,
    "libopenh264",
    "h264_mf",
    "h264_nvenc",
    "h264_amf",
];

/// The encoders of `H264_FALLBACKS` that depend on hardware or an OS service the machine may not have.
const PROBED: [&str; 3] = ["h264_mf", "h264_nvenc", "h264_amf"];

/// Whether the linked ffmpeg has an encoder called `name`. The hardware ones of `PROBED` also have to open (ffmpeg
/// lists h264_nvenc on a machine with no NVIDIA GPU), so they count only if a small test encoder opens.
pub fn has_linked_encoder(name: &str) -> bool {
    init();
    // The Intel and AMD GPU encoders need a hardware device and an upload filter that `VideoEncoder` does not set up:
    // the external ffmpeg drives them, whatever the linked one lists.
    if external::is_hardware(name) || encoder::find_by_name(name).is_none() {
        return false;
    }
    !PROBED.contains(&name) || opens(name)
}

/// Whether an encoder called `name` is available: in the linked ffmpeg, or in the separate ffmpeg program
/// (`external`) that carries the GPL ones (libx264, libx265).
pub fn has_encoder(name: &str) -> bool {
    has_linked_encoder(name) || external::has_encoder(name)
}

/// Whether encoder `name` opens for a small yuv420p picture; asked once for each name.
fn opens(name: &str) -> bool {
    static CACHE: OnceLock<Mutex<Vec<(String, bool)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(Vec::new()));
    if let Some((_, ok)) = cache.lock().unwrap().iter().find(|(n, _)| n == name) {
        return *ok;
    }
    let ok = (|| {
        let codec = encoder::find_by_name(name)?;
        let mut video = codec::context::Context::new_with_codec(codec)
            .encoder()
            .video()
            .ok()?;
        video.set_width(256);
        video.set_height(144);
        video.set_format(Pixel::YUV420P);
        video.set_time_base(Rational(1, 30));
        video.set_frame_rate(Some(Rational(30, 1)));
        video.set_bit_rate(1_000_000);
        video.open().ok().map(|_| ())
    })()
    .is_some();
    cache.lock().unwrap().push((name.to_string(), ok));
    ok
}

/// Why there is no usable encoder called `name`, and what to do: the message of every "no such encoder" refusal.
pub fn unavailable(name: &str) -> String {
    unavailable_message(name, external::availability(name))
}

fn unavailable_message(name: &str, external: external::Availability) -> String {
    match (external::is_hardware(name), external) {
        (true, external::Availability::Failed { program, reason }) => format!(
            "{} lists the encoder {name:?}, but it does not open on this machine: {reason}",
            program.display()
        ),
        (true, _) => format!(
            "this ffmpeg has no encoder called {name:?}: the ffmpeg linked into Kinetograph is LGPL-only and has no \
             Intel or AMD GPU encoders. Use your system's ffmpeg for them: set KINETOGRAPH_FFMPEG=/usr/bin/ffmpeg (its \
             `ffmpeg -encoders` must list {name})"
        ),
        (false, _) => format!(
            "this ffmpeg has no encoder called {name:?} that opens here (see `ffmpeg -encoders`); for one the linked \
             ffmpeg lacks, set KINETOGRAPH_FFMPEG to an ffmpeg program that has it"
        ),
    }
}

/// The H.264 encoder to use when none is asked for: `H264_FALLBACKS` in order.
fn default_h264(has: &impl Fn(&str) -> bool) -> Option<&'static str> {
    H264_FALLBACKS.into_iter().find(|name| has(name))
}

/// Picks the encoder: `requested` if given (and present), else VideoToolbox
/// on macOS when `has` it, else the first of `H264_FALLBACKS` that `has`
/// says exists.
pub fn select_encoder(
    requested: Option<&str>,
    macos: bool,
    has: impl Fn(&str) -> bool,
) -> Result<String, String> {
    if let Some(name) = requested {
        return if has(name) {
            Ok(name.to_string())
        } else {
            Err(unavailable(name))
        };
    }
    if macos && has(VIDEOTOOLBOX) {
        return Ok(VIDEOTOOLBOX.to_string());
    }
    if let Some(name) = default_h264(&has) {
        return Ok(name.to_string());
    }
    Err(format!(
        "this ffmpeg has no H.264 encoder ({}); pass --encoder with one it has",
        H264_FALLBACKS.join(", ")
    ))
}

/// The muxer for an output path, from its extension.
pub fn container_for(path: &Path) -> Result<&'static str, String> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp4") => Ok("mp4"),
        Some("mov") => Ok("mov"),
        _ => Err(format!(
            "cannot tell the container for {}: use a .mp4 or .mov output path",
            path.display()
        )),
    }
}

/// A frame rate as the exact fraction ffmpeg wants. Whole rates are n/1 and
/// the broadcast ones that are quoted rounded (23.976, 29.97, 59.94 ...) are
/// n*1000/1001; anything else is read to three decimals.
pub fn fps_rational(fps: f64) -> Result<(i32, i32), String> {
    if !(fps.is_finite() && fps > 0.0 && fps <= 100_000.0) {
        return Err(format!("fps must be between 0 and 100000, got {fps}"));
    }
    let whole = fps.round();
    if whole >= 1.0 && (fps - whole).abs() < 1e-3 {
        return Ok((whole as i32, 1));
    }
    let ntsc = (fps * 1.001).round();
    if ntsc >= 1.0 && (fps - ntsc * 1000.0 / 1001.0).abs() < 0.005 {
        return Ok((ntsc as i32 * 1000, 1001));
    }
    let (mut num, mut den) = ((fps * 1000.0).round() as i64, 1000_i64);
    if num == 0 {
        return Err(format!(
            "fps {fps} is too small: it reads as 0 to three decimals"
        ));
    }
    let (mut a, mut b) = (num, den);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    num /= a;
    den /= a;
    i32::try_from(num)
        .map(|num| (num, den as i32))
        .map_err(|_| format!("fps {fps} is too large"))
}

/// The bit rate for encoders that take one: `BITS_PER_PIXEL` per pixel per
/// frame, so about 0.2 * 1920 * 1080 * 30 = 12.4 Mbit/s for 1080p30.
pub fn bit_rate(width: u32, height: u32, fps: f64) -> usize {
    (BITS_PER_PIXEL * f64::from(width) * f64::from(height) * fps).round() as usize
}

/// The video codecs `render` can write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    H264,
    H265,
    ProRes,
    Vp9,
    Gif,
}

impl Codec {
    /// `h264`, `h265`, `prores`, `vp9` or `gif`.
    pub fn parse(name: &str) -> Result<Codec, String> {
        match name.to_ascii_lowercase().as_str() {
            "h264" => Ok(Codec::H264),
            "h265" | "hevc" => Ok(Codec::H265),
            "prores" => Ok(Codec::ProRes),
            "vp9" => Ok(Codec::Vp9),
            "gif" => Ok(Codec::Gif),
            _ => Err(format!(
                "unknown codec {name:?}: use h264, h265, prores, vp9 or gif"
            )),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Codec::H264 => "h264",
            Codec::H265 => "h265",
            Codec::ProRes => "prores",
            Codec::Vp9 => "vp9",
            Codec::Gif => "gif",
        }
    }

    fn id(self) -> codec::Id {
        match self {
            Codec::H264 => codec::Id::H264,
            Codec::H265 => codec::Id::HEVC,
            Codec::ProRes => codec::Id::PRORES,
            Codec::Vp9 => codec::Id::VP9,
            Codec::Gif => codec::Id::GIF,
        }
    }

    /// The codec an ffmpeg encoder writes, if it is one of these.
    fn of_encoder(name: &str) -> Option<Codec> {
        // The ones only the external ffmpeg has are not known to the linked one.
        let id = match name {
            "libx264" => codec::Id::H264,
            "libx265" => codec::Id::HEVC,
            // The Intel and AMD GPU encoders only the external ffmpeg drives.
            "h264_vaapi" | "h264_qsv" => codec::Id::H264,
            "hevc_vaapi" | "hevc_qsv" => codec::Id::HEVC,
            _ => encoder::find_by_name(name)?.id(),
        };
        [
            Codec::H264,
            Codec::H265,
            Codec::ProRes,
            Codec::Vp9,
            Codec::Gif,
        ]
        .into_iter()
        .find(|c| c.id() == id)
    }

    /// The container extension the codec writes (`.mp4` or `.mov` for the two MPEG ones).
    fn extensions(self) -> &'static [&'static str] {
        match self {
            Codec::H264 | Codec::H265 => &["mp4", "mov"],
            Codec::ProRes => &["mov"],
            Codec::Vp9 => &["webm"],
            Codec::Gif => &["gif"],
        }
    }
}

/// Pixel formats frames are converted to. The first six are what `--pixel-format` names; `P210` and `P416` are the
/// semi-planar layouts of `yuv422p10le` and `yuv444p10le` that the VideoToolbox ProRes encoder takes, and `Rgb8` is
/// the 3-3-2 palette-free format the GIF encoder takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pix {
    Yuv420p,
    Yuv422p,
    Yuv444p,
    Yuv420p10,
    Yuv422p10,
    Yuv444p10,
    P210,
    P416,
    Rgb8,
}

impl Pix {
    /// A `--pixel-format` value.
    pub fn parse_user(name: &str) -> Result<Pix, String> {
        match name {
            "yuv420p" => Ok(Pix::Yuv420p),
            "yuv422p" => Ok(Pix::Yuv422p),
            "yuv444p" => Ok(Pix::Yuv444p),
            "yuv420p10le" => Ok(Pix::Yuv420p10),
            "yuv422p10le" => Ok(Pix::Yuv422p10),
            "yuv444p10le" => Ok(Pix::Yuv444p10),
            _ => Err(format!(
                "unknown pixel format {name:?}: use yuv420p, yuv422p, yuv444p, yuv420p10le, yuv422p10le or yuv444p10le"
            )),
        }
    }

    /// Any name `name()` returns, for `rgbaToYuv`.
    pub fn parse(name: &str) -> Result<Pix, String> {
        match name {
            "p210le" => Ok(Pix::P210),
            "p416le" => Ok(Pix::P416),
            "rgb8" => Ok(Pix::Rgb8),
            _ => Pix::parse_user(name),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Pix::Yuv420p => "yuv420p",
            Pix::Yuv422p => "yuv422p",
            Pix::Yuv444p => "yuv444p",
            Pix::Yuv420p10 => "yuv420p10le",
            Pix::Yuv422p10 => "yuv422p10le",
            Pix::Yuv444p10 => "yuv444p10le",
            Pix::P210 => "p210le",
            Pix::P416 => "p416le",
            Pix::Rgb8 => "rgb8",
        }
    }

    /// What the file holds: the layout the stream is described by (`ffprobe`'s `pix_fmt`).
    pub fn file_name(self) -> &'static str {
        match self {
            Pix::P210 => "yuv422p10le",
            Pix::P416 => "yuv444p10le",
            other => other.name(),
        }
    }

    fn pixel(self) -> Pixel {
        match self {
            Pix::Yuv420p => Pixel::YUV420P,
            Pix::Yuv422p => Pixel::YUV422P,
            Pix::Yuv444p => Pixel::YUV444P,
            Pix::Yuv420p10 => Pixel::YUV420P10LE,
            Pix::Yuv422p10 => Pixel::YUV422P10LE,
            Pix::Yuv444p10 => Pixel::YUV444P10LE,
            Pix::P210 => Pixel::P210LE,
            Pix::P416 => Pixel::P416LE,
            Pix::Rgb8 => Pixel::RGB8,
        }
    }

    pub(crate) fn is_yuv(self) -> bool {
        self != Pix::Rgb8
    }

    /// Whether a converter must be made anew for each picture: the dithering that reduces RGB to 3-3-2 carries its
    /// error from one picture to the next, so a picture would depend on the ones the converter saw before it, and a
    /// render worker sees other frames than the encoder thread does.
    fn converts_afresh(self) -> bool {
        self == Pix::Rgb8
    }

    /// Bytes in a row of each plane, and the rows in it, for a `w` x `h` picture (`w` and `h` even).
    pub(crate) fn planes(self, w: usize, h: usize) -> Vec<(usize, usize)> {
        match self {
            Pix::Yuv420p => vec![(w, h), (w / 2, h / 2), (w / 2, h / 2)],
            Pix::Yuv422p => vec![(w, h), (w / 2, h), (w / 2, h)],
            Pix::Yuv444p => vec![(w, h), (w, h), (w, h)],
            Pix::Yuv420p10 => vec![(2 * w, h), (w, h / 2), (w, h / 2)],
            Pix::Yuv422p10 => vec![(2 * w, h), (w, h), (w, h)],
            Pix::Yuv444p10 => vec![(2 * w, h), (2 * w, h), (2 * w, h)],
            Pix::P210 => vec![(2 * w, h), (2 * w, h)],
            Pix::P416 => vec![(2 * w, h), (4 * w, h)],
            Pix::Rgb8 => vec![(w, h)],
        }
    }
}

/// What `--crf` and `--video-bitrate` ask for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Quality {
    /// The encoder's usual: CRF 18 for libx264, `bit_rate` for the rest.
    Default,
    /// Constant quality, lower is better (libx264, libx265, libvpx-vp9). VideoToolbox has no CRF: it is mapped to
    /// its 0 to 100 quality (`crf_to_quality`).
    Crf(f64),
    /// Bits per second.
    Bitrate(usize),
}

/// The audio codecs `--audio-codec` names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioCodec {
    Aac,
    Opus,
    /// 16-bit little-endian PCM.
    Pcm,
}

impl AudioCodec {
    pub fn parse(name: &str) -> Result<AudioCodec, String> {
        match name.to_ascii_lowercase().as_str() {
            "aac" => Ok(AudioCodec::Aac),
            "opus" => Ok(AudioCodec::Opus),
            "pcm" | "pcm_s16le" => Ok(AudioCodec::Pcm),
            _ => Err(format!(
                "unknown audio codec {name:?}: use aac, opus or pcm"
            )),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            AudioCodec::Aac => "aac",
            AudioCodec::Opus => "opus",
            AudioCodec::Pcm => "pcm",
        }
    }

    fn encoder(self) -> &'static str {
        match self {
            AudioCodec::Aac => "aac",
            AudioCodec::Opus => "libopus",
            AudioCodec::Pcm => "pcm_s16le",
        }
    }
}

/// What the user asked for beyond the scene (`render`'s export options); everything left out takes its default.
#[derive(Clone, Debug, Default)]
pub struct Settings {
    /// Inferred from the output path when left out: `.webm` is VP9, `.gif` is GIF, else H.264 (or what `encoder` writes).
    pub codec: Option<Codec>,
    /// An ffmpeg encoder name; default per codec (`resolve`).
    pub encoder: Option<String>,
    pub crf: Option<f64>,
    /// Bits per second.
    pub video_bitrate: Option<usize>,
    pub pixel_format: Option<String>,
    /// `proxy`, `light`, `standard`, `hq`, `4444` or `4444-xq`.
    pub prores_profile: Option<String>,
    pub audio_codec: Option<String>,
    /// Bits per second.
    pub audio_bitrate: Option<usize>,
    /// GIF only: the caller draws every nth frame, and the file plays them at the frame rate over n.
    pub every_nth_frame: Option<u32>,
}

/// `Settings` checked against the output path and the ffmpeg that is linked: everything the encoder needs to open.
#[derive(Clone, Debug)]
pub struct Resolved {
    pub codec: Codec,
    pub encoder: String,
    pub container: &'static str,
    /// The format frames are converted to for the encoder (`Pix::name`).
    pub pix: Pix,
    pub quality: Quality,
    /// 0 (proxy) to 5 (4444 XQ), for ProRes.
    pub prores_profile: u8,
    pub audio_codec: Option<AudioCodec>,
    pub audio_bitrate: Option<usize>,
    /// 1 unless `Settings::every_nth_frame` says.
    pub every_nth_frame: u32,
}

/// The ProRes profile names `--prores-profile` takes, by the number ffmpeg's encoders use.
const PRORES_PROFILES: [&str; 6] = ["proxy", "light", "standard", "hq", "4444", "4444-xq"];

/// The VideoToolbox encoders take 4:2:0 8-bit pictures only (ProRes aside).
fn is_videotoolbox(encoder: &str) -> bool {
    encoder.ends_with("_videotoolbox")
}

/// Whether `encoder` can take `pix`: the VAAPI and Quick Sync encoders (`external::HARDWARE`) take 4:2:0 only, 8-bit,
/// and HEVC also 10-bit (Intel's GPUs have no H.264 10-bit encoder). Anything else is not limited here.
fn hardware_takes(encoder: &str, pix: Pix) -> bool {
    !external::is_hardware(encoder)
        || pix == Pix::Yuv420p
        || (pix == Pix::Yuv420p10 && encoder.starts_with("hevc"))
}

/// A CRF as VideoToolbox's 0 to 100 quality (`-q:v`): 51 is the worst a CRF goes, 0 the best, mapped in a line.
/// CRF 18 comes to 65 and CRF 23 to 55.
pub fn crf_to_quality(crf: f64) -> u32 {
    ((100.0 * (51.0 - crf) / 51.0).round() as i64).clamp(1, 100) as u32
}

/// Checks `settings` for the output `path` and picks the encoder (`macos`: the hardware ones are preferred, when
/// `has` them and they can do what was asked), the pixel format, the container and the audio codec. Every refusal
/// says what to change.
pub fn resolve(
    settings: &Settings,
    path: &Path,
    macos: bool,
    has: impl Fn(&str) -> bool,
) -> Result<Resolved, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    // The codec: asked for, else the one the requested encoder writes, else what the extension says.
    let explicit = settings.codec;
    let codec = match (explicit, settings.encoder.as_deref()) {
        (Some(codec), _) => codec,
        (None, Some(name)) => {
            if !has(name) {
                return Err(unavailable(name));
            }
            Codec::of_encoder(name).ok_or_else(|| {
                format!("{name:?} is not an encoder of a codec render writes (h264, h265, prores, vp9, gif)")
            })?
        }
        (None, None) => match ext.as_deref() {
            Some("webm") => Codec::Vp9,
            Some("gif") => Codec::Gif,
            _ => Codec::H264,
        },
    };
    let container = match (codec, ext.as_deref()) {
        (Codec::H264 | Codec::H265, Some("mp4")) => "mp4",
        (Codec::H264 | Codec::H265, Some("mov")) => "mov",
        (Codec::ProRes, Some("mov")) => "mov",
        (Codec::Vp9, Some("webm")) => "webm",
        (Codec::Gif, Some("gif")) => "gif",
        _ => {
            let want = codec
                .extensions()
                .iter()
                .map(|e| format!(".{e}"))
                .collect::<Vec<_>>()
                .join(" or ");
            return Err(match (codec, ext.as_deref()) {
                // The wording the plain H.264 render has always had.
                (Codec::H264, _) if explicit.is_none() && settings.encoder.is_none() => format!(
                    "cannot tell the container for {}: use a .mp4 or .mov output path (or .webm for vp9, .gif for gif)",
                    path.display()
                ),
                _ => format!(
                    "codec {} writes {want} files, but the output is {}",
                    codec.name(),
                    path.display()
                ),
            });
        }
    };

    // Quality.
    if settings.crf.is_some() && settings.video_bitrate.is_some() {
        return Err("--crf and --video-bitrate cannot be used together: pick one".into());
    }
    let quality = match (settings.crf, settings.video_bitrate) {
        (Some(crf), None) => {
            let max = match codec {
                Codec::H264 | Codec::H265 => 51.0,
                Codec::Vp9 => 63.0,
                Codec::ProRes | Codec::Gif => {
                    return Err(format!(
                        "--crf does not apply to {}: {}",
                        codec.name(),
                        if codec == Codec::ProRes {
                            "ProRes picks its quality with --prores-profile"
                        } else {
                            "a GIF has no quality setting"
                        }
                    ));
                }
            };
            if !crf.is_finite() || !(0.0..=max).contains(&crf) {
                return Err(format!(
                    "--crf for {} must be between 0 and {max}, got {crf}",
                    codec.name()
                ));
            }
            Quality::Crf(crf)
        }
        (None, Some(bits)) => {
            if matches!(codec, Codec::ProRes | Codec::Gif) {
                return Err(format!(
                    "--video-bitrate does not apply to {}: {}",
                    codec.name(),
                    if codec == Codec::ProRes {
                        "ProRes picks its quality with --prores-profile"
                    } else {
                        "a GIF has no bit rate"
                    }
                ));
            }
            if bits == 0 {
                return Err("--video-bitrate must be above 0".into());
            }
            Quality::Bitrate(bits)
        }
        _ => Quality::Default,
    };

    // ProRes profile.
    let profile = match (&settings.prores_profile, codec) {
        (Some(_), c) if c != Codec::ProRes => {
            return Err("--prores-profile only applies to --codec prores".into());
        }
        (Some(name), _) => PRORES_PROFILES
            .iter()
            .position(|p| p.eq_ignore_ascii_case(name))
            .ok_or_else(|| {
                format!(
                    "unknown ProRes profile {name:?}: use {}",
                    PRORES_PROFILES.join(", ")
                )
            })? as u8,
        (None, _) => 3, // hq
    };

    // Pixel format, as the file holds it.
    let asked = settings
        .pixel_format
        .as_deref()
        .map(Pix::parse_user)
        .transpose()?;
    let wanted = match codec {
        Codec::Gif => {
            if settings.pixel_format.is_some() {
                return Err("--pixel-format does not apply to gif".into());
            }
            Pix::Rgb8
        }
        Codec::ProRes => {
            let four = profile >= 4;
            let ok = if four { Pix::Yuv444p10 } else { Pix::Yuv422p10 };
            match asked {
                None => ok,
                Some(p) if p == ok => p,
                Some(p) => {
                    return Err(format!(
                        "ProRes profile {} takes --pixel-format {}, not {}",
                        PRORES_PROFILES[profile as usize],
                        ok.name(),
                        p.name()
                    ));
                }
            }
        }
        _ => asked.unwrap_or(Pix::Yuv420p),
    };

    // Encoder.
    let encoder = match settings.encoder.as_deref() {
        Some(name) => {
            if !has(name) {
                return Err(unavailable(name));
            }
            if Codec::of_encoder(name) != Some(codec) {
                return Err(format!(
                    "encoder {name:?} does not write {}: pick one that does, or change --codec",
                    codec.name()
                ));
            }
            if !hardware_takes(name, wanted) {
                return Err(format!(
                    "{name} takes {}, not {}: use a software encoder for other pixel formats",
                    if name.starts_with("hevc") {
                        "only yuv420p or yuv420p10le"
                    } else {
                        "only yuv420p"
                    },
                    wanted.name()
                ));
            }
            if is_videotoolbox(name) && codec != Codec::ProRes && wanted != Pix::Yuv420p {
                return Err(format!(
                    "{name} takes only yuv420p, not {}: use a software encoder for other pixel formats",
                    wanted.name()
                ));
            }
            name.to_string()
        }
        None => {
            let hardware =
                |name: &'static str| (macos && has(name) && wanted == Pix::Yuv420p).then_some(name);
            let pick = match codec {
                Codec::H264 => hardware(VIDEOTOOLBOX)
                    .or_else(|| {
                        // The software ones and the GPU ones take 4:2:0 only; libx264 alone takes the others.
                        if wanted == Pix::Yuv420p {
                            default_h264(&has)
                        } else {
                            Some(DEFAULT_ENCODER)
                        }
                    })
                    .unwrap_or(DEFAULT_ENCODER),
                Codec::H265 => hardware("hevc_videotoolbox").unwrap_or("libx265"),
                Codec::ProRes => {
                    if macos && has("prores_videotoolbox") {
                        "prores_videotoolbox"
                    } else {
                        "prores_ks"
                    }
                }
                Codec::Vp9 => "libvpx-vp9",
                Codec::Gif => "gif",
            };
            if !has(pick) {
                let wanted_list = if codec == Codec::H264 && wanted == Pix::Yuv420p {
                    H264_FALLBACKS.join(", ")
                } else {
                    pick.to_string()
                };
                return Err(format!(
                    "this ffmpeg has no {wanted_list} encoder, which {} needs; pass --encoder with one it has",
                    codec.name()
                ));
            }
            pick.to_string()
        }
    };
    let pix = match (encoder.as_str(), wanted) {
        ("prores_videotoolbox", Pix::Yuv422p10) => Pix::P210,
        ("prores_videotoolbox", Pix::Yuv444p10) => Pix::P416,
        (_, p) => p,
    };

    // Audio.
    let audio_codec = match (codec, &settings.audio_codec) {
        (Codec::Gif, Some(_)) => {
            return Err("--audio-codec does not apply to gif, which has no sound".into());
        }
        (Codec::Gif, None) => None,
        (_, asked) => {
            let wanted = asked.as_deref().map(AudioCodec::parse).transpose()?;
            let default = match codec {
                Codec::ProRes => AudioCodec::Pcm,
                Codec::Vp9 => AudioCodec::Opus,
                _ => AudioCodec::Aac,
            };
            let chosen = wanted.unwrap_or(default);
            let allowed: &[AudioCodec] = match container {
                "mp4" => &[AudioCodec::Aac],
                "mov" => &[AudioCodec::Aac, AudioCodec::Pcm],
                _ => &[AudioCodec::Opus],
            };
            if !allowed.contains(&chosen) {
                return Err(format!(
                    "a .{container} file takes {} audio, not {}",
                    allowed
                        .iter()
                        .map(|a| a.name())
                        .collect::<Vec<_>>()
                        .join(" or "),
                    chosen.name()
                ));
            }
            if !has(chosen.encoder()) {
                return Err(format!("this ffmpeg has no {} encoder", chosen.encoder()));
            }
            Some(chosen)
        }
    };
    if let Some(bits) = settings.audio_bitrate {
        match audio_codec {
            None => return Err("--audio-bitrate does not apply to gif, which has no sound".into()),
            Some(AudioCodec::Pcm) => {
                return Err(
                    "--audio-bitrate does not apply to pcm audio, which is not compressed".into(),
                );
            }
            _ if bits == 0 => return Err("--audio-bitrate must be above 0".into()),
            _ => {}
        }
    }

    let every_nth_frame = match settings.every_nth_frame {
        None => 1,
        Some(_) if codec != Codec::Gif => {
            return Err("--every-nth-frame only applies to --codec gif".into());
        }
        Some(0) => return Err("--every-nth-frame must be at least 1".into()),
        Some(n) => n,
    };

    Ok(Resolved {
        codec,
        encoder,
        container,
        pix,
        quality,
        prores_profile: profile,
        audio_codec,
        audio_bitrate: settings.audio_bitrate,
        every_nth_frame,
    })
}

/// Sets swscale's matrix to BT.709, with RGB (or the decoded picture) full
/// range or not as asked. `ctx` converts between RGB and YUV; the table is
/// used for whichever side is YUV.
pub fn set_bt709(
    ctx: &mut scaling::Context,
    src_full_range: bool,
    dst_full_range: bool,
) -> Result<(), String> {
    // SAFETY: `ctx` is a live swscale context and the table comes from
    // swscale itself; both outlive the call.
    let status = unsafe {
        let table = ffmpeg::ffi::sws_getCoefficients(ffmpeg::ffi::SWS_CS_ITU709 as c_int);
        ffmpeg::ffi::sws_setColorspaceDetails(
            ctx.as_mut_ptr(),
            table,
            c_int::from(src_full_range),
            table,
            c_int::from(dst_full_range),
            0,
            1 << 16,
            1 << 16,
        )
    };
    if status < 0 {
        return Err("swscale cannot use BT.709 for this conversion".into());
    }
    Ok(())
}

/// swscale's RGBA to `pix` conversion, BT.709 with full-range RGB in and limited-range YUV out.
fn rgba_scaler(width: u32, height: u32, pix: Pix) -> Result<scaling::Context, String> {
    let mut scaler = scaling::Context::get(
        Pixel::RGBA,
        width,
        height,
        pix.pixel(),
        width,
        height,
        ScaleFlags::BICUBIC | ScaleFlags::ACCURATE_RND,
    )
    .map_err(|e| format!("cannot set up the RGBA to {} conversion: {e}", pix.name()))?;
    if pix.is_yuv() {
        set_bt709(&mut scaler, true, false)?;
    }
    Ok(scaler)
}

/// What `rgba_to_planes` keeps per thread: the converter for the last size and format, and its source picture.
struct Converter {
    scaler: scaling::Context,
    rgba: frame::Video,
    size: (u32, u32, Pix),
}

thread_local! {
    static CONVERTER: std::cell::RefCell<Option<Converter>> = const { std::cell::RefCell::new(None) };
}

/// Copies the visible part of each plane of `picture` into one buffer, planes one after another, rows tightly packed.
fn pack_planes(picture: &frame::Video, pix: Pix) -> Vec<u8> {
    let layout = pix.planes(picture.width() as usize, picture.height() as usize);
    let mut out = Vec::with_capacity(layout.iter().map(|(row, rows)| row * rows).sum());
    for (plane, (row, rows)) in layout.into_iter().enumerate() {
        let stride = picture.stride(plane);
        let data = picture.data(plane);
        for y in 0..rows {
            out.extend_from_slice(&data[y * stride..y * stride + row]);
        }
    }
    out
}

/// Converts a tightly packed RGBA8 picture to `yuv420p` the way the encoder does (`VideoEncoder::push`), on the calling
/// thread: the planes Y, U, V, rows packed. `rgba_to_planes` for any format.
pub fn rgba_to_yuv420(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    rgba_to_planes(rgba, width, height, Pix::Yuv420p)
}

/// Converts a tightly packed RGBA8 picture to `pix` the way the encoder does (`VideoEncoder::push`), on the calling
/// thread, so several threads can convert while one encoder only has to send: the planes one after another, rows packed.
pub fn rgba_to_planes(rgba: &[u8], width: u32, height: u32, pix: Pix) -> Result<Vec<u8>, String> {
    if rgba.len() != width as usize * height as usize * 4 {
        return Err(format!(
            "frame has {} bytes, expected {} for {width}x{height} RGBA",
            rgba.len(),
            width as usize * height as usize * 4
        ));
    }
    CONVERTER.with(|cell| {
        let mut held = cell.borrow_mut();
        if pix.converts_afresh() || held.as_ref().is_none_or(|c| c.size != (width, height, pix)) {
            *held = Some(Converter {
                scaler: rgba_scaler(width, height, pix)?,
                rgba: frame::Video::new(Pixel::RGBA, width, height),
                size: (width, height, pix),
            });
        }
        let c = held.as_mut().expect("set above");
        let row = width as usize * 4;
        let stride = c.rgba.stride(0);
        let dst = c.rgba.data_mut(0);
        for (y, line) in rgba.chunks_exact(row).enumerate() {
            dst[y * stride..y * stride + row].copy_from_slice(line);
        }
        let mut converted = frame::Video::empty();
        c.scaler
            .run(&c.rgba, &mut converted)
            .map_err(|e| format!("cannot convert a frame to {}: {e}", pix.name()))?;
        Ok(pack_planes(&converted, pix))
    })
}

/// Whether `settings` is written by the separate ffmpeg program rather than the linked one: its encoder is not linked.
pub fn is_external(settings: &Resolved) -> bool {
    !has_linked_encoder(&settings.encoder) && external::has_encoder(&settings.encoder)
}

/// A video file being written, by the linked ffmpeg (`VideoEncoder`) or, for encoders it lacks, the external one.
pub enum FrameEncoder {
    Linked(Box<VideoEncoder>),
    External(Box<ExternalEncoder>),
}

impl FrameEncoder {
    /// Opens `path`; see `VideoEncoder::create`.
    pub fn create(
        path: &Path,
        width: u32,
        height: u32,
        fps: f64,
        settings: &Resolved,
    ) -> Result<FrameEncoder, String> {
        if is_external(settings) {
            ExternalEncoder::create(path, width, height, fps, settings)
                .map(|e| FrameEncoder::External(Box::new(e)))
        } else {
            VideoEncoder::create(path, width, height, fps, settings)
                .map(|e| FrameEncoder::Linked(Box::new(e)))
        }
    }

    pub fn push(&mut self, rgba: &[u8]) -> Result<(), String> {
        match self {
            FrameEncoder::Linked(e) => e.push(rgba),
            FrameEncoder::External(e) => e.push(rgba),
        }
    }

    pub fn push_yuv(&mut self, planes: &[u8]) -> Result<(), String> {
        match self {
            FrameEncoder::Linked(e) => e.push_yuv(planes),
            FrameEncoder::External(e) => e.push_yuv(planes),
        }
    }

    pub fn push_repeat(&mut self) -> Result<(), String> {
        match self {
            FrameEncoder::Linked(e) => e.push_repeat(),
            FrameEncoder::External(e) => e.push_repeat(),
        }
    }

    pub fn finish(self) -> Result<u32, String> {
        match self {
            FrameEncoder::Linked(e) => e.finish(),
            FrameEncoder::External(e) => e.finish(),
        }
    }
}

/// An open output file taking RGBA frames, one after another.
pub struct VideoEncoder {
    output: format::context::Output,
    encoder: encoder::Video,
    scaler: scaling::Context,
    /// The caller's pixels, reused for every frame.
    rgba: frame::Video,
    pix: Pix,
    width: u32,
    height: u32,
    time_base: Rational,
    stream_time_base: Rational,
    next_pts: i64,
    /// The last picture sent, for `push_repeat`. Nothing writes to a picture
    /// once it is sent.
    last: Option<frame::Video>,
}

/// Sets the options of the encoder `settings.encoder` for `quality` etc. `video` is the not yet opened context.
fn encoder_options(
    video: &mut encoder::video::Video,
    settings: &Resolved,
    width: u32,
    height: u32,
    fps: f64,
) -> Dictionary<'static> {
    let mut options = Dictionary::new();
    let default_bits = bit_rate(width, height, fps);
    match settings.encoder.as_str() {
        DEFAULT_ENCODER => {
            match settings.quality {
                Quality::Bitrate(bits) => video.set_bit_rate(bits),
                Quality::Crf(crf) => options.set("crf", &crf.to_string()),
                Quality::Default => options.set("crf", "18"),
            }
            options.set("preset", "medium");
        }
        "libx265" => {
            match settings.quality {
                Quality::Bitrate(bits) => video.set_bit_rate(bits),
                Quality::Crf(crf) => options.set("crf", &crf.to_string()),
                Quality::Default => options.set("crf", "28"),
            }
            options.set("preset", "medium");
            options.set("x265-params", "log-level=error");
        }
        "libvpx-vp9" => {
            match settings.quality {
                Quality::Bitrate(bits) => video.set_bit_rate(bits),
                Quality::Crf(crf) => {
                    // Constant quality: libvpx wants the bit rate at 0 for the CRF to rule.
                    video.set_bit_rate(0);
                    options.set("crf", &crf.to_string());
                }
                Quality::Default => {
                    video.set_bit_rate(0);
                    options.set("crf", "30");
                }
            }
            options.set("deadline", "good");
            options.set("cpu-used", "4");
            options.set("row-mt", "1");
        }
        "prores_ks" | "prores_videotoolbox" | "prores_aw" => {
            options.set("profile", &settings.prores_profile.to_string());
            if settings.encoder == "prores_ks" {
                options.set("vendor", "apl0");
            }
        }
        "gif" => {}
        // The VideoToolbox H.264 and H.265 encoders: a bit rate, or the 0 to 100 quality a CRF maps to.
        _ => match settings.quality {
            Quality::Default => video.set_bit_rate(default_bits),
            Quality::Bitrate(bits) => video.set_bit_rate(bits),
            // Only VideoToolbox maps a CRF to a quality; the others (openh264, Media Foundation, NVENC) take a bit rate.
            Quality::Crf(_) if !is_videotoolbox(&settings.encoder) => {
                video.set_bit_rate(default_bits)
            }
            Quality::Crf(crf) => {
                // SAFETY: `video` is a live, not yet opened context; these two fields are what ffmpeg's `-q:v` sets.
                unsafe {
                    let ctx = video.as_mut_ptr();
                    (*ctx).flags |= ffmpeg::ffi::AV_CODEC_FLAG_QSCALE as c_int;
                    (*ctx).global_quality =
                        (crf_to_quality(crf) as c_int) * ffmpeg::ffi::FF_QP2LAMBDA as c_int;
                }
            }
        },
    }
    if is_videotoolbox(&settings.encoder) {
        // Fall back to Apple's software encoder where the hardware one is missing (a macOS VM, as on CI) or busy;
        // with the hardware present it is still what runs.
        options.set("allow_sw", "1");
    }
    options
}

impl VideoEncoder {
    /// Opens `path` for `width` x `height` frames at `fps`, encoded as `settings` says (`resolve`). The size must be
    /// even (the colour planes of the YUV formats are halved).
    pub fn create(
        path: &Path,
        width: u32,
        height: u32,
        fps: f64,
        settings: &Resolved,
    ) -> Result<VideoEncoder, String> {
        init();
        if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
            return Err(format!(
                "{width}x{height} has an odd side: video needs an even width and height"
            ));
        }
        let (fps_num, fps_den) = fps_rational(fps)?;
        let codec = encoder::find_by_name(&settings.encoder)
            .ok_or_else(|| format!("this ffmpeg has no encoder called {:?}", settings.encoder))?;
        let err = |what: &str| {
            let what = what.to_string();
            move |e: ffmpeg::Error| format!("{what}: {e}")
        };

        let mut output = format::output_as(path, settings.container)
            .map_err(err(&format!("cannot create {}", path.display())))?;
        let global_header = output
            .format()
            .flags()
            .contains(format::Flags::GLOBAL_HEADER);

        let time_base = Rational(fps_den, fps_num);
        let mut video = codec::context::Context::new_with_codec(codec)
            .encoder()
            .video()
            .map_err(err("cannot set up the encoder"))?;
        video.set_width(width);
        video.set_height(height);
        video.set_format(settings.pix.pixel());
        video.set_time_base(time_base);
        video.set_frame_rate(Some(Rational(fps_num, fps_den)));
        if settings.pix.is_yuv() {
            video.set_colorspace(color::Space::BT709);
            video.set_color_range(color::Range::MPEG);
            video.set_color_primaries(color::Primaries::BT709);
            video.set_color_transfer_characteristic(color::TransferCharacteristic::BT709);
        }
        if global_header {
            video.set_flags(CodecFlags::GLOBAL_HEADER);
        }
        let options = encoder_options(&mut video, settings, width, height, fps);
        let encoder_name = &settings.encoder;
        let video = video
            .open_with(options)
            .map_err(err(&format!("cannot open the {encoder_name} encoder")))?;

        let stream_index = {
            let mut stream = output
                .add_stream(codec)
                .map_err(err("cannot add the video stream"))?;
            stream.set_parameters(&video);
            stream.set_time_base(time_base);
            stream.set_avg_frame_rate(Rational(fps_num, fps_den));
            if settings.codec == Codec::H265 {
                // SAFETY: the stream's parameters are live and owned by `output`. QuickTime and Safari play HEVC
                // in MP4/MOV only when it is tagged `hvc1` (ffmpeg's default is `hev1`).
                unsafe {
                    (*stream.parameters().as_mut_ptr()).codec_tag = u32::from_le_bytes(*b"hvc1");
                }
            }
            stream.index()
        };
        let mut header = Dictionary::new();
        if matches!(settings.container, "mp4" | "mov") {
            header.set("movflags", "+faststart");
        }
        output
            .write_header_with(header)
            .map_err(err("cannot write the file header"))?;
        // The muxer may have chosen its own time base for the stream.
        let stream_time_base = output
            .stream(stream_index)
            .map(|s| s.time_base())
            .unwrap_or(time_base);

        let scaler = rgba_scaler(width, height, settings.pix)?;

        Ok(VideoEncoder {
            output,
            encoder: video,
            scaler,
            rgba: frame::Video::new(Pixel::RGBA, width, height),
            pix: settings.pix,
            width,
            height,
            time_base,
            stream_time_base,
            next_pts: 0,
            last: None,
        })
    }

    /// Encodes the next frame: tightly packed RGBA8, `width` x `height`.
    pub fn push(&mut self, rgba: &[u8]) -> Result<(), String> {
        let row = self.width as usize * 4;
        if rgba.len() != row * self.height as usize {
            return Err(format!(
                "frame has {} bytes, expected {} for {}x{} RGBA",
                rgba.len(),
                row * self.height as usize,
                self.width,
                self.height
            ));
        }
        let stride = self.rgba.stride(0);
        let dst = self.rgba.data_mut(0);
        for (y, line) in rgba.chunks_exact(row).enumerate() {
            dst[y * stride..y * stride + row].copy_from_slice(line);
        }
        if self.pix.converts_afresh() {
            self.scaler = rgba_scaler(self.width, self.height, self.pix)?;
        }
        // A fresh picture each time: the encoder may still hold the last.
        let mut converted = frame::Video::empty();
        let timer = kinetograph_core::profile::start();
        self.scaler
            .run(&self.rgba, &mut converted)
            .map_err(|e| format!("cannot convert a frame to {}: {e}", self.pix.name()))?;
        kinetograph_core::profile::add_shared_since("encoder_convert", timer);
        self.send(converted)
    }

    /// Encodes the next frame from planes converted elsewhere (`rgba_to_planes` with this encoder's format).
    pub fn push_yuv(&mut self, planes: &[u8]) -> Result<(), String> {
        let mut picture = frame::Video::new(self.pix.pixel(), self.width, self.height);
        let layout = self.pix.planes(self.width as usize, self.height as usize);
        let expected: usize = layout.iter().map(|(row, rows)| row * rows).sum();
        if planes.len() != expected {
            return Err(format!(
                "a converted frame has {} bytes, expected {expected} for {}x{} {}",
                planes.len(),
                self.width,
                self.height,
                self.pix.name()
            ));
        }
        let mut at = 0;
        for (plane, (row, rows)) in layout.into_iter().enumerate() {
            let stride = picture.stride(plane);
            let dst = picture.data_mut(plane);
            for y in 0..rows {
                dst[y * stride..y * stride + row]
                    .copy_from_slice(&planes[at + y * row..at + (y + 1) * row]);
            }
            at += row * rows;
        }
        self.send(picture)
    }

    /// Encodes the next frame as the same picture as the last one: what
    /// `push` or `push_yuv` would make of the same pixels, without converting
    /// them again.
    pub fn push_repeat(&mut self) -> Result<(), String> {
        let last = self
            .last
            .take()
            .ok_or("a frame was repeated before any frame was sent")?;
        self.send(last)
    }

    fn send(&mut self, mut yuv: frame::Video) -> Result<(), String> {
        yuv.set_pts(Some(self.next_pts));
        self.next_pts += 1;
        self.encoder
            .send_frame(&yuv)
            .map_err(|e| format!("encoder rejected a frame: {e}"))?;
        self.last = Some(yuv);
        self.write_packets()
    }

    /// Flushes the encoder and closes the file. Returns the number of frames
    /// written.
    pub fn finish(mut self) -> Result<u32, String> {
        self.encoder
            .send_eof()
            .map_err(|e| format!("cannot flush the encoder: {e}"))?;
        self.write_packets()?;
        self.output
            .write_trailer()
            .map_err(|e| format!("cannot finish the file: {e}"))?;
        Ok(self.next_pts as u32)
    }

    /// Moves whatever packets the encoder has ready into the file.
    fn write_packets(&mut self) -> Result<(), String> {
        let mut packet = Packet::empty();
        loop {
            match self.encoder.receive_packet(&mut packet) {
                Ok(()) => {
                    packet.set_stream(0);
                    packet.rescale_ts(self.time_base, self.stream_time_base);
                    packet
                        .write_interleaved(&mut self.output)
                        .map_err(|e| format!("cannot write to the file: {e}"))?;
                }
                // It wants more frames, or it is drained.
                Err(ffmpeg::Error::Eof) => return Ok(()),
                Err(ffmpeg::Error::Other {
                    errno: ffmpeg::error::EAGAIN,
                }) => return Ok(()),
                Err(e) => return Err(format!("encoder failed: {e}")),
            }
        }
    }
}

/// Sample rates the native AAC encoder takes.
const AAC_RATES: [u32; 13] = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/// Sample rates the Opus encoder takes.
const OPUS_RATES: [u32; 5] = [48000, 24000, 16000, 12000, 8000];

/// AAC bit rate per channel, bits per second (Opus gets the same unless `--audio-bitrate` says).
const AAC_BITS_PER_CHANNEL: usize = 96_000;

/// Audio as the mixer hands it over: one slice of samples in -1..1 per
/// channel, all the same length.
#[derive(Clone, Copy)]
pub struct AudioPcm<'a> {
    pub sample_rate: u32,
    pub channels: &'a [&'a [f32]],
}

impl AudioPcm<'_> {
    /// Samples per channel.
    pub fn len(&self) -> usize {
        self.channels.first().map_or(0, |c| c.len())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether the native AAC encoder can take it.
    pub fn validate(&self) -> Result<(), String> {
        self.validate_for(AudioCodec::Aac)
    }

    /// Whether the encoder for `codec` can take it.
    pub fn validate_for(&self, codec: AudioCodec) -> Result<(), String> {
        let (rates, what): (&[u32], &str) = match codec {
            AudioCodec::Aac => (&AAC_RATES, "AAC has (48000, 44100, 32000 ...)"),
            AudioCodec::Opus => (&OPUS_RATES, "Opus has (48000, 24000, 16000, 12000, 8000)"),
            AudioCodec::Pcm => (&[], ""),
        };
        if codec == AudioCodec::Pcm {
            if self.sample_rate == 0 {
                return Err("audio sample rate is 0".into());
            }
        } else if !rates.contains(&self.sample_rate) {
            return Err(format!(
                "audio sample rate {} is not one {what}",
                self.sample_rate
            ));
        }
        if !(1..=2).contains(&self.channels.len()) {
            return Err(format!(
                "audio has {} channels: {} output takes 1 or 2",
                self.channels.len(),
                codec.name().to_ascii_uppercase()
            ));
        }
        if self.channels.iter().any(|c| c.len() != self.len()) {
            return Err("the audio channels differ in length".into());
        }
        Ok(())
    }
}

/// Where the video is written to before `mux_audio` or a rename puts it
/// under its real name: `.<name>.partial.<ext>` beside `output`, so a file
/// that was not finished never has the final name.
pub fn partial_path(output: &Path) -> std::path::PathBuf {
    let name = output
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = output
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    output.with_file_name(format!(".{name}.partial.{ext}"))
}

/// Writes `video` (a file `VideoEncoder` made) to `output` with `audio`
/// added as a stream of the codec `settings` names (AAC unless asked
/// otherwise). The video packets are copied, not encoded again,
/// and audio is encoded alongside them so that the two interleave in time.
/// `audio` starts with the video; if it is longer, the file runs to the end
/// of the audio.
pub fn mux_audio(
    video: &Path,
    output: &Path,
    audio: &AudioPcm,
    settings: &Resolved,
) -> Result<(), String> {
    init();
    let audio_codec = settings
        .audio_codec
        .ok_or_else(|| format!("a {} file has no audio", settings.codec.name()))?;
    audio.validate_for(audio_codec)?;
    let container = settings.container;
    let err = |what: &str| {
        let what = what.to_string();
        move |e: ffmpeg::Error| format!("{what}: {e}")
    };

    let mut input =
        format::input(video).map_err(err(&format!("cannot read {}", video.display())))?;
    let (video_in, in_time_base, avg_frame_rate, parameters) = {
        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or_else(|| format!("{} has no video stream", video.display()))?;
        (
            stream.index(),
            stream.time_base(),
            stream.avg_frame_rate(),
            stream.parameters(),
        )
    };

    let mut octx = format::output_as(output, container)
        .map_err(err(&format!("cannot create {}", output.display())))?;
    let global_header = octx.format().flags().contains(format::Flags::GLOBAL_HEADER);
    let video_out = {
        let mut stream = octx
            .add_stream(encoder::find(codec::Id::None))
            .map_err(err("cannot add the video stream"))?;
        stream.set_parameters(parameters);
        stream.set_avg_frame_rate(avg_frame_rate);
        // A tag from the temporary file's container may not fit this one. ProRes keeps its own (it says the profile,
        // and both files are MOV); HEVC is tagged for QuickTime.
        // SAFETY: the stream's parameters are live and owned by `octx`.
        unsafe {
            let parameters = stream.parameters().as_mut_ptr();
            match settings.codec {
                Codec::ProRes => {}
                Codec::H265 => (*parameters).codec_tag = u32::from_le_bytes(*b"hvc1"),
                _ => (*parameters).codec_tag = 0,
            }
        }
        stream.index()
    };

    let wanted = encoder::find_by_name(audio_codec.encoder())
        .ok_or_else(|| format!("this ffmpeg has no {} encoder", audio_codec.encoder()))?;
    let aenc = wanted
        .audio()
        .map_err(err("the audio encoder is not an audio encoder"))?;
    let rate = audio.sample_rate as i32;
    let layout = if audio.channels.len() == 1 {
        ffmpeg::ChannelLayout::MONO
    } else {
        ffmpeg::ChannelLayout::STEREO
    };
    let sample_format = match audio_codec {
        AudioCodec::Aac => format::Sample::F32(format::sample::Type::Planar),
        AudioCodec::Opus => format::Sample::F32(format::sample::Type::Packed),
        AudioCodec::Pcm => format::Sample::I16(format::sample::Type::Packed),
    };
    let (audio_out, audio_encoder) = {
        let mut stream = octx
            .add_stream(aenc)
            .map_err(err("cannot add the audio stream"))?;
        let context = codec::context::Context::from_parameters(stream.parameters())
            .map_err(err("cannot set up the audio encoder"))?;
        let mut encoder = context
            .encoder()
            .audio()
            .map_err(err("cannot set up the audio encoder"))?;
        encoder.set_rate(rate);
        encoder.set_channel_layout(layout);
        encoder.set_format(sample_format);
        if audio_codec != AudioCodec::Pcm {
            encoder.set_bit_rate(
                settings
                    .audio_bitrate
                    .unwrap_or(AAC_BITS_PER_CHANNEL * audio.channels.len()),
            );
        }
        encoder.set_time_base((1, rate));
        if global_header {
            encoder.set_flags(CodecFlags::GLOBAL_HEADER);
        }
        let encoder = encoder.open_as(aenc).map_err(err(&format!(
            "cannot open the {} encoder",
            audio_codec.encoder()
        )))?;
        stream.set_parameters(&encoder);
        stream.set_time_base((1, rate));
        (stream.index(), encoder)
    };

    let mut header = Dictionary::new();
    if matches!(container, "mp4" | "mov") {
        header.set("movflags", "+faststart");
    }
    octx.write_header_with(header)
        .map_err(err("cannot write the file header"))?;
    let video_out_time_base = octx
        .stream(video_out)
        .map(|s| s.time_base())
        .unwrap_or(in_time_base);
    let audio_out_time_base = octx
        .stream(audio_out)
        .map(|s| s.time_base())
        .unwrap_or(Rational(1, rate));

    let mut feed = AudioFeed {
        encoder: audio_encoder,
        pcm: *audio,
        layout,
        format: sample_format,
        position: 0,
        stream: audio_out,
        time_base: audio_out_time_base,
    };
    for (stream, mut packet) in input.packets() {
        if stream.index() != video_in {
            continue;
        }
        // Audio up to this packet goes in first.
        let ticks = packet.dts().or(packet.pts()).unwrap_or(0).max(0) as f64;
        let seconds =
            ticks * f64::from(in_time_base.numerator()) / f64::from(in_time_base.denominator());
        feed.until(&mut octx, seconds)?;
        packet.rescale_ts(in_time_base, video_out_time_base);
        packet.set_position(-1);
        packet.set_stream(video_out);
        packet
            .write_interleaved(&mut octx)
            .map_err(err("cannot write to the file"))?;
    }
    feed.finish(&mut octx)?;
    octx.write_trailer().map_err(err("cannot finish the file"))
}

/// The audio, encoded a frame at a time as the video goes by.
struct AudioFeed<'a> {
    encoder: encoder::Audio,
    pcm: AudioPcm<'a>,
    layout: ffmpeg::ChannelLayout,
    /// The sample layout the encoder takes.
    format: format::Sample,
    /// Samples (per channel) sent to the encoder.
    position: usize,
    stream: usize,
    time_base: Rational,
}

impl AudioFeed<'_> {
    /// Samples in a frame: the encoder's, or 1024 for one that takes any (PCM).
    fn frame_size(&self) -> usize {
        match self.encoder.frame_size() {
            0 => 1024,
            n => n as usize,
        }
    }

    /// Encodes whole frames of audio up to `seconds`.
    fn until(&mut self, octx: &mut format::context::Output, seconds: f64) -> Result<(), String> {
        let wanted = (seconds * f64::from(self.pcm.sample_rate)).ceil() as usize;
        let target = wanted.min(self.pcm.len());
        let size = self.frame_size();
        while self.position + size <= target {
            self.send(octx, size)?;
        }
        Ok(())
    }

    /// The rest of the audio, a short last frame included, and the encoder's
    /// delay.
    fn finish(&mut self, octx: &mut format::context::Output) -> Result<(), String> {
        let size = self.frame_size();
        while self.position < self.pcm.len() {
            let n = size.min(self.pcm.len() - self.position);
            self.send(octx, n)?;
        }
        self.encoder
            .send_eof()
            .map_err(|e| format!("cannot flush the audio encoder: {e}"))?;
        self.write_packets(octx)
    }

    fn send(&mut self, octx: &mut format::context::Output, n: usize) -> Result<(), String> {
        let mut frame = frame::Audio::new(self.format, n, self.layout);
        frame.set_rate(self.pcm.sample_rate);
        frame.set_pts(Some(self.position as i64));
        // NaN would reach the encoder as noise.
        let sample = |s: f32| if s.is_finite() { s } else { 0.0 };
        let channels = self.pcm.channels;
        match self.format {
            format::Sample::F32(format::sample::Type::Planar) => {
                for (c, samples) in channels.iter().enumerate() {
                    let dst = &mut frame.plane_mut::<f32>(c)[..n];
                    for (d, s) in dst
                        .iter_mut()
                        .zip(&samples[self.position..self.position + n])
                    {
                        *d = sample(*s);
                    }
                }
            }
            format::Sample::F32(_) => {
                let dst = &mut frame.data_mut(0)[..n * channels.len() * 4];
                for i in 0..n {
                    for (c, samples) in channels.iter().enumerate() {
                        let at = (i * channels.len() + c) * 4;
                        dst[at..at + 4]
                            .copy_from_slice(&sample(samples[self.position + i]).to_le_bytes());
                    }
                }
            }
            _ => {
                let dst = &mut frame.data_mut(0)[..n * channels.len() * 2];
                for i in 0..n {
                    for (c, samples) in channels.iter().enumerate() {
                        let at = (i * channels.len() + c) * 2;
                        let v = (sample(samples[self.position + i]).clamp(-1.0, 1.0) * 32767.0)
                            .round() as i16;
                        dst[at..at + 2].copy_from_slice(&v.to_le_bytes());
                    }
                }
            }
        }
        self.position += n;
        self.encoder
            .send_frame(&frame)
            .map_err(|e| format!("audio encoder rejected a frame: {e}"))?;
        self.write_packets(octx)
    }

    fn write_packets(&mut self, octx: &mut format::context::Output) -> Result<(), String> {
        let mut packet = Packet::empty();
        loop {
            match self.encoder.receive_packet(&mut packet) {
                Ok(()) => {
                    packet.set_stream(self.stream);
                    packet.rescale_ts(Rational(1, self.pcm.sample_rate as i32), self.time_base);
                    packet
                        .write_interleaved(octx)
                        .map_err(|e| format!("cannot write to the file: {e}"))?;
                }
                Err(ffmpeg::Error::Eof) => return Ok(()),
                Err(ffmpeg::Error::Other {
                    errno: ffmpeg::error::EAGAIN,
                }) => return Ok(()),
                Err(e) => return Err(format!("audio encoder failed: {e}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Settings for H.264 by `libx264` into `path`'s container.
    fn x264(path: &Path) -> Resolved {
        resolve(
            &Settings {
                encoder: Some("libx264".into()),
                ..Settings::default()
            },
            path,
            false,
            has_encoder,
        )
        .unwrap()
    }

    #[test]
    fn rates_are_exact_fractions() {
        assert_eq!(fps_rational(30.0), Ok((30, 1)));
        assert_eq!(fps_rational(60.0), Ok((60, 1)));
        assert_eq!(fps_rational(24.0), Ok((24, 1)));
        assert_eq!(fps_rational(29.97), Ok((30000, 1001)));
        assert_eq!(fps_rational(23.976), Ok((24000, 1001)));
        assert_eq!(fps_rational(59.94), Ok((60000, 1001)));
        assert_eq!(fps_rational(30000.0 / 1001.0), Ok((30000, 1001)));
        // Anything else is read to three decimals and reduced.
        assert_eq!(fps_rational(12.5), Ok((25, 2)));
        assert_eq!(fps_rational(0.5), Ok((1, 2)));
        assert_eq!(fps_rational(7.125), Ok((57, 8)));
    }

    #[test]
    fn rates_must_be_positive_and_finite() {
        for fps in [0.0, -30.0, f64::NAN, f64::INFINITY, 1e9] {
            assert!(fps_rational(fps).is_err(), "{fps}");
        }
        // Positive, but 0 to three decimals: no time base to give ffmpeg.
        let msg = fps_rational(0.0004).unwrap_err();
        assert!(msg.contains("too small"), "{msg}");
        assert_eq!(fps_rational(0.001), Ok((1, 1000)));
    }

    #[test]
    fn a_requested_encoder_must_exist() {
        let has = |name: &str| name == "libx264" || name == "h264_videotoolbox";
        assert_eq!(
            select_encoder(Some("libx264"), true, has).unwrap(),
            "libx264"
        );
        assert_eq!(
            select_encoder(Some("h264_videotoolbox"), false, has).unwrap(),
            "h264_videotoolbox"
        );
        let msg = select_encoder(Some("nope"), true, has).unwrap_err();
        assert!(msg.contains("\"nope\""), "{msg}");
    }

    #[test]
    fn videotoolbox_is_the_default_only_on_macos_when_present() {
        let both = |name: &str| name == "libx264" || name == "h264_videotoolbox";
        let x264 = |name: &str| name == "libx264";
        assert_eq!(
            select_encoder(None, true, both).unwrap(),
            "h264_videotoolbox"
        );
        assert_eq!(select_encoder(None, false, both).unwrap(), "libx264");
        assert_eq!(select_encoder(None, true, x264).unwrap(), "libx264");
        let msg = select_encoder(None, false, |_| false).unwrap_err();
        assert!(
            msg.contains("libx264") && msg.contains("--encoder"),
            "{msg}"
        );
    }

    #[test]
    fn the_lgpl_safe_encoders_follow_libx264_in_order() {
        let only = |names: &'static [&'static str]| move |name: &str| names.contains(&name);
        // The LGPL-only ffmpeg: no libx264.
        assert_eq!(
            select_encoder(None, false, only(&["libopenh264", "h264_nvenc"])).unwrap(),
            "libopenh264"
        );
        assert_eq!(
            select_encoder(None, false, only(&["h264_mf", "h264_nvenc"])).unwrap(),
            "h264_mf"
        );
        assert_eq!(
            select_encoder(None, false, only(&["h264_nvenc", "h264_amf"])).unwrap(),
            "h264_nvenc"
        );
        // libx264 still wins where the ffmpeg has it (a developer's own build), VideoToolbox on macOS wins over both.
        assert_eq!(
            select_encoder(None, false, only(&["libopenh264", "libx264"])).unwrap(),
            "libx264"
        );
        assert_eq!(
            select_encoder(None, true, only(&["libopenh264", "h264_videotoolbox"])).unwrap(),
            "h264_videotoolbox"
        );
    }

    #[test]
    fn an_encoder_only_the_external_ffmpeg_has_is_chosen_like_a_linked_one() {
        // `has` does not say where an encoder lives: libx264 beats libopenh264 whether it is linked or external,
        // VideoToolbox still wins on macOS, and h265 and the explicit names resolve without being linked.
        let external = |name: &str| matches!(name, "libx264" | "libx265" | "libopenh264" | "aac");
        assert_eq!(select_encoder(None, false, external).unwrap(), "libx264");
        let path = Path::new("out.mp4");
        let plan = |settings: Settings, macos: bool, has: &dyn Fn(&str) -> bool| {
            resolve(&settings, path, macos, has).unwrap()
        };
        let h265 = Settings {
            codec: Some(Codec::H265),
            ..Settings::default()
        };
        assert_eq!(plan(h265, true, &external).encoder, "libx265");
        let named = Settings {
            encoder: Some("libx265".into()),
            ..Settings::default()
        };
        assert_eq!(plan(named, false, &external).codec, Codec::H265);
        let with_vt = |name: &str| external(name) || name == VIDEOTOOLBOX;
        assert_eq!(
            plan(Settings::default(), true, &with_vt).encoder,
            VIDEOTOOLBOX
        );
        let yuv444 = Settings {
            pixel_format: Some("yuv444p".into()),
            ..Settings::default()
        };
        assert_eq!(plan(yuv444, true, &with_vt).encoder, "libx264");
        // Neither linked nor external: the existing error.
        let msg = select_encoder(Some("libx264"), false, |_| false).unwrap_err();
        assert!(msg.contains("\"libx264\""), "{msg}");
    }

    #[test]
    fn the_gpu_encoders_write_their_codec_and_take_420_only() {
        let has = |name: &str| {
            matches!(
                name,
                "h264_vaapi" | "hevc_vaapi" | "h264_qsv" | "hevc_qsv" | "aac"
            )
        };
        let plan = |encoder: &str, pixel_format: Option<&str>, crf: Option<f64>| {
            resolve(
                &Settings {
                    encoder: Some(encoder.into()),
                    pixel_format: pixel_format.map(str::to_string),
                    crf,
                    ..Settings::default()
                },
                Path::new("out.mp4"),
                false,
                has,
            )
        };
        for (encoder, codec) in [
            ("h264_vaapi", Codec::H264),
            ("h264_qsv", Codec::H264),
            ("hevc_vaapi", Codec::H265),
            ("hevc_qsv", Codec::H265),
        ] {
            let r = plan(encoder, None, Some(20.0)).unwrap();
            assert_eq!(
                (r.codec, r.pix, r.quality),
                (codec, Pix::Yuv420p, Quality::Crf(20.0))
            );
        }
        // 10-bit: HEVC only (no Intel GPU encodes H.264 10-bit).
        assert_eq!(
            plan("hevc_vaapi", Some("yuv420p10le"), None).unwrap().pix,
            Pix::Yuv420p10
        );
        assert_eq!(
            plan("hevc_qsv", Some("yuv420p10le"), None).unwrap().pix,
            Pix::Yuv420p10
        );
        for (encoder, pix) in [
            ("h264_vaapi", "yuv420p10le"),
            ("h264_qsv", "yuv420p10le"),
            ("hevc_vaapi", "yuv444p"),
            ("hevc_qsv", "yuv422p10le"),
            ("h264_vaapi", "yuv422p"),
        ] {
            let msg = plan(encoder, Some(pix), None).unwrap_err();
            assert!(
                msg.contains(encoder) && msg.contains(pix) && msg.contains("software"),
                "{msg}"
            );
        }
        // The codec flag must agree, and --crf is checked like any H.264 one.
        assert!(
            resolve(
                &Settings {
                    encoder: Some("h264_vaapi".into()),
                    codec: Some(Codec::H265),
                    ..Settings::default()
                },
                Path::new("out.mp4"),
                false,
                has
            )
            .unwrap_err()
            .contains("does not write h265")
        );
        assert!(
            plan("h264_qsv", None, Some(52.0))
                .unwrap_err()
                .contains("between 0 and 51")
        );
        // The linked ffmpeg never drives them, whatever it lists.
        assert!(!has_linked_encoder("h264_vaapi") && !has_linked_encoder("hevc_qsv"));
    }

    #[test]
    fn a_missing_encoder_says_how_to_use_the_system_ffmpeg() {
        use external::Availability::{Failed, Missing, Ready};
        let msg = unavailable_message("libx265", Missing);
        assert!(
            msg.contains("\"libx265\"") && msg.contains("KINETOGRAPH_FFMPEG"),
            "{msg}"
        );
        assert!(unavailable_message("nope", Ready).contains("KINETOGRAPH_FFMPEG"));
        let msg = unavailable_message("h264_vaapi", Missing);
        assert!(
            msg.contains("\"h264_vaapi\"")
                && msg.contains("LGPL")
                && msg.contains("KINETOGRAPH_FFMPEG=/usr/bin/ffmpeg"),
            "{msg}"
        );
        // Listed but not opening: ffmpeg's own words and the fix come through, and the env var is not blamed.
        let failed = Failed {
            program: "/usr/bin/ffmpeg".into(),
            reason: "Failed to initialise VAAPI connection\nFix: install intel-media-va-driver"
                .into(),
        };
        let msg = unavailable_message("h264_vaapi", failed);
        assert!(
            msg.contains("/usr/bin/ffmpeg lists")
                && msg.contains("does not open")
                && msg.contains("intel-media-va-driver"),
            "{msg}"
        );
        // The same wording reaches `select_encoder`.
        let msg = select_encoder(Some("h264_qsv"), false, |_| false).unwrap_err();
        assert!(
            msg.contains("\"h264_qsv\"") && msg.contains("KINETOGRAPH_FFMPEG"),
            "{msg}"
        );
    }

    #[test]
    fn the_container_comes_from_the_extension() {
        assert_eq!(container_for(Path::new("a/out.mp4")), Ok("mp4"));
        assert_eq!(container_for(Path::new("out.MOV")), Ok("mov"));
        for bad in ["out", "out.mkv", "out.png", ".mp4"] {
            let msg = container_for(Path::new(bad)).unwrap_err();
            assert!(msg.contains(".mp4 or .mov"), "{bad}: {msg}");
        }
    }

    #[test]
    fn the_bit_rate_is_a_fifth_of_a_bit_per_pixel() {
        assert_eq!(bit_rate(1920, 1080, 30.0), 12_441_600);
        assert_eq!(bit_rate(100, 50, 24.0), 24_000);
    }

    #[test]
    fn odd_sizes_are_refused_before_anything_is_opened() {
        let path = std::env::temp_dir().join("kinetograph-odd-size.mp4");
        for (w, h) in [(65, 48), (64, 47)] {
            let msg = VideoEncoder::create(&path, w, h, 30.0, &x264(&path))
                .err()
                .expect("odd size accepted");
            assert!(
                msg.contains("even") && msg.contains(&format!("{w}x{h}")),
                "{msg}"
            );
        }
        assert!(!path.exists());
    }

    /// Decodes every frame of `path` to RGBA. Returns the size, the
    /// colour-space tag and the pictures.
    fn decode(path: &Path) -> (u32, u32, color::Space, Vec<Vec<u8>>) {
        let mut input = format::input(path).unwrap();
        let index = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .unwrap()
            .index();
        let parameters = input.stream(index).unwrap().parameters();
        let mut decoder = codec::context::Context::from_parameters(parameters)
            .unwrap()
            .decoder()
            .video()
            .unwrap();
        let (w, h) = (decoder.width(), decoder.height());
        let mut to_rgba = scaling::Context::get(
            decoder.format(),
            w,
            h,
            Pixel::RGBA,
            w,
            h,
            ScaleFlags::BICUBIC,
        )
        .unwrap();
        set_bt709(&mut to_rgba, false, true).unwrap();
        let mut frames = Vec::new();
        let mut take = |decoder: &mut ffmpeg::decoder::Video| {
            let mut yuv = frame::Video::empty();
            while decoder.receive_frame(&mut yuv).is_ok() {
                let mut rgba = frame::Video::empty();
                to_rgba.run(&yuv, &mut rgba).unwrap();
                let (stride, row) = (rgba.stride(0), w as usize * 4);
                let mut packed = Vec::with_capacity(row * h as usize);
                for y in 0..h as usize {
                    packed.extend_from_slice(&rgba.data(0)[y * stride..y * stride + row]);
                }
                frames.push(packed);
            }
        };
        for (stream, packet) in input.packets() {
            if stream.index() == index {
                decoder.send_packet(&packet).unwrap();
                take(&mut decoder);
            }
        }
        decoder.send_eof().unwrap();
        take(&mut decoder);
        (w, h, decoder.color_space(), frames)
    }

    fn mean(rgba: &[u8]) -> [f64; 3] {
        let n = (rgba.len() / 4) as f64;
        let mut sum = [0.0; 3];
        for px in rgba.as_chunks::<4>().0 {
            for c in 0..3 {
                sum[c] += f64::from(px[c]);
            }
        }
        sum.map(|s| s / n)
    }

    #[test]
    fn frames_survive_an_encode_and_decode_round_trip() {
        if !has_encoder("libx264") {
            panic!("this test needs an ffmpeg with libx264");
        }
        let dir = std::env::temp_dir().join(format!("kinetograph-encode-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("round-trip.mp4");

        let (w, h) = (64_u32, 48_u32);
        let mut encoder = VideoEncoder::create(&path, w, h, 29.97, &x264(&path)).unwrap();
        for i in 0..10_u8 {
            // A flat picture whose red climbs a step a frame.
            let rgba: Vec<u8> = (0..w * h)
                .flat_map(|_| [100 + 10 * i, 60, 140, 255])
                .collect();
            encoder.push(&rgba).unwrap();
        }
        assert_eq!(encoder.finish().unwrap(), 10);

        let (dw, dh, space, frames) = decode(&path);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((dw, dh), (w, h));
        assert_eq!(space, color::Space::BT709);
        assert_eq!(frames.len(), 10);
        for (i, frame) in frames.iter().enumerate() {
            let [r, g, b] = mean(frame);
            let want = [100.0 + 10.0 * i as f64, 60.0, 140.0];
            for (got, want) in [r, g, b].into_iter().zip(want) {
                // Lossy, and chroma is halved, but a flat colour comes back
                // within a few levels.
                assert!((got - want).abs() < 6.0, "frame {i}: {got} vs {want}");
            }
        }
    }

    #[test]
    fn a_repeated_frame_encodes_as_the_same_pixels_pushed_again() {
        if !has_encoder("libx264") {
            panic!("this test needs an ffmpeg with libx264");
        }
        let dir = std::env::temp_dir().join(format!("kinetograph-repeat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (w, h) = (64_u32, 48_u32);
        let picture = |i: u32| -> Vec<u8> {
            (0..w * h)
                .flat_map(|p| {
                    [
                        (p % w * 4 + i * 30) as u8,
                        (p / w * 5) as u8,
                        (i * 40) as u8,
                        255,
                    ]
                })
                .collect()
        };
        // 0, 1, 1, 1, 2, 2: once pushed again, once repeated (from RGBA and
        // from converted planes).
        let order = [0, 1, 1, 1, 2, 2];
        let pushed = dir.join("pushed.mp4");
        let mut encoder = VideoEncoder::create(&pushed, w, h, 30.0, &x264(&pushed)).unwrap();
        for &i in &order {
            encoder.push(&picture(i)).unwrap();
        }
        encoder.finish().unwrap();
        let repeated = dir.join("repeated.mp4");
        let mut encoder = VideoEncoder::create(&repeated, w, h, 30.0, &x264(&repeated)).unwrap();
        assert!(encoder.push_repeat().is_err(), "nothing to repeat yet");
        encoder.push(&picture(0)).unwrap();
        encoder.push(&picture(1)).unwrap();
        encoder.push_repeat().unwrap();
        encoder.push_repeat().unwrap();
        encoder
            .push_yuv(&rgba_to_yuv420(&picture(2), w, h).unwrap())
            .unwrap();
        encoder.push_repeat().unwrap();
        assert_eq!(encoder.finish().unwrap(), 6);
        let (a, b) = (decode(&pushed).3, decode(&repeated).3);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(a.len(), 6);
        assert!(
            a[1] != a[4],
            "the pictures differ, so the comparison means something"
        );
        assert!(a == b, "the decoded frames differ");
    }

    #[test]
    fn frames_converted_elsewhere_encode_to_the_same_video() {
        if !has_encoder("libx264") {
            panic!("this test needs an ffmpeg with libx264");
        }
        let dir = std::env::temp_dir().join(format!("kinetograph-yuv-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (w, h) = (64_u32, 48_u32);
        // Not flat, so rows, columns and the halved chroma all matter.
        let direct = dir.join("direct.mp4");
        let mut encoder = VideoEncoder::create(&direct, w, h, 30.0, &x264(&direct)).unwrap();
        for i in 0..6 {
            encoder.push(&picture_for(w, h, i)).unwrap();
        }
        encoder.finish().unwrap();
        // The converter runs on another thread, as a render worker's does.
        let converted = dir.join("converted.mp4");
        let mut encoder = VideoEncoder::create(&converted, w, h, 30.0, &x264(&converted)).unwrap();
        for i in 0..6 {
            let yuv = std::thread::spawn(move || rgba_to_yuv420(&picture_for(w, h, i), w, h))
                .join()
                .unwrap()
                .unwrap();
            assert_eq!(yuv.len(), (w * h * 3 / 2) as usize);
            encoder.push_yuv(&yuv).unwrap();
        }
        encoder.finish().unwrap();
        let (a, b) = (decode(&direct).3, decode(&converted).3);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(a.len(), 6);
        assert!(a == b, "the decoded frames differ");

        fn picture_for(w: u32, h: u32, i: u32) -> Vec<u8> {
            (0..w * h)
                .flat_map(|p| {
                    let (x, y) = (p % w, p / w);
                    [
                        (x * 4 + i * 9) as u8,
                        (y * 5) as u8,
                        ((x ^ y) * 3) as u8,
                        255,
                    ]
                })
                .collect()
        }
    }

    #[test]
    fn audio_must_be_something_aac_can_take() {
        let one = [0.0_f32; 10];
        let two = [0.0_f32; 9];
        let ok = |rate, channels: &[&[f32]]| {
            AudioPcm {
                sample_rate: rate,
                channels,
            }
            .validate()
        };
        assert!(ok(48000, &[&one, &one]).is_ok());
        assert!(ok(44100, &[&one]).is_ok());
        for (result, want) in [
            (ok(12345, &[&one]), "sample rate"),
            (ok(48000, &[]), "0 channels"),
            (ok(48000, &[&one, &one, &one]), "3 channels"),
            (ok(48000, &[&one, &two]), "differ in length"),
        ] {
            let msg = result.unwrap_err();
            assert!(msg.contains(want), "{msg}");
        }
    }

    #[test]
    fn the_partial_file_sits_beside_the_output_with_its_extension() {
        assert_eq!(
            partial_path(Path::new("/tmp/a/out.mp4")),
            Path::new("/tmp/a/.out.mp4.partial.mp4")
        );
        assert_eq!(container_for(&partial_path(Path::new("x.MOV"))), Ok("mov"));
    }

    #[test]
    fn audio_is_muxed_beside_the_copied_video() {
        if !has_encoder("libx264") || !has_encoder("aac") {
            panic!("this test needs an ffmpeg with libx264 and aac");
        }
        let dir = std::env::temp_dir().join(format!("kinetograph-mux-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (video, out) = (dir.join("video.mp4"), dir.join("out.mp4"));

        // One second of video at 10 fps, and 1.5 s of a 440 Hz tone, louder
        // on the left.
        let mut encoder = VideoEncoder::create(&video, 64, 48, 10.0, &x264(&video)).unwrap();
        for _ in 0..10 {
            encoder.push(&[128; 64 * 48 * 4]).unwrap();
        }
        encoder.finish().unwrap();
        let rate = 48000_u32;
        let tone: Vec<f32> = (0..rate as usize * 3 / 2)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin())
            .collect();
        let quiet: Vec<f32> = tone.iter().map(|s| s * 0.25).collect();
        mux_audio(
            &video,
            &out,
            &AudioPcm {
                sample_rate: rate,
                channels: &[&tone, &quiet],
            },
            &x264(&out),
        )
        .unwrap();

        let mut input = format::input(&out).unwrap();
        let audio_index = input
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .expect("no audio stream")
            .index();
        let parameters = input.stream(audio_index).unwrap().parameters();
        assert_eq!(parameters.id(), codec::Id::AAC);
        let mut decoder = codec::context::Context::from_parameters(parameters)
            .unwrap()
            .decoder()
            .audio()
            .unwrap();
        assert_eq!((decoder.rate(), decoder.channels()), (rate, 2));
        let mut samples = 0_usize;
        let mut energy = [0.0_f64; 2];
        let mut video_packets = 0;
        let mut take = |decoder: &mut ffmpeg::decoder::Audio| {
            let mut decoded = frame::Audio::empty();
            while decoder.receive_frame(&mut decoded).is_ok() {
                samples += decoded.samples();
                for (c, e) in energy.iter_mut().enumerate() {
                    *e += decoded.plane::<f32>(c)[..decoded.samples()]
                        .iter()
                        .map(|s| f64::from(*s).powi(2))
                        .sum::<f64>();
                }
            }
        };
        for (stream, packet) in input.packets() {
            if stream.index() == audio_index {
                decoder.send_packet(&packet).unwrap();
                take(&mut decoder);
            } else {
                video_packets += 1;
            }
        }
        decoder.send_eof().unwrap();
        take(&mut decoder);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(video_packets, 10, "the video is copied whole");
        // The encoder's delay adds a little at the front.
        assert!(
            samples >= rate as usize * 3 / 2 && samples < rate as usize * 3 / 2 + 4096,
            "{samples} samples"
        );
        // A tone of amplitude 1 has mean square 0.5; channel two is a
        // quarter of that amplitude.
        let mean = |e: f64| e / samples as f64;
        assert!(
            (mean(energy[0]) - 0.5).abs() < 0.1,
            "left {}",
            mean(energy[0])
        );
        assert!(
            (mean(energy[1]) - 0.5 / 16.0).abs() < 0.02,
            "right {}",
            mean(energy[1])
        );
    }

    fn ask(
        codec: Option<Codec>,
        out: &str,
        edit: impl FnOnce(&mut Settings),
    ) -> Result<Resolved, String> {
        let mut settings = Settings {
            codec,
            ..Settings::default()
        };
        edit(&mut settings);
        resolve(&settings, Path::new(out), true, has_encoder)
    }

    #[test]
    fn the_codec_follows_the_extension_and_the_container_must_fit_it() {
        assert_eq!(ask(None, "a.mp4", |_| {}).unwrap().codec, Codec::H264);
        assert_eq!(ask(None, "a.webm", |_| {}).unwrap().codec, Codec::Vp9);
        assert_eq!(ask(None, "a.gif", |_| {}).unwrap().codec, Codec::Gif);
        assert_eq!(
            ask(Some(Codec::ProRes), "a.mov", |_| {}).unwrap().container,
            "mov"
        );
        for (codec, out) in [
            (Codec::ProRes, "a.mp4"),
            (Codec::Vp9, "a.mp4"),
            (Codec::Gif, "a.mov"),
            (Codec::H265, "a.webm"),
        ] {
            let msg = ask(Some(codec), out, |_| {}).unwrap_err();
            assert!(msg.contains(codec.name()) && msg.contains(out), "{msg}");
        }
        assert!(
            ask(None, "a.mkv", |_| {})
                .unwrap_err()
                .contains(".mp4 or .mov")
        );
    }

    #[test]
    fn crf_and_bitrate_are_exclusive_and_checked_per_codec() {
        let both = ask(None, "a.mp4", |s| {
            s.crf = Some(20.0);
            s.video_bitrate = Some(1_000_000);
        });
        assert!(both.unwrap_err().contains("cannot be used together"));
        assert!(
            ask(Some(Codec::H264), "a.mp4", |s| s.crf = Some(52.0))
                .unwrap_err()
                .contains("between 0 and 51")
        );
        assert!(ask(Some(Codec::Vp9), "a.webm", |s| s.crf = Some(63.0)).is_ok());
        assert!(
            ask(Some(Codec::ProRes), "a.mov", |s| s.crf = Some(20.0))
                .unwrap_err()
                .contains("prores-profile")
        );
        assert!(ask(Some(Codec::Gif), "a.gif", |s| s.video_bitrate = Some(1)).is_err());
    }

    #[test]
    fn hardware_encoders_are_used_only_for_what_they_can_do() {
        if !has_encoder("h264_videotoolbox") {
            return;
        }
        assert_eq!(
            ask(None, "a.mp4", |_| {}).unwrap().encoder,
            "h264_videotoolbox"
        );
        let r = ask(None, "a.mp4", |s| s.pixel_format = Some("yuv444p".into())).unwrap();
        assert_eq!(r.encoder, "libx264");
        let r = ask(Some(Codec::ProRes), "a.mov", |_| {}).unwrap();
        assert_eq!(
            (r.encoder.as_str(), r.pix),
            ("prores_videotoolbox", Pix::P210)
        );
        let r = ask(Some(Codec::ProRes), "a.mov", |s| {
            s.prores_profile = Some("4444".into())
        })
        .unwrap();
        assert_eq!(r.pix, Pix::P416);
        let msg = ask(Some(Codec::ProRes), "a.mov", |s| {
            s.pixel_format = Some("yuv420p".into())
        })
        .unwrap_err();
        assert!(msg.contains("yuv422p10le"), "{msg}");
        let msg = ask(None, "a.mp4", |s| {
            s.encoder = Some("h264_videotoolbox".into());
            s.pixel_format = Some("yuv444p".into());
        })
        .unwrap_err();
        assert!(msg.contains("only yuv420p"), "{msg}");
        assert_eq!(crf_to_quality(18.0), 65);
        assert_eq!(crf_to_quality(0.0), 100);
        assert_eq!(crf_to_quality(51.0), 1);
    }

    #[test]
    fn audio_codec_must_fit_the_container() {
        assert_eq!(
            ask(None, "a.mp4", |_| {}).unwrap().audio_codec,
            Some(AudioCodec::Aac)
        );
        assert_eq!(
            ask(Some(Codec::ProRes), "a.mov", |_| {})
                .unwrap()
                .audio_codec,
            Some(AudioCodec::Pcm)
        );
        assert_eq!(
            ask(None, "a.webm", |_| {}).unwrap().audio_codec,
            Some(AudioCodec::Opus)
        );
        assert!(
            ask(None, "a.mp4", |s| s.audio_codec = Some("pcm".into()))
                .unwrap_err()
                .contains("aac")
        );
        assert!(ask(None, "a.mov", |s| s.audio_codec = Some("pcm".into())).is_ok());
        assert!(
            ask(None, "a.mov", |s| {
                s.audio_codec = Some("pcm".into());
                s.audio_bitrate = Some(1000);
            })
            .is_err()
        );
        assert!(ask(None, "a.gif", |s| s.audio_bitrate = Some(1000)).is_err());
    }

    /// Every codec writes a file that reads back with the right codec, size and pixel format, and frames converted on
    /// another thread encode to the same pictures as frames converted by the encoder.
    #[test]
    fn every_codec_writes_a_valid_file_from_either_path() {
        let dir = std::env::temp_dir().join(format!("kinetograph-codecs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (w, h) = (64_u32, 48_u32);
        let picture = |i: u32| -> Vec<u8> {
            (0..w * h)
                .flat_map(|p| [((p % w) * 4 + i * 9) as u8, ((p / w) * 5) as u8, 90, 255])
                .collect()
        };
        let cases: [(Codec, &str, Option<&str>, &str); 7] = [
            (Codec::H264, "a.mp4", None, "h264"),
            (Codec::H264, "b.mp4", Some("yuv444p"), "h264"),
            (Codec::H265, "c.mp4", None, "hevc"),
            (Codec::ProRes, "d.mov", None, "prores"),
            (Codec::Vp9, "e.webm", None, "vp9"),
            (Codec::Gif, "f.gif", None, "gif"),
            (Codec::H265, "g.mov", Some("yuv420p10le"), "hevc"),
        ];
        for (codec, name, pixel_format, id) in cases {
            let path = dir.join(name);
            let r = ask(Some(codec), path.to_str().unwrap(), |s| {
                s.pixel_format = pixel_format.map(str::to_string)
            })
            .unwrap();
            let mut direct = VideoEncoder::create(&path, w, h, 10.0, &r).unwrap();
            for i in 0..4 {
                direct.push(&picture(i)).unwrap();
            }
            assert_eq!(direct.finish().unwrap(), 4, "{name}");
            let input = format::input(&path).unwrap();
            let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
            let params = stream.parameters();
            assert_eq!(format!("{:?}", params.id()).to_lowercase(), id, "{name}");
            let dec = codec::context::Context::from_parameters(params)
                .unwrap()
                .decoder()
                .video()
                .unwrap();
            assert_eq!((dec.width(), dec.height()), (w, h), "{name}");
            if let Some(want) = pixel_format {
                assert_eq!(
                    format!("{:?}", dec.format()).to_lowercase(),
                    want.to_lowercase(),
                    "{name}"
                );
            }
            drop(input);

            let viaplanes = dir.join(format!("planes-{name}"));
            let mut converted = VideoEncoder::create(&viaplanes, w, h, 10.0, &r).unwrap();
            for i in 0..4 {
                let planes = rgba_to_planes(&picture(i), w, h, r.pix).unwrap();
                converted.push_yuv(&planes).unwrap();
            }
            converted.finish().unwrap();
            if codec != Codec::Gif && !is_videotoolbox(&r.encoder) {
                assert_eq!(
                    decode(&path).3,
                    decode(&viaplanes).3,
                    "{name}: the two paths differ"
                );
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A converted picture must not depend on the pictures this thread converted before it: workers draw different frames.
    #[test]
    fn a_dithered_picture_does_not_depend_on_the_ones_before() {
        let (w, h) = (64_u32, 48_u32);
        let picture = move |i: u32| -> Vec<u8> {
            (0..w * h)
                .flat_map(|p| {
                    [
                        ((p % w) * 3 + i * 7) as u8,
                        ((p / w) * 4) as u8,
                        (i * 40) as u8,
                        255,
                    ]
                })
                .collect()
        };
        for pix in [Pix::Rgb8, Pix::Yuv420p10] {
            let alone = std::thread::spawn(move || rgba_to_planes(&picture(3), w, h, pix).unwrap())
                .join()
                .unwrap();
            let after = std::thread::spawn(move || {
                for i in 0..3 {
                    rgba_to_planes(&picture(i), w, h, pix).unwrap();
                }
                rgba_to_planes(&picture(3), w, h, pix).unwrap()
            })
            .join()
            .unwrap();
            assert!(alone == after, "{pix:?}");
        }
    }
}
