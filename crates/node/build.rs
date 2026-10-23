fn main() {
    napi_build::setup();
    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");
    #[cfg(feature = "ffmpeg-static")]
    windows_system_libraries();
}

/// A static ffmpeg built with MSVC (`scripts/build-ffmpeg.sh`) needs the Windows libraries it was built against
/// (Media Foundation, COM, bcrypt ...). ffmpeg-sys-next links only ffmpeg's own archives when `FFMPEG_DIR` is set,
/// so the ones named in `Libs.private` of the installed `.pc` files are linked here.
#[cfg(feature = "ffmpeg-static")]
fn windows_system_libraries() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    // What the encoders and the random-seed code in the static archives call: Media Foundation (`mfenc.o`), COM GUIDs
    // (`IID_ICodecAPI` is in strmiids), BCryptGenRandom. The `.pc` files below do not always name them for MSVC.
    for lib in ["mfuuid", "strmiids", "ole32", "oleaut32", "bcrypt", "user32", "ws2_32", "secur32"] {
        println!("cargo:rustc-link-lib={lib}");
    }
    let Ok(dir) = std::env::var("FFMPEG_DIR") else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(std::path::Path::new(&dir).join("lib/pkgconfig")) else {
        return;
    };
    let mut libs = std::collections::BTreeSet::new();
    for entry in entries.flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        for line in text.lines() {
            let Some(private) = line.strip_prefix("Libs.private:") else {
                continue;
            };
            for token in private.split_whitespace() {
                let name = token.strip_prefix("-l").unwrap_or(token);
                let name = name.strip_suffix(".lib").unwrap_or(name);
                let ffmpeg_own = ["avutil", "avcodec", "avformat", "avfilter", "avdevice", "swscale", "swresample"];
                if !name.starts_with('-') && !name.is_empty() && !ffmpeg_own.contains(&name) {
                    libs.insert(name.to_string());
                }
            }
        }
    }
    for lib in libs {
        println!("cargo:rustc-link-lib={lib}");
    }
}
