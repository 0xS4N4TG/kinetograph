# Spike 2: Three.js `WebGPURenderer` headless on Dawn in Node

Question (`docs/HANDOFF.md` §4, §10): can real Three.js render offscreen in Node, on the `webgpu` npm package (Dawn),
so that a 3D layer is a texture the compositor draws? The answer decides Three.js against the kiss3d backup.

This directory is its own project, not an npm workspace. It needs a GPU, so it is run on the M4, never in the cloud.

## Run

```sh
cd spikes/three-dawn
npm ci
npm start            # node render.mjs
```

Options, as environment variables: `SIZE` (default 512), `FRAMES` (timed frames per scene, default 20), `SAMPLES`
(MSAA samples of the render target, default 0; try `SAMPLES=4` once the plain run works), `OUT_DIR` (default `out/`).

`npm run check` is the GPU-free part (syntax, and the glTF export and load round trip) and is safe anywhere.

## What it does

1. Gives Node the WebGPU API: `navigator.gpu` and the `GPU*` globals from the `webgpu` package.
2. Makes a `WebGPURenderer` with a stand-in canvas and `GPUCanvasContext` (Node has no canvas) and calls `init()`.
3. **Asserts the backend is WebGPU** (`renderer.backend.isWebGPUBackend`). `WebGPURenderer` silently falls back to
   WebGL2 when it finds no adapter, and there is no WebGL2 in Node, so a fallback fails the run.
4. Renders a torus knot built in code, and a glTF model: a small figure is built in the script, exported to a `.glb`
   with `GLTFExporter` and loaded back with `GLTFLoader`, so there is no third-party asset. Both go into a render
   target, which is read back with `readRenderTargetPixelsAsync`.
5. Checks the pixels are not blank (more than 2% of pixels differ from the background, more than 50 distinct colours),
   writes `out/torus-knot.png` and `out/gltf-model.png`, and prints one JSON object: backend, adapter, Three.js
   revision, `initMs`, and per scene the first frame (shader compilation), the mean render-only time and the mean
   render-plus-readback time per frame, and the pixel statistics.

Exit code 0 and `"ok": true` on success; on failure exit code 1 and `{ "ok": false, "error": { "code", "message" } }`.

## What to look at

- Open both PNGs. A lit orange torus knot and a blue, yellow, red and green figure on a dark background mean it works.
  Wrong colours (too dark or washed out) point at the sRGB handling of the render target (`target.texture.colorSpace`
  in `render.mjs`); a flipped picture at the readback row order.
- `renderAndReadbackMs` is the cost of one 3D layer per frame, readback included: the number that decides whether a
  CPU readback is acceptable (`HANDOFF.md` §4 estimates ~2 ms at 1080x1920 for the readback alone). Run it with `SIZE=1080`
  too, since the layer would be that large.
- The Dawn adapter in the output should be the M4's GPU, not a software one.
- If it fails, the message says where: the adapter, the backend assertion, a blank picture, or a Three.js exception
  (printed to stderr). A blank picture with the WebGPU assertion passing is the failure the forum reports describe.
- Not covered here: GLSL `ShaderMaterial` (`WebGPURenderer` does not run it), `@remotion/three` and react-three-fiber
  examples (the count of those that render unchanged is the second half of the spike in `HANDOFF.md` §4).
