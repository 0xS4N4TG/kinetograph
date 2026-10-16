//! The 3D layer's pixels: what a few small scenes must draw (the goldens in
//! `golden.rs` cover the looks; these pin the rules).

use std::path::Path;

use kinetograph_core::{Error, Frame, Renderer, Scene, render_still};

const BACKGROUND: [u8; 4] = [0x20, 0x30, 0x40, 0xff];

/// A 100x100 canvas with one 3D layer of the same size, from the layer's
/// `body` (the JSON after its `type`).
fn scene(body: &str) -> Scene {
    let json = format!(
        r##"{{"width": 100, "height": 100, "fps": 30, "durationInFrames": 30,
             "background": "#203040",
             "fonts": {{"DM Sans": "../../../../assets/fonts/DMSans-Medium.ttf"}},
             "layers": [{{"id": "s", "type": "scene3d", "width": 100, "height": 100, {body}}}]}}"##
    );
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenes");
    Scene::from_json(&json, base).unwrap_or_else(|e| panic!("{e}\n{json}"))
}

fn render(body: &str) -> Frame {
    render_still(scene(body), 0).unwrap()
}

fn px(frame: &Frame, x: usize, y: usize) -> [u8; 4] {
    let i = (y * frame.width as usize + x) * 4;
    frame.rgba[i..i + 4].try_into().unwrap()
}

/// An orthographic camera over a 10 x 10 view, looking down -z from z = 5.
const ORTHO: &str = r#""camera": {"type": "orthographic", "height": 10, "position": [0, 0, 5]}"#;

/// A square of side `side` at depth `z`, unlit.
fn quad(color: &str, side: f64, z: f64, extra: &str) -> String {
    format!(
        r##"{{"type": "mesh", "geometry": {{"kind": "plane", "width": {side}, "height": {side}}},
             "material": {{"color": "{color}", "unlit": true {extra}}}, "position": [0, 0, {z}]}}"##
    )
}

#[test]
fn an_empty_scene_leaves_the_background() {
    let frame = render(r#""objects": []"#);
    assert!(frame.rgba.chunks(4).all(|p| p == BACKGROUND));
}

#[test]
fn an_unlit_object_shows_its_colour_and_the_scene_is_transparent_around_it() {
    let frame = render(&format!(
        r#"{ORTHO}, "objects": [{}]"#,
        quad("#ff8000", 4.0, 0.0, "")
    ));
    assert_eq!(px(&frame, 50, 50), [255, 128, 0, 255]);
    // Outside the square (4 of 10 units: 30..70) the 2D background shows.
    assert_eq!(px(&frame, 10, 50), BACKGROUND);
    assert_eq!(px(&frame, 50, 90), BACKGROUND);
}

#[test]
fn depth_decides_what_is_in_front_not_document_order() {
    let near = quad("#ff0000", 4.0, 1.0, "");
    let far = quad("#0000ff", 6.0, -1.0, "");
    let one = render(&format!(r#"{ORTHO}, "objects": [{near}, {far}]"#));
    let two = render(&format!(r#"{ORTHO}, "objects": [{far}, {near}]"#));
    assert_eq!(one.rgba, two.rgba);
    assert_eq!(px(&one, 50, 50), [255, 0, 0, 255], "the near square");
    assert_eq!(px(&one, 25, 50), [0, 0, 255, 255], "the far one around it");
}

#[test]
fn translucent_objects_blend_farthest_first_in_any_order() {
    let near = quad("#ff0000", 6.0, 1.0, r#", "opacity": 0.5"#);
    let far = quad("#0000ff", 6.0, -1.0, r#", "opacity": 0.5"#);
    let one = render(&format!(r#"{ORTHO}, "objects": [{near}, {far}]"#));
    let two = render(&format!(r#"{ORTHO}, "objects": [{far}, {near}]"#));
    assert_eq!(one.rgba, two.rgba);
    let p = px(&one, 50, 50);
    // Red over blue over the background: more red than blue.
    assert!(p[0] > p[2] + 30, "{p:?}");
    // And one translucent layer over the background mixes with it.
    let half = render(&format!(
        r#"{ORTHO}, "objects": [{}]"#,
        quad("#ffffff", 6.0, 0.0, r#", "opacity": 0.5"#)
    ));
    let p = px(&half, 50, 50);
    // Half white over #203040 in linear light, back in sRGB.
    for (got, bg) in p.iter().zip(BACKGROUND).take(3) {
        assert!(*got > bg && *got < 255, "{p:?}");
    }
    assert!((i32::from(p[0]) - 189).abs() <= 1, "{p:?}");
}

#[test]
fn back_faces_are_culled_unless_the_material_is_double_sided() {
    let turned = |extra: &str| {
        format!(
            r##"{ORTHO}, "objects": [{{"type": "mesh", "geometry": {{"kind": "plane", "width": 4, "height": 4}},
                "material": {{"color": "#ffffff", "unlit": true {extra}}}, "rotation": [0, 180, 0]}}]"##
        )
    };
    let culled = render(&turned(""));
    assert!(culled.rgba.chunks(4).all(|p| p == BACKGROUND));
    let both = render(&turned(r#", "doubleSided": true"#));
    assert_eq!(px(&both, 50, 50), [255, 255, 255, 255]);
}

#[test]
fn a_mirrored_object_is_not_taken_for_its_own_back() {
    // A negative scale turns the triangles inside out on screen; the shader
    // undoes it, so the plane still shows its front.
    let frame = render(&format!(
        r##"{ORTHO}, "objects": [{{"type": "mesh", "geometry": {{"kind": "plane", "width": 4, "height": 4}},
            "material": {{"color": "#ffffff", "unlit": true}}, "scale": [-1, 1, 1]}}]"##
    ));
    assert_eq!(px(&frame, 50, 50), [255, 255, 255, 255]);
}

#[test]
fn msaa_smooths_edges_and_one_sample_does_not() {
    let sphere = |msaa: u32| {
        render(&format!(
            r##""msaa": {msaa}, {ORTHO}, "objects": [{{"type": "mesh", "geometry": {{"kind": "sphere", "radius": 3}},
                "material": {{"color": "#ffffff", "unlit": true}}}}]"##
        ))
    };
    let distinct = |f: &Frame| {
        let mut colours: Vec<[u8; 4]> = f.rgba.chunks(4).map(|p| p.try_into().unwrap()).collect();
        colours.sort();
        colours.dedup();
        colours.len()
    };
    assert_eq!(distinct(&sphere(1)), 2, "the background and the sphere");
    assert!(distinct(&sphere(4)) > 2, "edge pixels in between");
}

#[test]
fn the_layer_box_cuts_the_scene() {
    // A 4x4 box at the middle of the canvas, a scene much bigger than it.
    let json = r##"{"width": 100, "height": 100, "fps": 30, "durationInFrames": 1, "background": "#203040",
        "layers": [{"id": "s", "type": "scene3d", "width": 40, "height": 40,
          "transform": {"x": 30, "y": 30},
          "camera": {"type": "orthographic", "height": 4, "position": [0, 0, 5]},
          "objects": [{"type": "mesh", "geometry": {"kind": "plane", "width": 50, "height": 50},
                       "material": {"color": "#ffffff", "unlit": true}}]}]}"##;
    let frame = render_still(Scene::from_json(json, ".".into()).unwrap(), 0).unwrap();
    assert_eq!(px(&frame, 50, 50), [255, 255, 255, 255]);
    assert_eq!(px(&frame, 31, 31), [255, 255, 255, 255]);
    assert_eq!(px(&frame, 28, 50), BACKGROUND);
    assert_eq!(px(&frame, 50, 72), BACKGROUND);
}

#[test]
fn a_rotated_layer_is_cut_along_its_own_edges() {
    let json = r##"{"width": 100, "height": 100, "fps": 30, "durationInFrames": 1, "background": "#203040",
        "layers": [{"id": "s", "type": "scene3d", "width": 60, "height": 20,
          "transform": {"x": 50, "y": 50, "anchorX": 30, "anchorY": 10, "rotation": 90},
          "camera": {"type": "orthographic", "height": 4, "position": [0, 0, 5]},
          "objects": [{"type": "mesh", "geometry": {"kind": "plane", "width": 50, "height": 50},
                       "material": {"color": "#ffffff", "unlit": true}}]}]}"##;
    let frame = render_still(Scene::from_json(json, ".".into()).unwrap(), 0).unwrap();
    // Turned a quarter, the 60 x 20 box is 20 wide and 60 tall.
    assert_eq!(px(&frame, 50, 25), [255, 255, 255, 255]);
    assert_eq!(px(&frame, 50, 75), [255, 255, 255, 255]);
    assert_eq!(px(&frame, 30, 50), BACKGROUND);
    assert_eq!(px(&frame, 70, 50), BACKGROUND);
}

#[test]
fn lights_obey_lambert_ambient_and_the_inverse_square() {
    let lit = |lights: &str, y: f64| {
        // A rough, non-metal plane, facing +z, seen head on.
        let frame = render(&format!(
            r##"{ORTHO}, "lights": [{lights}], "objects": [{{"type": "mesh",
                "geometry": {{"kind": "plane", "width": 6, "height": 6}},
                "material": {{"color": "#808080", "roughness": 1}}, "position": [0, {y}, 0]}}]"##
        ));
        px(&frame, 50, 50)
    };
    let linear = |v: u8| {
        let v = f64::from(v) / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    // Ambient light of 1 on a #808080 surface: its own colour back.
    let ambient = lit(r#"{"type": "ambient", "intensity": 1}"#, 0.0);
    assert!((i32::from(ambient[0]) - 128).abs() <= 1, "{ambient:?}");
    // A directional light's Lambert term is the cosine of the angle: 60
    // degrees off the normal gives half of head-on (the little specular of a
    // rough surface aside).
    let head_on = lit(
        r#"{"type": "directional", "direction": [0, 0, -1], "intensity": 1}"#,
        0.0,
    );
    let slanted = lit(
        r#"{"type": "directional", "direction": [0, -0.866025, -0.5], "intensity": 1}"#,
        0.0,
    );
    let ratio = linear(slanted[0]) / linear(head_on[0]);
    assert!(
        (ratio - 0.5).abs() < 0.05,
        "{ratio} ({head_on:?} {slanted:?})"
    );
    // A point light four times as far gives a sixteenth of the light.
    let at = |z: f64| {
        lit(
            &format!(r#"{{"type": "point", "position": [0, 0, {z}], "intensity": 4}}"#),
            0.0,
        )
    };
    let (near, far) = (at(2.0), at(8.0));
    let ratio = linear(far[0]) / linear(near[0]);
    assert!(
        (ratio - 1.0 / 16.0).abs() < 0.01,
        "{ratio} ({near:?} {far:?})"
    );
}

#[test]
fn emission_shows_without_any_light() {
    let frame = render(&format!(
        r##"{ORTHO}, "objects": [{{"type": "mesh", "geometry": {{"kind": "plane", "width": 6, "height": 6}},
            "material": {{"color": "#000000", "emissive": "#00ff00"}}}}]"##
    ));
    assert_eq!(px(&frame, 50, 50), [0, 255, 0, 255]);
}

#[test]
fn a_perspective_camera_shrinks_distant_things_and_an_orthographic_one_does_not() {
    let width_at = |camera: &str, z: f64| {
        let frame = render(&format!(
            r#"{camera}, "objects": [{}]"#,
            quad("#ffffff", 2.0, z, "")
        ));
        (0..100)
            .filter(|&x| px(&frame, x, 50) != BACKGROUND)
            .count()
    };
    let ortho = r#""camera": {"type": "orthographic", "height": 10, "position": [0, 0, 10]}"#;
    let persp = r#""camera": {"fov": 40, "position": [0, 0, 10]}"#;
    assert_eq!(width_at(ortho, 0.0), width_at(ortho, -20.0));
    assert!(
        width_at(persp, -10.0) * 3 < width_at(persp, 5.0) * 2,
        "farther is smaller"
    );
}

#[test]
fn camera_and_objects_animate_with_the_frame() {
    let scene = scene(
        r##""camera": {"type": "orthographic", "height": 10, "position": [[{"frame": 0, "value": 0}, {"frame": 10, "value": 4}], 0, 5],
                       "target": [[{"frame": 0, "value": 0}, {"frame": 10, "value": 4}], 0, 0]},
           "objects": [{"type": "mesh", "geometry": {"kind": "plane", "width": 2, "height": 2},
                        "material": {"color": "#ffffff", "unlit": true}}]"##,
    );
    let mut renderer = Renderer::new(scene).unwrap();
    let start = renderer.render_frame(0).unwrap();
    let moved = renderer.render_frame(10).unwrap();
    assert_eq!(px(&start, 50, 50), [255, 255, 255, 255]);
    // The camera moved 4 units right, so the square is 40 pixels left.
    assert_eq!(px(&moved, 50, 50), BACKGROUND);
    assert_eq!(px(&moved, 10, 50), [255, 255, 255, 255]);
}

#[test]
fn rendering_is_a_pure_function_of_the_frame() {
    let body = r##""camera": {"fov": 40, "position": [0, 1, 7]},
        "lights": [{"type": "ambient", "intensity": 0.3}, {"type": "directional", "direction": [-1, -1, -1]}],
        "objects": [{"type": "mesh", "geometry": {"kind": "torus"}, "material": {"color": "#c77dff", "metallic": 0.4},
                     "rotation": [[{"frame": 0, "value": 0}, {"frame": 29, "value": 200}], 30, 0]},
                    {"type": "text", "text": "Hi", "font": "DM Sans", "position": [0, -1.5, 0]}]"##;
    let a = render_still(scene(body), 7).unwrap().rgba;
    let b = render_still(scene(body), 7).unwrap().rgba;
    assert_eq!(a, b);
    let mut renderer = Renderer::new(scene(body)).unwrap();
    let c = renderer.render_frame(7).unwrap().rgba;
    let other = renderer.render_frame(20).unwrap().rgba;
    let d = renderer.render_frame(7).unwrap().rgba;
    assert_eq!(a, c);
    assert_eq!(c, d);
    assert_ne!(c, other);
}

#[test]
fn a_model_and_a_texture_are_read_from_their_files() {
    let frame = render(
        r##""camera": {"fov": 40, "position": [0, 0.5, 6]},
            "lights": [{"type": "ambient", "intensity": 1}],
            "objects": [{"type": "model", "src": "media/gem.glb"}]"##,
    );
    assert!(
        frame.rgba.chunks(4).any(|p| p != BACKGROUND),
        "the gem is drawn"
    );
}

#[test]
fn missing_files_are_reported_by_name_when_the_renderer_is_built() {
    let missing = |object: &str| {
        let s = scene(&format!(r#""objects": [{object}]"#));
        match Renderer::new(s) {
            Err(e) => e.to_string(),
            Ok(_) => panic!("a missing file must fail"),
        }
    };
    assert!(missing(r#"{"type": "model", "src": "media/nope.glb"}"#).contains("nope.glb"));
    assert!(
        missing(r#"{"type": "mesh", "geometry": {"kind": "box"}, "material": {"texture": "media/nope.png"}}"#)
            .contains("nope.png")
    );
}

#[test]
fn bad_scenes_fail_when_they_load() {
    let json = r##"{"width": 10, "height": 10, "fps": 30, "durationInFrames": 1,
        "layers": [{"id": "s", "type": "scene3d", "width": 10, "height": 10,
          "objects": [{"type": "text", "text": "x", "font": "Nope"}]}]}"##;
    match Scene::from_json(json, ".".into()) {
        Err(Error::Scene(msg)) => assert!(msg.contains("Nope"), "{msg}"),
        other => panic!("expected a scene error, got {:?}", other.err()),
    }
}

// ---- shadows ----

/// A top-down view (10 x 10 units on the 100 x 100 canvas, +x to the right,
/// -z up) of a ground plane and a 2-unit box standing on it, under a light
/// that travels along (1, -1, 0): the box's shadow lies to its right, from
/// x = 1 to x = 3 on the ground. `light` is added to the light's fields,
/// `boxed` and `ground` to the two objects'.
fn shadow_scene(light: &str, boxed: &str, ground: &str) -> Frame {
    render(&format!(
        r##""camera": {{"type": "orthographic", "height": 10, "position": [0, 10, 0], "up": [0, 0, -1]}},
           "lights": [{{"type": "ambient", "intensity": 0.2}},
                      {{"type": "directional", "direction": [1, -1, 0], "intensity": 1 {light}}}],
           "objects": [
             {{"type": "mesh", "geometry": {{"kind": "plane", "width": 12, "height": 12}},
               "material": {{"color": "#ffffff", "roughness": 1}}, "rotation": [-90, 0, 0] {ground}}},
             {{"type": "mesh", "geometry": {{"kind": "box", "width": 2, "height": 2, "depth": 2}},
               "material": {{"color": "#ffffff", "roughness": 1}}, "position": [0, 1, 0] {boxed}}}]"##
    ))
}

const LIGHT_CASTS: &str = r#", "castShadow": true"#;
const CASTS: &str = r#", "castShadow": true"#;
const RECEIVES: &str = r#", "receiveShadow": true"#;

#[test]
fn a_shadow_falls_where_the_light_is_blocked() {
    let frame = shadow_scene(LIGHT_CASTS, CASTS, RECEIVES);
    let off = shadow_scene("", CASTS, RECEIVES);
    // Ground at x = -3 is in the open; at x = 2 it is behind the box.
    let (open, shaded) = (px(&frame, 20, 50), px(&frame, 70, 50));
    assert_eq!(
        open,
        px(&off, 20, 50),
        "the open ground is as lit as without"
    );
    assert!(open[0] > 150, "{open:?}");
    // Left with the ambient light only: 0.2 of white, sRGB 124.
    assert!((i32::from(shaded[0]) - 124).abs() <= 3, "{shaded:?}");
    assert_eq!(
        px(&off, 70, 50),
        open,
        "without a shadow map the ground is lit"
    );
    // Beyond the shadow's end (x = 3, pixel 80) the ground is lit again.
    assert_eq!(px(&frame, 90, 50), open);
}

#[test]
fn the_filter_softens_a_shadows_edge_by_its_radius() {
    let edge = |settings: &str| -> Vec<i32> {
        let light = format!(r#", "castShadow": true, "shadow": {settings}"#);
        let frame = shadow_scene(&light, CASTS, RECEIVES);
        (72..90).map(|x| i32::from(px(&frame, x, 50)[0])).collect()
    };
    let between = |row: &[i32]| row.iter().filter(|&&v| v > 130 && v < 235).count();
    // A coarse map (1.2 pixels a texel) and a wide filter: a soft edge.
    let soft = edge(r#"{"mapSize": 64, "radius": 3}"#);
    let sharp = edge(r#"{"mapSize": 64, "radius": 0}"#);
    assert!(between(&soft) >= 4, "{soft:?}");
    assert!(between(&sharp) < between(&soft), "{sharp:?} {soft:?}");
}

#[test]
fn shadows_need_a_caster_a_receiver_and_a_light_that_casts() {
    let shaded = |light, boxed, ground| px(&shadow_scene(light, boxed, ground), 70, 50)[0];
    assert!(shaded(LIGHT_CASTS, CASTS, RECEIVES) < 130);
    assert!(shaded(LIGHT_CASTS, "", RECEIVES) > 150, "nothing casts");
    assert!(
        shaded(LIGHT_CASTS, CASTS, "") > 150,
        "the ground does not receive"
    );
    assert!(shaded("", CASTS, RECEIVES) > 150, "the light casts none");
}

#[test]
fn a_caster_does_not_shade_itself() {
    let both = format!("{CASTS}{RECEIVES}");
    let frame = shadow_scene(LIGHT_CASTS, &both, RECEIVES);
    let unshadowed = shadow_scene("", "", "");
    // The box's top face seen from above, in the middle of the picture.
    assert_eq!(px(&frame, 50, 50), px(&unshadowed, 50, 50));
}

#[test]
fn shadow_maps_are_deterministic_and_follow_the_frame() {
    let body = r##""camera": {"type": "orthographic", "height": 10, "position": [0, 10, 0], "up": [0, 0, -1]},
        "lights": [{"type": "directional", "direction": [1, -1, 0], "castShadow": true,
                    "shadow": {"mapSize": 512, "radius": 2}}],
        "objects": [
          {"type": "mesh", "geometry": {"kind": "plane", "width": 12, "height": 12},
           "material": {"roughness": 1}, "rotation": [-90, 0, 0], "receiveShadow": true},
          {"type": "mesh", "geometry": {"kind": "sphere", "radius": 1}, "castShadow": true,
           "position": [[{"frame": 0, "value": -3}, {"frame": 29, "value": 0}], 1, 0]}]"##;
    let a = render_still(scene(body), 5).unwrap().rgba;
    assert_eq!(a, render_still(scene(body), 5).unwrap().rgba);
    assert_ne!(a, render_still(scene(body), 20).unwrap().rgba);
}

#[test]
fn bad_shadow_settings_name_the_problem() {
    let err = |light: &str| {
        let json = format!(
            r##"{{"width": 10, "height": 10, "fps": 30, "durationInFrames": 1,
                "layers": [{{"id": "s", "type": "scene3d", "width": 10, "height": 10,
                  "lights": [{light}]}}]}}"##
        );
        match Scene::from_json(&json, ".".into()) {
            Err(Error::Scene(msg)) => msg,
            other => panic!("expected a scene error, got {:?}", other.err()),
        }
    };
    let cast = r#"{"type": "directional", "castShadow": true"#;
    assert!(err(&format!(r#"{cast}, "shadow": {{"mapSize": 8192}}}}"#)).contains("mapSize"));
    assert!(err(&format!(r#"{cast}, "shadow": {{"bias": -1}}}}"#)).contains("bias"));
    let five = vec![format!("{cast}}}"); 5].join(",");
    assert!(err(&five).contains("5 lights that cast shadows"));
}
