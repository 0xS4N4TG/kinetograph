# Kinetograph

Kinetograph is a placeholder name.

A programmatic video engine: agents write TypeScript, a Rust core renders it on the GPU, no browser anywhere. It keeps
Remotion's API for visuals and the Web Audio API for sound, and puts a GPU compositor underneath them.

**Status:** Phase 1 is done: a Rust workspace with a GPU compositor (shape, text, image and group layers; all 16 W3C
blend modes; blur), PNG output, and a CLI with `still` and `bench`. Phase 2b adds `render` (video). Scenes are JSON
for now; the TypeScript runtime comes in later phases (see the [roadmap](docs/HANDOFF.md)).

- [Technical handoff](docs/HANDOFF.md)
- [Research notes](docs/RESEARCH.md)
- [Scene format](docs/SCENE.md)

## Build and run

Use the rustup toolchain (stable, edition 2024). It needs a GPU that wgpu supports (Metal on macOS); no window or
display is required. The CLI links FFmpeg for `render`, so building it needs the FFmpeg development libraries (see
[Rendering video](#rendering-video)).

```sh
# If Homebrew's rustc is first on PATH and fails to start, put rustup's first:
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"

cargo build --release

# Render frame 30 of the example scene to a PNG (add --json for machine-readable output)
./target/release/kinetograph still examples/papercut-card.json 30 -o out/card.png

# Render the whole scene (or a range) to an H.264 video; see "Rendering video" below
./target/release/kinetograph render examples/papercut-card.json -o out/card.mp4 --range 0..60

# Time one frame: two warm-up renders, then K runs; per-stage mean/min/max in ms
./target/release/kinetograph bench examples/papercut-card.json --frame 30 --runs 10
```

### Rendering video

`kinetograph render <scene> -o out.mp4 [--range a..b | a..=b] [--encoder NAME] [--json]` renders frames of a scene and
encodes them to H.264 with FFmpeg (the `ffmpeg-next` crate, linked against the FFmpeg development libraries: install
FFmpeg with `libx264` and `pkg-config`, and `libclang` for the bindings; `brew install ffmpeg` on macOS, `libavcodec-dev
libavformat-dev libswscale-dev libavutil-dev libclang-dev` on Debian and Ubuntu).

- **Range.** `10..40` is frames 10 to 39 and `10..=40` is 10 to 40, as in Rust; either start or the end of `..` may be
  left out. The default is the whole scene. A range that is empty or runs past `durationInFrames` is an error.
- **Encoder.** `--encoder` names any ffmpeg H.264 encoder. Without it, `h264_videotoolbox` is used on macOS when ffmpeg
  has it, and `libx264` everywhere else. `libx264` runs at `crf 18`, `preset medium`; the other encoders get a bit rate
  of 0.2 bits per pixel per frame (about 12.4 Mbit/s for 1080p30).
- **Container.** From the output's extension, `.mp4` or `.mov`; both are written with `+faststart` (the index first, so
  they play while downloading).
- **Format.** RGBA is converted to `yuv420p` by swscale with BT.709 coefficients, limited range, and the stream is tagged
  BT.709. The width and height must both be even (a clear error otherwise). **Alpha is dropped**, not composited: give
  the scene an opaque `background`, since where it is clear the video shows the renderer's straight colours (black for
  empty pixels).
- **Frame rate.** `fps` becomes an exact fraction: whole rates are `n/1`, and 23.976, 29.97 and 59.94 are
  `24000/1001`, `30000/1001` and `60000/1001`. Frame `first` of the range is time 0 in the file.
- **Speed.** One renderer (one GPU setup) renders the whole range, and finished frames go through a channel that holds
  two to an encoder thread, so the GPU work for frame N+1 overlaps the encoding of frame N. No sound yet: the file has a
  video stream only.
- **Output.** Text mode prints a progress line to stderr and a one-line summary. `--json` prints
  `{output, encoder, width, height, fps, frames, first, last, ms, ms_per_frame}` (`last` inclusive; `ms` covers
  rendering and encoding the range, not GPU setup). On failure the partial file is deleted.

Checks: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`. The golden-image tests compare
against PNGs in `crates/core/tests/golden/` made on an Apple M4; regenerate them with
`UPDATE_GOLDEN=1 cargo test --test golden` after checking the difference by eye. The example images are regenerated with
`cargo run -p kinetograph-core --example gen_test_image` and `--example gen_papercut_assets`.

`docs/reference/rajz-reference.mp4` is not in the repo. It is a third-party video and must be placed there locally
to run the reference comparisons.

## License

Licensed under either of Apache License 2.0 or MIT license at your option.

- [LICENSE-APACHE](LICENSE-APACHE)
- [LICENSE-MIT](LICENSE-MIT)
