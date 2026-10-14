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

/// Sample rates the native AAC encoder takes.
const AAC_RATES: [u32; 13] = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/// AAC bit rate per channel, bits per second.
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
        if !AAC_RATES.contains(&self.sample_rate) {
            return Err(format!(
                "audio sample rate {} is not one AAC has (48000, 44100, 32000 ...)",
                self.sample_rate
            ));
        }
        if !(1..=2).contains(&self.channels.len()) {
            return Err(format!(
                "audio has {} channels: AAC output takes 1 or 2",
                self.channels.len()
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
/// added as an AAC stream. The video packets are copied, not encoded again,
/// and audio is encoded alongside them so that the two interleave in time.
/// `audio` starts with the video; if it is longer, the file runs to the end
/// of the audio.
pub fn mux_audio(video: &Path, output: &Path, audio: &AudioPcm) -> Result<(), String> {
    init();
    audio.validate()?;
    let container = container_for(output)?;
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
        // A tag from the temporary file's container may not fit this one.
        // SAFETY: the stream's parameters are live and owned by `octx`.
        unsafe {
            (*stream.parameters().as_mut_ptr()).codec_tag = 0;
        }
        stream.index()
    };

    let aac = encoder::find_by_name("aac")
        .ok_or("this ffmpeg has no aac encoder")?
        .audio()
        .map_err(err("the aac encoder is not an audio encoder"))?;
    let rate = audio.sample_rate as i32;
    let layout = if audio.channels.len() == 1 {
        ffmpeg::ChannelLayout::MONO
    } else {
        ffmpeg::ChannelLayout::STEREO
    };
    let (audio_out, audio_encoder) = {
        let mut stream = octx
            .add_stream(aac)
            .map_err(err("cannot add the audio stream"))?;
        let context = codec::context::Context::from_parameters(stream.parameters())
            .map_err(err("cannot set up the audio encoder"))?;
        let mut encoder = context
            .encoder()
            .audio()
            .map_err(err("cannot set up the audio encoder"))?;
        encoder.set_rate(rate);
        encoder.set_channel_layout(layout);
        encoder.set_format(format::Sample::F32(format::sample::Type::Planar));
        encoder.set_bit_rate(AAC_BITS_PER_CHANNEL * audio.channels.len());
        encoder.set_time_base((1, rate));
        if global_header {
            encoder.set_flags(CodecFlags::GLOBAL_HEADER);
        }
        let encoder = encoder
            .open_as(aac)
            .map_err(err("cannot open the aac encoder"))?;
        stream.set_parameters(&encoder);
        stream.set_time_base((1, rate));
        (stream.index(), encoder)
    };

    let mut header = Dictionary::new();
    header.set("movflags", "+faststart");
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
    /// Samples (per channel) sent to the encoder.
    position: usize,
    stream: usize,
    time_base: Rational,
}

impl AudioFeed<'_> {
    /// Encodes whole frames of audio up to `seconds`.
    fn until(&mut self, octx: &mut format::context::Output, seconds: f64) -> Result<(), String> {
        let wanted = (seconds * f64::from(self.pcm.sample_rate)).ceil() as usize;
        let target = wanted.min(self.pcm.len());
        let size = (self.encoder.frame_size() as usize).max(1);
        while self.position + size <= target {
            self.send(octx, size)?;
        }
        Ok(())
    }

    /// The rest of the audio, a short last frame included, and the encoder's
    /// delay.
    fn finish(&mut self, octx: &mut format::context::Output) -> Result<(), String> {
        let size = (self.encoder.frame_size() as usize).max(1);
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
        let mut frame = frame::Audio::new(
            format::Sample::F32(format::sample::Type::Planar),
            n,
            self.layout,
        );
        frame.set_rate(self.pcm.sample_rate);
        frame.set_pts(Some(self.position as i64));
        for (c, samples) in self.pcm.channels.iter().enumerate() {
            let dst = &mut frame.plane_mut::<f32>(c)[..n];
            for (d, s) in dst
                .iter_mut()
                .zip(&samples[self.position..self.position + n])
            {
                // NaN would reach the encoder as noise.
                *d = if s.is_finite() { *s } else { 0.0 };
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
        let mut encoder = VideoEncoder::create(&video, 64, 48, 10.0, "libx264").unwrap();
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
}
