//! The real models on real frames. Each model's matte must hold the person and drop the background. Skipped unless the
//! model file is named in `KINETOGRAPH_MODNET` or `KINETOGRAPH_BEN2` (the files are not in the repository): CI has none.
//!
//! - Fred Ott's Sneeze (1894, public domain, in the repository): a man on a black wall. BEN2 holds him. MODNet does
//!   not, and neither does anything else tried: on dark, grainy black-and-white film MODNet's matte depends on the
//!   back end (ONNX Runtime's CPU and CoreML's NeuralNetwork format agree on none of three such frames, to 37 to 52
//!   percent of the pixels, and each puts blobs in the dark). On colour photographs they agree to 0.4 of 255. So it is
//!   a known-hard case for MODNet, not a bug of one provider, and only BEN2 is tested on it.
//! - A portrait, named in `KINETOGRAPH_PORTRAIT` as a 1920x1080 video: both models. The one used is Pexels photo
//!   5965592 (a woman with long hair holding a phone, in front of a wall and windows) made into a four-second clip,
//!   `ffmpeg -loop 1 -i pexels.jpg -vf "scale=3840:-1:flags=lanczos,crop=3840:2160:0:0,zoompan=z='1+0.0005*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=120:s=1920x1080:fps=30,format=yuv420p" -frames:v 120 -c:v libx264 -crf 12 pexels.mp4`,
//!   and the frame at two seconds. (A video, because the frame decoder reads no still image.)

use std::path::{Path, PathBuf};

use kinetograph_core::video::{VideoDecoder, probe};
use kinetograph_matte::{Model, matte_frame};

/// One frame of `path` at `seconds`, tightly packed RGBA8, and its size.
fn frame(path: &Path, seconds: f64) -> (Vec<u8>, u32, u32) {
    let info = probe(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let ts = info.media_time(seconds, info.duration).ts;
    let picture = VideoDecoder::open(path, info).unwrap().picture(ts).unwrap();
    (picture.data.data().to_vec(), picture.width, picture.height)
}

/// The mean alpha in a box given as fractions of the frame (x0, y0, x1, y1).
fn mean(alpha: &[u8], (w, h): (u32, u32), (x0, y0, x1, y1): (f64, f64, f64, f64)) -> f64 {
    let (x0, x1) = ((x0 * f64::from(w)) as u32, (x1 * f64::from(w)) as u32);
    let (y0, y1) = ((y0 * f64::from(h)) as u32, (y1 * f64::from(h)) as u32);
    let mut sum = 0.0;
    for y in y0..y1 {
        for x in x0..x1 {
            sum += f64::from(alpha[(y * w + x) as usize]);
        }
    }
    sum / f64::from((x1 - x0) * (y1 - y0))
}

type Boxes<'a> = &'a [(&'a str, (f64, f64, f64, f64), bool)];

/// Runs `model` on `frame` and asserts every box: (name, box, whether the person is there).
fn check(var: &str, model: Model, (rgba, w, h): (Vec<u8>, u32, u32), boxes: Boxes) {
    let Some(file) = std::env::var_os(var).map(PathBuf::from) else {
        eprintln!("{var} is not set: skipping {}", model.id());
        return;
    };
    let (alpha, backend) = matte_frame(&file, model, &rgba, w, h).unwrap();
    for (name, region, person) in boxes {
        let m = mean(&alpha, (w, h), *region);
        eprintln!("{} on {backend}: {name} {m:.0}", model.id());
        if *person {
            assert!(
                m > 200.0,
                "{} on {backend}: {name} has alpha {m:.0}, not above 200",
                model.id()
            );
        } else {
            assert!(
                m < 30.0,
                "{} on {backend}: {name} has alpha {m:.0}, not below 30",
                model.id()
            );
        }
    }
}

fn sneeze() -> (Vec<u8>, u32, u32) {
    let clip =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/launch/public/footage/fred.mp4");
    frame(&clip, 2.0)
}

const SNEEZE: Boxes = &[
    ("face", (0.44, 0.37, 0.50, 0.46), true),
    ("chest", (0.47, 0.88, 0.57, 0.97), true),
    ("wall", (0.78, 0.02, 0.99, 0.17), false),
];

const PORTRAIT: Boxes = &[
    ("face", (0.43, 0.24, 0.47, 0.35), true),
    ("jacket", (0.40, 0.70, 0.50, 0.89), true),
    ("wall", (0.02, 0.28, 0.16, 0.55), false),
    ("window", (0.68, 0.07, 0.94, 0.30), false),
];

fn portrait() -> Option<(Vec<u8>, u32, u32)> {
    let Some(path) = std::env::var_os("KINETOGRAPH_PORTRAIT").map(PathBuf::from) else {
        eprintln!("KINETOGRAPH_PORTRAIT is not set: skipping the portrait");
        return None;
    };
    Some(frame(&path, 2.0))
}

#[test]
fn ben2_holds_the_man_on_the_black_wall() {
    check("KINETOGRAPH_BEN2", Model::Ben2Base, sneeze(), SNEEZE);
}

#[test]
fn ben2_holds_the_woman_in_the_portrait() {
    if let Some(frame) = portrait() {
        check("KINETOGRAPH_BEN2", Model::Ben2Base, frame, PORTRAIT);
    }
}

#[test]
fn modnet_holds_the_woman_in_the_portrait() {
    if let Some(frame) = portrait() {
        check("KINETOGRAPH_MODNET", Model::Modnet, frame, PORTRAIT);
    }
}
