//! `probeStreams` and `scanStreams` (packages/cli/skills/kinetograph/references/AUTHORING.md §3, `@remotion/media-parser`): what a media file's container
//! says about its streams, and what its packets add. CPU only, through FFmpeg; nothing is decoded, and unlike
//! `probeMedia` a file without a video stream (an MP3, a WAV) is fine.

use std::ffi::CStr;
use std::path::Path;

use ffmpeg::ffi;
use ffmpeg::format::{self, stream::Disposition};
use ffmpeg::{Error as AvError, Packet, media};
use kinetograph_core::video;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

use crate::error::{Code, Result, error, invalid};
use crate::resolve_base;

/// One entry of the metadata of the container (no `stream`) or of one of its streams.
#[napi(object)]
pub struct MediaTag {
    /// The index of the stream the tag belongs to; container ids are not always distinct.
    pub stream: Option<u32>,
    pub key: String,
    pub value: String,
}

/// One stream of a container, as its header describes it.
#[napi(object)]
pub struct StreamDetails {
    pub index: u32,
    /// The container's number for the track (an MP4's `track_ID`, a Matroska `TrackNumber`).
    pub id: i32,
    /// `video`, `audio` or `other`.
    pub kind: String,
    /// FFmpeg's codec name: `h264`, `hevc`, `vp9`, `aac`, `pcm_s16le`, ...
    pub codec: String,
    /// The codec's four-character tag as the container stores it (`avc1`), if it has one.
    pub codec_tag: Option<String>,
    pub profile: Option<i32>,
    pub level: Option<i32>,
    pub bit_rate: Option<f64>,
    pub time_base_numerator: i32,
    pub time_base_denominator: i32,
    pub start_in_seconds: Option<f64>,
    pub duration_in_seconds: Option<f64>,
    /// The number of pictures or packets the container says the stream has.
    pub frames: Option<u32>,
    /// The codec's private data as the container keeps it (an `avcC` record, an AAC `AudioSpecificConfig`, ...).
    pub extradata: Option<Buffer>,
    pub width: u32,
    pub height: u32,
    pub sample_aspect_ratio_numerator: i32,
    pub sample_aspect_ratio_denominator: i32,
    /// A video stream's average frame rate.
    pub frame_rate: Option<f64>,
    /// How far, clockwise and in degrees from 0 up to 360, a player turns the pictures.
    pub rotation: f64,
    /// FFmpeg's numbers (the H.273 ones for the last three): `AVColorRange` (1 limited, 2 full),
    /// `AVColorPrimaries`, `AVColorTransferCharacteristic`, `AVColorSpace`.
    pub color_range: i32,
    pub color_primaries: i32,
    pub color_transfer: i32,
    pub color_space: i32,
    /// Bits per sample of the picture where the stream says (`bits_per_raw_sample`).
    pub bit_depth: Option<u32>,
    pub sample_rate: u32,
    pub channels: u32,
    /// Bits per sample of uncompressed audio (`bits_per_coded_sample`).
    pub bits_per_sample: u32,
    /// The picture, for a stream that is the cover art of the file and no video.
    pub attached_picture: Option<Buffer>,
}

#[napi(object)]
pub struct MediaStreams {
    /// FFmpeg's name for the container format: `mov,mp4,m4a,3gp,3g2,mj2`, `matroska,webm`, `mp3`, ...
    pub format: String,
    pub duration_in_seconds: Option<f64>,
    /// When the file's first stream starts: not 0 for a transport stream, whose clock starts where the muxer set it.
    pub start_in_seconds: Option<f64>,
    pub bit_rate: Option<f64>,
    pub tags: Vec<MediaTag>,
    pub streams: Vec<StreamDetails>,
}

/// A file that is not there is `IO`; one FFmpeg cannot open is the caller's `INVALID_ARG`.
fn open(path: &Path) -> Result<format::context::Input> {
    std::fs::metadata(path)
        .map_err(|e| error(Code::Io, format!("cannot read {}: {e}", path.display())))?;
    video::init();
    format::input(path).map_err(|e| invalid(format!("{}: cannot open: {e}", path.display())))
}

fn seconds(value: i64, time_base: (i32, i32)) -> Option<f64> {
    (value != ffi::AV_NOPTS_VALUE && time_base.0 > 0 && time_base.1 > 0)
        .then(|| value as f64 * f64::from(time_base.0) / f64::from(time_base.1))
}

fn tags_of(dictionary: ffmpeg::DictionaryRef<'_>, stream: Option<u32>, into: &mut Vec<MediaTag>) {
    for (key, value) in dictionary.iter() {
        into.push(MediaTag {
            stream,
            key: key.to_string(),
            value: value.to_string(),
        });
    }
}

/// FFmpeg's name for a codec id.
fn codec_name(id: ffi::AVCodecID) -> String {
    // SAFETY: `avcodec_get_name` returns a static string for any id.
    unsafe { CStr::from_ptr(ffi::avcodec_get_name(id)) }
        .to_string_lossy()
        .into_owned()
}

/// A four-character code, first byte lowest, as FFmpeg stores tags.
fn four_cc(tag: u32) -> Option<String> {
    let bytes = tag.to_le_bytes();
    (tag != 0 && bytes.iter().all(|b| (0x20..0x7f).contains(b)))
        .then(|| String::from_utf8_lossy(&bytes).into_owned())
}

/// The rotation a stream's display matrix asks for, as clockwise degrees in `0..360`.
///
/// # Safety
/// `par` must point to live codec parameters.
unsafe fn rotation_of(par: *const ffi::AVCodecParameters) -> f64 {
    // SAFETY: the caller guarantees `par`; the side data array belongs to it.
    unsafe {
        let side = ffi::av_packet_side_data_get(
            (*par).coded_side_data,
            (*par).nb_coded_side_data,
            ffi::AVPacketSideDataType::AV_PKT_DATA_DISPLAYMATRIX,
        );
        if side.is_null() || (*side).size < 9 * std::mem::size_of::<i32>() {
            return 0.0;
        }
        // Counterclockwise degrees in -180..=180; NaN for a matrix that is not a rotation.
        let turned = ffi::av_display_rotation_get((*side).data as *const i32);
        if turned.is_nan() {
            0.0
        } else {
            (-turned).rem_euclid(360.0)
        }
    }
}

fn details_of(stream: &format::stream::Stream<'_>) -> StreamDetails {
    let parameters = stream.parameters();
    let medium = parameters.medium();
    let tb = stream.time_base();
    let time_base = (tb.numerator(), tb.denominator());
    let rate = stream.avg_frame_rate();
    let video = medium == media::Type::Video;
    let audio = medium == media::Type::Audio;
    let cover = stream.disposition().contains(Disposition::ATTACHED_PIC);
    let known = |v: i32| (v >= 0).then_some(v);

    // SAFETY: `par` is live for as long as `parameters` is, and the fields read are plain data; `extradata` and the
    // cover picture's packet are buffers FFmpeg owns, copied here before anything else touches the stream.
    let (p, extradata, picture, rotation) = unsafe {
        let par = parameters.as_ptr();
        let p = &*par;
        let extradata = (!p.extradata.is_null() && p.extradata_size > 0)
            .then(|| std::slice::from_raw_parts(p.extradata, p.extradata_size as usize).to_vec());
        let attached = &(*stream.as_ptr()).attached_pic;
        let picture = (cover && !attached.data.is_null() && attached.size > 0)
            .then(|| std::slice::from_raw_parts(attached.data, attached.size as usize).to_vec());
        (
            p,
            extradata,
            picture,
            if video { rotation_of(par) } else { 0.0 },
        )
    };

    StreamDetails {
        index: stream.index() as u32,
        id: stream.id(),
        kind: if video && !cover {
            "video"
        } else if audio {
            "audio"
        } else {
            "other"
        }
        .into(),
        codec: codec_name(p.codec_id),
        codec_tag: four_cc(p.codec_tag),
        profile: known(p.profile),
        level: known(p.level),
        bit_rate: (p.bit_rate > 0).then_some(p.bit_rate as f64),
        time_base_numerator: time_base.0,
        time_base_denominator: time_base.1,
        start_in_seconds: seconds(stream.start_time(), time_base),
        duration_in_seconds: seconds(stream.duration(), time_base),
        frames: u32::try_from(stream.frames()).ok().filter(|&n| n > 0),
        extradata: extradata.map(Buffer::from),
        width: u32::try_from(p.width).unwrap_or(0),
        height: u32::try_from(p.height).unwrap_or(0),
        sample_aspect_ratio_numerator: p.sample_aspect_ratio.num,
        sample_aspect_ratio_denominator: p.sample_aspect_ratio.den,
        frame_rate: (video && rate.numerator() > 0 && rate.denominator() > 0)
            .then(|| f64::from(rate)),
        rotation,
        color_range: p.color_range as i32,
        color_primaries: p.color_primaries as i32,
        color_transfer: p.color_trc as i32,
        color_space: p.color_space as i32,
        bit_depth: u32::try_from(p.bits_per_raw_sample).ok().filter(|&n| n > 0),
        sample_rate: u32::try_from(p.sample_rate).unwrap_or(0),
        channels: if audio {
            u32::try_from(p.ch_layout.nb_channels).unwrap_or(0)
        } else {
            0
        },
        bits_per_sample: u32::try_from(p.bits_per_coded_sample).unwrap_or(0),
        attached_picture: picture.map(Buffer::from),
    }
}

/// Reads a file's container, without decoding anything (packages/cli/skills/kinetograph/references/AUTHORING.md §3).
#[napi]
pub fn probe_streams(path: String, base_dir: Option<String>) -> Result<MediaStreams> {
    let input = open(&resolve_base(base_dir).join(path))?;
    let mut tags = Vec::new();
    tags_of(input.metadata(), None, &mut tags);
    let mut streams = Vec::new();
    for stream in input.streams() {
        tags_of(stream.metadata(), Some(stream.index() as u32), &mut tags);
        streams.push(details_of(&stream));
    }
    let duration = input.duration();
    // SAFETY: the input is open, so its context is live.
    let start = unsafe { (*input.as_ptr()).start_time };
    Ok(MediaStreams {
        format: input.format().name().to_string(),
        duration_in_seconds: (duration != ffi::AV_NOPTS_VALUE && duration >= 0)
            .then(|| duration as f64 / f64::from(ffi::AV_TIME_BASE)),
        start_in_seconds: (start != ffi::AV_NOPTS_VALUE)
            .then(|| start as f64 / f64::from(ffi::AV_TIME_BASE)),
        bit_rate: (input.bit_rate() > 0).then(|| input.bit_rate() as f64),
        tags,
        streams,
    })
}

/// A keyframe's packet: where it is in the file and how big, and when it is decoded and shown.
#[napi(object)]
pub struct Keyframe {
    pub position: f64,
    pub size: f64,
    pub pts_in_seconds: Option<f64>,
    pub dts_in_seconds: Option<f64>,
}

/// What the packets of one stream add up to.
#[napi(object)]
pub struct StreamScan {
    pub index: u32,
    pub packets: u32,
    /// The sum of the packets' sizes.
    pub bytes: f64,
    /// The earliest time a packet is shown, and the latest time one ends.
    pub start_in_seconds: Option<f64>,
    pub end_in_seconds: Option<f64>,
    /// When the first packet is decoded; before 0 for a stream with a delay (B-frames, an encoder's priming).
    pub first_dts_in_seconds: Option<f64>,
    pub keyframes: Vec<Keyframe>,
}

/// Reads every packet of a file, without decoding, and totals them per stream: the "slow" fields of `parseMedia`.
#[napi]
pub fn scan_streams(path: String, base_dir: Option<String>) -> Result<Vec<StreamScan>> {
    let path = resolve_base(base_dir).join(path);
    let mut input = open(&path)?;
    let bases: Vec<(i32, i32)> = input
        .streams()
        .map(|s| (s.time_base().numerator(), s.time_base().denominator()))
        .collect();
    let mut scans: Vec<StreamScan> = (0..bases.len())
        .map(|index| StreamScan {
            index: index as u32,
            packets: 0,
            bytes: 0.0,
            start_in_seconds: None,
            end_in_seconds: None,
            first_dts_in_seconds: None,
            keyframes: Vec::new(),
        })
        .collect();
    loop {
        let mut packet = Packet::empty();
        match packet.read(&mut input) {
            Ok(()) => {}
            Err(AvError::Eof) => break,
            // A packet the demuxer could not use is skipped, as the decoders do.
            Err(AvError::InvalidData) => continue,
            Err(e) => return Err(invalid(format!("{}: cannot read: {e}", path.display()))),
        }
        let index = packet.stream();
        let (Some(scan), Some(&base)) = (scans.get_mut(index), bases.get(index)) else {
            continue;
        };
        scan.packets += 1;
        scan.bytes += packet.size() as f64;
        if scan.packets == 1 {
            scan.first_dts_in_seconds = packet.dts().and_then(|t| seconds(t, base));
        }
        if let Some(start) = packet.pts().or(packet.dts()).and_then(|t| seconds(t, base)) {
            scan.start_in_seconds = Some(scan.start_in_seconds.map_or(start, |s| s.min(start)));
            let end = start + seconds(packet.duration().max(0), base).unwrap_or(0.0);
            scan.end_in_seconds = Some(scan.end_in_seconds.map_or(end, |e| e.max(end)));
        }
        if packet.is_key() {
            scan.keyframes.push(Keyframe {
                position: packet.position().max(0) as f64,
                size: packet.size() as f64,
                pts_in_seconds: packet.pts().and_then(|t| seconds(t, base)),
                dts_in_seconds: packet.dts().and_then(|t| seconds(t, base)),
            });
        }
    }
    Ok(scans)
}
