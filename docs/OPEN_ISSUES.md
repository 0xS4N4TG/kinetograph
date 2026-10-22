# Open issues (logged 2026-10-16, added to 2026-10-19, pruned 2026-10-21)

What is known to be wrong or missing, with the cause where it is known, for a later run to fix. Each item says how
it was found. Strike an item out of this file in the commit that fixes it.

On 2026-10-21 two agents fixed most of the list (commits a6c6aca to a2bee64): WebP and animated WebP/APNG, the
`<Video>` CSS fallback, SVG `<image href={staticFile()}>`, the mutable DOM shim (tree methods, `document.head`/`body`,
`MutationObserver`, `Range`, SVG character positions), remote fonts and images downloaded once into the cache,
`getInfo().fonts`, the gradient-tile and blur limits, the `lint` false positives, the rest of `interpolate`,
`trimBefore`/`playbackRate`/`loop` on `<Sequence>`, `Artifact` files, the CSS gaps, most Canvas 2D gaps, spot lights,
point-light shadows, fog, glTF texture maps, the launch-film bugs, and the tooling items. What is left is below.

## 1. snapcn.dev components

Found by a scan of the 47 free components on [snapcn.dev](https://snapcn.dev) plus 3 variants (50 compositions,
1920x1080), each rendered as stills at its start, middle and end and compared with Remotion 4.0.390 in Chrome for
Testing (oracle only), on `main` at 704a7de. 35 of the 50 came out within a mean of 0 to 3 levels of Remotion. The
snapcn files are not on disk any more, so the items below could not be re-checked against the components themselves.

1. **`transform-style: preserve-3d` under `perspective` paints none of the children's content** (card-rail,
   announce-title at frame 0). Not reproduced on 2026-10-21: four probe pages (flex rail, nested transforms, text,
   SVG, filters, `backface-visibility`, a `translateZ` child) all draw their children. Re-run card-rail and
   announce-title before working on it. The engine sorts preserve-3d groups in painter's order with no depth buffer,
   so planes that intersect are still drawn wrong.
2. **Text position** (to investigate). text-select drew its text about 60 px lower than Chrome. Not reproduced
   without the component: a probe against Chrome (DM Sans at 16 to 57 px, several line-heights, flex-centred) gives
   the same ink bottom and right edges, and top and left edges 0 or 1 px off at 40 px and up (antialiasing weight, not
   a baseline offset).
3. **`@paper-design/shaders`** (pulsing-border): the DOM shim now has the tree methods it needs, but the library
   itself has not been run, so its WebGL2 needs (`getShaderPrecisionFormat` and others) are untested.
4. **One slow frame**: phone-frame with a video, frame 130, took 16 s once; frames are usually 0.1 to 3 s. Not
   reproduced yet.
5. Registry note, not ours: snapcn's `input.tsx` imports `@/lib/utils` (shadcn's `cn`), which its registry does not
   ship.

## 2. Remotion API surface

Found by comparing the exports of the published `remotion@4.0.536` and `@remotion/*` packages with ours, then
filled on 2026-10-16 and 2026-10-21. What is left:

- Exported but drawn without the missing part (a warning once): effects (`createEffect`) on `Solid`, `CanvasImage`,
  `AnimatedImage` and `HtmlInCanvas`; `HtmlInCanvas`'s `onPaint`/`onInit`. Both need an element drawn into a canvas
  and the GPU effect pass. `IFrame` renders an `iframe`, which the CSS engine reports as unsupported.
- `trimBefore`, `playbackRate` and `loop` on a `<Sequence>` change only its frame clock: an `<Audio>` or `<Video>`
  inside does not take the rate or the trim.
- Not exported: `Internals`, `FolderContext`, `PathInternals`, `AudioForPreview` (internal).
- Done on 2026-10-16 (merged): the 19 `@remotion/transitions` presentations, `useTransitionProgress`,
  `@remotion/light-leaks`, `@remotion/starburst`, `@remotion/sfx`, `zod-types`, `timeline-utils`, `media-parser`,
  `webcodecs`, `canvas`, `@remotion/rive` and `@remotion/skia` on real Skia (the optional `@kinetograph/skia` addon,
  CPU raster). `webcodecs` video and audio encode and decode, and `media-parser`'s box tree and sample callbacks,
  throw `UnsupportedApiError` and need a video decoder/encoder in the addon; what Skia leaves out is in section 3.
- Not planned: `@remotion/three` and `@remotion/player` (dropped: own 3D layer, own studio); `renderer`, `bundler`,
  `cli`, `lambda` (replaced by Kinetograph's CLI); `tailwind`/`tailwind-v4` (webpack config only; Tailwind itself
  works).

## 3. Engine features not done

- **Canvas 2D**: a pattern of a canvas used for a stroke or for text is drawn transparent (fills work, up to 10,000
  tiles); `isPointInStroke` ignores caps, joins and dashes; `url()` filters (reported). Shadow and filter pictures are
  capped at 50M pixels per canvas layer per frame (an error past that).
- **WebGL**: renderbuffers, depth and stencil attachments, `COLOR_ATTACHMENT1` and up, a texture level above 0 as a
  target, targets that are not RGBA or that hold uploaded pixels, `generateMipmap`/`texSubImage2D` on a drawn-into
  texture, `readPixels` (refused by design), `blitFramebuffer` (reported as unsupported), points and lines,
  instancing, cube/3D/float textures, multisampled edges. Framebuffer textures start every frame blank; a frame that
  only draws to framebuffers still clears the canvas, where a browser keeps the last picture. Each needs a new GPU
  pipeline.
- **3D (`scene3d`)**: occlusion and emissive texture maps, bevels, GPU skinning (the CPU deforms morphs and skins once
  per pose), a `doctor` report for `three` imports. At most 4 lights cast shadows and 8 shadow maps in all (a point
  light takes 6).
- **CSS**: `background-repeat: space` with thousands of gradient tiles still errors (other repeats are drawn as one
  tile repeated by `feTile`). Backdrop blur and glow stay capped at 128 px (`blur` takes 512).
- **WGSL `shader()`**: sees only its own layer, one pass, no other texture, `f32` uniforms only.
- **`@remotion/skia` / `@shopify/react-native-skia`** (AUTHORING.md §7.7): `Atlas`, `Patch`, `Glyphs`, `TextBlob`,
  `Picture` and `ImageSVG` are reported, not drawn; no Reanimated values, `FitBox`, `Skia.Surface`/`Offscreen`,
  `Skia.Image`/`Data`/`SVG`/`Typeface` factories, `useVideo`, animated images, paragraph measurement, shaders or filters
  set on a `Skia.Paint()` object. The raster is CPU only (about 15 ms of a 1080p frame is PNG hand-off; a GPU-backed Skia
  would skip it). The PNGs of drawn frames are kept under `~/.cache/kinetograph/skia` (newest 400 to 600).
- **`@remotion/rive`** (AUTHORING.md §7.6): `onLoad`, `assetLoader`, `effects` and the `ref` getters are not supported;
  a state machine starts with its inputs at their defaults (no way to set inputs); pictures embedded in a file only.

## 4. Tests and tooling

- The `lint` false-positive fixes (text-overflow-canvas, text-overlap) were tested on fixtures, not on the snapcn
  components that showed them.
- No benchmark has been run since the 2026-10-21 fixes; re-time S04 before quoting the speed-up again.

## 5. Showcase

Shots 3 to 10 of `examples/showcase`, the VO line 09 with the measured speed-up (S04 7.0x), and the full render are
deferred. `examples/showcase-3d` nits: the tagline is small; Clawd's legs sit slightly in front of the slab; Clawd is
cut off at the left in the first frames; Clawd is 22 to 27% of the frame height (30 to 35% was asked).

## 6. Found making the launch film (2026-10-17)

All fixed on 2026-10-21 except one, which was not reproduced:

- **A layer clip `inset()` needs a box.** On an element with no explicit width and height the inset clipped to
  nothing. On 2026-10-21 a DOM `clip-path: inset()` on auto-sized boxes and a content-sized scene layout group both
  clip correctly (tests added); a group whose children all have no box is 0 x 0, as in CSS. Re-check the launch
  film's case (`examples/launch`) with the workaround removed.

The workarounds in `examples/launch` (`Over`, the split `How` span, the `<Sequence from>` around a video, rounded cue
frames) can now be removed.

Found on 2026-10-22, not fixed:

- **An inline-block with a stacking context is painted twice.** A `display: inline-block` element with a `transform`
  (or anything else that makes it a stacking context, or positioned) comes out as two identical layers, `$0.0.1` and
  `$0.0.1~2`, so its antialiased edges get double alpha and it costs two draws. `Painter::walk`
  (`crates/dom/src/paint/mod.rs`) paints it through `paint_context`/`paint_atomic` before checking `inline_level`, and
  `paint_inline_root` (`paint/text.rs`, the `InlineBox` arm) paints the same box again from the lines. Repro: a div with
  the text "ab" and a `span` with `display: inline-block; transform: scale(0.5)`. The launch film's end card (frames
  1386 to 1520) has it. Fixing it changes pixels there.

## 7. Speed experiments not run (logged 2026-10-22)

Two cheap tests of the JS that runs every frame (about 10 ms of a launch-film frame at concurrency 1). Neither has been
measured. Run each on part of the launch film at `--concurrency 1` with `KINETOGRAPH_PROFILE` on, and compare the JS
time per frame with the current build. Keep the result either way.

- **React Compiler.** Compile the project with the React Compiler before esbuild bundles it (a test-only esbuild
  `onLoad` plugin that runs `babel-plugin-react-compiler`; the Rust port emits the same code). Its memoisation can only
  skip components that do not read the frame, so the gain is bounded by how much of the tree is static. If it saves
  2 ms or more a frame, ship it through the Rust port so bundling does not slow down.
- **Bun as the runtime.** Run the CLI under Bun (JavaScriptCore) instead of Node (V8). Unknowns: whether the N-API
  addon loads, and whether it loads in each worker thread. If it is faster, it can only be an option used when Bun is
  installed, since `npx kinetograph` starts Node. Bun as the bundler is not worth testing: bundling runs once a render.

## 8. More workers do not make a render faster (logged 2026-10-22)

Past 1 to 4 workers the render barely speeds up. Earlier Vello runs showed `--concurrency 4` only a little faster than
`--concurrency 1`. On the Skia backend (branch `exp/skia-backend`), papercut took about 22 s at 4 workers and 28 s and
39 s at 5 (load average 8 to 10 during the 5-worker runs, so noisy). Remotion on the same film took 131 s at 5 workers.
Cause (profiled 2026-10-22 on the launch film, Skia backend): the workers only run the JS in parallel. Every frame
then goes through one writer thread and one `Renderer` behind one `Mutex` (`crates/node/src/lib.rs`, `Shared.gpu`), so
parse, resolve, Skia recording, submit and readback are serial. At 4 workers that serial part is about 6.4 ms a frame,
89% of the frame loop (10.8 s of 14.6 s), and the JS per frame doubles (3.7 to 7.6 ms) while it waits. Other costs:
the encode and to-linear-premul GPU passes take 4.5 ms a frame, the hand-off to the encoder 3.4 ms a frame on the main
thread, and about 3.7 s of each render is outside the frame loop and not yet broken down. Full numbers in the stage 5
profile (scratchpad `prof/launch.md`). Fix: parse and resolve outside the lock, and a Skia Graphite `Recorder` per
worker so recording runs in parallel, with only `insert_recording` and submit serial. This is the main lever left for
the launch film, which is about 3x Remotion against a 5x goal.
