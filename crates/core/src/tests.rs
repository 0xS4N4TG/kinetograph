//! CPU-only checks that need no GPU: every built-in shader is valid WGSL,
//! and every committed scene file loads, with its fonts, images, animations,
//! videos, GIFs and LUTs.

use std::path::{Path, PathBuf};

use crate::Scene;
use crate::text::TextEngine;

fn files_with_extension(dir: &str, extension: &str) -> Vec<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join(dir);
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|e| e == extension))
        .collect();
    files.sort();
    files
}

#[test]
fn builtin_shaders_are_valid_wgsl() {
    let shaders = files_with_extension("src/shaders", "wgsl");
    assert!(!shaders.is_empty(), "no shaders found");
    // The helpers the compositor puts in front of the shaders that call them
    // (`compositor::shader_source`). hash.wgsl, turbulence.wgsl,
    // blend_math.wgsl and f16.wgsl stand alone; place.wgsl reads the `tex_a` of the shader it is put in front
    // of, so it is checked with a declaration of its own.
    for path in shaders {
        let source = std::fs::read_to_string(&path).unwrap();
        let source = if [
            "hash.wgsl",
            "turbulence.wgsl",
            "blend_math.wgsl",
            "f16.wgsl",
        ]
        .iter()
        .any(|name| path.ends_with(name))
        {
            source
        } else if path.ends_with("place.wgsl") {
            format!("@group(0) @binding(0) var tex_a: texture_2d<f32>;\n{source}")
        } else {
            crate::compositor::shader_source(&source)
        };
        let module = naga::front::wgsl::parse_str(&source)
            .unwrap_or_else(|e| panic!("{}: {}", path.display(), e.emit_to_string(&source)));
        // `store_f16` (shadow.wgsl) packs floats to halves, which wgpu allows
        // on Metal.
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::default()
                | naga::valid::Capabilities::SHADER_FLOAT16_IN_FLOAT32,
        )
        .validate(&module)
        .unwrap_or_else(|e| panic!("{}: {}", path.display(), e.emit_to_string(&source)));
    }
}

/// The `(group, binding)` pairs a built-in shader declares, as the compositor
/// compiles it.
fn declared_bindings(file: &str) -> Vec<(u32, u32)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/shaders")
        .join(file);
    let source = crate::compositor::shader_source(&std::fs::read_to_string(&path).unwrap());
    let module = naga::front::wgsl::parse_str(&source).unwrap();
    let mut pairs: Vec<_> = module
        .global_variables
        .iter()
        .filter_map(|(_, v)| v.binding.map(|b| (b.group, b.binding)))
        .collect();
    pairs.sort();
    pairs
}

#[test]
fn builtin_shaders_declare_the_bindings_of_their_bind_group_layouts() {
    // The compositor's shared layout (the two inputs, the pass's uniforms and
    // the placement), the lut's (the same, with a 3D table for the second
    // input), the filtered layout (the layer, a sampler, uniforms), the
    // blur's, the mesh's, and the turbulence tables at group 1.
    let shared = vec![(0, 0), (0, 1), (0, 2), (0, 3)];
    let with_tables = vec![(0, 0), (0, 1), (0, 2), (0, 3), (1, 0)];
    for file in [
        "composite.wgsl",
        "shadow.wgsl",
        "shadow_box.wgsl",
        "color.wgsl",
        "glow.wgsl",
        "aberration.wgsl",
        "gradient_map.wgsl",
        "grain.wgsl",
        "dither.wgsl",
        "dot_matrix.wgsl",
        "lut.wgsl",
        "page.wgsl",
    ] {
        assert_eq!(declared_bindings(file), shared, "{file}");
    }
    assert_eq!(declared_bindings("noise.wgsl"), with_tables);
    let filtered = vec![(0, 0), (0, 1), (0, 2)];
    for file in ["halftone.wgsl", "warp.wgsl", "blur.wgsl"] {
        assert_eq!(declared_bindings(file), filtered, "{file}");
    }
    assert_eq!(
        declared_bindings("displace.wgsl"),
        vec![(0, 0), (0, 1), (0, 2), (1, 0)]
    );
    assert_eq!(declared_bindings("mesh.wgsl"), vec![(0, 0)]);
    // The 3D layer's: the frame with its four shadow maps and their sampler,
    // the environment's two cube maps and their sampler, the draw (a dynamic
    // offset), the texture and its sampler; its shadow pass's: the light's
    // matrix and the draw; and the environment bake's: the pass's parameters
    // and sampler, the picture, the sky.
    assert_eq!(
        declared_bindings("scene3d.wgsl"),
        vec![
            (0, 0),
            (0, 1),
            (0, 2),
            (0, 3),
            (0, 4),
            (0, 5),
            (0, 6),
            (0, 7),
            (0, 8),
            (0, 9),
            (0, 10),
            (0, 11),
            (0, 12),
            (1, 0),
            (2, 0),
            (2, 1),
            (2, 2),
            (2, 3)
        ]
    );
    assert_eq!(
        declared_bindings("scene3d_shadow.wgsl"),
        vec![(0, 0), (1, 0)]
    );
    assert_eq!(
        declared_bindings("environment.wgsl"),
        vec![(0, 0), (0, 1), (1, 0), (2, 0)]
    );
}

#[test]
fn committed_scenes_load() {
    let mut scenes = files_with_extension("tests/scenes", "json");
    scenes.extend(files_with_extension("../../examples", "json"));
    assert!(!scenes.is_empty(), "no scenes found");
    for path in scenes {
        let scene = Scene::load(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        // What `Renderer::new` reads before it touches the GPU.
        TextEngine::new(&scene.fonts, &scene.base_dir)
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        crate::render::load_images(&scene).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        crate::lottie::load_lotties(&scene).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        crate::video::load_videos(&scene).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        crate::gif::load_gifs(&scene).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        crate::lut::load_luts(&scene).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let sources = crate::render::scene3d_sources(&scene);
        for src in sources.models {
            crate::scene3d::model::Model::open(&scene.base_dir, &src)
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        }
        for src in sources.textures {
            crate::scene3d::draw::Texture::open(&scene.base_dir, &src)
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        }
        for src in sources.environments {
            crate::scene3d::environment::Environment::open(&scene.base_dir, &src)
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        }
    }
}
