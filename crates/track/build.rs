fn main() {
    #[cfg(feature = "ffmpeg-static")]
    windows_system_libraries();
}

/// The static MSVC ffmpeg the tests link (the addon's, `scripts/build-ffmpeg.sh`) calls Media Foundation, COM GUIDs
/// and BCryptGenRandom; ffmpeg-sys-next does not link those when `FFMPEG_DIR` is set. Same list as crates/node/build.rs.
#[cfg(feature = "ffmpeg-static")]
fn windows_system_libraries() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    for lib in ["mfuuid", "strmiids", "ole32", "oleaut32", "bcrypt", "user32", "ws2_32", "secur32"] {
        println!("cargo:rustc-link-lib={lib}");
    }
}
