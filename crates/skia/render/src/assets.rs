//! The files a tree names: fonts and pictures, read once and kept for the next
//! frame. A file that changes on disk is read again.
//!
//! Bytes a project hands over itself (`Skia.Data.fromBytes`, an encoded picture,
//! a font made from data) are put here once with [`Assets::put_data`] and named
//! by the hash of their content, so a tree carries the name, not the bytes. They
//! are kept up to [`DATA_BUDGET`] bytes, the least recently used dropped first.
//! A video's pictures ([`Assets::put_frame_data`]) live for a frame: only the
//! last [`FRAME_KEEP`] are kept.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use skia_safe::{
    AlphaType, Codec, ColorType, Data, FontMgr, Image, ImageInfo, RuntimeEffect, Typeface, codec,
    images,
};

use crate::Error;

struct Held<T> {
    modified: Option<SystemTime>,
    value: T,
}

#[derive(Default)]
pub struct Assets {
    typefaces: HashMap<PathBuf, Held<Typeface>>,
    images: HashMap<PathBuf, Held<Image>>,
    effects: HashMap<String, RuntimeEffect>,
    /// What `put_data` was given, by the hash of the bytes, with when it was last used.
    data: HashMap<String, (Data, u64)>,
    data_bytes: usize,
    clock: u64,
    /// What `put_frame_data` was given, newest last.
    frames: VecDeque<(String, Data)>,
    /// `DATA_BUDGET` unless set (`set_data_budget`).
    budget: Option<usize>,
    data_typefaces: HashMap<String, Typeface>,
    data_images: HashMap<String, Image>,
    /// The frames of animated pictures (a file or data), decoded once.
    animations: HashMap<String, Held<Animation>>,
}

/// The most bytes `put_data` keeps.
pub const DATA_BUDGET: usize = 1 << 30;
/// The frame pictures `put_frame_data` keeps.
pub const FRAME_KEEP: usize = 16;

/// The frames of an animated picture and how long each is shown, in milliseconds.
#[derive(Clone)]
pub struct Animation {
    pub frames: Vec<Image>,
    pub durations: Vec<u32>,
}

impl Animation {
    /// The total length of one loop, in milliseconds.
    pub fn duration(&self) -> u64 {
        self.durations.iter().map(|d| u64::from(*d)).sum()
    }

    /// The frame shown `ms` milliseconds after the start, looping, as a player of the file does.
    pub fn index_at(&self, ms: f64) -> usize {
        let total = self.duration();
        if total == 0 || !ms.is_finite() || ms <= 0.0 {
            return 0;
        }
        let mut t = (ms as u64) % total;
        for (i, d) in self.durations.iter().enumerate() {
            if t < u64::from(*d) {
                return i;
            }
            t -= u64::from(*d);
        }
        self.frames.len() - 1
    }
}

/// The name `put_data` gives bytes: two 64-bit FNV-1a style hashes of them and their length, in hex, enough to tell a
/// project's own data apart with no other crate.
fn data_id(bytes: &[u8]) -> String {
    let mut a: u64 = 0xcbf2_9ce4_8422_2325;
    let mut b: u64 = 0x8422_2325_cbf2_9ce4;
    for byte in bytes {
        a = (a ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3);
        b = (b ^ u64::from(*byte))
            .wrapping_mul(0x0000_0100_0000_01b3)
            .rotate_left(5);
    }
    format!("{a:016x}{b:016x}{:x}", bytes.len())
}

fn read(path: &Path) -> Result<(Data, Option<SystemTime>), Error> {
    let io = |e: std::io::Error| Error(format!("{}: {e}", path.display()));
    let modified = fs::metadata(path).map_err(io)?.modified().ok();
    let bytes = fs::read(path).map_err(io)?;
    Ok((Data::new_copy(&bytes), modified))
}

impl Assets {
    /// Keeps `bytes` and answers the name a tree uses for them.
    pub fn put_data(&mut self, bytes: &[u8]) -> String {
        let id = data_id(bytes);
        self.clock += 1;
        let now = self.clock;
        if let Some(held) = self.data.get_mut(&id) {
            held.1 = now;
            return id;
        }
        self.data.insert(id.clone(), (Data::new_copy(bytes), now));
        self.data_bytes += bytes.len();
        // Past the budget the least recently used go, never the bytes just kept.
        while self.data_bytes > self.budget.unwrap_or(DATA_BUDGET) && self.data.len() > 1 {
            let Some(oldest) = self
                .data
                .iter()
                .filter(|(key, _)| **key != id)
                .min_by_key(|(_, (_, used))| *used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some((data, _)) = self.data.remove(&oldest) {
                self.data_bytes -= data.len();
            }
            self.data_typefaces.remove(&oldest);
            self.data_images.remove(&oldest);
        }
        id
    }

    /// Keeps a picture's bytes for the frame being drawn (a video's): only the last `FRAME_KEEP` stay.
    pub fn put_frame_data(&mut self, bytes: &[u8]) -> String {
        let id = format!("frame:{}", data_id(bytes));
        if let Some(at) = self.frames.iter().position(|(key, _)| *key == id) {
            let held = self.frames.remove(at).expect("found above");
            self.frames.push_back(held);
            return id;
        }
        self.frames.push_back((id.clone(), Data::new_copy(bytes)));
        while self.frames.len() > FRAME_KEEP {
            self.frames.pop_front();
        }
        id
    }

    /// The bytes put under `id`.
    pub fn data(&mut self, id: &str) -> Result<Data, Error> {
        if id.starts_with("frame:") {
            return self
                .frames
                .iter()
                .find(|(key, _)| key == id)
                .map(|(_, data)| data.clone())
                .ok_or_else(|| {
                    Error(format!(
                        "the video picture {id:?} is no longer kept: a picture lives for its frame"
                    ))
                });
        }
        self.clock += 1;
        let now = self.clock;
        match self.data.get_mut(id) {
            Some(held) => {
                held.1 = now;
                Ok(held.0.clone())
            }
            None => Err(Error(format!(
                "no data is kept as {id:?}: make it with Skia.Data (data past {} MB, least recently used first, is dropped)",
                DATA_BUDGET >> 20
            ))),
        }
    }

    /// Keeps at most `bytes` of `put_data`'s bytes from now on (tests; the default is `DATA_BUDGET`).
    pub fn set_data_budget(&mut self, bytes: usize) {
        self.budget = Some(bytes);
    }

    /// What is kept: the bytes of `put_data`, how many pieces, and how many frame pictures.
    pub fn kept(&self) -> (usize, usize, usize) {
        (self.data_bytes, self.data.len(), self.frames.len())
    }

    /// The typeface in the font bytes put under `id`.
    pub fn data_typeface(&mut self, id: &str) -> Result<Typeface, Error> {
        if let Some(typeface) = self.data_typefaces.get(id) {
            return Ok(typeface.clone());
        }
        let typeface = FontMgr::new()
            .new_from_data(self.data(id)?, None)
            .ok_or_else(|| Error("the data is not a font file".into()))?;
        self.data_typefaces.insert(id.to_string(), typeface.clone());
        Ok(typeface)
    }

    /// The picture in the encoded bytes (PNG, JPEG, WebP, GIF) put under `id`.
    pub fn data_image(&mut self, id: &str) -> Result<Image, Error> {
        if let Some(image) = self.data_images.get(id) {
            return Ok(image.clone());
        }
        let image = Image::from_encoded(self.data(id)?)
            .ok_or_else(|| Error("the data is not a picture Skia can decode".into()))?;
        // Decoded now, so that drawing it is the same work on every frame.
        let image = image.make_raster_image(None, None).unwrap_or(image);
        self.data_images.insert(id.to_string(), image.clone());
        Ok(image)
    }

    /// The frames of the animated picture (GIF, WebP) in the file at `path`, or in the data put under `id`.
    pub fn animation(&mut self, path: Option<&Path>, id: Option<&str>) -> Result<Animation, Error> {
        let (key, modified) = match (path, id) {
            (Some(path), _) => (
                path.to_string_lossy().into_owned(),
                fs::metadata(path).ok().and_then(|m| m.modified().ok()),
            ),
            (None, Some(id)) => (format!("data:{id}"), None),
            (None, None) => return Err(Error("an animated image needs a file or data".into())),
        };
        if let Some(held) = self.animations.get(&key).filter(|h| h.modified == modified) {
            return Ok(held.value.clone());
        }
        let data = match (path, id) {
            (Some(path), _) => read(path)?.0,
            (None, Some(id)) => self.data(id)?,
            (None, None) => unreachable!("checked above"),
        };
        let animation = decode_frames(data)?;
        self.animations.insert(
            key,
            Held {
                modified,
                value: animation.clone(),
            },
        );
        Ok(animation)
    }

    /// The runtime effect compiled from SkSL, compiled once.
    pub fn effect(&mut self, sksl: &str) -> Result<RuntimeEffect, Error> {
        if let Some(effect) = self.effects.get(sksl) {
            return Ok(effect.clone());
        }
        let effect = RuntimeEffect::make_for_shader(sksl, None)
            .map_err(|message| Error(format!("SkSL: {message}")))?;
        self.effects.insert(sksl.to_string(), effect.clone());
        Ok(effect)
    }

    /// The typeface in the font file at `path`.
    pub fn typeface(&mut self, path: &Path) -> Result<Typeface, Error> {
        let modified = fs::metadata(path).ok().and_then(|m| m.modified().ok());
        if let Some(held) = self.typefaces.get(path).filter(|h| h.modified == modified) {
            return Ok(held.value.clone());
        }
        let (data, modified) = read(path)?;
        let typeface = FontMgr::new()
            .new_from_data(data, None)
            .ok_or_else(|| Error(format!("{}: not a font file", path.display())))?;
        self.typefaces.insert(
            path.to_path_buf(),
            Held {
                modified,
                value: typeface.clone(),
            },
        );
        Ok(typeface)
    }

    /// The picture in the PNG, JPEG, WebP or GIF file at `path`.
    pub fn image(&mut self, path: &Path) -> Result<Image, Error> {
        let modified = fs::metadata(path).ok().and_then(|m| m.modified().ok());
        if let Some(held) = self.images.get(path).filter(|h| h.modified == modified) {
            return Ok(held.value.clone());
        }
        let (data, modified) = read(path)?;
        let image = Image::from_encoded(data)
            .ok_or_else(|| Error(format!("{}: not a picture Skia can decode", path.display())))?;
        self.images.insert(
            path.to_path_buf(),
            Held {
                modified,
                value: image.clone(),
            },
        );
        Ok(image)
    }
}

/// Every frame of an animated picture, each composed over the frame it needs as a player shows it.
fn decode_frames(data: Data) -> Result<Animation, Error> {
    let mut codec =
        Codec::from_data(data).ok_or_else(|| Error("not a picture Skia can decode".into()))?;
    let size = codec.dimensions();
    let info = ImageInfo::new(size, ColorType::RGBA8888, AlphaType::Premul, None);
    let row_bytes = size.width as usize * 4;
    let count = codec.get_frame_count().max(1);
    let mut pixels: Vec<Vec<u8>> = Vec::with_capacity(count);
    let mut durations = Vec::with_capacity(count);
    for index in 0..count {
        let frame = codec.get_frame_info(index);
        let required = frame
            .as_ref()
            .map_or(-1, |f| f.required_frame)
            .clamp(-1, index as i32 - 1);
        let mut buffer = if required >= 0 {
            pixels[required as usize].clone()
        } else {
            vec![0u8; row_bytes * size.height as usize]
        };
        let options = codec::Options {
            frame_index: index,
            prior_frame: (required >= 0).then_some(required as usize),
            ..codec::Options::default()
        };
        let result = codec.get_pixels_with_options(&info, &mut buffer, row_bytes, Some(&options));
        if !matches!(
            result,
            codec::Result::Success | codec::Result::IncompleteInput
        ) {
            if index == 0 {
                return Err(Error(format!(
                    "the picture could not be decoded: {}",
                    codec::result_to_string(result)
                )));
            }
            break;
        }
        pixels.push(buffer);
        durations.push(frame.map_or(0, |f| f.duration.max(0) as u32));
    }
    let frames = pixels
        .into_iter()
        .map(|p| {
            images::raster_from_data(&info, Data::new_copy(&p), row_bytes)
                .ok_or_else(|| Error("a frame could not be wrapped".into()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Animation { frames, durations })
}
