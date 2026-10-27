# Changelog

All notable changes to Kinetograph. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Kinetograph is in beta, so APIs can still change between versions.

## Unreleased

### Fixed

- `monospace` and `ui-monospace` text is set in a bundled JetBrains Mono (Regular, SIL OFL 1.1, 92 KB) when the project registers no fixed-pitch font, so code blocks (Shiki, Code Hike) line up instead of falling back to a proportional face. A registered monospace font still wins.
- SVG `<linearGradient>` and `<radialGradient>` blend their stops without premultiplying alpha, as Chrome does: a stop going from opaque red to `rgba(0,0,255,0)` passes through purple and fades out, where it used to fade to clear red. CSS gradients still blend premultiplied.
### Added

- `render`, `still`, `doctor`, `studio` and the other commands that open a project download what a project loads from the web before frame 0, then draw offline. HyperFrames pages: CDN scripts, data, media, pictures and fonts, as `fetch-deps` did. Remotion projects: the https pictures, videos and audio that `<Img>`, `<Video>` and CSS `url()` name in the bundle. `--offline` never downloads. `fetch-deps` stays as the explicit command, works on Remotion entries, and gains `--update`.
- `kinetograph.lock.json` beside the entry pins every downloaded file (URL to SHA-256 and size), written on first download. Later runs check the cache against it and stop with the URL on a mismatch; `fetch-deps --update` accepts new bytes. A Remotion URL first requested in the middle of a render is downloaded once, added to the lock and noted. Cache writes are atomic (the hash first, the file last), so parallel workers on a first render never read half a file.
- HyperFrames: `<script type="importmap">` (`imports`, `scopes`, trailing-slash prefixes) and `<script type="module">` that import. The graph (bare names through the map, URLs, relative paths, `export * from`, esm.sh `/v135/...` paths, dynamic `import("...")`) is downloaded in the pre-pass, locked, and each module script is bundled by esbuild from the cache into a classic script that runs after the classic scripts, in document order. `import.meta.url` is the module's URL. `cdn.skypack.dev` joins the default hosts.

## 0.2.0 (2026-10-27)

### Added

- `kinetograph render` and `still` print which renderer draws (`renderer: Skia GPU (Metal)`, `Skia CPU (no GPU found)` or `Skia CPU (KINETOGRAPH_SKIA_CPU=1)`), and `doctor` with no entry lists it too. The addon's `Renderer` has a `backend()` method for it.
- `libx264` and `libx265` in the npm packages. The platform packages (`@kinetographdev/native-<platform>`) now carry a separate GPL `ffmpeg` program in `bin/` (x264, x265 and libvpx; the addon itself still links only an LGPL ffmpeg), and the addon runs it as a child process for the encoders it lacks. H.264 now defaults to libx264 where there is no hardware encoder, ahead of libopenh264. `KINETOGRAPH_FFMPEG` points at another ffmpeg. The addon's ffmpeg also gained libvpx (VP8, VP9) on macOS and Linux. See `/docs/ffmpeg-license/`.
- `<Video datamosh>`: smear one shot into the next, using the video's own motion vectors. See the Datamosh guide on the site at `/docs/guides/datamosh/`. ([#5](https://github.com/0xS4N4TG/kinetograph/pull/5))
- GSAP support, including the free plugins (SplitText, MotionPath, DrawSVG, TextPlugin, Flip). Build a paused timeline and seek it to each frame. See `/docs/compat/#gsap`. ([#7](https://github.com/0xS4N4TG/kinetograph/pull/7))
- HTML text outlines: `-webkit-text-stroke` and `paint-order: stroke fill`, drawn with Chrome's miter joins, and working with `text-shadow`, transforms, opacity and `background-clip: text`. ([#8](https://github.com/0xS4N4TG/kinetograph/pull/8))
- WebGL: points (`gl_PointSize`, up to 511 px), instancing (divisor 1), `blitFramebuffer`, `texSubImage2D` into framebuffer textures and `gl_VertexID`. p5.brush's standalone build draws as it does in Chrome, and all 14 HyperFrames WebGL shader transitions draw. ([#9](https://github.com/0xS4N4TG/kinetograph/pull/9))
- Studio: a "Copy for agent" button that copies a change request for a coding agent, and a timeline that shows it is loading instead of staying empty. ([#6](https://github.com/0xS4N4TG/kinetograph/pull/6))
- Studio: readable layer names (component, text, and the file and line each came from); a simpler timeline with one row per Sequence, repeated components folded and a "Show details" toggle; and an Agent tab that chats with your coding agent over ACP about a layer or area you select in the preview. The studio now needs the per-launch `?token=` link it prints, and the agent is off on non-loopback hosts unless `--allow-remote-agent` is passed.
- HyperFrames projects render as they are: `kinetograph render|still|doctor|studio <index.html|dir>`, with nested compositions, GSAP timelines seeked as HyperFrames seeks them, `data-hidden`, `data-color-grading`, speed ramps and volume lanes, HyperFrames' 18 embedded fonts, and `kinetograph fetch-deps` to cache the CDN scripts, data and media a page uses (a render never touches the network). See `/docs/compat/#hyperframes-projects`. ([#13](https://github.com/0xS4N4TG/kinetograph/pull/13))
- `kinetograph fetch-deps` downloads the remote pictures of a HyperFrames page (`<img>`, `srcset`, `<video poster>`, SVG `<image>`, CSS `url()`) into the cache, under the same rules as scripts and media: https only, the default CDNs plus `--allow-host`, no redirect to another host, a hash checked on every read, 50 MB each. A render reads them from the cache, and a picture that is not cached is reported with the exact `fetch-deps` command. See `/docs/compat/#hyperframes-projects`.
- GSAP tweens that play by themselves (`gsap.to` in a `useEffect`, with no paused timeline): GSAP's root clock follows the frame, a frame is the same alone and in sequence, and a jump to a later frame renders the frames it skips. Flip works on a paused timeline. See `/docs/compat/#gsap`.
- `async` effects and `<HtmlInCanvas>` programs: an `async` `createEffect` `apply`, `onInit` or `onPaint` holds the frame until its promise settles, and a rejection is reported for the frame.
- WebGPU on a canvas: buffers, WGSL shaders, render pipelines and draws, replayed on the engine's own GPU device, so HyperFrames' shader backgrounds (aurora, blob, ripples, swirl) draw. Textures, samplers and compute are reported, not drawn. ([#15](https://github.com/0xS4N4TG/kinetograph/pull/15))
- WebGPU compute: compute pipelines (explicit layouts and `layout: 'auto'`), compute passes and `dispatchWorkgroups`, storage buffers and storage textures (`rgba32float`, `rgba16float`, `rgba8unorm`, `r32float` and the rest of WebGPU's table), 32-bit float textures sampled as `unfilterable-float`, and `clearBuffer`, replayed in submit order with the render passes. `device.limits` and `adapter.limits` are the engine device's own; every dispatch, binding and format is checked on the page side and again before the frame is drawn, and the work a frame holds is capped. The steps that made state a page carries from frame to frame are replayed from their history, and a frame that reads state an earlier frame made is reported. The 13 `shaders.iife.js` blocks that use textures and compute (`chrome-orb`, `frost`, `goo`, `heatmap`, `hologram`, `holographic`, `light-edge`, `liquid-metal`, `nebula`, `obsidian`, `plastic`, `thin-film`, `water`) draw with nothing reported.
- Plugins for libraries that run their own clock or randomness: `@kinetographdev/gsap`, `@kinetographdev/p5-brush`, `@kinetographdev/anime` and `@kinetographdev/motion`. Each is a thin wrapper that seeks the library to the frame; the libraries are peer dependencies, unchanged. See `/docs/libraries/`.
- Library support: Recharts, d3-selection, anime.js, Motion's `animate()`, Paper.js and Bklit UI now render, and Rapier draws its first frame. The DOM gained `NodeList`/`HTMLCollection`, `compareDocumentPosition`, `document.defaultView`, `customElements` and the `*AttributeNS` methods. ([#12](https://github.com/0xS4N4TG/kinetograph/pull/12))

### Fixed

- Canvas 2D gradients blend their stops without premultiplying alpha, as Chrome does: a gradient from transparent green to opaque red keeps its green in the middle. CSS gradients still blend premultiplied. HyperFrames' `transitions-destruction` now draws as in Chrome.
- `kinetograph doctor` counted frames twice in its summary ("nothing unsupported in 0 of 10 frames; with unsupported content: 10"). It now says "10 of 10 frames (100.0%) have unsupported content; 0 are clean", or "all N frames are clean".
- SVG files draw as pictures: `<Img src={staticFile('shape.svg')}>`, `<img src>`, `background-image: url(x.svg)` and `image` layers. The picture is sized from the file's `width`, `height` and `viewBox` (300 x 150 with none) and painted at the size it is drawn at, so it is sharp at any scale. Text inside such a picture is left out and warned about, as a browser sets it in none of the page's fonts. A file that cannot be read is reported by `doctor`. ([#30](https://github.com/0xS4N4TG/kinetograph/issues/30))
- Scene colours take any CSS colour, not only hex: the 148 names (`white`), `rgb()`, `hsl()`, `hwb()`, `lab()`, `oklch()`, `color()`, with commas or spaces. `background: 'white'` was rejected with `colour "white" must start with '#'`. ([#30](https://github.com/0xS4N4TG/kinetograph/issues/30))
- An element that starts at `width: 0` (or any zero length) and is animated wider by a script, such as anime.js `width: [0, 100]`, now draws. `element.style` gave `0` back where a browser gives `0px`, so anime.js wrote a unitless `55.5` that CSS drops. Zero lengths now read back as `0px`.
- `<TransitionSeries>` and `<Series>` accept children wrapped in a `React.Fragment`, nested ones too, so a `.map()` can emit a Transition and Sequence pair as Remotion allows. ([#31](https://github.com/0xS4N4TG/kinetograph/issues/31))
- Machines with a Vulkan 1.4 driver no longer fall back to the CPU. ([#1](https://github.com/0xS4N4TG/kinetograph/issues/1), [#2](https://github.com/0xS4N4TG/kinetograph/pull/2))
- A frame renders the same when the document was edited between frames: an inline box now sits on its baseline in an edited document as it does in a fresh one. ([#3](https://github.com/0xS4N4TG/kinetograph/pull/3))
- SVG `<text>` inherits font family, size, weight and style from the HTML around the `<svg>`. ([#4](https://github.com/0xS4N4TG/kinetograph/pull/4))
- Text with a glow, shadow, opacity or rotation keeps its descenders and the edge of its glow instead of being cut at the line box. ([#8](https://github.com/0xS4N4TG/kinetograph/pull/8))
- `getComputedStyle` and `getBoundingClientRect` on an element inside an `AbsoluteFill` that has a background no longer fail with "no element at path". ([#7](https://github.com/0xS4N4TG/kinetograph/pull/7))
- Page CSS styles SVG content: class, descendant and attribute selectors reach `fill`, `stroke`, fonts, `text-anchor`, `paint-order` and the other presentation properties. ([#14](https://github.com/0xS4N4TG/kinetograph/pull/14))
- SVG `fill`, `stroke` and `stop-color` of `var()`, `oklch()`, `oklab()`, `color-mix()` or `rgb(r g b / a)` were drawn black; they now draw in their colour, and a colour that cannot be read is reported. ([#14](https://github.com/0xS4N4TG/kinetograph/pull/14))
- Page CSS gives SVG shapes `transform` (with `rotate`, `scale`, `translate` and `transform-origin`), `filter: url(#id)`, `clip-path: url(#id)` and `mask: url(#id)`, with shapes a script adds and rules inside `@media` styled through the same cascade. HyperFrames no longer re-applies such rules in TypeScript.
- An MP4 whose moov atom is at the end decodes its audio. ([#14](https://github.com/0xS4N4TG/kinetograph/pull/14))
- `document.getElementById` and `querySelector` find nodes appended to `<body>` outside the React root, and SVG `<text>` measures its real size in `getBBox` and `getComputedTextLength`. ([#12](https://github.com/0xS4N4TG/kinetograph/pull/12))
- `transform-style: preserve-3d` on an element with `opacity`, a `filter`, `clip-path`, `mask`, `mix-blend-mode`, `isolation: isolate`, `contain: paint`, `backdrop-filter` or `overflow: hidden` failed the render with "a preserve3d group cannot have effects". Such an element is now flattened, as CSS Transforms 2 and Chrome do, and drawn as a flat group with its effect.
- `kinetograph doctor` runs the scene validation a render runs on every frame, and lists a scene the render would refuse (with its frames, exit code 1). It used to report only what is unsupported, so a project that cannot render looked fine.

- A character the font lacks (`→`, `✓`, `≈`, an emoji) is no longer drawn as a box. Text falls back, one character at a time, to the rest of the `font-family` list and then to Noto Sans Symbols 2, Noto Sans Math and Noto Emoji (monochrome), which ship inside the native addon (about 1.1 MB, SIL OFL). This covers HTML text, SVG `<text>`, text layers, Text3D and canvas `fillText`. A character no font has (CJK, for one) is still drawn as a box, but `doctor` and `--strict` now report it with its code point and the font list (`font-family`, "no glyph for U+2192 ..."); `inspect` lists it as `missingChars`. ([#32](https://github.com/0xS4N4TG/kinetograph/issues/32))

### Changed in behaviour

- A DOM measurement the engine cannot answer (a `getComputedStyle` or `getBoundingClientRect` lookup) is now a warning, and the script gets the element's own style. The render goes on. `--strict` still makes it an error.
- The `AbsoluteFill` background is written as a hex colour (`#rrggbb`) in scene JSON and `inspect` output. A named colour no longer fails the render.
- Text with a glow, shadow, opacity or rotation renders slightly differently at its edges (the descender and glow fix above). Re-approve snapshot tests that cover such text. ([#8](https://github.com/0xS4N4TG/kinetograph/pull/8))
- A WebGL canvas starts each frame empty. `preserveDrawingBuffer` no longer carries one frame's drawing into the next, since every frame must render on its own. ([#9](https://github.com/0xS4N4TG/kinetograph/pull/9))
- `requestAnimationFrame` callbacks run after the frame renders, and a jump to a later frame runs them through the frames it skips, so libraries with their own frame loop (Motion) give the same frame alone and in sequence. ([#12](https://github.com/0xS4N4TG/kinetograph/pull/12))
- The bundler reads a package's `browser` map, for imports that would not resolve otherwise. ([#12](https://github.com/0xS4N4TG/kinetograph/pull/12))

## 0.1.0 (2026-10-23)

First public release, in beta.

- The renderer: a Rust GPU compositor (wgpu, Skia) loaded into Node as an N-API addon, with effects, a 2.5D camera, motion blur and a layer cache.
- Remotion compatibility: `remotion` and `@remotion/*` imports resolve to Kinetograph's own implementation, drawn by a native DOM engine for CSS, SVG, Canvas 2D and WebGL fragment shaders.
- An own 3D layer (glTF, PBR) and Lottie.
- Audio through Web Audio, mixed into the render.
- The `kinetograph` CLI (`still`, `strip`, `render`, `inspect`), an MCP server, the studio and an agent skill.
