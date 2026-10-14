//! Writes RGBA frames to an H.264 MP4 or MOV file with FFmpeg.
//!
//! Frames are converted to `yuv420p` by swscale with BT.709 coefficients and
//! the stream is tagged BT.709, limited ("TV") range. The alpha channel is
//! dropped, not composited: a scene whose background is transparent shows
//! its straight colours where it is clear (black, for the empty pixels the
//! renderer writes). Give the scene an opaque `background` for video.

use std::ffi::c_int;
use std::path::Path;
use std::sync::Once;

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

/// Whether the linked ffmpeg has an encoder called `name`.
pub fn has_encoder(name: &str) -> bool {
    init();
    encoder::find_by_name(name).is_some()
}

/// Picks the encoder: `requested` if given (and present), else VideoToolbox
/// on macOS when `has` it, else libx264. `has` says whether ffmpeg has an
/// encoder by that name.
pub fn select_encoder(
    requested: Option<&str>,
    macos: bool,
    has: impl Fn(&str) -> bool,
) -> Result<String, String> {
    if let Some(name) = requested {
        return if has(name) {
            Ok(name.to_string())
        } else {
            Err(format!(
                "this ffmpeg has no encoder called {name:?} (see `ffmpeg -encoders`)"
            ))
        };
    }
    if macos && has(VIDEOTOOLBOX) {
        return Ok(VIDEOTOOLBOX.to_string());
    }
    if has(DEFAULT_ENCODER) {
        return Ok(DEFAULT_ENCODER.to_string());
    }
    Err(format!(
        "this ffmpeg has no {DEFAULT_ENCODER} encoder; pass --encoder with one it has"
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

/// An open output file taking RGBA frames, one after another.
pub struct VideoEncoder {
    output: format::context::Output,
    encoder: encoder::Video,
    scaler: scaling::Context,
    /// The caller's pixels, reused for every frame.
    rgba: frame::Video,
    width: u32,
    height: u32,
    time_base: Rational,
    stream_time_base: Rational,
    next_pts: i64,
}

impl VideoEncoder {
    /// Opens `path` for `width` x `height` frames at `fps`, encoded by the
    /// ffmpeg encoder `encoder_name`. The size must be even (`yuv420p` halves
    /// the colour planes).
    pub fn create(
        path: &Path,
        width: u32,
        height: u32,
        fps: f64,
        encoder_name: &str,
    ) -> Result<VideoEncoder, String> {
        init();
        if !width.is_multiple_of(2) || !height.is_multiple_of(2) {
            return Err(format!(
                "{width}x{height} has an odd side: yuv420p video needs an even width and height"
            ));
        }
        let (fps_num, fps_den) = fps_rational(fps)?;
        let container = container_for(path)?;
        let codec = encoder::find_by_name(encoder_name)
            .ok_or_else(|| format!("this ffmpeg has no encoder called {encoder_name:?}"))?;
        let err = |what: &str| {
            let what = what.to_string();
            move |e: ffmpeg::Error| format!("{what}: {e}")
        };

        let mut output = format::output_as(path, container)
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
        video.set_format(Pixel::YUV420P);
        video.set_time_base(time_base);
        video.set_frame_rate(Some(Rational(fps_num, fps_den)));
        video.set_colorspace(color::Space::BT709);
        video.set_color_range(color::Range::MPEG);
        video.set_color_primaries(color::Primaries::BT709);
        video.set_color_transfer_characteristic(color::TransferCharacteristic::BT709);
        if global_header {
            video.set_flags(CodecFlags::GLOBAL_HEADER);
        }
        let mut options = Dictionary::new();
        if encoder_name == DEFAULT_ENCODER {
            options.set("crf", "18");
            options.set("preset", "medium");
        } else {
            video.set_bit_rate(bit_rate(width, height, fps));
        }
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
            stream.index()
        };
        let mut header = Dictionary::new();
        header.set("movflags", "+faststart");
        output
            .write_header_with(header)
            .map_err(err("cannot write the file header"))?;
        // The muxer may have chosen its own time base for the stream.
        let stream_time_base = output
            .stream(stream_index)
            .map(|s| s.time_base())
            .unwrap_or(time_base);

        let mut scaler = scaling::Context::get(
            Pixel::RGBA,
            width,
            height,
            Pixel::YUV420P,
            width,
            height,
            ScaleFlags::BICUBIC | ScaleFlags::ACCURATE_RND,
        )
        .map_err(err("cannot set up the RGBA to YUV conversion"))?;
        set_bt709(&mut scaler, true, false)?;

        Ok(VideoEncoder {
            output,
            encoder: video,
            scaler,
            rgba: frame::Video::new(Pixel::RGBA, width, height),
            width,
            height,
            time_base,
            stream_time_base,
            next_pts: 0,
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
        // A fresh picture each time: the encoder may still hold the last.
        let mut yuv = frame::Video::empty();
        self.scaler
            .run(&self.rgba, &mut yuv)
            .map_err(|e| format!("cannot convert a frame to YUV: {e}"))?;
        yuv.set_pts(Some(self.next_pts));
        self.next_pts += 1;
        self.encoder
            .send_frame(&yuv)
            .map_err(|e| format!("encoder rejected a frame: {e}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
            let msg = VideoEncoder::create(&path, w, h, 30.0, "libx264")
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
        for px in rgba.chunks_exact(4) {
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
        let mut encoder = VideoEncoder::create(&path, w, h, 29.97, "libx264").unwrap();
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
}
