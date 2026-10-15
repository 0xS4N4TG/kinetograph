# Kinetograph

Kinetograph is a placeholder name.

A programmatic video engine: agents write TypeScript, a Rust core renders it on the GPU, no browser anywhere. It keeps
Remotion's API for visuals and the Web Audio API for sound, and puts a GPU compositor underneath them.

**Status:** Phases 1 and 2 are done: a Rust workspace with a GPU compositor (shape, text, image, group, noise and
mesh-gradient layers; blend modes, masks, mattes, the effects of [SCENE.md](docs/SCENE.md), a 2.5D camera, motion
blur), PNG and H.264 output. Phase 3 (authoring and agents) is built and awaiting its first GPU run: projects are
written in TSX with Remotion's API and native elements, run in Node, and rendered by the Rust core through an N-API
addon; the `kinetograph` CLI and MCP server are the agent surface (see the [roadmap](docs/HANDOFF.md) and the
[authoring contract](docs/AUTHORING.md)).

- [Technical handoff](docs/HANDOFF.md)
- [Research notes](docs/RESEARCH.md)
- [Scene format](docs/SCENE.md)
- [Authoring contract](docs/AUTHORING.md): the TS packages, the addon's API and how elements map to scenes

## Projects in TSX

Node 22 or later. The npm workspaces are `@kinetograph/scene` (scene types and effect helpers), `@kinetograph/react`
(the reconciler and native elements), `@kinetograph/core` (Remotion's API and packages, the frame loop, the
determinism shim), `@kinetograph/audio`, the `kinetograph` CLI, and `@kinetograph/native` (the addon, `crates/node`).

```sh
npm ci
npm run build                                   # TS packages and a debug addon
npm run build:release -w @kinetograph/native    # the addon for timing

npx kinetograph still examples/rajz-cards/index.tsx 60 -o out/rajz-60.png
npx kinetograph strip examples/rajz-cards/index.tsx -n 12 -o out/rajz-strip.png
npx kinetograph render examples/rajz-cards/index.tsx -o out/rajz-cards.mp4
npx kinetograph inspect examples/rajz-cards/index.tsx --frame 60 --json
```

A project imports from `remotion` and `@remotion/*` as it would for Remotion (the CLI maps them onto
`@kinetograph/core`) and from `@kinetograph/core` for the native elements and effects. Every command takes `--json`;
`npx kinetograph mcp` serves the same commands over MCP. `npm test` runs the CPU tests; the GPU ones run with
`KINETOGRAPH_GPU_TESTS=1`.

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

# Time successive frames in order, with the layer cache on (see "Layer cache" below)
./target/release/kinetograph bench examples/bench-diorama.json --range 40..90
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
  two to an encoder thread, so the GPU work for frame N+1 overlaps the encoding of frame N. Layers that did not change
  since the previous frame are not drawn again (see [Layer cache](#layer-cache)). No sound yet: the file has a video
  stream only.
- **Output.** Text mode prints a progress line to stderr and a one-line summary. `--json` prints
  `{output, encoder, width, height, fps, frames, first, last, ms, ms_per_frame}` (`last` inclusive; `ms` covers
  rendering and encoding the range, not GPU setup). On failure the partial file is deleted.

### Layer cache

A layer that has not changed since the previous frame is not drawn again: the renderer keeps the finished texture a
layer was blended from and blends it again. (A group keeps its whole subtree's, so a group of still layers is one blend.)
A kept texture is used only when everything it was made from is equal to what it is made from now, compared exactly:
the layer and everything in it as resolved for the frame (motion blur samples included, and the frame that grain,
dither and custom shaders read), its parent's matrix, its matte source, and the camera if something in it is moved in
3D. The layer's own `opacity` and `blendMode` are not part of that, since they are applied when it is blended, so a
fading layer is not redrawn. A layer with a `backdropBlur` (or whose matte source has one) is never kept, because its
texture is made from the canvas under it, and nor are the layers inside a motion-blurred layer, of which only the
average is kept. Frames are byte-identical with the cache on or off. What a frame does not use is dropped when it ends,
and no more than 1 GiB of textures is kept.

- `render` turns the cache on. `still` renders one frame, so it has nothing to reuse. In the library, a new `Renderer`
  has the cache off; `Renderer::set_layer_cache(true)` turns it on and `layer_cache_counts()` says how many layers have
  come from it.
- `bench --frame` renders the same frame over and over, so it runs with the cache off (on, every run after the first
  would only time the cache). `bench --range a..b` (the syntax of `render --range`) times the frames in order with the
  cache on, as `render` runs them: a line per frame with its time and how many layers came from the cache (`reused`)
  and how many were drawn and kept (`drawn`), then the stage means, minimums and maximums over the frames. The range is
  rendered twice from an empty cache, first the whole frames and then the stages (which wait for the GPU after every
  step, so they cannot also be the frame's time). `--range` cannot be combined with `--frame` or `--runs`.

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
