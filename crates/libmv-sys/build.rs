//! Builds libmv's tracker, Ceres and our C API (csrc/) into one static library. The C++ sources are vendored in
//! vendor/libmv (see vendor/README.md); Eigen is header-only.
//!
//! The C++ is always optimised and built with the same flags, whatever the Cargo profile, so a debug and a release
//! build of Kinetograph track identically.

use std::path::{Path, PathBuf};

const LIBMV: &[&str] = &[
    "autotrack/autotrack.cc",
    "autotrack/predict_tracks.cc",
    "autotrack/tracks.cc",
    "base/aligned_malloc.cc",
    "image/array_nd.cc",
    "image/convolve.cc",
    "multiview/conditioning.cc",
    "multiview/homography.cc",
    "multiview/projection.cc",
    "numeric/numeric.cc",
    "tracking/track_region.cc",
];

// Ceres files not needed: its C API.
const CERES_SKIP: &[&str] = &["c_api.cc"];

fn cc_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "cc"))
        .filter(|p| !CERES_SKIP.contains(&p.file_name().unwrap().to_str().unwrap()))
        .collect();
    files.sort();
    files
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let vendor = manifest.join("../../vendor/libmv");
    let libmv = vendor.join("libmv");
    let ceres = vendor.join("ceres");
    let ceres_internal = ceres.join("internal/ceres");

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++17")
        .opt_level(2)
        .debug(false)
        .warnings(false)
        .define("NDEBUG", None)
        // Eigen: refuse any non-MPL-2.0 header.
        .define("EIGEN_MPL2_ONLY", None)
        // miniglog: warnings and errors only, no INFO/VLOG chatter from libmv.
        .define("MAX_LOG_LEVEL", Some("-1"))
        .include(manifest.join("csrc"))
        .include(&vendor) // "libmv/..."
        .include(ceres.join("config"))
        .include(ceres.join("include"))
        .include(ceres.join("internal"))
        .include(ceres_internal.join("miniglog"))
        .include(vendor.join("eigen"));
    if build.get_compiler().is_like_msvc() {
        // NOGDI: <windows.h> (Ceres's wall_time.cc) would otherwise define ERROR, which miniglog declares.
        build
            .define("_USE_MATH_DEFINES", None)
            .define("NOMINMAX", None)
            .define("NOGDI", None)
            .define("WIN32_LEAN_AND_MEAN", None)
            .define("_CRT_SECURE_NO_WARNINGS", None)
            .flag("/EHsc")
            .flag("/bigobj")
            .flag("/utf-8");
    }

    build.file(manifest.join("csrc/kt_libmv.cc"));
    for f in LIBMV {
        build.file(libmv.join(f));
    }
    build.files(cc_files(&ceres_internal));
    build.files(cc_files(&ceres_internal.join("generated")));
    build.file(ceres_internal.join("miniglog/glog/logging.cc"));
    build.compile("kt_libmv");

    println!("cargo:rerun-if-changed=csrc");
    println!("cargo:rerun-if-changed=../../vendor/libmv");
}
