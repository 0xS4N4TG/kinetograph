//! Without ANGLE a WebGL layer is an error that says why (its own process, because ANGLE is looked for once).

use kinetograph_core::{Scene, render_still, webgl_backend};

#[test]
fn a_webgl_layer_without_angle_is_an_error_naming_why() {
    // SAFETY: the only test of this process, so no other thread reads the environment.
    unsafe { std::env::set_var("KINETOGRAPH_ANGLE_DIR", "/nonexistent/angle") };
    let (backend, device, why) = webgl_backend();
    assert_eq!((backend, device), ("none", None));
    assert!(why.contains("ANGLE"), "{why}");
    let json = r##"{"width": 8, "height": 8, "fps": 30, "durationInFrames": 1, "layers": [
        {"id": "g", "type": "glsl", "width": 8, "height": 8, "programs": {}, "buffers": {}, "ops": []}]}"##;
    let scene = Scene::from_json(json, Default::default()).unwrap();
    let error = render_still(scene, 0).err().expect("must fail").to_string();
    assert!(error.contains("WebGL cannot draw") && error.contains("ANGLE"), "{error}");
}
