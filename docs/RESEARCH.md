# Kinetograph: research notes

Evidence behind `HANDOFF.md`, gathered 2026-10-14. Star counts and push dates are from the GitHub API on that day.
Claims about other projects come from their READMEs unless marked as tested; nothing here was run.

## 1. Existing projects

| Project | What it is | Stars / activity | Relevance |
|---|---|---|---|
| [fframes](https://github.com/dmtrKovalenko/fframes) | Rust + SVG per frame (`svgr!` macro), Skia GPU on Metal/Vulkan, SkSL/Shadertoy shader layers, linked libav, agent skill, agent CLI, native preview, WASM editor. MIT. Repo created 2021, released recently. | ~2.7k, 21 contributors, pushed 2026-10-13 | Closest match. Read its code first. No synthesis, no TS authoring |
| [Remotion](https://github.com/remotion-dev/remotion) | React + headless Chrome, screenshot per frame | ~63.9k, active | The incumbent and the API to mirror. Custom licence (not MIT) |
| [Motion Canvas](https://github.com/motion-canvas/motion-canvas) | TS generators + canvas, browser rendering | ~19.3k, pushed 2026-07 | Canvas-based alternative |
| [Revideo](https://github.com/redotvideo/revideo) | Motion Canvas fork, headless browser → ffmpeg | ~4.1k, pushed 2026-07 | Still browser-bound |
| [Blitz](https://github.com/DioxusLabs/blitz) | Rust HTML/CSS engine: Stylo + taffy + parley + vello | ~4.3k, pushed 2026-10-13 | Possible base for compat mode, not the core |
| [VCR](https://github.com/coltonbatts/VCR) | Rust, YAML scenes, wgpu, ProRes 4444, agent JSON contract (`capabilities`, `lint`, `inspect`, `verify`, `doctor`) | 22 | Good agent-contract ideas |
| [rust-motion](https://github.com/sjkim1127/rust-motion) | Rust, browser-free, "for AI coding agents", Dioxus-based, claims 1.0 | 3 | Same pitch, no adoption |
| [web-audio-api-rs](https://github.com/orottier/web-audio-api-rs) | Web Audio API in Rust for non-browser use | 388, pushed 2026-10-12 | The synth backend |
| OpenReel, OpenChatCut, OpenEdit, mcp-video | MCP-driven timeline editors; motion comes from Remotion or HyperFrames | various | Editors, not renderers. Possible consumers of Kinetograph |
| Creatomate, Shotstack, JSON2Video | Hosted JSON → video APIs | commercial | Browser-free only because rendering is in their cloud |

fframes' agent CLI, for reference: `timeline`, `inspect` (missing fonts/images, text cut off, invalid SVG, panics,
exit code 2 on errors), `strip` (contact sheet), `frame`, `onion` (blended motion path), `audio analyze` (LUFS, true
peak, clipping, silence), `snapshot` (diff against approved PNGs), `preview`, `render [--draft]`, `--json`. Its launch
video: 128 s, built in 48 minutes, rendered in 36 seconds.

## 2. Papercut kit vs Blitz audit

A subagent audited the user's Remotion papercut code against Blitz on 2026-10-14 (Blitz `main` 2026-10-13, workspace
`0.3.0-beta.3`, stylo 0.22, parley 0.12). It read 107 source files: the kit
(`$KINETOGRAPH_CORPUS/lib/papercut/kit/`) and episodes 12 and 13
(`.../tiny-agent/episodes/12-mirofish/papercut/src/`, `.../13-mods/papercut/src/`). Blitz statuses come from Blitz
source and docs; Blitz was not run.

**Result: about 0% of frames would match Chrome as-is.** Two kit-wide effects break every scene, and both were
spot-checked in the code:
- Paper grain: `backgroundImage: url(grain.png)` + `backgroundBlendMode: 'multiply'`
  (e.g. `kit/paper/overlays.tsx:26`). Blitz has no blend modes, so pieces paint flat grey.
- Torn edges: `filter: 'url(#torn) drop-shadow(...)'` (`overlays.tsx:29`), an SVG feTurbulence + feDisplacementMap
  filter on HTML. Blitz drops `url()` filters (`blitz-paint/src/filters.rs`: `StyloFilter::Url(_) => return None`).

| Feature | Uses | Blitz |
|---|---|---|
| `filter: url(#svg)` | ~17 | Unsupported |
| `mix-blend-mode` (multiply 18, screen 6, soft-light 3) | 30 | Unsupported |
| `background-blend-mode: multiply` | 15 | Unsupported |
| 3D transforms (`perspective()`, rotateX/Y, translateZ) | `OrbitCamera` in `kit/paper/camera.tsx`; `perspective(` also in `transitions.tsx` | Unsupported |
| Filter functions: drop-shadow 21, blur 15, saturate 5, contrast 4, brightness 4, grayscale 3, sepia 1 | ~53 | Skia backend: all. Vello: blur and drop-shadow only |
| `box-shadow` (many inset) | 47 | Partial; inset bugs (blitz#1038) |
| `text-shadow` | 2 | Unsupported (blitz#271) |
| clip-path (polygon 53, inset 3, path 3, ellipse 1) | 91 | Supported |
| mask-image (radial/linear) | 7 | Supported |
| Gradients (radial 55, linear 31, repeating 3, conic 1) | ~90 | Supported in source |
| 2D transforms, transform-origin | ~140 | Supported |
| Inline SVG filters (feTurbulence 9, feDisplacementMap 4, feGaussianBlur 8, feColorMatrix 5) | | Unknown (blitz#701 plans them as a "render-unfiltered fallback") |

Not used at all: Tailwind classes, DOM measurement (`getBoundingClientRect`, `ResizeObserver`, canvas), third-party
packages beyond react/remotion/@remotion/*, CSS animations, `<video>` elements.

Remotion APIs the shim needs, by usage: `useCurrentFrame` 86, `interpolate` 63, `random` 57 (must be bit-exact),
`AbsoluteFill` 55, `Easing` 54, `staticFile` 21, `spring` 19, `useVideoConfig` 16, `Img` 15, `Freeze` 6,
`delayRender`/`continueRender`/`cancelRender` 6 each, `Sequence` 5, `Loop` 3, `Audio` 2–3, `TransitionSeries`/
`linearTiming` 3 files, `fitText` (one call site, `TapeBanner`, needs a real text measurer), `OffthreadVideo` (one
unused component). Fonts load through `new FontFace(...).load()` + `document.fonts.add` in `kit/fonts.ts`; shim that
as font registration.

Per-scene estimate after cheap fixes: ep 12 S01/S08 and ep 13 S01/S06 need 3D (`OrbitCamera`); the rest are 2D.
Ep 13 S04 is a good first 2D test scene. Transitions (`whip` uses an SVG blur; `tearAway`, `stampCut`, `tapePull` use
clip-path and `rough`) overlap two scenes.

Takeaway: Blitz is built for web pages, and its gaps are exactly the motion-design features. Kinetograph's compositor
must support blend modes, SVG-style filter primitives and 3D natively, which is why the core is a layer compositor.

## 3. Reference video breakdown

`docs/reference/rajz-reference.mp4`: 1920×1080, 25 fps, 29.5 s, by Rajz ("Let me know when Opus 5.5 can do this"),
a promo for a product called Appara. Frames: `rajz-contact-sheet-1fps.jpg` (1 fps, 30 frames, 5×6 grid) and
`rajz-effect-closeups.jpg` (t = 1.6, 7.4, 11.3, 17.2, 22.4, 24.2 s).

| Time | What happens | Engine feature |
|---|---|---|
| 0–3 s | Blurred, gradient-mapped human silhouette; "Imagine to have all your tool" with per-word gradient colour reveal; thin horizontal rules | gradient map, blur, per-word text animation, gradient text fill |
| 3–6 s | `{ in one place }` and `{ intro[image]ducing }` with corner dots; small images inline inside a word | kinetic type, inline images in text |
| 6–9 s | Interior photo in a thermal/false-colour grade dissolving into the real photo | gradient map/LUT, cross-fade |
| 10–13 s | Halftone clouds; a frosted-glass band with large type and a typing cursor ("neo goth", "a clothin"); big translucent serif "Appara" behind a prompt bar | halftone, backdrop blur, typing animation, UI mockup |
| 14–16 s | "Building Image" step list (Processing, Generating, Image, Assemble) | flex layout, UI mockup, staggered reveal |
| 17 s | Portrait revealed as a coloured dot matrix | dither/dot-matrix shader |
| 18–24 s | Photo cards in 3D stacks and arcs; angled words ("gets", "better", "you … create") | 2.5D camera, depth sort, text on 3D layers |
| 24–25 s | Whip transition with heavy smear over a gradient | motion blur |
| 25–29 s | Animated mesh-gradient background, "The AI powered platform for modern creatives" with bracket dots; corner-pinned photo with corner dots | mesh gradient, corner pin |

## 4. Why not the alternatives (short)

- **Rust-native renderer with a new DSL only:** loses model fluency; fframes already occupies this spot.
- **Tauri webview + screenshots:** Remotion again with worse capture (no CDP on WebKit, slow per-OS snapshot APIs,
  no headless mode, per-OS output differences).
- **Webview + canvas + WebCodecs:** fast and screenshot-free (Revideo/Diffusion Studio style), but only for canvas
  content, needs a browser on servers, and WKWebView WebCodecs support depends on the Safari version. Kinetograph keeps
  this path only as the WASM preview build.
- **Drop-in CSS renderer (Blitz) as the core:** fails on blend modes, SVG filters and 3D, per §2.

## 5. Where Remotion's time goes (for benchmarks)

Per frame: React render → Chrome style/layout/paint → screenshot encode (PNG/JPEG) → CDP transfer → decode → x264
software encode. Steps 2–5 exist only because a browser is in the middle. Kinetograph: scene update → GPU raster →
async readback (or zero-copy texture to encoder) → hardware encode. The expected 10x is unmeasured; heavy scenes
(many video layers, 4K) gain less because decode and encode dominate.
