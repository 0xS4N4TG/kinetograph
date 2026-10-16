//! The files a tree names: fonts and pictures, read once and kept for the next
//! frame. A file that changes on disk is read again.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use skia_safe::{Data, FontMgr, Image, RuntimeEffect, Typeface};

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
}

fn read(path: &Path) -> Result<(Data, Option<SystemTime>), Error> {
    let io = |e: std::io::Error| Error(format!("{}: {e}", path.display()));
    let modified = fs::metadata(path).map_err(io)?.modified().ok();
    let bytes = fs::read(path).map_err(io)?;
    Ok((Data::new_copy(&bytes), modified))
}

impl Assets {
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
