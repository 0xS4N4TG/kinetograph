# @kinetograph/native

The Node-API addon over the Rust core: validate, inspect and measure scenes on the CPU, and render them on the GPU.
Scenes cross as JSON strings (`docs/SCENE.md`); pixels stay in Rust. The API is specified in `docs/AUTHORING.md` §3
and typed in `index.d.ts`, which `napi build` generates from `src/lib.rs`.

- CPU only, safe anywhere: `version`, `validateScene`, `inspect`, `layoutText`, `parseRange`. They never open a GPU
  device.
- GPU: `new Renderer()` opens one device and builds the pipelines. Every scene given to it afterwards (`still`, `rgba`,
  `bench`, `render`, `beginVideo` and its `pushFrame`) reuses that setup, whatever the scene's size, fonts, images,
  tables or shaders. Frames are byte for byte what a new `Renderer` draws for the same scene.
- Calls are synchronous and run on the JS thread. A thrown error is an `Error` with a `code` (`SCENE_INVALID`, `IO`,
  `FRAME_OUT_OF_RANGE`, `RENDER`, `ENCODE`, `INVALID_ARG`) and the Rust error's text as `message`. Frame numbers, counts
  and sizes must be whole numbers from 0 (a negative one is `INVALID_ARG`).

## Build and test

From the repository root, with `CARGO_TARGET_DIR` set if you share a target directory:

```sh
npm ci
npm run build -w @kinetograph/native            # debug build; writes kinetograph.<platform>.node, index.js, index.d.ts
npm test -w @kinetograph/native                 # node --test: the CPU tests; the GPU tests are skipped
KINETOGRAPH_GPU_TESTS=1 npm test -w @kinetograph/native    # on the M4: opens a GPU
cargo test --lib                                # Rust unit tests (CPU)
```

For benchmarks use the release build, which is several times faster than debug:

```sh
npm run build:release -w @kinetograph/native
```

The Rust integration tests (`cargo test`, without `--lib`) need a GPU. `crates/core/tests/renderer_reuse.rs` checks
that one renderer taking scene after scene draws what a new renderer draws.

## Renderer reuse

`kinetograph_core::Renderer::set_scene` takes a new scene and keeps the device, queue,
the Skia context, compositor pipelines and the layer cache.

- Fonts, images and LUTs are read only if the scene names one the renderer has not read, or one whose file changed
  (path, size and modification time tell). Custom shader pipelines are built by source text the first time they are
  seen.
- The textures that depend on the size are made again only when the canvas size or the margin changes. The margin
  comes from the effects (a shadow or glow needs room), so a video whose effect reach changes from frame to frame pays
  for that each time.
- The layer cache carries over between scenes: a layer that is the same as in the last frame is blended from its
  cached texture, whichever scene it came from. It is emptied when the size changes or when a name the renderer
  already holds (a font family, an image `src`) now stands for a different file.
- A scene that cannot be loaded leaves the renderer as it was.

## Video

`render(sceneJson, output, { range, encoder, audio, baseDir })` renders a whole JSON scene. `beginVideo(output,
{ width, height, fps, encoder })` returns a `VideoWriter` for projects whose scene changes every frame: `pushFrame`
with the frame's scene JSON, then `finish(audio?)`. Both keep the CLI's pipeline: the GPU starts frame N+1 before
frame N is read back, and an encoder thread holds at most two finished frames.

- The video is written beside `output` as `.<name>.partial.<ext>` and takes its real name when the file is finished.
  `abort()`, a failed call, or dropping the writer deletes it, so a half-written file never has the real name.
- Audio is `{ sampleRate, channels }`: one `Float32Array` per channel (1 or 2) of samples in -1..1, starting with the
  first frame, at an AAC sample rate (48000, 44100, ...). It is encoded with ffmpeg's native `aac` and interleaved
  with the copied video packets.
- While a `VideoWriter` is open the `Renderer` refuses other work (`INVALID_ARG`), because its frames are collected a
  call late. An error from `pushFrame` ends the video, as `abort()` does. Frames must be pushed in increasing order,
  and every scene must have the writer's size and fps.

## Spike 1: what the handoff costs

The question is what JavaScript pays per frame to give the addon a scene: stringifying the scene object, then the
addon parsing and validating the JSON and swapping it into the renderer. `Renderer.bench` has a `handoff` stage for
the last two, timed per run on the same JSON string, next to `resolve`, `raster`, `composite`, `readback` and `total`
(the frame as `render` draws it, without the handoff). A frame from JSON string to pixels costs `handoff + total`.

```sh
npm run build:release -w @kinetograph/native
KINETOGRAPH_GPU_TESTS=1 node crates/node/spike/handoff.mjs examples/papercut-card.json --frame 30 --runs 50
```

It prints one JSON object: `stringifyMs` and `validateSceneMs` (CPU, measured without a GPU) and, with
`KINETOGRAPH_GPU_TESTS=1`, `bench` with all stages. Without that variable it runs the CPU part only and no GPU is
opened. `bench` also takes `{ range: "10..40" }` to time successive frames with the layer cache on, doing a handoff
before each, as a video of per-frame scenes does.

## Layout of the code

- `src/lib.rs`: the exports. `src/error.rs`: the error codes. `src/layout.rs`: `layoutText` (one text engine per fonts
  map, kept between calls). `src/bench.rs`: `Renderer.bench`.
- `crates/core/src/inspect.rs`: the resolved scene for `inspect`. `crates/cli/src/render.rs` and `encode.rs`: the
  frame pipeline, the video writer and the AAC muxer, shared with the Rust CLI.
- `test/*.test.cjs`: `cpu.test.cjs` runs anywhere; `gpu.test.cjs` needs `KINETOGRAPH_GPU_TESTS=1`.
