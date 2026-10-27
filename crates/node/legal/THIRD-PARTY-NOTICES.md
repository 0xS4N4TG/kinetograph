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

## HyperFrames colour grading (Apache License 2.0)

The colour grade and its 18 look effects (the shaders `color_grade.wgsl` and `grade_prepass.wgsl` and `grade.rs`,
compiled into the addon) port the shader maths and the effect passes of HyperFrames' colour grading runtime
(`packages/core/src/runtime/colorGrading.ts`). Copyright HeyGen, Inc. and the HyperFrames contributors,
https://github.com/heygen-com/hyperframes, licensed under the Apache License, Version 2.0, whose text follows the
Abseil section of `CERES-LICENSE` and is at http://www.apache.org/licenses/LICENSE-2.0. Changed from the original:
rewritten in WGSL and Rust for the engine's GPU passes, reading the layer's texture instead of a media element.

## OpenH264 (BSD-2-Clause), macOS and Linux builds

The software H.264 encoder is Cisco's OpenH264 2.6.0, built from source (`OPENH264-LICENSE`). Cisco's patent licence
covers only the binaries Cisco itself distributes; this build is compiled from source, so any patent licence for H.264
encoding is the user's to arrange.

## Noto Sans Symbols 2, Noto Sans Math and Noto Emoji (SIL Open Font License 1.1)

Text falls back to these fonts for a character its own font lacks (an arrow, a check mark, a maths sign, an emoji). They
are embedded in the addon as WOFF2 files, converted from the TrueType originals without other changes. The copyright
notices and the licence are in `OFL-NOTO.txt`:

- Noto Sans Symbols 2: Copyright 2022 The Noto Project Authors (<https://github.com/notofonts/symbols>)
- Noto Sans Math: Copyright 2022 Google LLC. All Rights Reserved.
- Noto Emoji: Copyright 2013-2026 Google LLC

## JetBrains Mono (SIL Open Font License 1.1)

`monospace` and `ui-monospace` text is set in JetBrains Mono Regular when the project loads no fixed-pitch font, so code
blocks line up. It is embedded in the addon as a WOFF2 file, converted from the TrueType original without other changes.
Copyright 2020 The JetBrains Mono Project Authors (<https://github.com/JetBrains/JetBrainsMono>). The licence is in
`OFL-NOTO.txt`, with the Noto fonts'.

## libvpx (BSD-3-Clause), macOS and Linux builds

VP8 and VP9 encoding and decoding use Google's libvpx 1.15.0, built from source (<https://github.com/webmproject/libvpx>,
tag `v1.15.0`). Its licence and patent grant are in the libvpx `LICENSE` and `PATENTS` files at that tag.

## libmv, Ceres Solver, Eigen and miniglog (motion tracking)

`kinetograph track` uses Blender's motion tracker, as Blender 4.5 LTS (tag `v4.5.9`) ships it, built from source
without changes (`vendor/libmv` in the repository):

- libmv (MIT): Copyright (c) 2007-2011 libmv authors. The licence is in `LIBMV-LICENSE`. Blender's GPL C API around
  libmv is not included; the addon has its own.
- Ceres Solver 2.2.0 (BSD-3-Clause): Copyright 2023 Google Inc. The licence is in `CERES-LICENSE`. Its
  `fixed_array.h` and `memory.h` come from Abseil under the Apache License 2.0, whose text follows in the same file.
- miniglog, Ceres's small logging library (BSD-3-Clause): Copyright 2015 Google Inc., under the same terms as Ceres
  (`CERES-LICENSE`).
- Eigen 3.4.0 (MPL-2.0), header-only, built with `EIGEN_MPL2_ONLY`. The licence is in `EIGEN-COPYING.MPL2`; Eigen's
  source is at <https://gitlab.com/libeigen/eigen> (tag `3.4.0`) and in `vendor/libmv/eigen` of the repository. A few
  of its headers also carry a BSD notice (`EIGEN-COPYING.BSD`).

## The separate GPL ffmpeg program (`bin/ffmpeg`)

Not part of the addon and not linked into it: `bin/ffmpeg` is a stand-alone FFmpeg 9.0.1 executable built with
`--enable-gpl` and libx264 (GPL-2.0+), libx265 (GPL-2.0+) and libvpx (BSD-3-Clause). The addon runs it as a child
process for H.264 and H.265 encoding. Its licence, sources and build script are described in `FFMPEG-LICENSE.md`; the
GPL text is `COPYING.GPLv2`.

## Others

The addon also links Skia (BSD-3-Clause), wgpu, Vello and the other Rust crates listed in `Cargo.lock` of the repository,
each under its own permissive licence.
