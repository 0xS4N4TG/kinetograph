# Proposal: VAAPI and Quick Sync in the linked ffmpeg

Status: not done. Intel and AMD hardware encoding works today through the external ffmpeg (`KINETOGRAPH_FFMPEG`,
`crates/cli/src/external.rs`). This page says what it would take to have them in the ffmpeg linked into the addon,
and why it was not done.

## How the linked ffmpeg is built

- `scripts/build-ffmpeg.sh` builds ffmpeg `n9.0.1` as static libraries (`--enable-static --disable-shared
  --enable-pic --disable-autodetect --disable-programs`), LGPL only (the script ends by checking `config.h`).
  `--disable-autodetect` means nothing is enabled unless the script names it. On Linux it enables `--enable-ffnvcodec
  --enable-nvenc` (header-only: NVENC loads the driver's library with `dlopen`, so nothing is linked), `libopenh264`
  and `libvpx` (built static from source), and `zlib`.
- The addon links it with the `ffmpeg-static` cargo feature (`crates/node/Cargo.toml`: `ffmpeg/static`) from
  `PKG_CONFIG_PATH=$PREFIX/lib/pkgconfig`. `.github/workflows/native.yml` builds it on `ubuntu-22.04` for
  `linux-x64-gnu`.
- The GPL `bin/ffmpeg` (`scripts/build-ffmpeg-gpl.sh`) is built with `--disable-everything` and enables only a handful
  of filters (no `hwupload`), so it cannot drive VAAPI either.

## Could VAAPI and QSV be enabled in it?

Technically yes: add `--enable-vaapi` (and `--enable-libvpl` for Quick Sync, which on Linux needs VAAPI as well) plus
`libva`, `libva-drm` and `libvpl` development packages. The licences are fine: libva is MIT, libvpl (oneVPL) is MIT,
libdrm is MIT; the ffmpeg build stays LGPL.

The problem is linking. ffmpeg's VAAPI code calls libva directly (`vaInitialize`, `vaCreateConfig`, ...), so a normal
build puts `libva.so.2` and `libva-drm.so.2` in the addon's `DT_NEEDED` list. The addon would then fail to load on every
machine without libva, which includes minimal containers and headless servers, and the failure would hit every
render, not just hardware ones. libvpl's dispatcher can be built static and loads the real runtime with `dlopen`, so
it is not the problem; libva is. NVENC avoids this because its headers define function-pointer tables loaded at run time.
Statically linking libva instead is not safe either: the driver modules (`iHD_drv_video.so`) load the system
`libva.so.2` themselves, so a process would hold two copies of libva.

## Proposal (needs a CI change, so not done here)

1. Build a small stub library (as Chromium does for libva): the `va*` functions ffmpeg uses, each a trampoline that
   resolves the real symbol with `dlsym` from a `dlopen("libva.so.2")` on first use, and returns `VA_STATUS_ERROR_UNIMPLEMENTED` when
   the library is missing. Link ffmpeg against the stub (a `libva.pc` and `libva-drm.pc` pointing at it) so that
   `--enable-vaapi` configures. Same for `libva-drm`. Quick Sync then needs only a static libvpl dispatcher.
2. Add to `scripts/build-ffmpeg.sh` for Linux: build the stubs, `--enable-vaapi --enable-libvpl --enable-libdrm`
   (libdrm can use the same trick), add `h264_vaapi`, `hevc_vaapi`, `h264_qsv`, `hevc_qsv` to the post-build checks.
3. Teach `encode.rs` to give the linked encoders a hardware device (`av_hwdevice_ctx_create` with the render node) and a
   `hw_frames_ctx`, and upload planes with `av_hwframe_transfer_data`; or keep driving them through the external
   program and ship the linked ones only as a listing. The linked path needs real GPU tests, which only a Linux
   runner with a GPU can run (the CI runners have none).
4. Add a check to the addon smoke job (`scripts/smoke/clean-install.mjs`) that loads the addon in a container with no libva
   installed: `ldd kinetograph.linux-x64-gnu.node` must not list `libva`.

Cost: a stub generator to maintain against libva's API, a CI change, and hardware to test on. Benefit over today's
external route: no `KINETOGRAPH_FFMPEG` to set. The external route already covers the use, so this is deferred until
someone needs it without a system ffmpeg.
