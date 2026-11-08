// The Mac's prebuilt ONNX Runtime has CoreML code in it, which asks which macOS it runs on with
// `__isPlatformVersionAtLeast`. That lives in clang's runtime library, which Rust links without, so link it here (the
// directive reaches the addon's link).
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let out = std::process::Command::new("clang")
            .arg("--print-runtime-dir")
            .output()
            .expect("clang is needed on macOS");
        let dir = String::from_utf8(out.stdout).expect("clang prints UTF-8");
        println!("cargo:rustc-link-search=native={}", dir.trim());
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
    #[cfg(feature = "ffmpeg-static")]
    windows_system_libraries();
}

/// The static MSVC ffmpeg the tests link (the addon's, `scripts/build-ffmpeg.sh`) calls Media Foundation, COM GUIDs
/// and BCryptGenRandom; ffmpeg-sys-next does not link those when `FFMPEG_DIR` is set. Same list as crates/node/build.rs
/// and crates/track/build.rs.
#[cfg(feature = "ffmpeg-static")]
fn windows_system_libraries() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    for lib in ["mfuuid", "strmiids", "ole32", "oleaut32", "bcrypt", "user32", "ws2_32", "secur32"] {
        println!("cargo:rustc-link-lib={lib}");
    }
}
