//! Timings of the 3D layer's heavy paths: a skinned, morphing model and scenes
//! with many shadow maps. Ignored by default; run on the M4 with
//!
//! ```text
//! cargo test --release -p kinetograph-core --test scene3d_bench -- --ignored --nocapture --test-threads 1
//! ```
//!
//! Each prints the mean time of a 1920 x 1080 frame (readback included) over
//! frames whose pose or lights change, after a few to warm up.

use std::path::{Path, PathBuf};
use std::time::Instant;

use kinetograph_core::{Renderer, Scene};
use serde_json::json;

const WARM: u32 = 5;
const FRAMES: u32 = 60;

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join("kinetograph-scene3d-bench");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn mean_ms(scene: Scene) -> f64 {
    let mut renderer = Renderer::new(scene).unwrap();
    for f in 0..WARM {
        renderer.render_frame(f).unwrap();
    }
    let start = Instant::now();
    for f in WARM..WARM + FRAMES {
        renderer.render_frame(f).unwrap();
    }
    start.elapsed().as_secs_f64() * 1000.0 / f64::from(FRAMES)
}

fn scene(layer: serde_json::Value, base: &Path) -> Scene {
    let json = json!({
        "width": 1920, "height": 1080, "fps": 30, "durationInFrames": WARM + FRAMES,
        "background": "#203040",
        "layers": [layer],
    });
    Scene::from_json(&json.to_string(), base.to_path_buf()).unwrap()
}

/// A GLB of a tube `rings` x `around` vertices along +y (0 to 4), skinned to a
/// chain of `joints` joints that bend about z over a 2 s clip "bend", with one
/// morph target (the tube swelling) whose weight the clip also drives, and
/// `idle` more targets that move nothing (they share one accessor of zeros).
fn skinned_tube(rings: usize, around: usize, joints: usize, idle: usize) -> Vec<u8> {
    let height = 4.0_f32;
    let radius = 0.3_f32;
    let mut positions = Vec::new();
    let mut normals = Vec::new();
    let mut swell = Vec::new();
    let mut joint_ids = Vec::new();
    let mut weights = Vec::new();
    let span = height / (joints - 1) as f32;
    for r in 0..rings {
        let y = height * r as f32 / (rings - 1) as f32;
        // The two joints around y and the share of each.
        let at = (y / span).min((joints - 1) as f32 - 1e-4);
        let (j, t) = (at.floor() as u16, at.fract());
        for a in 0..around {
            let angle = std::f32::consts::TAU * a as f32 / around as f32;
            let (s, c) = angle.sin_cos();
            positions.extend([radius * c, y, radius * s]);
            normals.extend([c, 0.0, s]);
            swell.extend([0.1 * c, 0.0, 0.1 * s]);
            joint_ids.extend([j, j + 1, 0, 0]);
            weights.extend([1.0 - t, t, 0.0, 0.0]);
        }
    }
    let mut indices: Vec<u32> = Vec::new();
    for r in 0..rings - 1 {
        for a in 0..around {
            let i = |rr: usize, aa: usize| (rr * around + aa % around) as u32;
            indices.extend([i(r, a), i(r + 1, a), i(r, a + 1)]);
            indices.extend([i(r, a + 1), i(r + 1, a), i(r + 1, a + 1)]);
        }
    }
    let mut inverse_bind = Vec::new();
    for k in 0..joints {
        let mut m = [0.0_f32; 16];
        m[0] = 1.0;
        m[5] = 1.0;
        m[10] = 1.0;
        m[15] = 1.0;
        m[13] = -(k as f32) * span;
        inverse_bind.extend(m);
    }
    let times = [0.0_f32, 1.0, 2.0];
    let half = (10.0_f32.to_radians() / 2.0).sin_cos();
    let bend: Vec<f32> = [0.0, half.0, 0.0]
        .iter()
        .flat_map(|&s| [0.0, 0.0, s, (1.0 - s * s).sqrt()])
        .collect();
    let swell_weights: Vec<f32> = [0.0_f32, 1.0, 0.0]
        .iter()
        .flat_map(|&w| std::iter::once(w).chain(std::iter::repeat_n(0.0, idle)))
        .collect();

    let mut blob: Vec<u8> = Vec::new();
    let mut views = Vec::new();
    let mut accessors = Vec::new();
    let mut add = |bytes: Vec<u8>,
                   count: usize,
                   kind: &str,
                   component: u32,
                   bounds: Option<(Vec<f32>, Vec<f32>)>| {
        while !blob.len().is_multiple_of(4) {
            blob.push(0);
        }
        views.push(json!({"buffer": 0, "byteOffset": blob.len(), "byteLength": bytes.len()}));
        blob.extend(bytes);
        let mut accessor = json!({"bufferView": views.len() - 1, "componentType": component, "count": count, "type": kind});
        if let Some((lo, hi)) = bounds {
            accessor["min"] = json!(lo);
            accessor["max"] = json!(hi);
        }
        accessors.push(accessor);
        accessors.len() - 1
    };
    let f32s = |v: &[f32]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
    let count = rings * around;
    let pos = add(
        f32s(&positions),
        count,
        "VEC3",
        5126,
        Some((vec![-radius, 0.0, -radius], vec![radius, height, radius])),
    );
    let nrm = add(f32s(&normals), count, "VEC3", 5126, None);
    let swl = add(f32s(&swell), count, "VEC3", 5126, None);
    let still = add(vec![0; count * 12], count, "VEC3", 5126, None);
    let jnt = add(
        joint_ids.iter().flat_map(|x| x.to_le_bytes()).collect(),
        count,
        "VEC4",
        5123,
        None,
    );
    let wgt = add(f32s(&weights), count, "VEC4", 5126, None);
    let idx = add(
        indices.iter().flat_map(|x| x.to_le_bytes()).collect(),
        indices.len(),
        "SCALAR",
        5125,
        None,
    );
    let ibm = add(f32s(&inverse_bind), joints, "MAT4", 5126, None);
    let tms = add(
        f32s(&times),
        3,
        "SCALAR",
        5126,
        Some((vec![0.0], vec![2.0])),
    );
    let rot = add(f32s(&bend), 3, "VEC4", 5126, None);
    let mw = add(
        f32s(&swell_weights),
        swell_weights.len(),
        "SCALAR",
        5126,
        None,
    );
    let targets: Vec<_> = std::iter::once(json!({"POSITION": swl}))
        .chain(std::iter::repeat_n(json!({"POSITION": still}), idle))
        .collect();

    // Node 0 is the mesh; nodes 1.. the joints, each the child of the one before.
    let mut nodes = vec![json!({"mesh": 0, "skin": 0})];
    for k in 0..joints {
        let mut node = json!({"translation": [0.0, if k == 0 { 0.0 } else { span }, 0.0]});
        if k + 1 < joints {
            node["children"] = json!([k + 2]);
        }
        nodes.push(node);
    }
    let channels: Vec<_> = (1..joints)
        .map(|k| json!({"sampler": 0, "target": {"node": k + 1, "path": "rotation"}}))
        .chain([json!({"sampler": 1, "target": {"node": 0, "path": "weights"}})])
        .collect();
    let document = json!({
        "asset": {"version": "2.0", "generator": "kinetograph scene3d_bench"},
        "scene": 0,
        "scenes": [{"nodes": [0, 1]}],
        "nodes": nodes,
        "meshes": [{"weights": vec![0.0; 1 + idle], "primitives": [{
            "attributes": {"POSITION": pos, "NORMAL": nrm, "JOINTS_0": jnt, "WEIGHTS_0": wgt},
            "targets": targets,
            "indices": idx,
            "material": 0
        }]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [0.8, 0.5, 0.3, 1.0], "roughnessFactor": 0.5}}],
        "skins": [{"joints": (1..=joints).collect::<Vec<_>>(), "inverseBindMatrices": ibm}],
        "animations": [{"name": "bend",
            "samplers": [{"input": tms, "output": rot}, {"input": tms, "output": mw}],
            "channels": channels}],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": blob.len()}],
    });
    while !blob.len().is_multiple_of(4) {
        blob.push(0);
    }
    let mut text = document.to_string().into_bytes();
    while !text.len().is_multiple_of(4) {
        text.push(b' ');
    }
    let total = 12 + 8 + text.len() + 8 + blob.len();
    let mut glb = Vec::with_capacity(total);
    glb.extend(b"glTF");
    glb.extend(2_u32.to_le_bytes());
    glb.extend((total as u32).to_le_bytes());
    glb.extend((text.len() as u32).to_le_bytes());
    glb.extend(b"JSON");
    glb.extend(text);
    glb.extend((blob.len() as u32).to_le_bytes());
    glb.extend(b"BIN\0");
    glb.extend(blob);
    glb
}

#[test]
#[ignore]
fn bench_skinned_model() {
    let dir = scratch();
    // 400 rings of 512: 204,800 vertices and 408,576 triangles a model.
    std::fs::write(dir.join("tube.glb"), skinned_tube(400, 512, 8, 0)).unwrap();
    for copies in [1, 4] {
        let objects: Vec<_> = (0..copies)
            .map(|i| {
                json!({"type": "model", "src": "tube.glb", "animation": "bend",
                       "position": [(i as f64 - (copies as f64 - 1.0) / 2.0) * 1.5, -2.0, 0.0]})
            })
            .collect();
        let layer = json!({"id": "s", "type": "scene3d", "width": 1920, "height": 1080,
            "camera": {"position": [0, 0, 8]},
            "lights": [{"type": "ambient", "intensity": 0.3}, {"type": "directional", "direction": [-1, -1, -1]}],
            "objects": objects});
        let ms = mean_ms(scene(layer, &dir));
        println!(
            "skinned tube x{copies} (204,800 vertices each, 8 joints, 1 morph target): {ms:.2} ms/frame"
        );
    }
}

/// A ground, a ring of 24 boxes that turn with the frame, and `lights`.
fn shadow_layer(lights: Vec<serde_json::Value>) -> serde_json::Value {
    let mut objects = vec![
        json!({"type": "mesh", "geometry": {"kind": "plane", "width": 30, "height": 30},
        "rotation": [-90, 0, 0], "receiveShadow": true}),
    ];
    for i in 0..24 {
        let a = std::f64::consts::TAU * f64::from(i) / 24.0;
        objects.push(json!({"type": "mesh", "geometry": {"kind": "box"},
            "position": [6.0 * a.cos(), 0.5, 6.0 * a.sin()],
            "rotation": [0, [{"frame": 0, "value": 0}, {"frame": 65, "value": 360}], 0],
            "castShadow": true, "receiveShadow": true}));
    }
    json!({"id": "s", "type": "scene3d", "width": 1920, "height": 1080,
        "camera": {"position": [0, 12, 16]},
        "lights": lights, "objects": objects})
}

#[test]
#[ignore]
fn bench_shadow_maps() {
    let dir = scratch();
    let directional = |x: f64, size: u32| {
        json!({"type": "directional", "direction": [x, -2, -1], "intensity": 0.5, "castShadow": true,
               "shadow": {"mapSize": size}})
    };
    let point = |x: f64, size: u32| {
        json!({"type": "point", "position": [x, 4, 0], "intensity": 4, "castShadow": true,
               "shadow": {"mapSize": size}})
    };
    let cases: Vec<(&str, Vec<serde_json::Value>)> = vec![
        (
            "4 directional, 2048",
            (0..4)
                .map(|i| directional(f64::from(i) - 1.5, 2048))
                .collect(),
        ),
        (
            "1 point + 2 directional (8 maps), 2048",
            vec![
                point(0.0, 2048),
                directional(-1.0, 2048),
                directional(1.0, 2048),
            ],
        ),
        (
            "8 directional, 2048",
            (0..8)
                .map(|i| directional(f64::from(i) - 3.5, 2048))
                .collect(),
        ),
        (
            "8 point (48 maps), 1024",
            (0..8)
                .map(|i| point(f64::from(i) * 2.0 - 7.0, 1024))
                .collect(),
        ),
    ];
    for (name, lights) in cases {
        let layer = shadow_layer(lights);
        match Scene::from_json(
            &json!({"width": 1920, "height": 1080, "fps": 30, "durationInFrames": WARM + FRAMES,
                    "background": "#203040", "layers": [layer]})
            .to_string(),
            dir.clone(),
        ) {
            Ok(scene) => println!("shadows, {name}: {:.2} ms/frame", mean_ms(scene)),
            Err(e) => println!("shadows, {name}: not drawn ({e})"),
        }
    }
}

/// Not a benchmark: a rig whose morph targets are more than the device lets
/// one storage binding hold (128 MiB by default) is deformed on the CPU, and
/// draws as the same pose with the GPU deforming it.
#[test]
fn a_morph_rig_over_the_storage_binding_limit_is_drawn_as_on_the_gpu() {
    let dir = scratch();
    // 200 x 300 = 60,000 vertices; 1 + 99 targets of 24 bytes a vertex is 144 MB.
    std::fs::write(dir.join("rig.glb"), skinned_tube(200, 300, 4, 99)).unwrap();
    std::fs::write(dir.join("small.glb"), skinned_tube(200, 300, 4, 0)).unwrap();
    let frame = |src: &str| {
        let layer = json!({"id": "s", "type": "scene3d", "width": 320, "height": 180,
            "camera": {"position": [0, 0, 8]},
            "lights": [{"type": "ambient", "intensity": 0.3}, {"type": "directional", "direction": [-1, -1, -1]}],
            "objects": [{"type": "model", "src": src, "animation": "bend", "position": [0, -2, 0], "castShadow": true}]});
        let json = json!({"width": 320, "height": 180, "fps": 30, "durationInFrames": 60, "layers": [layer]});
        let scene = Scene::from_json(&json.to_string(), dir.clone()).unwrap();
        // 0.5 s into the clip: bent, and swollen by half.
        kinetograph_core::render_still(scene, 15).unwrap()
    };
    let (big, small) = (frame("rig.glb"), frame("small.glb"));
    assert!(big.rgba.chunks(4).any(|p| p[3] > 0), "the rig is drawn");
    let off = big
        .rgba
        .iter()
        .zip(&small.rgba)
        .filter(|(a, b)| a.abs_diff(**b) > 2)
        .count();
    assert!(off < 20, "{off} channels differ");
}
