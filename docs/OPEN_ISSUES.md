# Open issues (logged 2026-10-16)

What is known to be wrong or missing, with the cause where it is known, for a later run to fix. Each item says how
it was found. Strike an item out of this file in the commit that fixes it.

## 1. snapcn.dev components

Found by a scan of the 47 free components on [snapcn.dev](https://snapcn.dev) plus 3 variants (50 compositions,
1920x1080), each rendered as stills at its start, middle and end and compared with Remotion 4.0.390 in Chrome for
Testing (oracle only), on `main` at 704a7de. 35 of the 50 come out within a mean of 0 to 3 levels of Remotion. The
rest fail or differ, for the reasons below, ranked by how many components hit them. None is a reason to change the
approach (a native engine, no Chrome); most are things earlier test projects (papercut, the reference video) never
used.

1. **WebP is not decoded** (about 12 components; small). The `image` crate is built with only its png, jpeg and gif
   features in `crates/core`, `crates/dom` and `crates/node`, so `<Img>`, CSS `url()` and SVG `<image>` of a `.webp`
   are refused (reported in `compat.leftOut`). snapcn's default images and posters are all WebP. Animated WebP and
   APNG (for `AnimatedImage`, which draws them as a still today) are a second, medium step.
2. **`<Video>` / `<OffthreadVideo>` drop most of their style** (screen-recording, phone-frame, laptop-frame with a
   video, hero-launch; medium). They become native video layers, and `boxOf()` in `packages/react/src/elements.ts`
   reads only a numeric or px `width`/`height` and `objectFit`; percentage sizes, `position: absolute; inset: 0`,
   `opacity`, `filter` and `border-radius` are dropped silently, and the video is drawn at its natural size at the top
   left. `Img` already falls back to a CSS `<img>` when its style is more than the image layer can take; `Video` needs
   the same fallback (a replaced element in the DOM engine whose pixels are the decoded frame).
3. **`transform-style: preserve-3d` under `perspective` paints none of the children's content** (card-rail,
   announce-title at frame 0; medium to large). The cards draw their background only; the same markup without
   `preserve-3d` is right. CSS 3D transforms work element by element; a 3D rendering context that keeps children in
   one 3D space (depth-sorted, intersecting) is not built.
4. **SVG `<image href={staticFile(...)}>` draws nothing, silently** (capture-reveal; small). `staticFile()` returns an
   absolute path (Remotion returns a URL), and the SVG resource resolver (`crates/dom/src/paint/svg/mod.rs`,
   `assets.rs::resolve_under`) only takes paths under the base directory, so usvg drops the image with no
   `unsupported` entry. Accept absolute paths under the public directory, and report a read that fails.
5. **DOM APIs missing from the shim** (small each).
   - `document.createRange()` and `Range.getBoundingClientRect()` (search-typing).
   - `SVGTextContentElement.getNumberOfChars()` / `getStartPositionOfChar()` (font-shuffle).
   - The rendered host elements are a read-only view (`DomElement`, `packages/compat/src/shim/element.ts`): no
     `prepend`, `append`, `insertBefore`. Libraries that mount their own nodes break, e.g. `@paper-design/shaders`
     (pulsing-border) at `document.head.prepend` and `parentElement.prepend(canvas)`. Its later WebGL2 needs
     (`getShaderPrecisionFormat`, `IntersectionObserver`) are untested.
     Planned approach, no DOM library: the reconciler's host tree is already mutable (`packages/react/src/root.ts`,
     `appendChild`/`insertBefore`/`removeChild`) and is what emit serialises, so give `DomElement` the tree methods
     (`append`, `prepend`, `appendChild`, `insertBefore`, `removeChild`, `replaceChildren`, `remove`, `textContent`)
     on top of those same operations, bumping the tree generation; make `document.createElement`/`createTextNode`/
     `createElementNS` return detached host nodes; give `document.head`/`body` real nodes (a `<style>` put there is a
     stylesheet); add `MutationObserver`, and `IntersectionObserver` that reports everything visible. A JS DOM
     (linkedom, happy-dom) would add a second tree to keep in step with React's. The risk to test: React's own
     insertions must land right when a parent also holds nodes a library added.
6. **Remote `new FontFace(name, 'url(https://…)')`** (check-cycle, capture-reveal, font-shuffle; small). Refused by
   design (a frame must not depend on the network) with a clear message, but the error code is `INTERNAL` and `lint`
   and `doctor` abort instead of reporting it. Fix the code and the reporting; consider downloading the file once into
   the cache the way `@remotion/google-fonts` does, which keeps renders offline and deterministic after the first.
   Remote `<Img>` defaults (snapcn's `https://snapcn.dev/...`) are the same question.
7. **`@remotion/google-fonts` `getInfo()` has no `fonts` map** (orb-swarm; small to medium). Remotion's returns the
   URLs of each weight and subset; ours has none, so `getInfo().fonts.normal['500'].latin` throws. Needs local file
   URLs for the downloaded faces.
8. **Limits set too low** (small to medium).
   - `crates/dom/src/paint/background.rs`: "5184 tiles of a gradient are more than are drawn one by one"
     (moodboard-reveal, every frame).
   - Blur radius over 128 px is clamped (reel-collage).
9. **Text position** (to investigate). text-select draws its text about 60 px lower than Chrome and misses its
   selection band, although `offsetWidth` and the baseline `offsetTop` match Chrome in a probe. Most components also
   show text about 1 px off Chrome's baseline.
10. **`lint` false positives** (small). `text-overflow-canvas` (error) and `text-overlap` (warning) fire on text that
    is off canvas or layered on purpose: roster-grant 69 errors, announce-title 22 errors and 362 warnings, text-swap
    631 warnings. Missing avatar files are listed twice (`img src` and `resource None`).
11. **One slow frame**: phone-frame with a video, frame 130, took 16 s once; frames are usually 0.1 to 3 s. Not
    reproduced yet.
12. Registry note, not ours: snapcn's `input.tsx` imports `@/lib/utils` (shadcn's `cn`), which its registry does not
    ship.

## 2. Remotion API surface

Found by comparing the exports of the published `remotion@4.0.536` and `@remotion/*` packages with ours, then
filled on 2026-10-16. What is left:

- `interpolate`: string, tuple and boolean output ranges, `output: 'perceptual-scale'`, `outputType`.
- Exported but drawn without the missing part (a warning once): effects (`createEffect`) on `Solid`, `CanvasImage`,
  `AnimatedImage` and `HtmlInCanvas`; `HtmlInCanvas`'s `onPaint`/`onInit`; `Artifact` (draws nothing, a render
  writes no extra files); `trimBefore`, `playbackRate` and `loop` on `Track`, `Interactive.*`, `Solid`, `CanvasImage`
  and `HtmlInCanvas`. `IFrame` renders an `iframe`, which the CSS engine reports as unsupported.
- Not exported: `Internals`, `FolderContext`, `PathInternals`, `AudioForPreview` (internal).
- Packages in flight on 2026-10-16 (check their branches before starting any): `@remotion/sfx`, `zod-types`,
  `timeline-utils`, `media-parser`, `webcodecs`, `canvas` (done on the packages branch; `webcodecs` video and audio
  encode and decode, and `media-parser`'s box tree and sample callbacks, throw `UnsupportedApiError` and need a video
  decoder/encoder in the addon);
  `@remotion/skia` on real Skia (`skia-safe`, an optional addon, CPU raster first) and `@remotion/rive` (`rive-rs`).
- Not planned: `@remotion/three` and `@remotion/player` (dropped: own 3D layer, own studio); `renderer`, `bundler`,
  `cli`, `lambda` (replaced by Kinetograph's CLI); `tailwind`/`tailwind-v4` (webpack config only; Tailwind itself
  works).

## 3. Engine features not done

- **Canvas 2D**: letter and word spacing, right-to-left `direction`, `isPointInPath`, patterns of a canvas and a
  pattern's transform, `url()` filters (reported). Shadow and filter pictures are capped at 50M pixels per canvas
  layer per frame (an error past that).
- **WebGL**: renderbuffers, depth and stencil attachments, `COLOR_ATTACHMENT1` and up, a texture level above 0 as a
  target, targets that are not RGBA or that hold uploaded pixels, `generateMipmap`/`texSubImage2D` on a drawn-into
  texture, `readPixels`, `blitFramebuffer` (not defined, so it is a TypeError rather than an `unsupported:` message),
  points and lines, instancing, cube/3D/float textures, multisampled edges. Framebuffer textures start every frame
  blank; a frame that only draws to framebuffers still clears the canvas, where a browser keeps the last picture.
- **3D (`scene3d`)**: spot lights, point-light shadows, the texture maps beyond base colour, bevels, GPU skinning (the
  CPU deforms morphs and skins once per pose), a `doctor` report for `three` imports. Shadows, image-based lighting
  and glTF animation, morph targets and skins are done (2026-10-16).
- **CSS**: `@starting-style`, container `style()` queries, cancelling a running transition, `preserve-3d` (above).
- **WGSL `shader()`**: sees only its own layer, one pass, no other texture, `f32` uniforms only.

## 4. Tests and tooling

- Under heavy load (load average about 210, six agents building), one `packages/core` transitions test times out at
  vitest's 5 s default (it passes alone with a longer timeout), and the `crates/dom` `webgl` Chrome-oracle test hung
  once at 0% CPU. Re-run both on a quiet machine; if either fails again, find out why.
- A fresh git worktree has no `node_modules/@kinetograph/*`, so `react` and `compat` resolve the main checkout's built
  packages instead of the worktree's. Agents in worktrees need the workspace links (`npm install` in the worktree, or
  symlinks) before testing.

## 5. Showcase

Shots 3 to 10 of `examples/showcase`, the VO line 09 with the measured speed-up (S04 7.0x), and the full render are
deferred. `examples/showcase-3d` nits: the tagline is small; Clawd's legs sit slightly in front of the slab; Clawd is
cut off at the left in the first frames; Clawd is 22 to 27% of the frame height (30 to 35% was asked).
