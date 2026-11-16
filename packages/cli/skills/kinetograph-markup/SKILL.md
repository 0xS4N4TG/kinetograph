---
name: kinetograph-markup
description: Write or change a Kinetograph composition: the Remotion API, native elements (Layer, Rect, Text, Image, Camera, Audio), layout, type, fonts, media, effects, Web Audio sound, timing, plugins, and what the engine draws and does not. Use when writing or editing the TSX, HTML or JSON scene of a video.
metadata:
  version: "0.4.0-rc.1"
---

# Write a composition

A new project imports the API from `@kinetographdev/core`, which comes with `kinetograph`; never install `remotion`
(`@remotion/*` imports such as the font loaders are mapped too). An existing Remotion project keeps its `remotion` and
`@remotion/*` imports, which map onto the same code. The entry must call `registerRoot`; a file that only exports a
component is not an entry. An entry is a project file (`.tsx`, `.ts`, `.jsx`, `.js`), a `.json` scene, or an HTML page.

```tsx
import { AbsoluteFill, Composition, Layer, Rect, Text, interpolate, registerRoot, spring,
         useCurrentFrame, useVideoConfig, dropShadow, linearGradient, registerFont, staticFile } from '@kinetographdev/core';

registerFont({ family: 'DM Sans', path: staticFile('fonts/DMSans-Medium.ttf') }); // fonts BEFORE any text is measured

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
  `staticFile('x.png')` is `public/x.png` next to the entry file, or in the `public/` at the package.json's folder.
- Rendering is a pure function of the frame number. `Math.random()`, `Date.now()` and timers are driven by the frame; use
  `random(seed)` for jitter. Never read the real clock.
- Register fonts before text is laid out. Text with a font that is not registered is a lint error.
- For new work use the native elements below. `<div>`s, `className`, stylesheets, Tailwind and SVG also work (compat
  mode); a frame holding something the engine cannot draw yet is drawn without it or approximated, and the command warns.
  Run `doctor` on such a project before `render` (`kinetograph-render`).

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
`hueRotate`, `gradientMap`, `lut`, `colorGrade` (HyperFrames' grade and its 18 look effects: `{ effects: { halftone: 0.9 } }`),
`grain`, `dither`, `halftone`, `dotMatrix`, `displace`, `cornerPin`, and `shader` for your own WGSL. `motionBlur({ samples: 8 })`
goes in the same `effects` array.

## Sound

Web Audio code runs offline against the frame timeline. Call `onFrame` at module level; `ctx` is an `OfflineAudioContext`,
`t` is the start time in seconds.

```ts
import { onFrame } from '@kinetographdev/audio';

onFrame(42, (ctx, t) => {
  const o = ctx.createOscillator(); const g = ctx.createGain();
  o.frequency.setValueAtTime(3000, t); o.frequency.exponentialRampToValueAtTime(4500, t + 0.055);
  g.gain.setValueAtTime(0.4, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.06);
});
```

`<Audio src={staticFile('audio/music.mp3')} volume={(f) => interpolate(f, [0, 30], [0, 1])} />` plays a file. `render`
mixes both into the video. Measure it with `audio analyze` (`kinetograph-render`).

## Habits

- Run `npx kinetograph plugins` and read each plugin's `SKILL.md` before using it. Plugin tools show as `<plugin>_<tool>`.
- Give an explicit `id` to matte sources and to anything an `<Audio>` or matte refers to.
- Use `random(seed)`, never `Math.random()`, so a frame is the same every time.

## References

Read the part you need; these files are large.

| File | What it holds |
|---|---|
| `references/capabilities.md` | the `@remotion/*` packages that import, compat mode (DOM, CSS, SVG, Canvas, WebGL), libraries and plugins that render, HTML and HyperFrames pages, fonts, datamosh, motion tracking, video matting |
| `references/AUTHORING.md` | the contract of each package: §5 helpers, §6 elements and their JSON, §7 the Remotion API, §8 audio, §9 CLI and export, §11 video layers, GSAP and plugins |
| `references/SCENE.md` | the `.json` scene: every layer type, effect and field, and what each means exactly |
| `references/ENGINE.md` | the DOM and CSS engine: what CSS and SVG it draws |
| `references/INTERNALS.md` | how a frame is made, and the code map |
