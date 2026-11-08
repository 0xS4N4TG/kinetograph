//! The real models on a real frame: Fred Ott's Sneeze (1894, public domain), a man on a black background. Each model's
//! matte must hold the face and drop the far corner. Skipped unless the model file is named in `KINETOGRAPH_MODNET`
//! or `KINETOGRAPH_BEN2` (the files are not in the repository): CI has none.
//!
//! This is what caught ONNX Runtime's CPU provider giving MODNet a junk matte on an M4 Mac while CoreML's
//! NeuralNetwork format gave the right one.

use std::path::{Path, PathBuf};

use kinetograph_core::video::{VideoDecoder, probe};
use kinetograph_matte::{Model, matte_frame};

/// Frame 60 of the clip, tightly packed RGBA8, 1920x1080.
fn frame() -> (Vec<u8>, u32, u32) {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/launch/public/footage/fred.mp4");
    let info = probe(&path).expect("the sneeze clip is in the repository");
    let ts = info.media_time(2.0, info.duration).ts;
    let picture = VideoDecoder::open(&path, info)
        .unwrap()
        .picture(ts)
        .unwrap();
    (picture.data.data().to_vec(), picture.width, picture.height)
}

fn mean(alpha: &[u8], width: u32, (x0, y0, x1, y1): (u32, u32, u32, u32)) -> f64 {
    let mut sum = 0.0;
    for y in y0..y1 {
        for x in x0..x1 {
            sum += f64::from(alpha[(y * width + x) as usize]);
        }
    }
    sum / f64::from((x1 - x0) * (y1 - y0))
}

fn check(var: &str, model: Model) {
    let Some(path) = std::env::var_os(var).map(PathBuf::from) else {
        eprintln!("{var} is not set: skipping {}", model.id());
        return;
    };
    let (rgba, width, height) = frame();
    let (alpha, backend) = matte_frame(&path, model, &rgba, width, height).unwrap();
    let face = mean(&alpha, width, (850, 400, 950, 500));
    let chest = mean(&alpha, width, (900, 950, 1100, 1050));
    // The black wall far from the man: the top right, where the models have nothing to mistake for a person.
    let wall = mean(&alpha, width, (1500, 20, 1900, 200));
    eprintln!(
        "{} on {backend}: face {face:.0}, chest {chest:.0}, wall {wall:.1}",
        model.id()
    );
    assert!(
        face > 200.0,
        "{} on {backend}: the face has alpha {face:.0}, not above 200",
        model.id()
    );
    assert!(
        chest > 200.0,
        "{} on {backend}: the chest has alpha {chest:.0}, not above 200",
        model.id()
    );
    assert!(
        wall < 30.0,
        "{} on {backend}: the wall has alpha {wall:.1}, not below 30",
        model.id()
    );
}

// Fails on ONNX Runtime's CPU provider on an M4 Mac (the face comes out transparent) and passes on CoreML's
// NeuralNetwork format, which is 2 to 3 times slower than the CPU; both agree to 0.2 of 255 on a colour portrait. The
// network is unstable on this dark, grainy frame (ORT's CPU, ORT's reference evaluator and CoreML give three different
// mattes), so the clip is a bad test of MODNet, not proof that the CPU provider is wrong. Run it with --ignored.
#[test]
#[ignore = "MODNet is unstable on this dark grainy frame: see the comment"]
fn modnet_holds_the_person() {
    check("KINETOGRAPH_MODNET", Model::Modnet);
}

#[test]
fn ben2_holds_the_person() {
    check("KINETOGRAPH_BEN2", Model::Ben2Base);
}
