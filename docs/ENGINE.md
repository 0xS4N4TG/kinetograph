# The full engine (Phase 6)

Decided 2026-10-15 (`DECISION_RENDERING_CRITICAL.md` §6, approved by the user the same day): compat mode stops
parsing CSS in TypeScript. A DOM island is handed to Rust, styled by Stylo, laid out by taffy and Parley through
Blitz's DOM (`blitz-dom` 0.3.0-beta.3, which uses the same Parley 0.12 and taffy 0.15 as the core), and painted by our
own compositor. Blitz's painter (`blitz-paint`) is not used. No Chrome in the render path, ever; Chrome for Testing
may be used only by tests and `doctor --compare` to make reference images.

Success, measured on the M4:
- The tiny-agent episode 13 papercut project (`$KINETOGRAPH_CORPUS/tiny-agent/episodes/13-mods/papercut/src/index.ts`,
  `ModsPapercut`, 988 frames) renders with every frame native, today 0 of 988.
- Each frame looks like Chrome's: `doctor --compare` against Chrome references within a per-pixel threshold (text and
  anti-aliasing differ; byte equality is not the goal).
- `cargo test`, clippy, fmt and every npm suite pass; `bench` does not regress against `feat/remotion-compat`.

## 1. Pipeline

```
React tree (DOM host elements + native kg-* ones)
  emit (packages/react/src/emit.ts), per frame: each outermost run of DOM nodes is an island
    TS  (stream 4): DomNode tree → IslandRequest JSON: tags, attributes, style as CSS text, stylesheets, time
    addon renderDomIsland(json)  (crates/node/src/dom.rs)
      Rust (stream 1): IslandRequest → blitz_dom::BaseDocument; fonts, images; resolve(time): Stylo + layout
      Rust (stream 2): paint(doc) → scene layers in CSS paint order; core gains what boxes need
      Rust (stream 3): <svg> subtrees and filter graphs → scene layers and a filterGraph effect
    → IslandOutput JSON: layers, unsupported, camera
  frame loop, render: unchanged (frames with unsupported items still go to Chrome until the fallback is removed)
```

Readback (`getBoundingClientRect`, `offsetWidth`, `getComputedStyle`, `ResizeObserver`) goes through the same
document: `domLayoutBoxes(json)` in the addon (stream 1) answers for the island's current host tree; the TS DOM shim
(stream 4) calls it lazily and caches by tree generation.

## 2. The contract

`crates/dom/src/request.rs` is the contract and is owned by the orchestrator: streams may add optional fields;
changing an existing one goes through the orchestrator. In short:

- `IslandRequest { root: DomNode, stylesheets, viewport, fonts, baseDir, publicDir?, time, path }`.
- `DomNode` = `element { tag, path, attrs, style, children }` | `text { text }` | `native { path, width?, height? }`.
  `style` is CSS declaration text (`width: 10px; opacity: 0.5`), serialized by TS with React's rules.
- `IslandOutput { layers: LayerJson[], unsupported: Unsupported[], camera }`, the shape of `IslandResult`.
  A `{"type": "native", "path", "x", "y", "width", "height"}` layer marks where a native element's layers go.
- Layer ids: derived from the node's explicit `id` attribute if it is a valid layer id, else its `path`, with the
  suffixes the painter needs (`.bg`, `.border`, `.text`, …), unique per island.
- Addon functions (stream 1): `renderDomIsland(requestJson: string): string` and
  `domLayoutBoxes(requestJson: string): string` → `{ [path]: { x, y, width, height, rect: {x,y,width,height},
  client: {width,height}, scroll: {width,height} } }` (offset box in island coordinates; `rect` is the transformed
  bounding box, as `getBoundingClientRect` gives).

## 3. Streams and ownership

Each stream works on its own branch off `feat/full-engine`, in its own worktree, and commits often (Conventional
Commits). The orchestrator merges them into `feat/full-engine`.

| Stream | Branch | Owns |
|---|---|---|
| 1 front | `engine/front` | `crates/dom/src/{lib.rs,document.rs,fonts.rs,net.rs,readback.rs}` and new non-paint modules; `crates/dom/Cargo.toml`; `crates/node/src/dom.rs` and the addon exports; CSS animation clock; UA stylesheet |
| 2 paint | `engine/paint` | `crates/dom/src/paint/**` except `svg/`; core additions for boxes: 2D/3D matrices per layer, per-element `perspective`/`preserve-3d`/`backface-visibility`, tiled and sized background images, `background-blend-mode`, `mix-blend-mode` and `isolation` on any layer, per-side borders and border styles, `border-image`, inset and outer shadows of any shape, `text-shadow`, every CSS filter function, `backdrop-filter`, `mask-*`, every `clip-path`, glyph runs from Blitz's Parley layouts |
| 3 svg | `engine/svg` | `crates/dom/src/paint/svg/**`; core additions for SVG: stroke dashes, caps, joins, miter limit, markers, patterns, SVG masks and clip paths, and the `filterGraph` effect (all `fe*` primitives); the lookup stream 2 calls for `filter: url(#id)` |
| 4 runtime | `engine/runtime` | `packages/**`: DomNode → IslandRequest (React style serialization, `className`, `<style>`, `.css` imports as text), switch `mapDomIsland` to the addon, readback DOM shim and the `useLayoutEffect` measure loop, frame-driven CSS animation time, web APIs (`Image`, `fetch` of project files, `requestAnimationFrame`, `matchMedia`, `window.inner*`), doctor wiring, the episode 13 corpus harness |
| 5 perf | `perf/gpu-passes` (from `perf/gpu-pass-timing`) | compositor internals only: one to-linear pass per Vello page, merged blends of layers that do not overlap, closed-form inset shadows for rect shapes, anything else `bench --passes` shows; output byte-identical |

Shared files (`crates/core/src/scene.rs`, `compositor.rs`, `docs/SCENE.md`, `crates/node/src/lib.rs`): add new
items in new places (new enum variants, new functions), do not reorder or reformat existing ones. The orchestrator
resolves merge conflicts.

## 4. Painting (stream 2)

Walk the laid-out document in CSS paint order (stacking contexts, `z-index`, positioned, floats, inline), as CSS 2.1
Appendix E says. Each box becomes the fewest layers that draw it: a group for a stacking context (opacity, transform,
filter, blend, isolation, clip, mask), and inside it background, border, content, outline. Text comes from the
Parley layouts Blitz made, so lines break where Blitz measured. Images and video keep the core's image and video
layers. Anything not drawn as Chrome would draw it is an `Unsupported` item, never silently wrong.

## 5. SVG (stream 3)

An `<svg>` element is a replaced box; its subtree is painted as path layers (usvg may be used to resolve shapes,
`use`, gradients, patterns, text to paths), with Stylo's computed values for presentation properties. Filters
become one `filterGraph` effect: the primitives, their inputs (`SourceGraphic`, `SourceAlpha`, named results),
`filterUnits`/`primitiveUnits`, and regions. Seeded turbulence and displacement already exist as effects; reuse their
shaders.

## 6. Rules for every stream

- Rendering is a pure function of (project, frame). No system fonts, no network, no wall clock.
- Reimplement from the specs (CSS, SVG, Filter Effects, Compositing); do not copy Chromium or Remotion source.
- Every feature gets a test: unit tests on the CPU side, and a golden for anything drawn (`crates/core/tests/golden`
  or a new `crates/dom/tests/golden`), checked by eye against Chrome's rendering of the same HTML.
- Build with the rustup toolchain: `export PATH=$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH`.
- Disk is tight (about 35 GB free): all worktrees share `CARGO_TARGET_DIR=<main checkout>/target`; never
  `cargo clean`.

## 11. Stream 5 notes

Branch `perf/gpu-passes` (from `perf/gpu-pass-timing`, `feat/full-engine` merged in). Compositor internals only; every
change below draws the same bytes as the build before it, checked on 34 scenes (`crates/core/tests/scenes`,
`examples`, the S04 JSON port, all frames; `examples/frame_hashes.rs` prints a hash per frame) against the build
before the stream, and by the goldens.

### Results (M4, 2026-10-15)

S04 (89 frames, 1080x1920), whole `kinetograph render`, interleaved rounds, load average 3–6 (other jobs share the
machine; mins and medians of 4 rounds):

| | min | median |
|---|---|---|
| Remotion 4.0.530, `--gl=angle`, on AC power | 8.86 s | 8.96 s |
| Kinetograph before the stream | 2.68 s | 2.72 s |
| Kinetograph after | **1.25 s** | **1.28 s** |
| speedup against Remotion | 7.1x | 7.0x |

The two videos decode to the same 89 frames (md5 of the frame md5s). Per frame (`frame_hashes --times`, min of 5): 25.8
to 11.4 ms. Passes a frame (`bench --passes`): 278 to 113. The per-stage times are in HANDOFF (Phase 2c). The first of
the four rounds was a cold start for all three (Remotion 11.13 s, before 2.92 s, after 2.51 s); the others were 8.86–9.15
s, 2.68–2.74 s and 1.25–1.41 s.

### What was done

1. **Inset shadow with no blur and no spread, one pass** (`fs_inset_inverted`): the spread pass only inverted the alpha;
   the shadow pass inverts where it reads. Byte-identical needs the half-float store emulated: **Apple GPUs round a
   float to Rgba16Float towards zero, not to the nearest** (`examples/f16_probe.rs` checks a million values against the
   hardware), so `store_f16` (shaders/f16.wgsl) steps down when `pack2x16float` rounded up. Outside the canvas
   texture the inverted alpha is 0, as the texture it replaces ended there.
2. **Leaves cut out of their Vello page when wanted**, each page with its own target texture (pooled by size, kept
   for the frame): no to-linear for a leaf the layer cache supplies, no submit before a page is drawn. This replaces
   the plan's "one to-linear pass per page" (see Rejected).
3. **`blend_many`**: drawn layers wait in a list and are composited up to seven to a pass, each pixel in order, the
   canvas rounded to half floats (`store_f16`) between layers as the textures of separate passes were. Flushed
   when the canvas is wanted as it is (a backdrop blur, a preserve3d group), at 16 waiting and at the end of the list.
   A pass is not built when its box would be more than twice what its layers cover plus 64x64.
4. **Pages** drawn from the canvas's top left corner only as far as their leaves reach (the tile grid and the
   transforms do not move, so the pixels are the same; a translated draw would round differently), and leaves packed by
   DSATUR colouring (largest area first past 600 leaves).
5. **A leaf with a sharp inset shadow** is cut out and shadowed in one pass (`fs_inset_page`); a clipped leaf is cut
   out and masked in one (`fs_leaf_clip`); **a plain leaf** (no effects, mask, matte, any separable blend mode) is
   blended straight from its page, with its clip's page if it has one: `blend_many` slots take a texture or a page leaf.
   Such a leaf has no texture for the layer cache, which is told only what it was made from (`LayerCache::note`); a
   leaf that is unchanged the next frame is drawn the old way and cached from its third frame on.
6. **Vello** (vendored, `vendor/README.md`): its dispatches share one compute pass instead of a pass each (about 17
   a page), and its MSAA mask table is computed once.
7. **Clip shapes are page leaves** (white, packed with the others), a command buffer is finished and submitted in
   pieces of 512 passes (one of thousands is rejected by the driver with no error), and page targets are sized to
   their area.

`Renderer::set_pass_fusion(false)` turns 1, 3 and 5 off; `tests/fusion.rs` renders `tests/scenes/passes.json`,
`blend-runs.json` and six seeds of 150 random shapes (strokes, alphas down to 3, rotations, clips, sharp inset shadows,
blend modes, opacities, groups, drop shadows) with it on and off and compares the bytes.

### Rejected or not done

- **One to-linear pass per page** (the plan): a page's leaves would land in one shared texture, and every consumer
  that reads past a texture's bounds (blur, shadows) would see the other leaves' pixels; copying them out costs a
  copy each. Converting only what is wanted, and fusing the conversion into its consumer, removed the pass instead
  (S04: 82.8 to 1.9 a frame).
- **Closed-form inset shadows for rect shapes** (erf): S04's are all blur 0, where the exact path above is a single
  pass for any shape (paths included) and byte-identical; an erf form would only be within tolerance. Not built.
  Inset shadows with a blur or a spread still take the spread, blur and shadow passes.
- **Hardware blending for `blend`**: its result is not bit-for-bit the shader's (the shader unpremultiplies and
  multiplies back), so not byte-identical.
- **Translating a page's draw** to its leaves' box: Vello's f32 transform rounds differently, flipping a few
  samples of the 16 a frame.
- **Finishing command encoders on other threads** (wgpu encodes to Metal at `finish`): no change in time on the
  papercut frame, and holding many finished buffers before submitting made wgpu report a buffer invalid. Reverted.
- **Fusing blur's pad pass into its first Gaussian pass**: the blur reads through the hardware's bilinear filter, whose
  8-bit weights cannot be reproduced exactly.

### What is next

S04's remaining cost: 113 passes (22 `blend`, 16 + 8 + 3 blur, 8 displace, 8 drop shadow, 26 inset shadow), about 20
Vello pages a frame at 0.3–0.5 ms each, and the encoder cost per Metal render pass (about 25 µs of CPU each, in
wgpu's `finish`). Fewer pages needs fewer overlapping leaf boxes; the painter can help (below). The inset shadow with a
blur or a spread, and groups with `displace` + `dropShadow` (full-canvas filtered passes), are the next passes to merge.

### The papercut frame (episode 13, frame 30, 6,828 layers)

Scene JSON from `engine/runtime`'s CLI (`source.frame(30).sceneJson`), measured with `engine/runtime` merged into a
scratch branch of this one. `frame_hashes --no-cache`, ms a frame, load 5: **990 before the clip and page-blend work
(which is this stream's S04 work already on it) to 500**, same bytes (hash `b9f451ea436b688e`). The "5 to 10 s" stream 4
saw was a frame on a machine with a load average of 20–30 from other jobs; at load 1 the frame took 1.4 s before this
work. Where the time went: 1,098 layers have a clip, and each had a Vello render of its own over the whole canvas and
a mask pass (1,098 extra renders, 80% of the main thread); 3,749 to-linear passes, 1,803 blends; 9,135 passes in all,
4,615 now. The deepest stack of leaf boxes at one pixel is 404, so there are about 450 Vello pages however they are
packed.

What the painter could change (stream 2, `crates/dom/src/paint`), in order of what it saves:

1. **Inset box shadows are emitted as a ring path with a clip** (`...insetshadow0`: an outer rectangle 2 px past the
   box, an inner rounded rectangle for the hole, clipped to the padding box): 962 of the frame's 4,847 leaves, each
   with a clip leaf. Emit them as an `insetShadow` effect on the box's background layer (blur 0, the offset, the colour;
   the compositor draws that in the pass that cuts the background out), or as one path already cut to the box. That is
   about 1,900 leaves and 960 clips fewer, and the page depth falls with them.
2. **Groups with no effect, clip or opacity** (1,978 here) could be left out; the compositor flattens them, but
   each still costs a walk and a cache key.
3. **Per-element clips that equal the layer's own box** (the 260 `M0 0 L60 0 L60 18 L0 18 Z` clips on rings) are the
   same shape as the ring's hole boundary and could go with item 1.
