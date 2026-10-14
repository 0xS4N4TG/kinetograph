//! Lottie animations, rasterised by ThorVG's CPU renderer.
//!
//! LottieFiles' `dotlottie-rs` is their own player, built on ThorVG (C++, a
//! submodule of the crate, compiled by its build script). It reads `.json`
//! and `.lottie` files, and paints a frame of the animation, at any time, into
//! a pixel buffer. The renderer asks for a buffer the size the layer is drawn
//! at, uploads it as an image and draws it like one (`render.rs`).
//!
//! The picture is a pure function of the time asked for: a frame is set from
//! the time, whatever was drawn before, and nothing reads a clock. (An
//! expression in the animation that draws on a random number would not be;
//! such expressions must be seeded in the file.) ThorVG is built without
//! threads, so a frame is painted by one thread in one order.

use std::collections::HashMap;
use std::ffi::CString;
use std::path::Path;
use std::sync::Mutex;

use dotlottie_rs::{ColorSpace, Player};
use vello::peniko::{Blob, ImageAlphaType, ImageData, ImageFormat};

use crate::error::{Error, Result};
use crate::scene::{LayerKind, Scene, walk_layers};

/// ThorVG's engine is initialised and torn down as players come and go, which
/// is not safe to do from two threads at once.
static ENGINE: Mutex<()> = Mutex::new(());

/// One animation, loaded, with the pixel buffer ThorVG paints it into.
pub struct Lottie {
    // Declared first, so it is dropped first: ThorVG holds a pointer to
    // `buffer` from `set_sw_target` on.
    player: Player,
    /// The target, `size.0 x size.1` pixels of straight-alpha RGBA, one
    /// `u32` each (the value's little-endian bytes are R, G, B, A).
    buffer: Vec<u32>,
    size: (u32, u32),
    /// The frame `buffer` shows.
    frame: f32,
    /// The animation's own size in pixels.
    natural: (f64, f64),
    total_frames: f32,
    frames_per_second: f64,
}

// SAFETY: a `Lottie` owns its ThorVG objects and its buffer, and is used
// through `&mut` only, so it is never touched by two threads at once. ThorVG
// keeps no thread-local state for them (it is built without threads), so it
// may move between threads.
unsafe impl Send for Lottie {}

impl Lottie {
    /// Reads `path`: a `.lottie` archive, or Lottie JSON for any other
    /// extension.
    pub fn open(path: &Path) -> std::result::Result<Lottie, String> {
        let bytes = std::fs::read(path).map_err(|e| format!("cannot read: {e}"))?;
        let _engine = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
        let mut player = Player::new();
        // ThorVG needs a target to load into; the first draw sizes it.
        let mut buffer = vec![0_u32; 1];
        player
            .set_sw_target(&mut buffer, 1, 1, ColorSpace::ABGR8888S)
            .map_err(|e| format!("cannot set up ThorVG: {e:?}"))?;
        let loaded = if path.extension().is_some_and(|e| e == "lottie") {
            player.load_dotlottie_data(&bytes)
        } else {
            let json = CString::new(bytes).map_err(|_| "not Lottie JSON (it has a NUL byte)")?;
            player.load_animation_data(&json)
        };
        loaded.map_err(|e| format!("not a Lottie animation ({e:?})"))?;
        let [width, height] = player.animation_size()[..] else {
            return Err("the animation has no size".into());
        };
        let (total_frames, duration_ms) = (player.total_frames(), player.duration());
        if !(width > 0.0 && height > 0.0 && total_frames > 0.0 && duration_ms > 0.0) {
            return Err(format!(
                "the animation is empty ({width} x {height}, {total_frames} frames, {duration_ms} ms)"
            ));
        }
        Ok(Lottie {
            player,
            buffer,
            size: (1, 1),
            frame: 0.0,
            natural: (f64::from(width), f64::from(height)),
            total_frames,
            frames_per_second: f64::from(total_frames) / (f64::from(duration_ms) / 1000.0),
        })
    }

    /// The animation's own size, in pixels.
    pub fn natural_size(&self) -> (f64, f64) {
        self.natural
    }

    /// The frame number the animation shows `time` seconds in: `loop` wraps
    /// past the end, otherwise the last frame is held. Frame numbers run from
    /// 0 to `total_frames - 1`.
    pub fn frame_at(&self, time: f64, looped: bool) -> f32 {
        let duration = f64::from(self.total_frames) / self.frames_per_second;
        let t = if looped {
            time.rem_euclid(duration)
        } else {
            time.max(0.0)
        };
        let last = f64::from((self.total_frames - 1.0).max(0.0));
        (t * self.frames_per_second).min(last) as f32
    }

    /// The animation at `time` seconds, fitted inside a `width` x `height`
    /// picture and centred (lottie-web's `xMidYMid meet`), as straight-alpha
    /// sRGB RGBA8.
    pub fn render(
        &mut self,
        time: f64,
        looped: bool,
        width: u32,
        height: u32,
    ) -> std::result::Result<Vec<u8>, String> {
        let _engine = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
        let frame = self.frame_at(time, looped);
        let resized = (width, height) != self.size;
        if resized {
            // The old buffer stays registered with ThorVG until the next
            // line replaces it, and nothing draws in between.
            self.buffer = vec![0_u32; width as usize * height as usize];
            self.player
                .set_sw_target(&mut self.buffer, width, height, ColorSpace::ABGR8888S)
                .map_err(|e| format!("cannot size the picture ({e:?})"))?;
            self.size = (width, height);
        }
        // Setting the frame ThorVG already shows is an error, and the buffer
        // already holds it.
        let changed = frame != self.frame;
        if changed {
            self.player
                .set_frame(frame)
                .map_err(|e| format!("cannot show frame {frame} ({e:?})"))?;
            self.frame = frame;
        }
        if resized || changed {
            self.player
                .render()
                .map_err(|e| format!("cannot draw frame {frame} ({e:?})"))?;
        }
        Ok(self.buffer.iter().flat_map(|p| p.to_le_bytes()).collect())
    }
}

/// The size of a Lottie file's animation, for a layer that leaves it out.
pub fn natural_size(path: &Path) -> std::result::Result<(f64, f64), String> {
    Lottie::open(path).map(|l| l.natural_size())
}

/// Every animation of a scene, loaded, by `src`.
#[derive(Default)]
pub struct Lotties {
    animations: HashMap<String, Lottie>,
}

impl Lotties {
    pub fn is_empty(&self) -> bool {
        self.animations.is_empty()
    }

    /// The animation `src` at `time` seconds, `width` x `height` pixels, as an
    /// image to draw.
    pub fn image(
        &mut self,
        src: &str,
        time: f64,
        looped: bool,
        width: u32,
        height: u32,
    ) -> Result<ImageData> {
        let lottie = self
            .animations
            .get_mut(src)
            .ok_or_else(|| Error::Render(format!("lottie {src:?} was not loaded")))?;
        let rgba = lottie
            .render(time, looped, width, height)
            .map_err(|e| Error::Render(format!("lottie {src:?}: {e}")))?;
        Ok(ImageData {
            data: Blob::from(rgba),
            format: ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::Alpha,
            width,
            height,
        })
    }
}

/// Loads every animation the scene refers to, so that a missing or broken
/// file fails before any frame, and says which layer asked for it.
pub(crate) fn load_lotties(scene: &Scene) -> Result<Lotties> {
    let mut wanted = Vec::new();
    walk_layers(&scene.layers, &mut |layer| {
        if let LayerKind::Lottie(l) = &layer.kind {
            wanted.push((layer.id.clone(), l.src.clone()));
        }
    });
    let mut lotties = Lotties::default();
    for (id, src) in wanted {
        if lotties.animations.contains_key(&src) {
            continue;
        }
        let path = scene.base_dir.join(&src);
        let lottie = Lottie::open(&path)
            .map_err(|e| Error::Render(format!("layer {id:?}: lottie {}: {e}", path.display())))?;
        lotties.animations.insert(src, lottie);
    }
    Ok(lotties)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn anim(file: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/scenes/anims")
            .join(file)
    }

    /// The pixel `(x, y)` of a `width` wide RGBA picture.
    fn px(rgba: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * width + x) * 4) as usize;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    const YELLOW: [u8; 4] = [255, 209, 102, 255];
    const BLUE: [u8; 4] = [41, 110, 245, 255];
    const WHITE: [u8; 4] = [255, 255, 255, 255];

    /// Within a level or two, for the anti-aliased and rounded colours.
    fn near(got: [u8; 4], want: [u8; 4]) -> bool {
        got.iter().zip(want).all(|(a, b)| a.abs_diff(b) <= 3)
    }

    #[test]
    fn reads_the_size_and_timing_of_json_and_dotlottie_files() {
        for file in ["burst.json", "burst.lottie"] {
            let lottie = Lottie::open(&anim(file)).unwrap_or_else(|e| panic!("{file}: {e}"));
            assert_eq!(lottie.natural_size(), (120.0, 120.0), "{file}");
            // 60 frames at 30 per second: frames 0 to 59 over two seconds.
            assert_eq!(lottie.frame_at(0.0, false), 0.0);
            assert!((lottie.frame_at(0.5, false) - 15.0).abs() < 1e-3);
            // Past the end the last frame is held, or the time wraps.
            assert_eq!(lottie.frame_at(10.0, false), 59.0);
            assert_eq!(lottie.frame_at(-3.0, false), 0.0);
            assert!((lottie.frame_at(2.5, true) - 15.0).abs() < 1e-3);
            assert!((lottie.frame_at(-1.5, true) - 15.0).abs() < 1e-3);
            assert!(lottie.frame_at(1.999, true) > 59.0 - 0.1);
        }
        assert_eq!(natural_size(&anim("burst.json")), Ok((120.0, 120.0)));
    }

    #[test]
    fn paints_the_animation_at_the_time_and_size_asked() {
        let mut lottie = Lottie::open(&anim("burst.json")).unwrap();
        // Frame 0: the yellow bar lies across the middle, over a white dot, on
        // a blue rounded card.
        let at0 = lottie.render(0.0, false, 120, 120).unwrap();
        assert_eq!(at0.len(), 120 * 120 * 4);
        assert!(near(px(&at0, 120, 60, 60), YELLOW));
        assert!(near(px(&at0, 120, 60, 50), WHITE));
        assert!(near(px(&at0, 120, 60, 20), BLUE));
        assert_eq!(px(&at0, 120, 0, 0)[3], 0, "the corner is outside the card");
        // Half a second on, the bar has turned a quarter.
        let at15 = lottie.render(0.5, false, 120, 120).unwrap();
        assert!(near(px(&at15, 120, 60, 20), YELLOW));
        assert!(near(px(&at15, 120, 20, 60), BLUE));
        // Half the size: the same picture, smaller.
        let half = lottie.render(0.5, false, 60, 60).unwrap();
        assert_eq!(half.len(), 60 * 60 * 4);
        assert!(near(px(&half, 60, 30, 10), YELLOW));
        assert!(near(px(&half, 60, 10, 30), BLUE));
        // A wider picture: the animation is fitted inside and centred.
        let wide = lottie.render(0.5, false, 240, 120).unwrap();
        assert_eq!(px(&wide, 240, 30, 60)[3], 0);
        assert_eq!(px(&wide, 240, 210, 60)[3], 0);
        assert!(near(px(&wide, 240, 120, 20), YELLOW));
        assert!(near(px(&wide, 240, 80, 60), BLUE));
    }

    #[test]
    fn a_frame_is_a_function_of_the_time_alone() {
        let mut a = Lottie::open(&anim("burst.json")).unwrap();
        let first = a.render(0.4, false, 90, 90).unwrap();
        // Other times, another size, and back.
        a.render(1.7, false, 90, 90).unwrap();
        a.render(0.9, false, 33, 47).unwrap();
        assert_eq!(a.render(0.4, false, 90, 90).unwrap(), first);
        // The same time twice in a row, with nothing to redraw.
        assert_eq!(a.render(0.4, false, 90, 90).unwrap(), first);
        // A fresh animation, and the other file format, agree.
        let mut b = Lottie::open(&anim("burst.json")).unwrap();
        assert_eq!(b.render(0.4, false, 90, 90).unwrap(), first);
        let mut c = Lottie::open(&anim("burst.lottie")).unwrap();
        assert_eq!(c.render(0.4, false, 90, 90).unwrap(), first);
        // Time past the end holds the last frame, or wraps to the first.
        let held = b.render(2.0, false, 90, 90).unwrap();
        assert_eq!(b.render(50.0, false, 90, 90).unwrap(), held);
        let wrapped = b.render(2.0, true, 90, 90).unwrap();
        assert_eq!(wrapped, b.render(0.0, false, 90, 90).unwrap());
        assert_ne!(wrapped, held);
    }

    #[test]
    fn says_what_is_wrong_with_a_file() {
        let missing = Lottie::open(&anim("nope.json")).err().unwrap();
        assert!(missing.contains("cannot read"), "{missing}");
        let dir = std::env::temp_dir().join(format!("kinetograph-lottie-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (name, content, want) in [
            ("junk.json", "this is not json", "not a Lottie animation"),
            ("empty.json", "{}", "not a Lottie animation"),
        ] {
            let path = dir.join(name);
            std::fs::write(&path, content).unwrap();
            let err = Lottie::open(&path).err().unwrap();
            assert!(err.contains(want), "{name}: {err}");
        }
        std::fs::write(dir.join("bad.lottie"), b"PK not a zip").unwrap();
        assert!(Lottie::open(&dir.join("bad.lottie")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
