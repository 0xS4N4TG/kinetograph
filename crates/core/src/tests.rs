//! CPU-only checks that need no GPU: every built-in shader is valid WGSL,
//! and every committed scene file loads, with its fonts and images.

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
    for path in shaders {
        let source = std::fs::read_to_string(&path).unwrap();
        let module = naga::front::wgsl::parse_str(&source)
            .unwrap_or_else(|e| panic!("{}: {}", path.display(), e.emit_to_string(&source)));
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::default(),
        )
        .validate(&module)
        .unwrap_or_else(|e| panic!("{}: {}", path.display(), e.emit_to_string(&source)));
    }
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
    }
}
