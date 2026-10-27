# Unsupported and partial: what to do instead

The rule for all of these: draw without it or approximate it, warn, tell the user. `--strict` turns the warning into
the error `UNSUPPORTED_CONTENT`. Never fill the gap with a browser, Chrome, Puppeteer or a hosted page. The list of
known gaps is at `/docs/known-issues/` on the docs site.

## IFrame

A real web page needs a browser, so `<IFrame>` is not drawn and `doctor` reports it. Choose by what the page was:

- A page the user owns (a chart, a slide, a card): rebuild it as components in the project, with HTML, CSS, SVG,
  `<canvas>` or the native elements.
- A third-party page, a video player embed, a map: replace it with a screenshot saved to `public/` and drawn with
  `<Img src={staticFile('shot.png')}>`, or a plain placeholder box with a label. Take the screenshot outside the render
  path, by hand or by the user. Say that it is now a still picture.
- Otherwise leave it out and say so.

With the `<IFrame>` gone, the `resource` finding for its URL (a network request) goes too. Run `doctor` again. A
placeholder box with a label is a fine default when you have no screenshot: say that the real page is not shown.

## @remotion/webcodecs and @remotion/media-parser

- `parseMedia` works on local files (`staticFile('clip.mp4')`) for duration, dimensions, fps, codecs, tracks, rotation,
  sample rate and metadata. URLs fail (no network). The box tree (`slowStructure`) and sample callbacks
  (`onVideoTrack`, `onAudioTrack` with samples) throw `UnsupportedApiError`.
- `convertMedia` writes a file's sound to WAV. Video encode and decode, `extractFrames` and `createVideoDecoder`
  throw `UnsupportedApiError`.
- Use instead: `<Video>` and `<Audio>` from `@remotion/media` or `remotion` to play a clip; `trimBefore`, `playbackRate`,
  `volume` for edits; `kinetograph render` for encoding. If the project extracted frames to build a strip or a
  thumbnail, replace it with a prepared image sequence or still in `public/` made ahead of time with ffmpeg.
- Normal `<Video>` and `<Audio>` are not affected.

## @remotion/rive

`<RemotionRiveCanvas src={staticFile('a.riv')} stateMachine="...">` plays, with `onLoad`, `assetLoader`, `effects` and the
`ref` getters (`getRenderer()` is `null`). Set state machine inputs with `stateMachineInputs` (an object, or
`(frame) => ({ ... })`): this replaces code that sets inputs on the runtime's objects. Put referenced pictures and fonts
beside the `.riv` (`name-id.ext`, as the Rive editor exports them) or give them with `assetLoader`; an asset on Rive's CDN
is not fetched.

## @remotion/skia and @shopify/react-native-skia

Needs the optional addon: `npm install @kinetographdev/skia`. Drawing is CPU only. Reanimated shared values work but live
for one frame: compute them from `useCurrentFrame()` (`useDerivedValue(() => frame * 2)`); `withTiming`, `withSpring` and
the other clock animations jump to their end value and are reported, so replace them with `interpolate`/`spring` on the
frame. `FitBox`, surfaces, `Skia.Data`/`Image`/`Typeface`/`FontMgr`, animated images, paragraph measurement, shaders set on
a `Skia.Paint()` and SVG text are drawn. Not supported: `useVideo`, `makeImageFromView`, `Skia.SVG.MakeFromData`.

## Canvas 2D, WebGL, shaders

- Every canvas (2D, WebGL, WebGPU) starts empty each frame, also with `preserveDrawingBuffer`: redraw the whole frame from
  the frame number instead of painting over the last one.
- Canvas 2D: a pattern of a canvas used for a stroke or text draws transparent; `isPointInStroke` ignores caps, joins
  and dashes; `url()` filters are not drawn; shadow and filter images are capped at 50 megapixels per layer per frame.
  Use a plain `fillStyle`, or draw the pattern as repeated shapes.
- WebGL: framebuffer rendering is limited (no renderbuffers, depth or stencil attachments, cube or float textures,
  lines, instanced points). Points, instancing and `blitFramebuffer` work. `readPixels` is refused. Move to a fragment-shader-only effect, the `shader()` effect
  (WGSL, one pass, own layer only, `f32` uniforms), or redraw the look with gradients and the effects list.
- Libraries built on WebGL (three.js, pixi): see `references/three.md` for 3D. Pixi has no equivalent: redraw it.

## CSS

- `preserve-3d` with planes that cross is drawn back to front without depth. Avoid crossing planes, or use
  `<Scene3D>` (`references/three.md`).
- `background-repeat: space` with thousands of gradient tiles errors. Use fewer tiles.
- Backdrop blur and glow are capped at 128 px.
- An `inline-block` with a transform is drawn twice (slightly heavier edges). Use `display: block`.
- `doctor` names any other property, with the value and frames. Replace it with one the engine draws, or remove it.

## Core internals

`Internals` and `FolderContext` from `remotion` do not exist. Code that reads them is tooling (studio plugins, custom
renderers). Remove it.

## Always

After each leave-out or approximation, write one line for the report: what, where (file, frames), what was done, and
why. Run `doctor` again to confirm it left the report or is now an approximation, then `render --strict`.
