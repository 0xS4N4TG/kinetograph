# Rendering decisions after the first real Remotion project (2026-10-15)

Read this before any work on compat mode, Chrome, CSS support or performance. It records what happened when
Phases 4 and 5 were tested on the M4 against a real papercut episode, and what the user decided because of it.

**Status, 2026-10-16.** The full-engine direction (section 6) and the GPU-pass work were approved and are done, and
everything is merged into `main` (merge `449a639`, pushed). Results: S04 renders 7.0 to 7.1x faster than Remotion
(Kinetograph 1.28 s median, Remotion 8.96 s median, 89 frames, byte-identical to the build before). Papercut ep13
frame 30 went from 990 to 500 ms. 988 of 988 frames of the papercut corpus draw natively; pixels more than 48 levels
off summed 5,312,576 before and 1,276,162 after. Sections 2 to 4 and 8 below are the state on 2026-10-15 and are kept
as the record. Still true: no Chrome ever, port rather than work around. Three.js, `@remotion/three`,
react-three-fiber, drei and pixi compatibility was dropped on 2026-10-15 for an own native 3D layer. Remaining work
is Phase 6 (HANDOFF §8): Canvas 2D, CSS gaps, corpus leftovers, WebGL fragment shaders, the 3D layer, then removing
the Chrome fallback.

## 1. Decisions

1. **No Chrome, ever.** Kinetograph ships with no browser, including for `<canvas>`, WebGL and three.js projects.
   The Phase 5 Chrome fallback (`--compat`, `packages/cli/src/fallback/`, Chrome for Testing) is temporary: it is
   removed once the native path covers the papercut corpus. Never propose Chrome as the answer for a feature.
2. **Port, do not work around.** Every CSS and SVG feature a project uses is drawn by our own compositor (Vello).
   These were proposed and rejected; do not build them:
   - several Chrome pages in parallel (what Remotion does with tabs);
   - a hybrid where Chrome draws only the unsupported element as an image layer.
3. **GPU-pass work was on hold; approved and done 2026-10-15.** The performance plan from `perf/gpu-pass-timing`
   (one to-linear pass per Vello page, merging blends of layers that do not overlap, closed-form inset shadows) was
   listed together with the rejected items. S04 went from 278 GPU passes a frame to 113 (HANDOFF §8, Phase 2c).
4. **The port (section 4) was waiting on the go-ahead; it is done** through the full engine below.
5. **Direction for the full engine (approved, built, merged 2026-10-16):** Blitz's front half (Stylo for CSS, taffy for
   layout, Parley for text) with our compositor as the painter, replacing the per-property TS mapping of Phase 5.
   See section 6.

## 2. State of the code

All on `feat/remotion-compat` (Phase 5, PR #31, draft, against `feat/studio-video`, PR #26). *As of 2026-10-15 none of
this was pushed; it is all in `main` now.*

| Commit | What |
|---|---|
| `0fe35b1` (on `feat/studio-video`, merged into Phase 5 as `abe69f3`) | `video.png` and `gif.png` goldens, made on the M4 and checked by eye |
| `ff576cd` | fix(core): the real timers are bound to `globalThis`; `delayRender` threw "Illegal invocation" in Chrome |
| `32ba207` | fix(compat): a `<Sequence>`'s group gets the composition's box in Chrome frames (scenes were missing) |
| `fa83bae` | feat: `FontFace`/`document.fonts` in Node, WOFF/WOFF2 unpacked by `wuff` in the text engine |
| `4cb1e91` | feat: audio data APIs, `toneFrequency`, and bundling unported Remotion projects (below) |

What `4cb1e91` adds:
- `@remotion/media-utils` audio half: `getAudioData`, `useAudioData`, `useWindowedAudioData`,
  `getAudioDurationInSeconds`, `visualizeAudio`, `getWaveformPortion` (AUTHORING.md §11.7). Decoded once with the
  addon's `decodeAudio` at 48 kHz; synchronous, so `useAudioData` has data on the first frame. `visualizeAudio`
  follows Remotion's documented behaviour, not its numbers.
- `toneFrequency` on `<Audio>` and `<Video>` (0.01 to 2): WSOLA stretch plus resample, pitch changed, length kept
  (AUTHORING.md §6.4, `packages/audio/src/pitch.ts`).
- Real Remotion projects bundle as they are (COMPAT.md §2): `@remotion/media` maps to our `Audio`/`Video`; `.css`
  imports bundle to nothing; the entry runs even when package.json `sideEffects` leaves it out; `public/` is found
  beside the nearest package.json; a project that throws while starting in Chrome reports the top of the stack.

Also done: the session-link footer was removed from PR #26's body. The studio was opened on `examples/rajz-cards`
and works (preview at frame 60, scene tree, Sequence timeline); its full UI checklist (#23) and S04 in the studio
were not run.

### Tests on the M4 (after the commits)

- Rust: 501 passed, 0 failed. `cargo fmt --check` and `clippy -D warnings` clean.
- npm with `KINETOGRAPH_GPU_TESTS=1`: scene 63, react 161, core 256, audio 59, compat 301, cli 214 (the 9 Chrome
  tests run against Chrome for Testing 154 via `KINETOGRAPH_CHROME`), studio 59, studio UI 50, addon 29. 0 failed.
- Chrome for Testing 154.0.8037.57 downloads into `~/.cache/kinetograph/chrome` on first use (about 4 minutes,
  375 MB).

## 3. The real project: tiny-agent episode 13 (papercut)

`$KINETOGRAPH_CORPUS/tiny-agent/episodes/13-mods/papercut/src/index.ts`,
1080x1920, 30 fps, 988 frames. First 5 seconds rendered with `render --range 0..150`.

| | Time for 150 frames | Per frame |
|---|---|---|
| Kinetograph (all 150 frames in Chrome) | 295 s | 1.96 s |
| Remotion (`--frames=0-149`, same flags as `$S/time3.sh`) | 28.1 s | ~0.19 s |

- Kinetograph was **about 10x slower** because native drawing covered 0 of 150 frames (0 of 988 for the whole
  episode): every frame holds something the native path cannot draw, so every frame went through one Chrome page.
  On S04, which is drawn natively, Kinetograph is 3.4x faster than Remotion.
- Sound matched Remotion: mean -17.4 dB, peak -0.8 dB on both (voiceover, ducked music, `fx.wav`).
- Picture matched at frames 20 and 75. **Frame ~140 is wrong:** in the `stampCut` transition into S02, Chrome draws
  a pale block over the lower half. Not fixed.
- Outputs (git-ignored): `out/ep13-5s.mp4`, `out/ep13-5s-remotion.mp4`, `out/cmp.png` (frames 20, 75, 140; top
  row Kinetograph, bottom row Remotion).

## 4. What the native path cannot draw yet (the port list)

From `kinetograph doctor` on the whole episode: 34 items. Items 1 to 9 are in every frame, so all of them must land
before a single frame stays native.

**In every frame (988)**
1. `backgroundBlendMode: multiply` on divs
2. `backgroundRepeat: repeat` of an image at its natural size (texture tiling)
3. inset `boxShadow` on a box with a border or a background image
4. `filter: url(#...)` pointing at an SVG filter
5. `letterSpacing` on divs
6. the individual `rotate` property on divs
7. the individual `scale` property on divs
8. the individual `translate` property on divs
9. the individual `translate` property on `<img>`

**Fonts**

10. `fontFamily`: no registered font at weight 800 (778 frames). Inter 800 is registered, so this is probably a
    name-matching bug (a font stack, or a family name spelled differently), not a missing feature.
24. the same at weight 400 (89 frames)
29. the same at weight 900 (46 frames)
34. the same at weight 900 italic (18 frames)

**Transforms**

11. `skew` (596 frames)
14. `perspective()` (566 frames)
17. a scale that differs per axis (221 frames)
18. a translation after a rotation or scale (179 frames)

**Layout and text**

12. `display: grid` (587 frames)
13. `placeItems` (587 frames)
15. `whiteSpace: pre` on divs (371 frames)
19. `verticalAlign` on spans (171 frames)
21. `whiteSpace: pre` on spans (110 frames)
23. `letterSpacing` on spans (94 frames)
30. an `inline-block` span next to text on the same line (35 frames)

**SVG**

16. `<filter>` elements (222 frames)
20. `mixBlendMode` on `<g>` (163 frames)
26. `rotate` on `<svg>` (66 frames)
27. `scale` on `<svg>` (66 frames)
31. `strokeDasharray` (22 frames)
32. `strokeLinecap` other than butt (22 frames)
33. `strokeLinejoin` other than miter (22 frames)

**Boxes and backgrounds**

22. `calc()` in `clipPath` (94 frames)
25. a radial-gradient ellipse that is not the box's shape (88 frames)
28. borders with different widths per side (46 frames)

### Difficulty

- **Easy, in the TS mapping onto existing layers:** individual `rotate`/`scale`/`translate` (6 to 9, 26, 27),
  `letterSpacing` (5, 23; Parley supports it), the font-name bug (10, 24, 29, 34), `whiteSpace: pre` (15, 21),
  grid and `placeItems` (12, 13; taffy has grid, the feature is off), `calc()` in `clipPath` (22, resolved against
  the box), per-side borders (28), radial ellipses (25), `verticalAlign` and `inline-block` (19, 30).
- **Medium, a small engine addition each:** full 2D matrices for skew, per-axis scale and translate-after-rotate
  (11, 17, 18); SVG stroke dashes, round caps and joins (31 to 33; Vello and kurbo have them); tiled background
  images (2; Vello's repeat extend); `backgroundBlendMode` and `mixBlendMode` on SVG groups (1, 20; the blend modes
  exist); inset shadows on textured boxes (3).
- **Harder:** per-element `perspective()` (14; today there is one camera per scene) and SVG `<filter>` /
  `filter: url()` (4, 16). The papercut kit uses feTurbulence (9), feDisplacementMap (4), feGaussianBlur (8) and
  feColorMatrix (5) (RESEARCH.md §2); turbulence, displacement and blur already exist as effects.

## 5. Why Node or Bun cannot just run it

The project is JavaScript, but JavaScript is not what draws it. React only produces a tree of `<div>`s with CSS
styles. A browser engine (Blink in Chrome, WebKit in Safari) resolves the CSS, lays out the boxes and paints them
with filters, blend modes and 3D. Node and Bun run the JavaScript but have no DOM, no CSS engine and no painter.
That is why Remotion drives Chrome, and why Kinetograph has to draw the tree itself.

Engines that draw HTML/CSS without a browser, and why none is enough:

| Engine | What it is | Why not as is |
|---|---|---|
| Blitz | Rust: Stylo + taffy + Parley + Vello | Audited against papercut 2026-10-14 (RESEARCH.md §2): no blend modes (paper paints flat grey), drops `url()` filters, no SVG filters, inset-shadow bugs, no `text-shadow` |
| Servo | Full browser engine in Rust | Heavy; filters, blending and 3D incomplete |
| Satori (Vercel) | JSX to SVG | Flexbox subset only; no filters, blend modes or 3D |
| Ultralight | Embeddable HTML renderer | Closed source |

## 6. A complete engine (proposed direction)

"Every blur, blend and everything" means the painting half of a browser, not a browser. From scratch is not
realistic (Blink: about 25 years and hundreds of engineers; Ladybird: 10 to 20 people for about 4 years and still
alpha). Reusing the front half is.

| Part | Existing piece | Left for us |
|---|---|---|
| CSS parsing and cascade: selectors, `className`, stylesheets, `calc()`, `var()` | Stylo (Firefox's CSS engine, used by Blitz) | Nothing; also brings Tailwind and stylesheets |
| Layout: block, flex, grid, inline | taffy + Parley (already used) | Grid on; inline gaps |
| Text | Parley | Mapping |
| Painting and compositing | Our compositor already has blend modes, blur, shadows, masks, the 2.5D camera, displacement, turbulence | The real work, below |

Painting work, largest first:
1. SVG filter graphs: the 17 `fe*` primitives chained as a graph, and `filter: url()`.
2. 3D: per-element `perspective()`, `preserve-3d`, `backface-visibility`.
3. All blend and isolation modes: `mix-blend-mode`, `background-blend-mode`, `isolation`, `backdrop-filter`
   (mostly there).
4. Backgrounds and borders: layered and tiled backgrounds, all gradients including repeating ones, `border-image`,
   per-side borders, dashed and dotted styles.
5. Masks and clips: `mask-image`, mask modes, every `clip-path` shape.
6. Shadows: box (outer and inset), text, `drop-shadow`, generalised.

Plan: Blitz's Stylo + taffy + Parley, its painter replaced by our compositor. Conformance measured with the Web
Platform Tests reftests for those areas and the papercut corpus (`doctor --compare`). Estimate, not measured:
2 to 3 cloud-session phases the size of Phases 3 to 5, with SVG filters and 3D the long poles. Output will look the
same as Chrome's, not match it byte for byte (text and anti-aliasing differ).

### Canvas, WebGL and 3D without Chrome

- three.js: its `WebGPURenderer` on Dawn (the `webgpu` npm package). HANDOFF §4 spike passed: about 0.44 ms a
  frame at 512x512, 1.3 to 1.4 ms with readback.
- GLSL `ShaderMaterial` (which `WebGPURenderer` does not run): translate GLSL to WGSL with naga's GLSL front end
  (naga is already a dependency).
- Canvas 2D: its API (paths, fills, strokes, gradients, `drawImage`, text) maps onto Vello and Parley.
- Still to solve: code that reads layout at run time (`getBoundingClientRect`, `ResizeObserver`).

## 7. Size of the shipped app

| Part | Today (measured) | Full engine (estimate) |
|---|---|---|
| Native addon (`.node`: compositor, Vello, wgpu, Parley, taffy, Lottie, video) | 14.3 MB | 25 to 30 MB (Stylo about +10 to 15 MB, from Blitz builds; SVG filters, 3D, canvas about +1 to 2 MB) |
| Dawn (three.js on WebGPU) | not installed | 15 to 30 MB (a guess) |
| FFmpeg | 16 MB (Homebrew dylibs) | 16 MB, or about 10 MB as a trimmed static build |
| TS packages and studio UI | a few MB (UI 0.5 MB) | about the same |
| Chrome | 375 MB (temporary fallback) | **0** |
| **Total** | | **about 60 to 75 MB** |

The repo's 410 MB `node_modules` is development tooling (Vite, Vitest, esbuild, test libraries), not what a user
installs. Measure the real addon size once Stylo is in.

## 8. Open items

1. ~~Push `feat/studio-video` and `feat/remotion-compat`~~ Done: merged into `main` and pushed 2026-10-16.
2. The broken `stampCut` transition at frame ~140 of episode 13 (Chrome path).
3. No Rust unit test for WOFF2 unpacking; the episode render is its only check.
4. Studio UI checklist (#23) and server checklist (#25); S04 in the studio.
5. The port (section 4), on the user's go-ahead, then the full-engine direction (section 6) if approved.
6. ~~GPU-pass work~~ Approved and done (status note at the top).
7. Issues #16 (`kinetograph check`) and #17 (rajz-cards perf) are still open.
