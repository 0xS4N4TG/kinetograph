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
}
