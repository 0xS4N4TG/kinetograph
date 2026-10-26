# Third-party notices

The native addon in this package contains these libraries, linked statically.

## FFmpeg (LGPL 2.1 or later)

Video decoding and encoding use FFmpeg 9.0.1 (<https://ffmpeg.org>), built as LGPL only: configured without
`--enable-gpl`, `--enable-version3` and `--enable-nonfree`, and without libx264 or libx265. The licence text is in
`COPYING.LGPLv2.1`.

- Source: the unmodified `n9.0.1` tag of <https://github.com/FFmpeg/FFmpeg>.
- Build: `scripts/build-ffmpeg.sh` in <https://github.com/0xS4N4TG/kinetograph> holds the exact configure options. The
  addon's Rust source is in the same repository, so you can rebuild the addon against a different build of FFmpeg
  (`npm run build:release -w @kinetographdev/native -- --features ffmpeg-static` with `PKG_CONFIG_PATH` or `FFMPEG_DIR`
  pointing at it) and replace the file in this package, which is the right the LGPL gives you.

## OpenH264 (BSD-2-Clause), macOS and Linux builds

The software H.264 encoder is Cisco's OpenH264 2.6.0, built from source (`OPENH264-LICENSE`). Cisco's patent licence
covers only the binaries Cisco itself distributes; this build is compiled from source, so any patent licence for H.264
encoding is the user's to arrange.

## libvpx (BSD-3-Clause), macOS and Linux builds

VP8 and VP9 encoding and decoding use Google's libvpx 1.15.0, built from source (<https://github.com/webmproject/libvpx>,
tag `v1.15.0`). Its licence and patent grant are in the libvpx `LICENSE` and `PATENTS` files at that tag.

## Others

The addon also links Skia (BSD-3-Clause), wgpu, Vello and the other Rust crates listed in `Cargo.lock` of the repository,
each under its own permissive licence.
