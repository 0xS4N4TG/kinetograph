//! Compiles `src/render/skia/vk_shim.cpp` for the Skia backend on Linux and Windows (Vulkan). Nothing else here: on
//! macOS this script does nothing.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/render/skia/vk_shim.cpp");
    println!("cargo:rerun-if-env-changed=KINETOGRAPH_SKIA_SOURCE");
    shim();
}

/// The `skia` directory of the skia-bindings crate this build links: its headers are the ones the shim needs, and
/// they are the ones the libskia it links was built from. `KINETOGRAPH_SKIA_SOURCE` overrides (a `SKIA_SOURCE_DIR`
/// build of skia-bindings, say).
fn skia_source() -> std::path::PathBuf {
    use std::path::PathBuf;
    if let Ok(dir) = std::env::var("KINETOGRAPH_SKIA_SOURCE") {
        return PathBuf::from(dir);
    }
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let out = std::process::Command::new(cargo)
        .args(["metadata", "--offline", "--format-version", "1", "--manifest-path"])
        .arg(format!("{manifest}/Cargo.toml"))
        .output()
        .expect("cargo metadata");
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).expect("cargo metadata output");
    let package = json["packages"]
        .as_array()
        .and_then(|all| all.iter().find(|p| p["name"] == "skia-bindings"))
        .expect("the skia-bindings package");
    let manifest_path = PathBuf::from(package["manifest_path"].as_str().expect("manifest_path"));
    manifest_path.parent().expect("crate directory").join("skia")
}

fn shim() {
    if std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "macos") {
        return;
    }
    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++17")
        .file("src/render/skia/vk_shim.cpp")
        .include(skia_source())
        .define("SK_VULKAN", None)
        .define("SK_GRAPHITE", None)
        .define("SK_RELEASE", None)
        // The Vulkan headers that ship in Skia's tree, not the system's.
        .define("SK_USE_INTERNAL_VULKAN_HEADERS", None)
        .warnings(false);
    if let Err(e) = build.try_compile("kinetograph_vk_shim") {
        // `cargo check` for another OS from a machine with no compiler for it needs no object, only the Rust that
        // calls it; a build that links does.
        if std::env::var("HOST") != std::env::var("TARGET") {
            println!("cargo:warning=the Vulkan shim was not compiled for this target ({e}); it is needed to link");
        } else {
            panic!("compiling vk_shim.cpp: {e}");
        }
    }
}
