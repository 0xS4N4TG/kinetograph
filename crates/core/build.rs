//! Compiles `src/render/skia/vk_shim.cpp` for the Skia backend on Linux and Windows (Vulkan). Nothing else here: on
//! macOS, or without the `skia` feature, this script does nothing.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/render/skia/vk_shim.cpp");
    println!("cargo:rerun-if-env-changed=KINETOGRAPH_SKIA_SOURCE");
    #[cfg(feature = "skia")]
    shim();
}

/// The `skia` directory of the skia-bindings crate this build links: its headers are the ones the shim needs, and
/// they are the ones the libskia it links was built from. `KINETOGRAPH_SKIA_SOURCE` overrides (a `SKIA_SOURCE_DIR`
/// build of skia-bindings, say).
#[cfg(feature = "skia")]
fn skia_source() -> std::path::PathBuf {
    use std::path::PathBuf;
    if let Ok(dir) = std::env::var("KINETOGRAPH_SKIA_SOURCE") {
        return PathBuf::from(dir);
    }
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let out = std::process::Command::new(cargo)
        // `--all-features`: skia-bindings is an optional dependency that the default features leave out of the listing.
        // `--filter-platform`: only the packages this target builds, which are the ones cargo has downloaded (a plain
        // `--offline` listing fails on a fresh CI checkout, where the other platforms' crates are not fetched).
        .args(["metadata", "--all-features", "--format-version", "1", "--filter-platform"])
        .arg(std::env::var("TARGET").expect("TARGET"))
        .arg("--manifest-path")
        .arg(format!("{manifest}/Cargo.toml"))
        .output()
        .expect("cargo metadata");
    if !out.status.success() {
        panic!("cargo metadata failed: {}", String::from_utf8_lossy(&out.stderr));
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).expect("cargo metadata output");
    let package = json["packages"]
        .as_array()
        .and_then(|all| all.iter().find(|p| p["name"] == "skia-bindings"))
        .expect("the skia-bindings package");
    let manifest_path = PathBuf::from(package["manifest_path"].as_str().expect("manifest_path"));
    let bundled = manifest_path.parent().expect("crate directory").join("skia");
    if bundled.join("include/gpu/graphite/BackendTexture.h").exists() {
        return bundled;
    }
    fetch_skia_headers()
}

/// The crates.io package of skia-bindings has no Skia source (it is a git submodule of rust-skia; a machine that has
/// built Skia from source has it, a machine that downloads the prebuilt libskia does not). The headers are all the
/// shim needs: fetch `include/` of the commit rust-skia's tag for skia-bindings 0.153.3 points at (`skia-bindings/skia`
/// at tag 0.153.3). Bump it with the skia-safe version.
#[cfg(feature = "skia")]
fn fetch_skia_headers() -> std::path::PathBuf {
    use std::process::Command;
    const REV: &str = "61e7ca4e99062cdd0ab69445d5963fb3365778f6";
    let dir = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("skia-headers");
    if dir.join("include/gpu/graphite/BackendTexture.h").exists() {
        return dir;
    }
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create the Skia headers directory");
    let git = |args: &[&str]| {
        let out = Command::new("git").args(args).current_dir(&dir).output().expect("run git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "--quiet"]);
    git(&["remote", "add", "origin", "https://github.com/rust-skia/skia"]);
    git(&["sparse-checkout", "set", "--no-cone", "/include/"]);
    git(&["fetch", "--quiet", "--depth=1", "origin", REV]);
    git(&["-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD"]);
    dir
}

#[cfg(feature = "skia")]
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
