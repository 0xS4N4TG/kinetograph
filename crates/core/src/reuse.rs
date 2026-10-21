//! Identical-frame reuse: a frame that is provably the same as the frame the
//! renderer drew before it is not drawn again (no raster, no compositing, no
//! readback); its pixels are the earlier frame's.
//!
//! The proof is the same as the layer cache's (`cache.rs`), for the whole
//! frame: the resolved scene holds every value a frame is drawn from, and two
//! frames whose resolved scenes are equal, compared exactly with `PartialEq`
//! (no hashing), draw the same pixels. Every frame-dependent input is a field
//! of it: keyframed numbers are resolved; a custom shader's `frame` and
//! `time`, a grain's or dither's `frame`, a Lottie's, GIF's (and animated
//! PNG's and WebP's) time, a video's picked picture (`MediaTime`), a Canvas 2D
//! context's commands, a WebGL recording with its uniforms, a 3D scene and the
//! motion blur samples are all in it. A float that is NaN never equals itself,
//! so a frame holding one is drawn.
//!
//! The one field that is not compared is `ResolvedScene::frame`, the frame's
//! number: no pass reads it (the passes that hash the frame read the copy in
//! their own effect, which is compared).
//!
//! What a frame is drawn from beside its resolved scene is the renderer's:
//! the files behind fonts, images, videos and tables, the canvas size and
//! margin, the blend space, the frame rate and the asset directory. The
//! renderer forgets the frame it drew whenever any of those changes
//! (`Renderer::set_scene`), and when anything is read from a file it did not
//! hold, so a frame is only ever compared with one drawn from the same files.
//! A renderer keeps no other state that a frame's pixels depend on: the layer
//! cache, the video decoders' positions and the pooled textures give the same
//! pixels whatever they hold (`cache.rs`, `video.rs`).
//!
//! Reuse is off in a new renderer, as the layer cache is, and only compares a
//! frame with the one started just before it. `KINETOGRAPH_NO_REUSE=1` turns
//! it off where the CLI and the addon would turn it on.

use crate::resolve::ResolvedScene;

/// Whether the environment allows frame reuse: unless `KINETOGRAPH_NO_REUSE`
/// is set to something other than `0` or the empty string.
pub fn allowed_by_env() -> bool {
    std::env::var_os("KINETOGRAPH_NO_REUSE").is_none_or(|v| v.is_empty() || v == "0")
}

/// Whether two resolved scenes draw the same pixels (see the module). All
/// fields are named, so a field added to `ResolvedScene` stops this compiling
/// until it is decided.
pub fn same_frame(a: &ResolvedScene, b: &ResolvedScene) -> bool {
    let ResolvedScene {
        width,
        height,
        // The frame's number: read by no pass.
        frame: _,
        background,
        camera,
        layers,
    } = a;
    *width == b.width
        && *height == b.height
        && *background == b.background
        && *camera == b.camera
        && *layers == b.layers
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::same_frame;
    use crate::scene::Scene;

    /// A scene of `layers`, 30 frames at 30 fps, its files in `tests/scenes`.
    fn scene(layers: &str) -> Scene {
        let json = format!(
            r##"{{ "width": 160, "height": 90, "fps": 30, "durationInFrames": 30, "layers": [{layers}] }}"##
        );
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes");
        Scene::from_json(&json, dir).unwrap()
    }

    fn same_at(scene: &Scene, a: u32, b: u32) -> bool {
        same_frame(&scene.resolve(a).unwrap(), &scene.resolve(b).unwrap())
    }

    const RECT: &str = r##"{ "id": "r", "type": "shape", "shape": { "kind": "rect", "width": 20, "height": 10 }, "fill": "#ffffff" }"##;

    #[test]
    fn a_still_scene_is_the_same_at_every_frame() {
        let s = scene(RECT);
        assert!(same_at(&s, 0, 1));
        assert!(same_at(&s, 3, 29));
    }

    #[test]
    fn a_keyframed_value_changes_it_until_it_holds() {
        let s = scene(
            r##"{ "id": "r", "type": "shape", "shape": { "kind": "rect", "width": 20, "height": 10 }, "fill": "#ffffff",
                  "opacity": [{ "frame": 0, "value": 0 }, { "frame": 10, "value": 1 }] }"##,
        );
        assert!(!same_at(&s, 3, 4));
        assert!(!same_at(&s, 9, 10));
        assert!(same_at(&s, 10, 11));
    }

    /// Each input that changes with time and not through a keyframed number
    /// makes two frames differ.
    #[test]
    fn each_time_dependent_input_changes_it() {
        let cases = [
            (
                "shader frame and time",
                r##"{ "id": "s", "type": "shape", "shape": { "kind": "rect", "width": 20, "height": 10 }, "fill": "#808080",
                     "effects": [{ "type": "shader", "code": "fn effect(px: vec2<f32>) -> vec4<f32> { return layer(px); }" }] }"##,
            ),
            (
                "grain",
                r##"{ "id": "s", "type": "shape", "shape": { "kind": "rect", "width": 20, "height": 10 }, "fill": "#808080",
                     "effects": [{ "type": "grain", "amount": 0.3, "seed": 3 }] }"##,
            ),
            (
                "video",
                r##"{ "id": "v", "type": "video", "src": "media/clip.mp4" }"##,
            ),
            (
                "gif",
                r##"{ "id": "g", "type": "gif", "src": "media/spinner.gif" }"##,
            ),
            (
                "lottie",
                r##"{ "id": "l", "type": "lottie", "src": "anims/burst.json" }"##,
            ),
            (
                "motion blur of a moving layer",
                r##"{ "id": "m", "type": "shape", "shape": { "kind": "rect", "width": 20, "height": 10 }, "fill": "#ffffff",
                      "motionBlur": { "samples": 4, "shutter": 1 },
                      "transform": { "x": [{ "frame": 0, "value": 0 }, { "frame": 29, "value": 100 }] } }"##,
            ),
        ];
        for (what, layer) in cases {
            let s = scene(layer);
            assert!(!same_at(&s, 4, 5), "{what}: frames 4 and 5 compare equal");
        }
    }

    #[test]
    fn a_held_video_picture_gif_time_or_still_grain_does_not() {
        let cases = [
            r##"{ "id": "v", "type": "video", "src": "media/clip.mp4", "frame": 10 }"##,
            r##"{ "id": "g", "type": "gif", "src": "media/spinner.gif", "time": 0.15 }"##,
            r##"{ "id": "s", "type": "shape", "shape": { "kind": "rect", "width": 20, "height": 10 }, "fill": "#808080",
                 "effects": [{ "type": "grain", "amount": 0.3, "seed": 3, "animate": false }] }"##,
        ];
        for layer in cases {
            assert!(same_at(&scene(layer), 4, 5), "{layer}");
        }
    }

    #[test]
    fn canvas_commands_are_compared() {
        let canvas = |colour: &str| {
            scene(&format!(
                r##"{{ "id": "c", "type": "canvas", "width": 40, "height": 40,
                      "commands": [{{ "op": "fill", "path": "M0 0h10v10h-10Z", "paint": {{ "type": "color", "color": "{colour}" }} }}] }}"##
            ))
        };
        let (red, red2, green) = (canvas("#ff0000"), canvas("#ff0000"), canvas("#00ff00"));
        assert!(same_frame(
            &red.resolve(0).unwrap(),
            &red2.resolve(1).unwrap()
        ));
        assert!(!same_frame(
            &red.resolve(0).unwrap(),
            &green.resolve(0).unwrap()
        ));
    }

    #[test]
    fn the_scene_size_and_background_are_compared() {
        let a = scene(RECT).resolve(0).unwrap();
        let mut b = a.clone();
        b.background = crate::color::Color {
            r: 1,
            ..crate::color::Color::BLACK
        };
        assert!(!same_frame(&a, &b));
        let mut c = a.clone();
        c.width += 2;
        assert!(!same_frame(&a, &c));
        // A NaN never equals itself: such a frame is drawn.
        let mut d = a.clone();
        d.layers[0].opacity = f32::NAN;
        assert!(!same_frame(&d, &d.clone()));
    }
}
