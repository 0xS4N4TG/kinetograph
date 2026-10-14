---
name: kinetograph
description: Make videos and motion graphics with Kinetograph. Write Remotion-shaped TSX (useCurrentFrame, interpolate, spring, Sequence, native elements) and Web Audio code, look at frames with `kinetograph still` and `strip`, check them with `inspect` and `lint`, then `render` to MP4. Use when asked to build, edit, preview or render a video, animation, title card or sound design with Kinetograph.
---

# Working with Kinetograph

Kinetograph renders video without a browser. You write TypeScript with the Remotion API and a few native elements; Node
runs it; a GPU compositor draws it. You cannot watch a video, so you look at single frames and read the scene graph.

Run everything as `npx kinetograph <command>`. Add `--json` to get one JSON object you can parse; a failure is
`{ "error": { "code", "message" } }` with exit code 1. (If you are connected to the MCP server there is one tool per
command with the same arguments; `still`, `strip` and `onion` return the image itself.)

## The loop

1. **Write** a project file, e.g. `src/index.tsx`, that calls `registerRoot` (see below).
2. **Look.** `kinetograph still src/index.tsx 45 -o out/f45.png` for one frame; `kinetograph strip src/index.tsx -n 12 -o out/strip.png`
   for twelve labelled frames at once (do this first, it shows the whole animation); `kinetograph onion src/index.tsx 0..60 -n 6 -o out/path.png`
   to see a motion path. Open the PNG to look at it.
3. **Check** without pixels: `kinetograph inspect src/index.tsx --frame 45` gives every layer's resolved position, size,
   bounds, effects and text lines. `kinetograph lint src/index.tsx` reports text overflowing its box or the canvas,
   layers off the canvas, overlapping text, missing fonts and assets, each with the frame and layer id. Fix what it says.
4. **Fix** and repeat from 2. A still takes well under a second.
5. **Render.** `kinetograph render src/index.tsx -o out/video.mp4`. Use `--draft` for a half-size quick look,
   `--range 0..90` for a part (`a..b` is a to b-1, `a..=b` includes b).

Also: `compositions <entry>` lists compositions (pick one with `--comp <id>`; pass props with `--props '{"title":"Hi"}'`),
`audio analyze <entry>` measures the sound, `snapshot <entry> --update` approves frames and `snapshot <entry>` later
diffs against them, `bench <entry>` times the stages, `effects` lists effects, `doctor` says what this install can do.

An entry is a project file (`.tsx`, `.ts`, `.jsx`, `.js`) or a `.json` scene (docs/SCENE.md); every command takes both.

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
  `fonts`, `lottie` and `@remotion/google-fonts/<Family>` import as usual. Other `@remotion/*` packages and arbitrary
  HTML/CSS do not exist yet (`doctor` says so): do not use `<div>`, `style`, CSS or the DOM; use the elements below.
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
| `<Image>`, `<Img>` | PNG/JPEG; `fit="cover"` |
| `<Noise>`, `<MeshGradient>`, `<Lottie>` | generated and Lottie layers |
| `<Camera>` | a perspective camera for 3D transforms |
| `<Audio>` | a sound file: `src`, `volume`, `trimBefore`, `playbackRate`, `loop` |

Effects (helpers of the same name; `kinetograph effects` lists their fields): `blur`, `backdropBlur`, `glow`,
`chromaticAberration`, `dropShadow`, `insetShadow`, `saturate`, `contrast`, `brightness`, `grayscale`, `sepia`, `invert`,
`hueRotate`, `gradientMap`, `lut`, `grain`, `dither`, `halftone`, `dotMatrix`, `displace`, `cornerPin`, and `shader`
for your own WGSL. `motionBlur({ samples: 8 })` goes in the same `effects` array.

The details are in `docs/AUTHORING.md` (§5 helpers, §6 elements and their JSON, §7 the Remotion API) and
`docs/SCENE.md` (every layer type, effect and field; the exact meaning of each).

## Sound

Web Audio code runs offline against the frame timeline. Call `onFrame` at module level; `ctx` is an
`OfflineAudioContext`, `t` is the start time in seconds.

```ts
import { onFrame } from '@kinetograph/audio';

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

## Habits that save iterations

- `strip` before `render`; `lint` before `strip`. Fix every lint error.
- When a layer is in the wrong place, `inspect` it instead of guessing from the picture: `bounds` and `matrix` are in canvas pixels.
- Give an explicit `id` to matte sources and to anything an `<Audio>` or matte refers to.
- `snapshot --update` once a look is approved, so a later change that moves a pixel by more than 2 levels shows up.
- A task that fails prints the cause: read `error.message` and `error.code` before changing anything.
