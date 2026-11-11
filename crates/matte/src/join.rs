//! The pieces of a clip, each encoded on its own, written into one file by copying their packets (nothing is encoded
//! again). Each piece starts on its own keyframe, so the joins are clean cuts.

use std::path::{Path, PathBuf};

use ffmpeg::format;
use ffmpeg::{Dictionary, Rational, codec, encoder};
use kinetograph_cli::encode::{Codec, Resolved};

/// Writes the video of `pieces` to `output` one after another. A piece is the file and the number of the frame it
/// starts at; the frames last `fps` (numerator, denominator) per second.
pub fn join(
    pieces: &[(PathBuf, u64)],
    output: &Path,
    settings: &Resolved,
    fps: (i32, i32),
) -> Result<(), String> {
    kinetograph_cli::encode::init();
    let err = |what: String| move |e: ffmpeg::Error| format!("{what}: {e}");
    let (first, _) = pieces.first().ok_or("nothing to join")?;
    let (parameters, avg_frame_rate, alpha_mode) = {
        let input =
            format::input(first).map_err(err(format!("cannot read {}", first.display())))?;
        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or_else(|| format!("{} has no video stream", first.display()))?;
        (
            stream.parameters(),
            stream.avg_frame_rate(),
            stream.metadata().get("alpha_mode").map(str::to_string),
        )
    };

    let mut octx = format::output_as(output, settings.container)
        .map_err(err(format!("cannot create {}", output.display())))?;
    let video_out = {
        let mut stream = octx
            .add_stream(encoder::find(codec::Id::None))
            .map_err(err("cannot add the video stream".into()))?;
        stream.set_parameters(parameters);
        stream.set_avg_frame_rate(avg_frame_rate);
        // The WebM muxer writes AlphaMode only from this tag (the demuxer's decoder parameters say yuv420p, as ffmpeg's
        // VP9 decoder drops the alpha plane), and without it players ignore the alpha packets.
        if let Some(alpha_mode) = &alpha_mode {
            let mut metadata = Dictionary::new();
            metadata.set("alpha_mode", alpha_mode);
            stream.set_metadata(metadata);
        }
        // SAFETY: the stream's parameters are live and owned by `octx`. A tag from the piece's container may not fit this
        // one; ProRes keeps its own (it says the profile, and both files are MOV), HEVC is tagged for QuickTime.
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
    let mut header = Dictionary::new();
    if matches!(settings.container, "mp4" | "mov") {
        header.set("movflags", "+faststart");
    }
    octx.write_header_with(header)
        .map_err(err("cannot write the file header".into()))?;
    let out_time_base = octx
        .stream(video_out)
        .map(|s| s.time_base())
        .ok_or("the output has no video stream")?;

    for (path, start) in pieces {
        let mut input =
            format::input(path).map_err(err(format!("cannot read {}", path.display())))?;
        let (index, in_time_base) = {
            let stream = input
                .streams()
                .best(ffmpeg::media::Type::Video)
                .ok_or_else(|| format!("{} has no video stream", path.display()))?;
            (stream.index(), stream.time_base())
        };
        let offset = offset_ticks(*start, fps, out_time_base);
        for (stream, mut packet) in input.packets() {
            if stream.index() != index {
                continue;
            }
            packet.rescale_ts(in_time_base, out_time_base);
            packet.set_pts(packet.pts().map(|t| t + offset));
            packet.set_dts(packet.dts().map(|t| t + offset));
            packet.set_position(-1);
            packet.set_stream(video_out);
            packet
                .write_interleaved(&mut octx)
                .map_err(err("cannot write to the file".into()))?;
        }
    }
    octx.write_trailer()
        .map_err(err("cannot finish the file".into()))
}

/// How many ticks of `time_base` `frames` frames last at `fps` (numerator, denominator), to the nearest.
pub fn offset_ticks(frames: u64, fps: (i32, i32), time_base: Rational) -> i64 {
    let seconds = frames as f64 * f64::from(fps.1) / f64::from(fps.0);
    (seconds * f64::from(time_base.denominator()) / f64::from(time_base.numerator())).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_piece_starts_where_the_frames_before_it_end() {
        // 30 fps in a WebM's millisecond ticks: frame 90 is at 3 s.
        assert_eq!(offset_ticks(90, (30, 1), Rational(1, 1000)), 3000);
        // 24000/1001 in a MOV's 24000-ticks-a-second base: one tick-per-frame of 1001.
        assert_eq!(offset_ticks(5, (24000, 1001), Rational(1, 24000)), 5 * 1001);
        assert_eq!(offset_ticks(0, (25, 1), Rational(1, 12800)), 0);
    }
}
