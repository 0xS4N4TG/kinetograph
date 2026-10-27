---
name: kinetograph
description: Make videos and motion graphics with Kinetograph. Write Remotion-shaped TSX (useCurrentFrame, interpolate, spring, Sequence, native elements) and Web Audio code, look at frames with `kinetograph still` and `strip`, check them with `inspect` and `lint`, then `render` to MP4. Use when asked to build, edit, preview or render a video, animation, title card or sound design with Kinetograph.
---

# Working with Kinetograph

Kinetograph renders video without a browser. You write TypeScript with the Remotion API and a few native elements; Node
runs it; a GPU compositor draws it. You cannot watch a video, so you look at single frames and read the scene graph.

To move an existing Remotion project onto Kinetograph, use the `kinetograph-migrate` skill.

Run everything as `npx kinetograph <command>`. Add `--json` to get one JSON object you can parse; a failure is
`{ "error": { "code", "message" } }` with exit code 1. (Over MCP (`kinetograph mcp`) there is one tool per command except `studio`, named
like the command (`audio analyze` is `audio_analyze`), with the same arguments; `still`, `strip` and `onion` return the image
itself, and `output` is optional for them.)

## The loop

1. **Write** a project file, e.g. `src/index.tsx`, that calls `registerRoot` (see below).
2. **Look.** `kinetograph still src/index.tsx 45 -o out/f45.png` for one frame; `kinetograph strip src/index.tsx -n 12 -o out/strip.png`
   for twelve labelled frames at once (do this first, it shows the whole animation); `kinetograph onion src/index.tsx 0..60 -n 6 -o out/path.png`
   to see a motion path. Open the PNG to look at it.
3. **Check** without pixels: `kinetograph inspect src/index.tsx --frame 45` gives every layer's resolved position, size,
   bounds, effects and text lines. `kinetograph lint src/index.tsx` (`--frames 0,45,89` picks the frames; default 8 spread out) reports text overflowing its box or the canvas,
   layers off the canvas, overlapping text, missing fonts and assets, each with the frame and layer id. Fix what it
   says. It only checks what a frame can show: a layer at opacity 0 (or inside a group at opacity 0) and one that its
   clip cuts away completely are skipped at that frame, so a toast fading in off the canvas is not reported while hidden.
   Rendering never type-checks, so a misspelled prop (`opactiy={0.5}`) draws at full opacity without an error;
   `kinetograph check src/index.tsx` runs `tsc --noEmit` on the project (its nearest `tsconfig.json`) and `lint` reports
   the same errors as `type-error`.
4. **Fix** and repeat from 2. A still takes well under a second.
5. **Render.** `kinetograph render src/index.tsx -o out/video.mp4`. Use `--draft` for a half-size quick look,
   `--range 0..90` for a part (`a..b` is a to b-1, `a..=b` includes b), `--concurrency 4` to draw several frames at once
   on a long film (the file is the same). Export options are Remotion's: `--scale 2` for 4K from 1080p (drawn at that
   size, not upscaled), `--codec h265|prores|vp9|gif` (the output extension must fit: `.mov` for prores, `.webm` for vp9,
   `.gif` for gif), `--crf 20` or `--video-bitrate 8M` (not both), `--prores-profile 4444`, `--pixel-format yuv444p`,
   `--audio-codec opus`, `--audio-bitrate 320k`, and for a gif `--every-nth-frame 2`. Bad combinations are refused with
   what to change. React runs in production mode (faster); `--dev-react` keeps the development build when you want
   React's warnings.

Also: `compositions <entry>` lists compositions (pick one with `--comp <id>`; pass props with `--props '{"title":"Hi"}'`),
`audio analyze <entry>` measures the sound, `snapshot <entry> --update` approves frames and `snapshot <entry>` later
diffs against them, `bench <entry>` times the stages, `effects` lists effects, `doctor <entry>` says what the engine
cannot draw and in which frames (see "Compat mode and doctor"; `doctor` alone says what this install can do).
`studio <entry>` starts the local studio (preview, timeline, scene tree, props, render queue) at `http://127.0.0.1:3000`
and opens a browser; it is for the person at the screen, runs until stopped, and is not an MCP tool. Use `--no-open`
when you start it yourself.

An entry is a project file (`.tsx`, `.ts`, `.jsx`, `.js`) or a `.json` scene (references/SCENE.md); every command takes both.

## A project

```tsx
import { AbsoluteFill, Composition, Layer, Rect, Text, interpolate, registerRoot, spring,
         useCurrentFrame, useVideoConfig, dropShadow, linearGradient, registerFont, staticFile } from 'remotion';

registerFont({ family: 'DM Sans', path: staticFile('DMSans-Medium.ttf') }); // fonts BEFORE any text is measured

const Card = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 14 } });
  return (
    <AbsoluteFill style={{ backgroundColor: '#10131a' }}>
      <Layer x={width / 2} y={height / 2} scale={s} origin="center" effects={[dropShadow({ y: 12, blur: 24 })]}>
        <Rect width={600} height={300} radius={32} fill={linearGradient(['#f9a', '#fc6'])} />
        <Text font="DM Sans" size={72} color="#fff" x={60} y={100}>gets better</Text>
      </Layer>
    </AbsoluteFill>
  );
};

registerRoot(() => <Composition id="Main" component={Card} durationInFrames={90} fps={30} width={1080} height={1920} />);
```

- Remotion's API works as documented: `useCurrentFrame`, `useVideoConfig`, `interpolate`, `interpolateColors`, `spring`,
  `Easing`, `random`, `Sequence`, `Series`, `Loop`, `Freeze`, `AbsoluteFill`, `Img`, `staticFile`, `delayRender`.
  `staticFile('x.png')` is `public/x.png` next to the entry file.
- `@remotion/transitions`, `motion-blur`, `noise`, `paths`, `shapes`, `layout-utils`, `animation-utils`, `captions`,
  `fonts`, `lottie` and `@remotion/google-fonts/<Family>` import as usual. `@remotion/rive`'s `<RemotionRiveCanvas src={staticFile('a.riv')}>` plays a Rive file with Rive's own runtime (frame
  exact; `stateMachine` prop added). `@remotion/skia` and `@shopify/react-native-skia` (`<SkiaCanvas>`, RN-Skia's components, SkSL shaders) run on real Skia
  in the optional `@kinetographdev/skia` addon (`npm install @kinetographdev/skia`; the first Skia canvas says so if it is
  missing). Other `@remotion/*` packages do not exist yet.
  For new work, use the elements below. `<div>`s, `className`, stylesheets (`.css` imports, `<style>`, Tailwind) and SVG
  also work (compat mode, see "Compat mode and doctor"): the engine's own CSS engine styles, lays out and draws them,
  and a frame holding something it cannot draw yet is drawn without it (or approximated) and the command warns.
- `@remotion/sfx` sounds (`whip`, `ding`, …) play with `<Audio src={whip} />`. The first render downloads each sound
  into `~/.cache/kinetograph/sfx`; after that it is offline.
- `@remotion/zod-types` (`zColor`, `zMatrix`, `zTextarea`) bundles for a `<Composition schema>`; Kinetograph does not
  check the props against the schema.
- `@remotion/timeline-utils` (waveform peaks and drawing, loop and frame-strip maths) works for local files; what needs
  video pictures as WebCodecs frames (`extractFrames`) throws an `UnsupportedApiError` saying so.
- `@remotion/media-parser`'s `parseMedia` reads local files (`staticFile('clip.mp4')`) through FFmpeg: duration,
  dimensions, fps, codecs, tracks, rotation, sample rate, metadata, and the slow fields. Not the box tree
  (`slowStructure`) or sample callbacks (`onVideoTrack`); URLs fail, as everywhere (offline).
- `@remotion/webcodecs` bundles; `convertMedia` writes a file's sound to WAV and the lists and track checks work, the
  rest (video encode and decode, `extractFrames`) throws an `UnsupportedApiError`. `@remotion/canvas` is Remotion
  Studio's editor canvas: it bundles, and every call throws the same error.
- Rendering is a pure function of the frame number. `Math.random()`, `Date.now()` and timers are driven by the frame;
  use `random(seed)` for jitter. Never read the real clock.
- Register fonts before text is laid out. Text with a font that is not registered is a lint error.

## Elements and effects

Every element takes `id`, `x`, `y`, `scale`, `rotation`, `origin="center"`, `opacity`, `blendMode`, `effects`, `clip`,
`mask`, `matte`, `motionBlur`, and 3D `z`, `rotateX`, `rotateY`. Numbers may be plain or keyframe lists.

| Element | For |
|---|---|
| `<Layer>` | a group; `layout` (flexbox) and `preserve3d` |
| `<Rect>`, `<Ellipse>`, `<Path>`, `<Shape>` | vector shapes with `fill` (colour or gradient) and `stroke` |
| `<Text>` | text; `font`, `size`, `color`, `maxWidth`, `align`, per-character `chars` |
| `<Image>`, `<Img>` | PNG, JPEG, GIF, WebP, SVG files; `fit="cover"` |
| `<Noise>`, `<MeshGradient>`, `<Lottie>` | generated and Lottie layers |
| `<Camera>` | a perspective camera for 3D transforms |
| `<Audio>` | a sound file: `src`, `volume`, `trimBefore`, `playbackRate`, `loop` |

Effects (helpers of the same name; `kinetograph effects` lists their fields): `blur`, `backdropBlur`, `glow`,
`chromaticAberration`, `dropShadow`, `insetShadow`, `saturate`, `contrast`, `brightness`, `grayscale`, `sepia`, `invert`,
`hueRotate`, `gradientMap`, `lut`, `grain`, `dither`, `halftone`, `dotMatrix`, `displace`, `cornerPin`, and `shader`
for your own WGSL. `motionBlur({ samples: 8 })` goes in the same `effects` array.

The details are in this skill's references: `references/AUTHORING.md` (§5 helpers, §6 elements and their JSON, §7 the
Remotion API), `references/SCENE.md` (every layer type, effect and field; the exact meaning of each),
`references/ENGINE.md` (the DOM engine) and `references/INTERNALS.md` (how a frame is made, the code map).

## Sound

Web Audio code runs offline against the frame timeline. Call `onFrame` at module level; `ctx` is an
`OfflineAudioContext`, `t` is the start time in seconds.

```ts
import { onFrame } from '@kinetographdev/audio';

onFrame(42, (ctx, t) => {
  const o = ctx.createOscillator(); const g = ctx.createGain();
  o.frequency.setValueAtTime(3000, t); o.frequency.exponentialRampToValueAtTime(4500, t + 0.055);
  g.gain.setValueAtTime(0.4, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.06);
});
```

`<Audio src={staticFile('music.mp3')} volume={(f) => interpolate(f, [0, 30], [0, 1])} />` plays a file. `render` mixes
both into the video. Check it with `kinetograph audio analyze src/index.tsx`: `integratedLufs` (null means silence),
`truePeakDb` (keep it under -1), `clippedSamples` (should be 0) and `silences`. Aim for about -14 LUFS for online video.

## Compat mode and doctor

A project written for Remotion may use DOM elements, `style`, `className` and stylesheets next to the native ones. The
engine styles and lays them out with its own CSS engine (references/ENGINE.md) and draws what it can. There is no browser:
a frame holding anything it cannot draw yet is still drawn, without that item or approximated, and `still`, `strip`
and `render` print a `warning:` on stderr naming each kind (element, property, values, reason, frames); with `--json`
the same list is in the result under `compat.leftOut`. Pass `--strict` to `still`, `strip` or `render` to fail with
`UNSUPPORTED_CONTENT` on the first such frame instead of getting an approximate picture. Find out what is missing
before a long render. Refs to DOM elements answer `getBoundingClientRect` and
friends from the same CSS engine, `useLayoutEffect` measure-then-render code settles within the frame, and `fetch`,
`new Image()` and `matchMedia` work for project files and the composition's size, and `<canvas>` with
`getContext('2d')` is drawn natively (paths, gradients, text, shadows, filters, `drawImage`, `getImageData`), and so
are `webgl`/`webgl2` contexts; there is no network. `<Canvas width height draw={(ctx) => ...} />` is the native
element for the same drawing. In a component, a canvas you draw to in a frame starts that frame empty; one you don't touch
keeps its pixels. Draw the whole frame from the frame number every time, never on top of what an earlier frame drew.

`kinetograph doctor src/index.tsx` runs the JS stage for every frame (no GPU) and reports:

- how many frames have nothing unsupported (`cleanFrames`, `unsupportedFrames`, `cleanShare`);
- each **issue**, grouped by element, property and reason, the one on the most frames first: `values` it was seen with,
  the element `paths` (`$0.2 <div>`, the host-tree position) and the inclusive frame `ranges`.

`--range 0..90` limits the frames, `--comp` and `--props` choose the composition and its props. A `stylesheets:` note
in the report says a stylesheet could not be used (Tailwind that could not be built, a remote font).

How to read it: an issue with a `property` is that CSS property on that element; one with `null` is the element itself
(unsupported). 100% clean means nothing is left out. To bring the share up, remove or replace what the top issues name
(a property the painter does not draw yet becomes one it does), then run `doctor` again. `lint` also lists each
issue as a `compat` warning (it does not fail), but only for the frames it samples; `doctor` checks them all.

## What 0.2.0 can draw and use

One line each; the pointer has the detail. `kinetograph doctor` alone lists the renderer and what this install can do.

- **Encoders.** `--encoder libx264|libx265` run in the bundled GPL `ffmpeg` program (`KINETOGRAPH_FFMPEG=/path` uses
  another); H.264 defaults to libx264 off macOS hardware; VP9 on macOS and Linux; `--crf`, `--video-bitrate`.
  AUTHORING.md §9 (render flags), `/docs/ffmpeg-license/`.
- **SVG files as pictures.** `<Img src={staticFile('a.svg')}>`, `<img>`, `background-image`, `data:` URLs; text inside
  an SVG picture is not drawn (warned). ENGINE.md "SVG files as pictures".
- **Scene colours** take any CSS colour (`white`, `rgb()`, `hsl()`, `oklch()`, ...), not only hex. SCENE.md, top.
- **Missing glyphs.** A character the font lacks falls back per character to bundled Noto Symbols 2, Math and Emoji
  (monochrome). CJK is not bundled: load a font. A character no font has is reported by `doctor`, `--strict` and
  `inspect` (`missingChars`). `monospace` is the bundled JetBrains Mono (Regular) unless you load a mono font. ENGINE.md "Fallback fonts".
- **`<Series>` / `<TransitionSeries>`** accept Fragment-wrapped children, so `.map()` can emit pairs. AUTHORING.md §7.1.
- **`renderer:` line.** `render`, `still` and `doctor` print `Skia GPU (Metal)` or `Skia CPU (...)`; CPU means slow.
- **GSAP** (core, free plugins, Flip): seek a paused timeline to `frame / fps`, or let `gsap.to` play by itself.
  AUTHORING.md §11.9, `/docs/compat/#gsap`.
- **Plugins** `@kinetographdev/gsap`, `p5-brush`, `anime`, `motion`: seek a library with its own clock to the frame.
  AUTHORING.md §11.10, `/docs/libraries/`.
- **Libraries that render:** Recharts, d3-selection, anime.js, Motion `animate()`, Paper.js, Bklit, rough.js, Chart.js,
  Plot, Vega; Shiki is close (needs a mono font); Mermaid is broken (pre-render to SVG). AUTHORING.md §11.10.
- **HyperFrames projects** render as they are: `render|still|doctor|studio <index.html|dir>`; the
  run downloads CDN scripts, ES modules, media and pictures first and pins them in `kinetograph.lock.json` (no need to run
  `fetch-deps` first; `--offline` never downloads; `fetch-deps --update` refreshes the lock). AUTHORING.md §11.11, `/docs/compat/#hyperframes-projects`.
- **A plain HTML page** (no React) renders the same way: give the root element `data-composition-id`, `data-width`,
  `data-height` and `data-duration` (seconds; 30 fps), or it renders at 1920x1080 for 1 s. Scripts run as in a browser;
  `requestAnimationFrame` gets each frame's time (frame 45 is 1500 ms). A page's canvas keeps its pixels from frame to
  frame (trails work) and a single frame replays the calls before it, so a still matches the same frame of a render.
- **Canvas.** `<Canvas width height draw>` or `<canvas>` + `getContext('2d'|'webgl'|'webgl2'|'webgpu')`; in a component,
  redraw the whole frame each time (never build on earlier frames). A plain HTML page is the exception (below). AUTHORING.md §6.5 to §6.7. `preserve-3d` with effects is flattened (ENGINE.md).
- **`<Video datamosh>`** smears one shot into the next with the video's motion vectors. AUTHORING.md §11.8,
  `/docs/guides/datamosh/`.

## Habits that save iterations

- `strip` before `render`; `lint` before `strip`. Fix every lint error.
- When a layer is in the wrong place, `inspect` it instead of guessing from the picture: `bounds` and `matrix` are in canvas pixels.
- Give an explicit `id` to matte sources and to anything an `<Audio>` or matte refers to.
- `snapshot --update` once a look is approved, so a later change that moves a pixel by more than 2 levels shows up.
- Run `doctor` on a project that uses DOM elements or CSS, before `render`: it shows what the render will leave out or approximate.
- A task that fails prints the cause: read `error.message` and `error.code` before changing anything.
