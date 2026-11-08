# What the engine draws and uses

One line each; the pointer has the detail. `kinetograph doctor` alone lists the renderer and what this install can do.

## `@remotion/*` and friends

- `@remotion/transitions`, `motion-blur`, `noise`, `paths`, `shapes`, `layout-utils`, `animation-utils`, `captions`,
  `fonts`, `lottie` and `@remotion/google-fonts/<Family>` import as usual. Other `@remotion/*` packages do not exist yet,
  except those below.
- `@remotion/rive`'s `<RemotionRiveCanvas src={staticFile('a.riv')}>` plays a Rive file with Rive's own runtime (frame
  exact; `stateMachine` and `stateMachineInputs` props added; referenced assets beside the `.riv` or from `assetLoader`).
- `@remotion/skia` and `@shopify/react-native-skia` (`<SkiaCanvas>`, RN-Skia's components, SkSL shaders) run on real Skia
  (Reanimated shared values, `FitBox`, surfaces, `Skia.Data`/`Image`/`Typeface`, animated images, paragraph measurement,
  paint shaders, SVG text included) in the optional `@kinetographdev/skia` addon (`npm install @kinetographdev/skia`; the
  first Skia canvas says so if it is missing).
- `@remotion/sfx` sounds (`whip`, `ding`, …) play with `<Audio src={whip} />`. The first render downloads each sound into
  `~/.cache/kinetograph/sfx`; after that it is offline.
- `@remotion/zod-types` (`zColor`, `zMatrix`, `zTextarea`) bundles for a `<Composition schema>`; Kinetograph does not check
  the props against the schema.
- `@remotion/timeline-utils` (waveform peaks and drawing, loop and frame-strip maths) works for local files; what needs
  video pictures as WebCodecs frames (`extractFrames`) throws an `UnsupportedApiError` saying so.
- `@remotion/media-parser`'s `parseMedia` reads local files (`staticFile('video/clip.mp4')`) through FFmpeg: duration,
  dimensions, fps, codecs, tracks, rotation, sample rate, metadata, and the slow fields. Not the box tree
  (`slowStructure`) or sample callbacks (`onVideoTrack`); URLs fail, as everywhere (offline).
- `@remotion/webcodecs` bundles; `convertMedia` writes a file's sound to WAV and the lists and track checks work, the
  rest (video encode and decode, `extractFrames`) throws an `UnsupportedApiError`. `@remotion/canvas` is Remotion
  Studio's editor canvas: it bundles, and every call throws the same error.

## Compat mode

A project written for Remotion may use DOM elements, `style`, `className` and stylesheets (`.css` imports, `<style>`,
Tailwind) and SVG next to the native ones. The engine styles and lays them out with its own CSS engine (`ENGINE.md`) and
draws what it can. There is no browser: a frame holding anything it cannot draw yet is still drawn, without that item or
approximated, and `still`, `strip` and `render` print a `warning:` on stderr naming each kind (element, property, values,
reason, frames); with `--json` the same list is in the result under `compat.leftOut`. `--strict` fails with
`UNSUPPORTED_CONTENT` on the first such frame instead. Reading the report is in `kinetograph-render`.

- Refs to DOM elements answer `getBoundingClientRect` and friends from the same CSS engine, `useLayoutEffect`
  measure-then-render code settles within the frame, and `fetch`, `new Image()` and `matchMedia` work for project files
  and the composition's size; there is no network.
- `<canvas>` with `getContext('2d')` is drawn natively (paths, gradients, text, shadows, filters, `drawImage`,
  `getImageData`; `<Video onVideoFrame>` hands the frame to `drawImage` and `getImageData` reads its pixels), and so are
  `webgl`/`webgl2` contexts. `<Canvas width height draw={(ctx) => ...} />` is the native element for the same drawing.
- In a component, a canvas you draw to in a frame starts that frame empty; one you don't touch keeps its pixels. Draw the
  whole frame from the frame number every time, never on top of what an earlier frame drew.

## Formats, fonts and libraries

- **SVG files as pictures.** `<Img src={staticFile('images/a.svg')}>`, `<img>`, `background-image`, `data:` URLs; text
  inside an SVG picture is not drawn (warned). ENGINE.md "SVG files as pictures".
- **Scene colours** take any CSS colour (`white`, `rgb()`, `hsl()`, `oklch()`, ...), not only hex. SCENE.md, top.
- **Missing glyphs.** A character the font lacks falls back per character to bundled Noto Symbols 2, Math and Emoji
  (monochrome). CJK is not bundled: load a font. A character no font has is reported by `doctor`, `--strict` and
  `inspect` (`missingChars`). `monospace` is the bundled JetBrains Mono (Regular) unless you load a mono font. ENGINE.md
  "Fallback fonts".
- **`<Series>` / `<TransitionSeries>`** accept Fragment-wrapped children, so `.map()` can emit pairs. AUTHORING.md §7.1.
- **GSAP** (core, free plugins, Flip): seek a paused timeline to `frame / fps`, or let `gsap.to` play by itself.
  AUTHORING.md §11.9, `/docs/compat/#gsap`.
- **Plugins** `@kinetographdev/gsap`, `p5-brush`, `anime`, `motion`: seek a library with its own clock to the frame.
  AUTHORING.md §11.10, `/docs/plugins/library-adapters/`.
- **Libraries that render:** Recharts, d3-selection, anime.js, Motion `animate()`, Paper.js, Bklit, rough.js, Chart.js,
  Plot, Vega, Shiki (code falls back to a bundled JetBrains Mono); Mermaid draws with its default HTML labels
  (`<foreignObject>`). AUTHORING.md §11.10.
- **Canvas.** `<Canvas width height draw>` or `<canvas>` + `getContext('2d'|'webgl'|'webgl2'|'webgpu')`; in a component,
  redraw the whole frame each time. AUTHORING.md §6.5 to §6.7. `preserve-3d` with effects is flattened (ENGINE.md).
- **`<Video datamosh>`** smears one shot into the next with the video's motion vectors. AUTHORING.md §11.8,
  `/docs/guides/datamosh/`.

## HTML pages and HyperFrames

- **HyperFrames projects** render as they are: `render|still|doctor|studio <index.html|dir>`; the run downloads CDN
  scripts, ES modules, media and pictures first and pins them in `kinetograph.lock.json` (no need to run `fetch-deps`
  first; `--offline` never downloads; `fetch-deps --update` refreshes the lock). AUTHORING.md §11.11,
  `/docs/compat/#hyperframes-projects`.
- **A plain HTML page** (no React) renders the same way: give the root element `data-composition-id`, `data-width`,
  `data-height` and `data-duration` (seconds; 30 fps), or it renders at 1920x1080 for 1 s; `doctor`, `render` and `still`
  warn when they are missing. Scripts run as in a browser; `requestAnimationFrame` gets each frame's time (frame 45 is
  1500 ms). A page's canvas keeps its pixels from frame to frame (trails work) and a single frame replays the calls before
  it, so a still matches the same frame of a render.

## Motion tracking

`kinetograph track public/video/clip.mp4 --point x,y` (video pixels of the first frame, y down; find the point in a still)
runs Blender's tracker once and writes `clip.mp4.track.json` beside it; in a component
`const { x, y, rotation, scale, corners } = useTrack('video/clip.mp4.track.json')` (from `@kinetographdev/core`) pins
anything to it. Check the `lost` frame it prints; use `--model locrotscale` for rotation and scale. `--detect` finds points
itself (Blender's Detect Features); `--plane p1,p2,p3,p4` makes a plane track from 4+ points on a flat surface, and
`cornerPin(usePlaneTrack(file).pin)` pins a picture to it. AUTHORING.md §11.12, `/docs/guides/motion-tracking/`.
