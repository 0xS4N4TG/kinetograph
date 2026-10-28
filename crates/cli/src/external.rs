//! Encoders the linked ffmpeg lacks, run by a separate `ffmpeg` program.
//!
//! The ffmpeg linked into the addon is LGPL-only and has no libx264 or libx265 (both GPL). Kinetograph's platform
//! packages ship a second, GPL `ffmpeg` executable with them (`scripts/build-ffmpeg-gpl.sh`); like Remotion's, it is
//! only ever run as a child process, never linked. This module finds it, asks it which encoders it has, and drives it:
//! raw pictures in on a pipe, a video-only file out. Audio is muxed afterwards by the linked ffmpeg like any other
//! video (`encode::mux_audio`).
//!
//! Where the program comes from, first match wins: `KINETOGRAPH_FFMPEG`, the path the host gave (`set_path`: the
//! platform package's `bin/ffmpeg`), `ffmpeg` on the `PATH` when it lists libx264 (or, for the hardware encoders
//! below, the encoder asked for). An encoder is looked for in each of those in turn, so a `KINETOGRAPH_FFMPEG` that
//! names a system ffmpeg with `h264_vaapi` does not hide the bundled program's `libx264`.
//!
//! The Intel and AMD hardware encoders (`h264_vaapi`, `hevc_vaapi`, `h264_qsv`, `hevc_qsv`) run here too. The linked
//! ffmpeg cannot have them without linking libva, which would stop the addon loading on a machine without it (see the
//! known issues), so a system ffmpeg that has them does the encoding. They need a hardware device and an upload filter
//! (`hardware_plan`), and they count as available only if a small test encode opens (`opened`), as `encode::PROBED`
//! does for NVENC.

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

/// The ffmpeg programs to try, in order, and the encoders each lists. The `PATH`'s counts only when it lists libx264
/// (the encoder this exists for) or the hardware encoder `wanted`: a user whose system ffmpeg has `h264_vaapi` should
/// not have to set anything.
fn candidates(wanted: Option<&str>) -> Vec<(PathBuf, Vec<String>)> {
    let env = std::env::var_os("KINETOGRAPH_FFMPEG").filter(|v| !v.is_empty());
    let configured = CONFIGURED.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut found: Vec<(PathBuf, Vec<String>)> = Vec::new();
    for candidate in [env.map(PathBuf::from), configured].into_iter().flatten() {
        if let Some(list) = encoders_of(&candidate) {
            found.push((candidate, list));
        }
    }
    let path = PathBuf::from(PROGRAM);
    if let Some(list) = encoders_of(&path) {
        let wanted_here = wanted.is_some_and(|w| is_hardware(w) && list.iter().any(|n| n == w));
        if wanted_here || list.iter().any(|n| n == encode::DEFAULT_ENCODER) {
            found.push((path, list));
        }
    }
    found
}

/// Whether the external ffmpeg has an encoder called `name`; a hardware one (`is_hardware`) must also open.
pub fn has_encoder(name: &str) -> bool {
    program_for(name).is_some()
}

/// The ffmpeg program that has `name` (and, for a hardware encoder, opens it), for a message.
pub fn program_for(name: &str) -> Option<PathBuf> {
    candidates(Some(name))
        .into_iter()
        .find_map(|(program, list)| {
            let listed = list.iter().any(|n| n == name);
            (listed && (!is_hardware(name) || opened(&program, name).is_ok())).then_some(program)
        })
}

/// Whether the external ffmpeg can encode with an encoder, and if not why.
#[derive(Clone, Debug, PartialEq)]
pub enum Availability {
    /// No ffmpeg program was found, or none lists it.
    Missing,
    /// `program` lists it, but a test encode with it did not open.
    Failed {
        program: PathBuf,
        reason: String,
    },
    Ready,
}

/// Whether, and if not why, the external ffmpeg can encode with `name`.
pub fn availability(name: &str) -> Availability {
    let mut failed = None;
    for (program, list) in candidates(Some(name)) {
        if !list.iter().any(|n| n == name) {
            continue;
        }
        if !is_hardware(name) {
            return Availability::Ready;
        }
        match opened(&program, name) {
            Ok(_) => return Availability::Ready,
            Err(reason) => {
                failed.get_or_insert(Availability::Failed { program, reason });
            }
        }
    }
    failed.unwrap_or(Availability::Missing)
}

/// The hardware encoders the external ffmpeg drives for Intel and AMD GPUs: VAAPI (Linux) and Intel Quick Sync.
pub const HARDWARE: [&str; 4] = ["h264_vaapi", "hevc_vaapi", "h264_qsv", "hevc_qsv"];

/// Whether `name` is one of `HARDWARE`.
pub fn is_hardware(name: &str) -> bool {
    HARDWARE.contains(&name)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Hw {
    Vaapi,
    Qsv,
}

fn hw_of(encoder: &str) -> Option<Hw> {
    match encoder {
        "h264_vaapi" | "hevc_vaapi" => Some(Hw::Vaapi),
        "h264_qsv" | "hevc_qsv" => Some(Hw::Qsv),
        _ => None,
    }
}

/// The render node VAAPI uses: `requested` (`KINETOGRAPH_VAAPI_DEVICE`) when it is set and not empty, else the lowest
/// numbered `renderD*` among `entries` (file names in `/dev/dri`). Render nodes, not `card*`: they need no display
/// server and no root.
fn pick_render_node(requested: Option<&str>, entries: &[String]) -> Option<String> {
    if let Some(device) = requested.filter(|d| !d.is_empty()) {
        return Some(device.to_string());
    }
    entries
        .iter()
        .filter_map(|name| {
            let n: u32 = name.strip_prefix("renderD")?.parse().ok()?;
            Some((n, name))
        })
        .min()
        .map(|(_, name)| format!("/dev/dri/{name}"))
}

/// The device a hardware encoder opens: VAAPI's render node (always), QSV's only when `KINETOGRAPH_VAAPI_DEVICE` names
/// one (else the Quick Sync runtime picks).
fn device_for(hw: Hw) -> Result<Option<String>, String> {
    let requested = std::env::var("KINETOGRAPH_VAAPI_DEVICE")
        .ok()
        .filter(|d| !d.is_empty());
    match hw {
        Hw::Qsv => Ok(requested),
        Hw::Vaapi => {
            if !cfg!(target_os = "linux") && requested.is_none() {
                return Err("VAAPI exists only on Linux".into());
            }
            let entries: Vec<String> = std::fs::read_dir("/dev/dri")
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .collect();
            pick_render_node(requested.as_deref(), &entries).map(Some).ok_or_else(|| {
                "there is no render node (/dev/dri/renderD*): no GPU driver is loaded, or this container has no \
                 /dev/dri (docker run --device /dev/dri)"
                    .into()
            })
        }
    }
}

/// How a hardware encoder is started: the options before the input, the filter that moves the pictures to the GPU, and
/// options of the encoder itself.
#[derive(Clone, Debug, PartialEq)]
struct HardwarePlan {
    /// Before `-i`: the device.
    device_args: Vec<String>,
    /// The `-vf` value: converts to the layout the encoder takes and uploads.
    filter: String,
    /// After `-c:v`: `-low_power 1`.
    encoder_args: Vec<String>,
}

/// The device options, upload filter and encoder options for `encoder` taking `ten_bit` (or 8-bit) 4:2:0 pictures from
/// `device`. `low_power` asks for the fixed-function (VDEnc) entry point, which the newest Intel GPUs (Arc, Meteor Lake)
/// have for H.264 and HEVC and some older ones lack, so `opened` tries it second.
fn hardware_plan(
    encoder: &str,
    ten_bit: bool,
    device: Option<&str>,
    low_power: bool,
) -> Result<HardwarePlan, String> {
    let hw = hw_of(encoder).ok_or_else(|| format!("{encoder} is not a hardware encoder"))?;
    // Both want semi-planar pictures: 8-bit NV12, 10-bit P010. ffmpeg converts from the planar ones sent in.
    let layout = if ten_bit { "p010le" } else { "nv12" };
    let s = |v: &str| v.to_string();
    let (device_args, filter) = match hw {
        Hw::Vaapi => {
            let device = device.ok_or("VAAPI needs a render node")?;
            (
                vec![
                    s("-init_hw_device"),
                    format!("vaapi=va:{device}"),
                    s("-filter_hw_device"),
                    s("va"),
                ],
                format!("format={layout},hwupload"),
            )
        }
        Hw::Qsv => {
            let args = match device {
                // A named render node: make the VAAPI device there and derive the Quick Sync one from it.
                Some(device) => vec![
                    s("-init_hw_device"),
                    format!("vaapi=va:{device}"),
                    s("-init_hw_device"),
                    s("qsv=hw@va"),
                    s("-filter_hw_device"),
                    s("hw"),
                ],
                None => vec![
                    s("-init_hw_device"),
                    s("qsv=hw"),
                    s("-filter_hw_device"),
                    s("hw"),
                ],
            };
            (
                args,
                format!("format={layout},hwupload=extra_hw_frames=64,format=qsv"),
            )
        }
    };
    let encoder_args = if low_power {
        vec![s("-low_power"), s("1")]
    } else {
        Vec::new()
    };
    Ok(HardwarePlan {
        device_args,
        filter,
        encoder_args,
    })
}

/// What a hardware encoder needed to open: the device, and whether `-low_power 1` was required.
#[derive(Clone, Debug, PartialEq)]
struct Opened {
    device: Option<String>,
    low_power: bool,
}

type OpenedKey = (PathBuf, String, Option<String>);

fn opened_cache() -> &'static Mutex<HashMap<OpenedKey, Result<Opened, String>>> {
    static CACHE: OnceLock<Mutex<HashMap<OpenedKey, Result<Opened, String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether `program` can open hardware encoder `name` on this machine, asked once per program, encoder and device: a
/// small encode of four grey pictures, first with the encoder's defaults and then with `-low_power 1`. `Err` says
/// what ffmpeg said and what usually fixes it.
fn opened(program: &Path, name: &str) -> Result<Opened, String> {
    let hw = hw_of(name).ok_or_else(|| format!("{name} is not a hardware encoder"))?;
    let device = device_for(hw).map_err(|e| format!("{name}: {e}"))?;
    let key = (program.to_path_buf(), name.to_string(), device.clone());
    if let Some(known) = opened_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
    {
        return known.clone();
    }
    let outcome = probe(program, name, hw, device.as_deref());
    opened_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, outcome.clone());
    outcome
}

fn probe(program: &Path, name: &str, hw: Hw, device: Option<&str>) -> Result<Opened, String> {
    let (width, height) = (256_u32, 144_u32);
    let settings = Resolved {
        codec: if name.starts_with("hevc") {
            encode::Codec::H265
        } else {
            encode::Codec::H264
        },
        encoder: name.to_string(),
        container: "null",
        pix: Pix::Yuv420p,
        quality: Quality::Default,
        prores_profile: 3,
        audio_codec: None,
        audio_bitrate: None,
        every_nth_frame: 1,
    };
    let size: usize = Pix::Yuv420p
        .planes(width as usize, height as usize)
        .iter()
        .map(|(row, rows)| row * rows)
        .sum();
    let picture = vec![128_u8; size];
    let mut first_failure = None;
    for low_power in [false, true] {
        let plan = hardware_plan(name, false, device, low_power)?;
        let mut args = base_args();
        args.extend(encode_args(
            &settings,
            width,
            height,
            30.0,
            (30, 1),
            Some(&plan),
        ));
        args.extend(["-frames:v", "4", "-f", "null", "-"].map(OsString::from));
        match run_probe(program, &args, &picture, 4) {
            Ok(()) => {
                return Ok(Opened {
                    device: device.map(str::to_string),
                    low_power,
                });
            }
            Err(why) => {
                first_failure.get_or_insert(why);
            }
        }
    }
    Err(format!(
        "{}\n{}",
        first_failure.unwrap_or_default(),
        fix_hint(hw, device)
    ))
}

/// The usual causes and cures, appended to what ffmpeg said.
fn fix_hint(hw: Hw, device: Option<&str>) -> String {
    match hw {
        Hw::Vaapi => {
            let node = device.unwrap_or("/dev/dri/renderD128");
            format!(
                "Fix: VAAPI needs a driver for the GPU (Intel: intel-media-va-driver or intel-media-va-driver-non-free; \
                 AMD: mesa-va-drivers) and read access to {node} (your user in the `render` group). \
                 `vainfo --display drm --device {node}` must list an encode entry point (VAEntrypointEncSlice or \
                 EncSliceLP) for the codec. KINETOGRAPH_VAAPI_DEVICE=/dev/dri/renderD129 picks another GPU."
            )
        }
        Hw::Qsv => "Fix: Quick Sync needs Intel's oneVPL runtime (libvpl2 and libmfx-gen1.2, or onevpl-intel-gpu), the \
                    iHD VAAPI driver (intel-media-va-driver-non-free), an ffmpeg built with --enable-libvpl, and read \
                    access to /dev/dri/renderD* (the `render` group). If h264_vaapi works and this does not, use the \
                    VAAPI encoder."
            .to_string(),
    }
}

/// Runs `program` with `args`, sends it `pictures` copies of `picture` and waits for it, at most 20 seconds. `Err` is
/// the last of what it said on stderr.
fn run_probe(
    program: &Path,
    args: &[OsString],
    picture: &[u8],
    pictures: usize,
) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run {}: {e}", program.display()))?;
    let mut stdin = child.stdin.take();
    let mut err = child.stderr.take().ok_or("no stderr on the ffmpeg child")?;
    let reader = thread::spawn(move || {
        let mut raw = Vec::new();
        let _ = err.read_to_end(&mut raw);
        String::from_utf8_lossy(&raw).into_owned()
    });
    let data = picture.to_vec();
    let writer = thread::spawn(move || {
        for _ in 0..pictures {
            if stdin.as_mut().is_none_or(|s| s.write_all(&data).is_err()) {
                break;
            }
        }
        drop(stdin.take());
    });
    // Not a render: a one-time capability check, so a stuck driver is cut off by the clock.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if std::time::Instant::now() < deadline => {
                thread::sleep(std::time::Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let _ = writer.join();
    let said = reader.join().unwrap_or_default();
    match status {
        Some(s) if s.success() => Ok(()),
        Some(s) => Err(format!(
            "{} failed ({s}): {}",
            program.display(),
            tail(&said)
        )),
        None => Err(format!(
            "{} did not finish a four-picture test encode in 20 s: {}",
            program.display(),
            tail(&said)
        )),
    }
}

/// The last few lines of ffmpeg's messages: the cause comes last, and a long log hides it.
fn tail(said: &str) -> String {
    let lines: Vec<&str> = said
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    lines[lines.len().saturating_sub(4)..].join(" | ")
}

/// A CRF as the whole number an integer option takes, at least `least`.
fn whole(crf: f64, least: i64) -> String {
    (crf.round() as i64).max(least).to_string()
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
        // Constant quality is the encoder's CQP: the QP of an H.264 or HEVC picture, on the same 0 to 51 scale as a CRF
        // (not the same picture quality for the same number; see the encoder docs).
        "h264_vaapi" | "hevc_vaapi" => {
            match settings.quality {
                Quality::Crf(crf) => push("-qp", whole(crf, 0)),
                Quality::Bitrate(bits) => push("-b:v", bits.to_string()),
                Quality::Default => push("-b:v", encode::bit_rate(width, height, fps).to_string()),
            }
            if settings.encoder == "hevc_vaapi" && settings.pix == Pix::Yuv420p10 {
                push("-profile:v", "main10".into());
            }
        }
        // Quick Sync's constant quality is ICQ (`-global_quality`, 1 to 51; 0 would turn it off).
        "h264_qsv" | "hevc_qsv" => {
            match settings.quality {
                Quality::Crf(crf) => push("-global_quality", whole(crf, 1)),
                Quality::Bitrate(bits) => push("-b:v", bits.to_string()),
                Quality::Default => push("-b:v", encode::bit_rate(width, height, fps).to_string()),
            }
            if settings.encoder == "hevc_qsv" && settings.pix == Pix::Yuv420p10 {
                push("-profile:v", "main10".into());
            }
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

fn base_args() -> Vec<OsString> {
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
        .map(OsString::from)
        .into()
}

/// Every option from the first input to the output's container: the raw pictures in, the encoder and its quality, and
/// the stream's colour tags. `rate` is `fps` as numerator and denominator. With a `plan` (a hardware encoder)
/// the pictures go through its upload filter and the encoder gets its device, and no `-pix_fmt` is put on the output:
/// the filter has already made the hardware frames, and ffmpeg would try to convert them back.
fn encode_args(
    settings: &Resolved,
    width: u32,
    height: u32,
    fps: f64,
    rate: (i32, i32),
    plan: Option<&HardwarePlan>,
) -> Vec<OsString> {
    let (num, den) = rate;
    let mut args: Vec<OsString> = Vec::new();
    let mut arg = |s: &str| args.push(s.into());
    if let Some(plan) = plan {
        for s in &plan.device_args {
            arg(s);
        }
    }
    // The pictures are already in the pixel format the file holds, so ffmpeg converts nothing (but for hardware).
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
    if let Some(plan) = plan {
        arg("-vf");
        arg(&plan.filter);
    }
    for s in encoder_args(settings, width, height, fps) {
        arg(&s);
    }
    if let Some(plan) = plan {
        for s in &plan.encoder_args {
            arg(s);
        }
    } else {
        arg("-pix_fmt");
        arg(settings.pix.name());
    }
    // The same tags the linked encoder puts on the stream (BT.709, limited range).
    for s in [
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
    args
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
        let program =
            program_for(&settings.encoder).ok_or_else(|| encode::unavailable(&settings.encoder))?;
        let plan = if is_hardware(&settings.encoder) {
            let how = opened(&program, &settings.encoder)?;
            Some(hardware_plan(
                &settings.encoder,
                settings.pix == Pix::Yuv420p10,
                how.device.as_deref(),
                how.low_power,
            )?)
        } else {
            None
        };
        let mut args = base_args();
        args.extend(encode_args(
            settings,
            width,
            height,
            fps,
            (num, den),
            plan.as_ref(),
        ));
        if matches!(settings.container, "mp4" | "mov") {
            args.extend(["-movflags", "+faststart"].map(OsString::from));
        }
        args.push("-f".into());
        args.push(settings.container.into());
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

    const NODE: &str = "/dev/dri/renderD128";

    fn settings(encoder: &str, pix: Pix, quality: Quality) -> Resolved {
        Resolved {
            codec: if encoder.starts_with("hevc") {
                encode::Codec::H265
            } else {
                encode::Codec::H264
            },
            encoder: encoder.into(),
            container: "mp4",
            pix,
            quality,
            prores_profile: 3,
            audio_codec: None,
            audio_bitrate: None,
            every_nth_frame: 1,
        }
    }

    /// The options `encode_args` builds for a 1920x1080 picture at 30 fps (12441600 bit/s by default), as text.
    fn line(encoder: &str, pix: Pix, quality: Quality, device: Option<&str>) -> String {
        let plan = is_hardware(encoder)
            .then(|| hardware_plan(encoder, pix == Pix::Yuv420p10, device, false).unwrap());
        let s = settings(encoder, pix, quality);
        encode_args(&s, 1920, 1080, 30.0, (30, 1), plan.as_ref())
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }

    const INPUT_8: &str = "-f rawvideo -pix_fmt yuv420p -s 1920x1080 -framerate 30/1 -i pipe:0 -an";
    const TAGS: &str =
        "-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv -fps_mode cfr";

    #[test]
    fn vaapi_takes_a_device_and_uploads_nv12() {
        // Constant quality is -qp, a rate is -b:v, and nothing is asked for by default but the bit rate of the other
        // hardware encoders.
        assert_eq!(
            line("h264_vaapi", Pix::Yuv420p, Quality::Crf(20.0), Some(NODE)),
            format!(
                "-init_hw_device vaapi=va:{NODE} -filter_hw_device va {INPUT_8} -vf format=nv12,hwupload -c:v h264_vaapi -qp 20 {TAGS}"
            )
        );
        assert_eq!(
            line(
                "h264_vaapi",
                Pix::Yuv420p,
                Quality::Bitrate(5_000_000),
                Some(NODE)
            ),
            format!(
                "-init_hw_device vaapi=va:{NODE} -filter_hw_device va {INPUT_8} -vf format=nv12,hwupload -c:v h264_vaapi -b:v 5000000 {TAGS}"
            )
        );
        assert_eq!(
            line("h264_vaapi", Pix::Yuv420p, Quality::Default, Some(NODE)),
            format!(
                "-init_hw_device vaapi=va:{NODE} -filter_hw_device va {INPUT_8} -vf format=nv12,hwupload -c:v h264_vaapi -b:v 12441600 {TAGS}"
            )
        );
        // A CRF with a fraction is rounded: -qp is an integer.
        assert!(
            line("h264_vaapi", Pix::Yuv420p, Quality::Crf(22.6), Some(NODE)).contains(" -qp 23 ")
        );
    }

    #[test]
    fn hevc_vaapi_tags_hvc1_and_takes_ten_bit_as_p010() {
        assert_eq!(
            line("hevc_vaapi", Pix::Yuv420p, Quality::Crf(28.0), Some(NODE)),
            format!(
                "-init_hw_device vaapi=va:{NODE} -filter_hw_device va {INPUT_8} -vf format=nv12,hwupload -c:v hevc_vaapi -qp 28 -tag:v hvc1 {TAGS}"
            )
        );
        assert_eq!(
            line("hevc_vaapi", Pix::Yuv420p10, Quality::Crf(28.0), Some(NODE)),
            format!(
                "-init_hw_device vaapi=va:{NODE} -filter_hw_device va -f rawvideo -pix_fmt yuv420p10le -s 1920x1080 -framerate 30/1 -i pipe:0 -an \
                 -vf format=p010le,hwupload -c:v hevc_vaapi -qp 28 -profile:v main10 -tag:v hvc1 {TAGS}"
            )
        );
    }

    #[test]
    fn quick_sync_derives_its_device_and_uploads_to_qsv_frames() {
        assert_eq!(
            line("h264_qsv", Pix::Yuv420p, Quality::Crf(20.0), None),
            format!(
                "-init_hw_device qsv=hw -filter_hw_device hw {INPUT_8} \
                 -vf format=nv12,hwupload=extra_hw_frames=64,format=qsv -c:v h264_qsv -global_quality 20 {TAGS}"
            )
        );
        // A render node named by the user: the VAAPI device there, and Quick Sync derived from it.
        assert_eq!(
            line(
                "hevc_qsv",
                Pix::Yuv420p10,
                Quality::Default,
                Some("/dev/dri/renderD129")
            ),
            format!(
                "-init_hw_device vaapi=va:/dev/dri/renderD129 -init_hw_device qsv=hw@va -filter_hw_device hw \
                 -f rawvideo -pix_fmt yuv420p10le -s 1920x1080 -framerate 30/1 -i pipe:0 -an \
                 -vf format=p010le,hwupload=extra_hw_frames=64,format=qsv -c:v hevc_qsv -b:v 12441600 \
                 -profile:v main10 -tag:v hvc1 {TAGS}"
            )
        );
        // global_quality 0 would switch ICQ off: the lowest is 1.
        assert!(
            line("h264_qsv", Pix::Yuv420p, Quality::Crf(0.0), None).contains(" -global_quality 1 ")
        );
        assert!(
            line("h264_qsv", Pix::Yuv420p, Quality::Bitrate(8_000_000), None)
                .contains(" -c:v h264_qsv -b:v 8000000 ")
        );
    }

    #[test]
    fn hardware_encoders_put_no_pix_fmt_on_the_output() {
        // After the upload filter the frames are hardware ones: an output -pix_fmt would convert them back.
        for encoder in HARDWARE {
            let text = line(encoder, Pix::Yuv420p, Quality::Default, Some(NODE));
            assert_eq!(text.matches("-pix_fmt").count(), 1, "{encoder}: {text}");
        }
        // The software ones keep it, as ever.
        let text = line("libx264", Pix::Yuv444p, Quality::Crf(0.0), None);
        assert_eq!(text.matches("-pix_fmt").count(), 2, "{text}");
    }

    #[test]
    fn low_power_is_asked_for_after_the_encoder() {
        let plan = hardware_plan("h264_vaapi", false, Some(NODE), true).unwrap();
        assert_eq!(plan.encoder_args, ["-low_power", "1"]);
        let s = settings("h264_vaapi", Pix::Yuv420p, Quality::Crf(18.0));
        let text: Vec<String> = encode_args(&s, 64, 48, 30.0, (30, 1), Some(&plan))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let at = text.iter().position(|a| a == "-low_power").unwrap();
        assert_eq!(text[at - 2..=at + 1], ["-qp", "18", "-low_power", "1"]);
        assert!(
            hardware_plan("h264_vaapi", false, Some(NODE), false)
                .unwrap()
                .encoder_args
                .is_empty()
        );
    }

    #[test]
    fn a_hardware_plan_needs_a_hardware_encoder_and_vaapi_a_node() {
        assert!(hardware_plan("libx264", false, None, false).is_err());
        assert!(hardware_plan("h264_vaapi", false, None, false).is_err());
        assert!(hardware_plan("h264_qsv", false, None, false).is_ok());
    }

    #[test]
    fn the_render_node_is_the_override_else_the_lowest_numbered() {
        let dri = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        let entries = dri(&[
            "by-path",
            "card1",
            "renderD129",
            "card0",
            "renderD128",
            "renderD1000",
        ]);
        assert_eq!(
            pick_render_node(None, &entries).as_deref(),
            Some("/dev/dri/renderD128")
        );
        assert_eq!(
            pick_render_node(Some("/dev/dri/renderD129"), &entries).as_deref(),
            Some("/dev/dri/renderD129")
        );
        // An empty override is no override; 1000 is numerically above 129 (a string sort would put it first).
        assert_eq!(
            pick_render_node(Some(""), &dri(&["renderD1000", "renderD129"])).as_deref(),
            Some("/dev/dri/renderD129")
        );
        assert_eq!(pick_render_node(None, &dri(&["card0", "by-path"])), None);
        assert_eq!(pick_render_node(None, &[]), None);
        // A named device is used even if the directory could not be listed.
        assert_eq!(
            pick_render_node(Some("/dev/foo"), &[]).as_deref(),
            Some("/dev/foo")
        );
    }

    #[test]
    fn the_hardware_encoders_are_named() {
        assert!(HARDWARE.iter().all(|n| is_hardware(n)));
        assert!(
            !is_hardware("libx264")
                && !is_hardware("h264_nvenc")
                && !is_hardware("h264_videotoolbox")
        );
        assert_eq!(hw_of("hevc_qsv"), Some(Hw::Qsv));
        assert_eq!(hw_of("hevc_vaapi"), Some(Hw::Vaapi));
        assert_eq!(hw_of("libx265"), None);
    }

    #[test]
    fn only_the_last_lines_of_ffmpegs_complaint_are_kept() {
        assert_eq!(tail("a\n\n b \nc\nd\ne\n"), "b | c | d | e");
        assert_eq!(tail(""), "");
    }

    /// A stand-in for ffmpeg, as `program`: logs its arguments to `log`, drains its input, and succeeds only if `ok`
    /// says so about the arguments (a shell `case` pattern), else says `said` on stderr and fails.
    #[cfg(unix)]
    fn fake_ffmpeg(dir: &Path, log: &Path, ok: &str, said: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let program = dir.join("ffmpeg");
        let script = format!(
            "#!/bin/sh\necho \"$@\" >> '{}'\ncat > /dev/null\ncase \"$*\" in {ok}) exit 0;; esac\necho '{said}' >&2\nexit 1\n",
            log.display()
        );
        std::fs::write(&program, script).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        program
    }

    #[cfg(unix)]
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kinetograph-hw-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    #[test]
    fn the_probe_tries_the_defaults_and_then_low_power() {
        let dir = scratch("low-power");
        let log = dir.join("log");
        // Opens only with -low_power 1, as the newest Intel GPUs' H.264 does.
        let program = fake_ffmpeg(
            &dir,
            &log,
            "*-low_power*",
            "No usable encoding entrypoint found",
        );
        let how = probe(&program, "h264_vaapi", Hw::Vaapi, Some(NODE)).unwrap();
        assert_eq!(
            how,
            Opened {
                device: Some(NODE.into()),
                low_power: true
            }
        );
        let calls: Vec<String> = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(calls.len(), 2, "{calls:?}");
        assert_eq!(
            calls[0],
            format!(
                "-hide_banner -loglevel error -nostdin -y -init_hw_device vaapi=va:{NODE} -filter_hw_device va -f rawvideo -pix_fmt yuv420p -s 256x144 \
                 -framerate 30/1 -i pipe:0 -an -vf format=nv12,hwupload -c:v h264_vaapi -b:v 221184 {TAGS} \
                 -frames:v 4 -f null -"
            )
        );
        assert!(
            calls[1].contains("-c:v h264_vaapi -b:v 221184 -low_power 1 "),
            "{}",
            calls[1]
        );

        // Opens at once: one run.
        let log = dir.join("log2");
        let program = fake_ffmpeg(&dir, &log, "*", "");
        let how = probe(&program, "h264_qsv", Hw::Qsv, None).unwrap();
        assert_eq!(
            how,
            Opened {
                device: None,
                low_power: false
            }
        );
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_probe_that_fails_says_what_ffmpeg_said_and_how_to_fix_it() {
        let dir = scratch("fails");
        let log = dir.join("log");
        let program = fake_ffmpeg(
            &dir,
            &log,
            "NEVER",
            "Failed to initialise VAAPI connection: -1 (unknown libva error).",
        );
        let why = probe(&program, "h264_vaapi", Hw::Vaapi, Some(NODE)).unwrap_err();
        assert!(
            why.contains("Failed to initialise VAAPI connection"),
            "{why}"
        );
        assert!(
            why.contains("intel-media-va-driver")
                && why.contains("vainfo")
                && why.contains("render"),
            "{why}"
        );
        assert!(why.contains("KINETOGRAPH_VAAPI_DEVICE"), "{why}");
        let why = probe(&program, "hevc_qsv", Hw::Qsv, None).unwrap_err();
        assert!(
            why.contains("oneVPL") && why.contains("--enable-libvpl"),
            "{why}"
        );
        // A program that cannot be run at all.
        let why = probe(
            Path::new("/nonexistent/ffmpeg-for-kinetograph"),
            "h264_qsv",
            Hw::Qsv,
            None,
        )
        .unwrap_err();
        assert!(why.contains("cannot run"), "{why}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
