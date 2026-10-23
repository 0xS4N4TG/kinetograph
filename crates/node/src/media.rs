//! `probeMedia` and `decodeAudio` (packages/cli/skills/kinetograph/references/AUTHORING.md §11.2): CPU-only reads of
//! video and GIF files through FFmpeg and the `image` crate.

use std::path::Path;

use ffmpeg::format::{self, Sample, sample::Type as SampleType};
use ffmpeg::software::resampling;
use ffmpeg::{ChannelLayout, Error as AvError, Packet, codec, frame, media};
use kinetograph_core::{gif, video};
use napi::bindgen_prelude::Float32Array;

use crate::error::{Code, Result, error, invalid};
use crate::{AudioPcm, MediaInfo};

/// A file that is not there is `IO`; anything else wrong with it is the
/// caller's `INVALID_ARG`.
fn exists(path: &Path) -> Result<()> {
    std::fs::metadata(path)
        .map(|_| ())
        .map_err(|e| error(Code::Io, format!("cannot read {}: {e}", path.display())))
}

/// Reads a video's container, or a GIF's pictures. (A GIF has no index: its
/// pictures are counted by decoding them.)
pub fn probe_media(path: &Path) -> Result<MediaInfo> {
    exists(path)?;
    let bad = |what: String| invalid(format!("{}: {what}", path.display()));
    if gif::is_gif(path) {
        let info = gif::probe(path).map_err(bad)?;
        return Ok(MediaInfo {
            kind: "gif".into(),
            width: info.width,
            height: info.height,
            duration_in_seconds: info.duration_ms / 1000.0,
            fps: None,
            frames: Some(info.pictures),
            has_audio: false,
            video_codec: Some("gif".into()),
            audio_codec: None,
        });
    }
    let info = video::probe(path).map_err(bad)?;
    Ok(MediaInfo {
        kind: "video".into(),
        width: info.width,
        height: info.height,
        duration_in_seconds: info.duration,
        fps: info.fps,
        frames: info.frames.and_then(|n| u32::try_from(n).ok()),
        has_audio: info.has_audio,
        video_codec: Some(info.video_codec.clone()),
        audio_codec: info.audio_codec.clone(),
    })
}

/// The first audio stream of `path`, decoded and resampled to `sample_rate`
/// as planar float, mono if it is mono and stereo otherwise (more channels
/// are downmixed by swresample's default matrix). `None` without an audio
/// stream.
pub fn decode_audio(path: &Path, sample_rate: u32) -> Result<Option<AudioPcm>> {
    if sample_rate == 0 {
        return Err(invalid("sampleRate must be above 0"));
    }
    exists(path)?;
    video::init();
    let bad = |what: String| invalid(format!("{}: {what}", path.display()));
    let mut input = format::input(path).map_err(|e| bad(format!("cannot open: {e}")))?;
    let (index, mut decoder) = {
        let Some(stream) = input
            .streams()
            .find(|s| s.parameters().medium() == media::Type::Audio)
        else {
            return Ok(None);
        };
        let context = codec::Context::from_parameters(stream.parameters())
            .map_err(|e| bad(format!("cannot set up the audio decoder: {e}")))?;
        let mut decoder = context.decoder();
        decoder.set_packet_time_base(stream.time_base());
        let decoder = decoder
            .audio()
            .map_err(|e| bad(format!("cannot open the audio decoder: {e}")))?;
        (stream.index(), decoder)
    };

    let mut converter = Converter::new(sample_rate);
    let mut frame = frame::Audio::empty();
    let mut drain = |decoder: &mut ffmpeg::decoder::Audio,
                     converter: &mut Converter|
     -> std::result::Result<(), String> {
        loop {
            match decoder.receive_frame(&mut frame) {
                Ok(()) => converter.push(&mut frame)?,
                Err(AvError::Eof) => return Ok(()),
                Err(AvError::Other { errno }) if errno == ffmpeg::error::EAGAIN => return Ok(()),
                Err(e) => return Err(format!("cannot decode: {e}")),
            }
        }
    };
    loop {
        let mut packet = Packet::empty();
        match packet.read(&mut input) {
            Ok(()) if packet.stream() != index => {}
            Ok(()) => match decoder.send_packet(&packet) {
                Ok(()) => drain(&mut decoder, &mut converter).map_err(bad)?,
                // A packet the decoder cannot use is skipped.
                Err(AvError::InvalidData) => {}
                Err(e) => return Err(bad(format!("cannot decode: {e}"))),
            },
            Err(AvError::Eof) => break,
            Err(AvError::InvalidData) => {}
            Err(e) => return Err(bad(format!("cannot read: {e}"))),
        }
    }
    let _ = decoder.send_eof();
    drain(&mut decoder, &mut converter).map_err(bad)?;
    converter.finish().map_err(bad)?;

    let Converter { channels, .. } = converter;
    if channels.is_empty() {
        return Ok(None);
    }
    Ok(Some(AudioPcm {
        sample_rate,
        channels: channels.into_iter().map(Float32Array::new).collect(),
    }))
}

/// Resamples decoded frames to planar float at the output rate, appending
/// each channel's samples to `channels`.
struct Converter {
    rate: u32,
    /// Made from the first frame, whose format, rate and layout it converts.
    resampler: Option<resampling::Context>,
    layout: ChannelLayout,
    channels: Vec<Vec<f32>>,
}

impl Converter {
    fn new(rate: u32) -> Converter {
        Converter {
            rate,
            resampler: None,
            layout: ChannelLayout::STEREO,
            channels: Vec::new(),
        }
    }

    fn push(&mut self, input: &mut frame::Audio) -> std::result::Result<(), String> {
        // A decoder that does not say which speakers the channels are gets
        // the default layout for their number, on the frame too: the
        // resampler refuses a frame that does not match what it was set up
        // with.
        if input.channel_layout().is_empty() {
            input.set_channel_layout(ChannelLayout::default(i32::from(input.channels())));
        }
        if self.resampler.is_none() {
            let in_layout = input.channel_layout();
            self.layout = if input.channels() == 1 {
                ChannelLayout::MONO
            } else {
                ChannelLayout::STEREO
            };
            let resampler = resampling::Context::get(
                input.format(),
                in_layout,
                input.rate(),
                Sample::F32(SampleType::Planar),
                self.layout,
                self.rate,
            )
            .map_err(|e| format!("cannot resample: {e}"))?;
            self.channels = vec![Vec::new(); self.layout.channels() as usize];
            self.resampler = Some(resampler);
        }
        let resampler = self.resampler.as_mut().expect("just made");
        // Room for every sample this frame can give: its own, rescaled, and
        // what the resampler is still holding.
        let held = resampler.delay().map_or(0, |d| d.output.max(0) as usize);
        let rescaled =
            input.samples() as u64 * u64::from(self.rate) / u64::from(input.rate().max(1));
        let mut out = frame::Audio::new(
            Sample::F32(SampleType::Planar),
            rescaled as usize + held + 1024,
            self.layout,
        );
        resampler
            .run(input, &mut out)
            .map_err(|e| format!("cannot resample: {e}"))?;
        append(&mut self.channels, &out);
        Ok(())
    }

    /// Takes what the resampler still holds at the end of the input.
    fn finish(&mut self) -> std::result::Result<(), String> {
        let Some(resampler) = self.resampler.as_mut() else {
            return Ok(());
        };
        for _ in 0..8 {
            let held = resampler.delay().map_or(0, |d| d.output.max(0) as usize);
            if held == 0 {
                break;
            }
            let mut out =
                frame::Audio::new(Sample::F32(SampleType::Planar), held + 1024, self.layout);
            resampler
                .flush(&mut out)
                .map_err(|e| format!("cannot resample: {e}"))?;
            if out.samples() == 0 {
                break;
            }
            append(&mut self.channels, &out);
        }
        Ok(())
    }
}

/// Adds the samples of `out`, planar float, to the per-channel `channels`.
fn append(channels: &mut [Vec<f32>], out: &frame::Audio) {
    let n = out.samples();
    for (c, channel) in channels.iter_mut().enumerate() {
        let plane = out.plane::<f32>(c);
        channel.extend_from_slice(&plane[..n.min(plane.len())]);
    }
}
