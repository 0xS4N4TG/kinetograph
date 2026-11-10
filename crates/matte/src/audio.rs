//! The first audio stream of a video as planar float PCM, for `mux_audio` to encode into the matte's files. The same
//! decode and resample the addon's `decodeAudio` does (`crates/node/src/media.rs`), without the JavaScript types.

use std::path::Path;

use ffmpeg::format::{self, Sample, sample::Type as SampleType};
use ffmpeg::software::resampling;
use ffmpeg::{ChannelLayout, Error as AvError, Packet, codec, frame, media};

/// The audio of `path` at `sample_rate`: one `Vec` of samples per channel, mono if the source is mono and stereo
/// otherwise. `None` when there is no audio stream, or nothing in it.
pub fn decode(path: &Path, sample_rate: u32) -> Result<Option<Vec<Vec<f32>>>, String> {
    kinetograph_core::video::init();
    let bad = |what: String| format!("{}: {what}", path.display());
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
     -> Result<(), String> {
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
    let channels = converter.channels;
    Ok((!channels.is_empty() && !channels[0].is_empty()).then_some(channels))
}

/// Resamples decoded frames to planar float at the output rate, appending each channel's samples to `channels`.
struct Converter {
    rate: u32,
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

    fn push(&mut self, input: &mut frame::Audio) -> Result<(), String> {
        // A decoder that does not say which speakers the channels are gets the default layout for their number.
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
    fn finish(&mut self) -> Result<(), String> {
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

fn append(channels: &mut [Vec<f32>], out: &frame::Audio) {
    let n = out.samples();
    for (c, channel) in channels.iter_mut().enumerate() {
        let plane = out.plane::<f32>(c);
        channel.extend_from_slice(&plane[..n.min(plane.len())]);
    }
}
