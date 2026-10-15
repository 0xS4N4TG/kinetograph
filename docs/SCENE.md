# Scene format

A scene is one JSON file. The renderer is a pure function of (scene, frame): the same scene and frame always give the
same pixels. Phase 3's reconciler will emit this same shape from React.

```json
{
  "width": 1280, "height": 720, "fps": 30, "durationInFrames": 90,
  "background": "#10131a",
  "fonts": { "DM Sans": "../assets/fonts/DMSans-Medium.ttf" },
  "layers": [ ... ]
}
```

| Field | Type | Notes |
|---|---|---|
| `width`, `height` | integer | Pixels, 1..=8192. |
| `fps` | number | Greater than 0. Frame numbers are what the engine uses; `fps` is carried for encoding. |
| `durationInFrames` | integer | At least 1. Valid frames are `0..durationInFrames`; anything else is an error. |
| `background` | colour | Optional, default `#000000`. May be transparent. |
| `margin` | integer | Optional, default `0`. The least [canvas margin](#canvas-margin) in pixels; a number, not animated, not negative. |
| `fonts` | object | Optional. Font family name to font file path. Text layers refer to these names. |
| `camera` | object | Optional. The viewpoint for layers with a 3D transform. See [3D transforms and the camera](#3d-transforms-and-the-camera). |
| `layers` | array | Bottom layer first, topmost last (the same order as SVG and DOM paint order). |

Asset paths (`fonts`, image, lottie, video and gif `src`, `lut` `src`) resolve relative to the directory of the scene file.

Only the fonts listed in `fonts` exist. There is no system font lookup and no fallback, so output does not depend on
the machine.

## Animated numbers

Any property typed `number` below accepts either a constant or a keyframe list:

```json
"x": 100
"x": [ {"frame": 0, "value": 0, "easing": "easeOut"}, {"frame": 30, "value": 640} ]
```

- Keyframes must be in increasing `frame` order. Two keyframes on the same frame make a step.
- Before the first keyframe the first value holds; after the last keyframe the last value holds.
- `easing` shapes the segment that starts at that keyframe. It is `linear` (default), `easeIn` (t^3), `easeOut`
  (1 - (1 - t)^3) or `easeInOut` (cubic, symmetric).
- Colours, strings and paths are not animated.
- Loading a scene rejects an unparsable path `d`, a non-positive text `size`, and a negative width, height, `maxWidth`
  or stroke width, at any keyframe.

Colours are `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` or `transparent`, in sRGB with straight alpha.

## Layers

Every layer has these fields:

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | string | required | Unique across the whole scene, including nested layers. |
| `type` | string | required | `shape`, `text`, `image`, `group`, `noise`, `meshGradient`, `lottie`, `canvas`, `video` or `gif`. |
| `layoutItem` | object | none | How the layer takes part in its parent group's flex layout. See [Layout](#layout). |
| `transform` | object | identity | See below. |
| `opacity` | number | `1` | Clamped to 0..1. |
| `blendMode` | string | `normal` | `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `colorDodge`, `colorBurn`, `hardLight`, `softLight`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`. These are the 16 modes of W3C Compositing and Blending Level 1, evaluated in linear light, then mixed in with the layer's `opacity`. |
| `effects` | array | `[]` | Applied in order to the layer's own pixels, before it is blended. See [Effects](#effects). |
| `clip` | object | none | Cuts the layer to a shape. See [Clip paths](#clip-paths). |
| `mask` | object | none | Fades the layer by a gradient. See [Gradient masks](#gradient-masks). |
| `matte` | object | none | Cuts the layer by a sibling layer. See [Track mattes](#track-mattes). |
| `motionBlur` | object | none | Averages the layer over the time the shutter is open. See [Motion blur](#motion-blur). |

`transform` fields, all animatable numbers:

| Field | Default | Meaning |
|---|---|---|
| `x`, `y` | `0` | Where the anchor point lands in the parent, in pixels. |
| `scale` | `1` | Uniform scale about the anchor. |
| `rotation` | `0` | Degrees, clockwise. |
| `anchorX`, `anchorY` | `0` | Anchor point in the layer's own coordinates. Scale and rotation pivot here. |
| `rotateX`, `rotateY` | `0` | Degrees. Turn the layer in 3D about the horizontal and the vertical axis through its position, as CSS's `rotateX` and `rotateY`. See [3D transforms and the camera](#3d-transforms-and-the-camera). |
| `z` | `0` | Pixels toward the viewer, as CSS's `translateZ`. |
| `originX`, `originY` | `0` | A point of the layer's box as a fraction of its size, added to the anchor to make the pivot: see [Transform origin](#transform-origin). |

The layer matrix is `translate(x, y) * rotate(rotation) * scale(scale) * translate(-anchorX, -anchorY)`. A child's
matrix is applied inside its parent's. `rotateX`, `rotateY` and `z` do not change it: they move the finished layer
afterwards.

### Transform origin

`originX` and `originY` say where the layer turns and scales without knowing its size: a point of its box (the box
`inset` clips use, see [Clip paths](#clip-paths)) as a fraction of the box's width and height, so `0.5, 0.5` is the
centre and `1, 1` the bottom-right corner. The pivot of `rotation`, `scale` and, in 3D, `rotateX` and `rotateY` is then
the anchor plus `(box.x + originX * width, box.y + originY * height)`, where `box.x, box.y` is the box's top-left
corner: `0, 0` for every layer but a path, whose box is its bounding box. An origin left at `0, 0` (the default)
keeps the pivot at the anchor, even for a path.

Like CSS's `transform-origin`, the origin changes the pivot and does not move the layer: with no turn and no scale the
layer is where it would be without an origin, with its anchor at `(x, y)`, and the pivot sits at `(x, y)` plus the
origin offset whatever `rotation` and `scale` do. The matrix is
`translate(x + ox, y + oy) * rotate(rotation) * scale(scale) * translate(-(anchorX + ox), -(anchorY + oy))`, with
`(ox, oy)` the origin in pixels. The 3D turn is about that same point.

- Both are animatable numbers. The size is the box at that frame, so a text layer or an image whose size animates keeps
  turning about its middle.
- A layer without a box (a group without a `layout`) ignores them. A group with a `layout` has its size as its box, and
  an origin is a fraction of that.
- A text layer's box is its laid-out box, so measuring it needs its font: a scene with an origin on text is resolved with
  the renderer's text engine.

Layers are blended bottom-up in linear light (not in sRGB as CSS does, so `multiply`, `screen` and `softLight` look
different from a browser).

### shape

```json
{ "id": "card", "type": "shape",
  "shape": { "kind": "roundedRect", "width": 400, "height": 240, "radius": 24 },
  "fill": "#f6c177",
  "stroke": { "color": "#ffffff", "width": 4 } }
```

`fill` and `stroke` are both optional (a shape with neither draws nothing). The stroke is centred on the outline and
is drawn over the fill. `fill` is a colour string or a [gradient](#gradients) (see [Gradient fills](#gradient-fills));
`stroke.color` is a colour string only.

The stroke can be finished and dashed as SVG's can:

| `stroke` field | Default | Meaning |
|---|---|---|
| `color`, `width` | required | |
| `cap` | `butt` | `butt`, `round` or `square`: how an open end is finished. |
| `join` | `round` | `miter`, `round` or `bevel`: how a corner is finished. |
| `miterLimit` | `4` | A `miter` join whose tip is longer than this many stroke widths is bevelled. |
| `dashArray` | none | Dash and gap lengths, alternating, starting with a dash, repeated along the line; an odd count is repeated to make it even. A list that is empty, has a negative number or adds up to nothing is a solid line. |
| `dashOffset` | `0` | How far into the pattern the line starts. |

`fillRule` (`nonzero`, the default, or `evenodd`) says which parts of a path with crossings or holes the fill covers.
A stroke's box (for the texture the shape is drawn in) grows with its joins and caps: a `miter` join reaches
`miterLimit` half widths, a `square` cap a corner.

`shape.kind` and its fields (the shape's top-left corner is the layer's origin):

| Kind | Fields |
|---|---|
| `rect` | `width`, `height` |
| `roundedRect` | `width`, `height`, `radius` |
| `ellipse` | `width`, `height` (the bounding box) |
| `path` | `d`: SVG path data string, in layer coordinates |

### text

```json
{ "id": "title", "type": "text", "text": "Hello\nworld", "font": "DM Sans",
  "size": 64, "color": "#ffffff", "lineHeight": 1.2, "maxWidth": 600 }
```

One font per layer, no fallback, no bidi. `\n` starts a new line. The layer origin is the top-left of the text box.

- `font`: a key of the scene's `fonts`.
- `size`: font size in pixels.
- `color`: a colour string or a [gradient](#gradients) (see [Gradient fills](#gradient-fills)).
- `lineHeight`: multiple of `size`. Omitted: the font's own line height.
- `maxWidth`: wrap width in pixels. Omitted: lines break only at `\n`.
- `align`: `left` (default), `center` or `right`. Each line is placed within `maxWidth`, or within the widest line when
  there is no `maxWidth`. A line wider than `maxWidth` (a long word that does not break) is left-aligned. The text box
  does not change with `align`: it is `maxWidth`, or the widest line, wide.

Fonts are registered before any text is measured.

### Per-character styles

`chars` styles single characters, for kinetic type:

```json
{ "id": "word", "type": "text", "text": "Hi!", "font": "DM Sans", "size": 80, "color": "#fff",
  "chars": [ { "y": [{ "frame": 0, "value": 40 }, { "frame": 12, "value": 0 }], "opacity": [{ "frame": 0, "value": 0 }, { "frame": 12, "value": 1 }] },
             null,
             { "scale": 1.4, "rotation": -10, "color": "#ff4d4d" } ] }
```

It is an array with one entry per Unicode code point of `text` (what JavaScript's `Array.from(text)` counts, so a `\n`
has an entry, which is ignored). An entry is `null`, a character drawn as the layer is, or an object whose fields are all
optional:

| Field | Default | Meaning |
|---|---|---|
| `x`, `y` | `0` | Offset of the character, in text-box pixels. |
| `scale` | `1` | About the character's centre. |
| `rotation` | `0` | Degrees clockwise, about the character's centre. |
| `opacity` | `1` | 0..1, multiplies the layer's `opacity`. |
| `color` | the layer's | A colour string; replaces the layer's `color` (a colour or a gradient) for this character. |

All but `color` are animatable. The offset is applied first, then the turn and the scale about the centre.

- **The centre of a character** is the middle of its glyph's advance, horizontally, and the middle of its line box,
  vertically (the line's `top` and `bottom`, which `lineHeight` sets). A character of several glyphs takes the middle of
  all their advances.
- **Clusters.** Characters are the code points of the text, but glyphs belong to clusters: a cluster of several code
  points (a ligature, a letter and its combining mark) takes the entry of its first code point, and the others' entries
  do nothing. A code point with no glyph (a newline, the later letters of a ligature) shows nothing, whatever its entry
  says.
- A list shorter than the text styles the first characters only, and entries past its end are ignored.
- **The text box** (for `inset` clips, `sweep` dot matrices, [box-unit gradients](#box-units), a transform origin and
  layout) is the box without the offsets, so styling characters never changes it. The bounds of the layer, which the
  renderer uses to size the layer's texture, do follow the characters.
- A gradient `color` is in the text box and moves with the character: a letter keeps the colours it had where it was laid
  out. A character's `color` replaces the gradient for that character, with a plain colour.
- Characters are drawn in text order. Effects, clips, masks and mattes work on the layer as a whole, after its
  characters.
- Glyph positions are what the addon's `layoutText` returns, with `charIndex` the index into `chars`.

### image

```json
{ "id": "logo", "type": "image", "src": "logo.png", "width": 256, "height": 256 }
```

PNG or JPEG, drawn in the box `width` x `height` from the layer origin. Colours are read as sRGB.

| Field | Default | Meaning |
|---|---|---|
| `src` | required | The file, relative to the scene. |
| `width`, `height` | the file's size | Animatable, not negative. Both left out: the file's size in pixels. One left out: the other side, with the file's aspect ratio. |
| `fit` | `fill` | How the picture sits in the box. `fill` stretches it to the box. `contain` scales it to fit inside the box, keeping its aspect ratio, and centres it; the rest of the box is empty. `cover` scales it to cover the box, keeping its aspect ratio, centres it, and cuts it to the box. Like CSS's `object-fit`. |

- The size of a file is read from its header when the scene loads, and only for a layer that leaves a side out. A missing
  or unreadable file is a load error naming the layer.
- The box does not change with `fit`: it is the layer's box for `inset` clips, `sweep` dot matrices and box-unit
  gradients, and the layer is cut and bounded by it.

### group

```json
{ "id": "stack", "type": "group", "opacity": 0.8, "children": [ ... ] }
```

A group composites its children (bottom first) into its own buffer, then blends that result into its parent using the
group's `opacity` and `blendMode`. (A group that blends normally at opacity 1, with no effects, clip, mask,
matte, motion blur or 3D turn, whose drawn children all blend normally and none of which reads the backdrop, skips
the buffer and draws its children straight into its parent; the result is the same up to rounding.) Its
`transform` applies to all children. `anchorX/anchorY` are in the group's
coordinates. `"preserve3d": true` (default `false`) makes the group a 3D scene instead: see
[preserve3d groups](#preserve3d-groups). A group with a `layout` places its children with flexbox: see
[Layout](#layout). `"passThrough": true` (default `false`) draws the children straight into the group's parent
even if they blend with a mode other than `normal`, so they blend with what is behind the group, as if it were not
there (CSS `isolation: auto` on an element that is not a stacking context, such as an `<svg>` root). It only takes
effect on a group that is otherwise plain (opacity 1, `normal` blending, no effects, clip, mask or matte).

### noise

```json
{ "id": "clouds", "type": "noise", "width": 480, "height": 270,
  "turbulence": { "type": "fractalNoise", "baseFrequency": 0.01, "numOctaves": 4, "seed": 3 } }
{ "id": "static", "type": "noise", "width": 200, "height": 200, "channels": "gray",
  "turbulence": { "type": "turbulence", "baseFrequency": [0.05, 0.2], "seed": 11 } }
```

The raw output of SVG's `feTurbulence` over a box, from the layer origin: clouds, marble or smoke to blend, matte or
mask with, or to displace by. Like any layer it takes `effects`, `clip`, `mask`, `matte`, `blendMode` and `opacity`.

| Field | Default | Meaning |
|---|---|---|
| `width`, `height` | required | Animatable, not negative: the box in layer pixels. |
| `turbulence` | required | The noise, with the fields described under [`displace`](#displace): `type`, `baseFrequency`, `numOctaves`, `seed`. |
| `channels` | `rgba` | `rgba`: the four noise channels are red, green, blue and alpha, as SVG draws a `feTurbulence`, so the box is a coloured, partly see-through haze. `gray`: the red channel as grey, fully opaque. |

- **Colour.** The channel values are taken as linear light, which is what SVG's default `linearRGB` filter space
  means, and the compositor's own space, so `rgba` is premultiplied (each colour times its alpha) and nothing else is
  done to it. A noise value of 0.5 is therefore a mid grey in linear light, which looks lighter (about 188 of 255)
  than a 0.5 sRGB grey. Use a [`gradientMap`](#gradientmap) or a colour filter to grade it.
- **In layer space.** The noise is computed at each pixel's centre in the layer's own coordinates, so it moves, scales
  and rotates with the layer (a scaled-up noise layer has a bigger, softer pattern; `baseFrequency` is per layer
  pixel). It is a function of the layer's space and the `seed` only: it changes over time only if you animate
  `baseFrequency`, the transform or the box.
- **The box edge** is anti-aliased: the box is drawn as a white shape through the layer matrix by the same rasteriser
  as a `shape` layer, and the noise fills its coverage. A box off the canvas is clipped as any layer is.
- A group without a `layout` has no box, but a noise layer does: an `inset` clip or a `sweep` dot matrix on one measures from
  `(0, 0, width, height)`.
- Counts nothing in the [margin](#canvas-margin).

### meshGradient

```json
{ "id": "bg", "type": "meshGradient", "width": 480, "height": 270, "columns": 3, "rows": 3,
  "colors": ["#3a1c71", "#d76d77", "#ffaf7b",
             "#0f2027", "#2c5364", "#ff6a88",
             "#11998e", "#38ef7d", "#fc4a1a"] }
{ "id": "drift", "type": "meshGradient", "width": 480, "height": 270, "columns": 3, "rows": 2,
  "points": [[0, 0], [240, 0], [480, 0],
             [0, 270], [[{ "frame": 0, "value": 240 }, { "frame": 60, "value": 360 }], 270], [480, 270]],
  "colors": ["#f72585", "#7209b7", "#3a0ca3", "#4361ee", "#4cc9f0", "#fff"] }
```

An animated mesh gradient: a grid of colour control points joined by smooth patches, the soft many-coloured
backgrounds of motion graphics. Move the points (every coordinate is an animatable number) and the colours flow with
them. Like any layer it takes `effects`, `clip`, `mask`, `matte`, `blendMode` and `opacity`.

| Field | Default | Meaning |
|---|---|---|
| `width`, `height` | required | Animatable, not negative: the box in layer pixels. It places the default points and is the box an `inset` clip or a `sweep` dot matrix measures from; moving the points does not change it. |
| `columns`, `rows` | `3`, `3` | Points across and down, each a whole number from 2 to 8. |
| `points` | regular grid | `columns x rows` `[x, y]` pairs, row by row (left to right, top to bottom), in layer pixels. Each coordinate is an animatable number. Omitted: points spread evenly over `(0, 0, width, height)`, so the box animates the grid. |
| `colors` | required | One colour per point, in the same order. Not animated (a mesh that changes colour is two layers, cross-faded). |

- **Interpolation.** Between four neighbouring points the surface is one bicubic Hermite patch, with Catmull-Rom
  slopes: at each point the slope along a row or column is half the difference of the two neighbouring points (the
  difference to the one neighbour at the border of the mesh), and the twist is the same rule applied to the slopes.
  The surface passes through every point, is smooth (C1) across the edges between patches, and a regular grid comes
  out exactly regular. Position and colour use the same patch, so colour is as smooth as the shape.
- **Colour.** Interpolated in sRGB with straight alpha (a transparent point does not darken its neighbours' colour,
  it only fades alpha), then clamped to 0..1; Catmull-Rom can overshoot a little where colours change sharply, and the
  clamp is what stops that from going negative.
- **Tessellation.** Each patch is drawn as 16 x 16 quads, on the CPU, in the layer's matrix; the GPU draws the
  triangles with vertex colours into a 4x multisampled texture, so the outer edge of the mesh is anti-aliased (the
  canvas edge is not, if the mesh fills the canvas exactly). Patches that fold over each other blend with "over", in
  document order; there is no depth.
- A group without a `layout` has no box, but a mesh does: an `inset` clip or a `sweep` dot matrix on one measures from
  `(0, 0, width, height)`.
- Counts nothing in the [margin](#canvas-margin).

### lottie

```json
{ "id": "confetti", "type": "lottie", "src": "anims/confetti.json", "width": 400, "height": 400, "time": 1.2, "loop": true }
```

A [Lottie](https://lottiefiles.com) animation (After Effects, through Bodymovin, or any LottieFiles download), painted
by ThorVG, the renderer behind LottieFiles' own player (`dotlottie-rs`). Like any layer it takes `effects`, `clip`,
`mask`, `matte`, `blendMode` and `opacity`.

| Field | Default | Meaning |
|---|---|---|
| `src` | required | A Lottie `.json` file or a `.lottie` archive, relative to the scene like an image's `src`. Read when the scene is loaded into a renderer (and, for its size, when the scene loads). |
| `width`, `height` | the animation's own size | Animatable, not negative: the box in layer pixels. Both left out: the size the file declares. One left out: the other side, with the animation's aspect ratio. |
| `time` | the frame's time, `frame / fps` | Animatable. Seconds into the animation. |
| `loop` | `false` | Past the end of the animation, `false` holds its last frame and `true` wraps round. |

- **Fitting.** The animation is fitted inside the box, centred, keeping its aspect ratio, as lottie-web's
  `xMidYMid meet` does. A box with the animation's shape is filled; any other has empty space on two sides. The box is
  what `inset` clips, `sweep` dot matrices, box-unit gradients, layout and the transform origin measure.
- **Time.** The animation's frame is `time` times the file's frame rate, counted from the file's first frame, up to
  its last (the one before `op`). A time below 0 is the first frame. With `loop` the time wraps modulo the
  animation's duration instead of holding the last frame. `time` is in seconds of the animation, not of the scene: to
  slow an animation down, scale the time (`time` at half the rate of `frame / fps`), as the authoring layer's
  `playbackRate` does. Frames between two whole frames are interpolated, and a motion blur's sub-frames are at their own
  times.
- **Rasterising.** ThorVG's CPU renderer paints the animation straight into a picture the size of the box times the
  largest stretch of the layer's matrix (at most 4096 pixels a side), rounded up, so a layer drawn at twice its size is
  painted at twice its size and stays sharp, rather than upscaled. The picture is straight-alpha sRGB and goes in like an
  [image](#image): drawn through the layer's matrix, so a layer that is turned is resampled. Painting is a pure function
  of `time`: the same time gives the same pixels whatever was drawn before. An expression in the file that uses
  randomness must be seeded, or it is not.
- **What ThorVG draws.** Shape, solid, null, precomposition, image and text layers, the usual masks, mattes, trim paths
  and gradient fills, layer effects of the kinds ThorVG supports, and JavaScript expressions (ThorVG's own interpreter).
  Text in the file uses the fonts it embeds and ThorVG's built-in one; the scene's `fonts` are not used. What ThorVG
  leaves out, this leaves out.
- Counts nothing in the [margin](#canvas-margin).
- A missing or unreadable file, or one that is not an animation, is an error naming the layer, when the scene loads (if
  the box needs the file's size) or when a renderer is built from it.

### canvas

```json
{ "id": "chart", "type": "canvas", "width": 640, "height": 360, "commands": [
  { "op": "fill", "path": "M0 0H640V360H0Z", "paint": { "type": "color", "color": "#10131a" } },
  { "op": "stroke", "path": "M20 300L200 120L400 220L620 40", "paint": { "type": "color", "color": "#7aa2f7" },
    "width": 4, "cap": "round", "join": "round" },
  { "op": "text", "text": "Revenue", "font": "DM Sans", "size": 24, "x": 20, "y": 40,
    "paint": { "type": "color", "color": "#ffffff" } }
] }
```

What a Canvas 2D context drew: the list of commands a `CanvasRenderingContext2D` was given, drawn into the box
`(0, 0, width, height)` with Vello, under the layer's transform. The authoring layer's `<Canvas>` and a Remotion
project's `<canvas>` (`getContext('2d')`) both make one; the context object is `createCanvasContext` of
`@kinetograph/scene` (AUTHORING.md §6.5). Like any layer it takes `effects`, `clip`, `mask`, `matte`,
`blendMode` and `opacity`.

| Field | Default | Meaning |
|---|---|---|
| `width`, `height` | required | Animatable, not negative: the box in layer pixels. What the commands draw outside it is cut off. |
| `commands` | `[]` | The drawing, in order. Not animated: a canvas that changes from frame to frame has a layer with other commands at each. |

The context keeps the canvas's state (transform, `globalAlpha`, `globalCompositeOperation`, styles, the line style, the
text state) and writes each command with the state it is drawn in, so the renderer holds none. Every drawing command
takes `m` (default the identity: the matrix that takes the command's own space, where its path or text is, to the
canvas, `[a, b, c, d, e, f]` as `setTransform`), `a` (`globalAlpha`, default 1) and `blend` (`globalCompositeOperation`,
default `source-over`).

| `op` | Fields | Draws |
|---|---|---|
| `fill` | `path`, `rule` (`nonzero`, `evenodd`), `paint` | The path, as `fill()` does. `path` is SVG path data. |
| `stroke` | `path`, `paint`, `width` (1), `cap` (`butt`), `join` (`miter`), `miterLimit` (10), `dash`, `dashOffset` | The path's outline, as `stroke()` does. |
| `text` | `text`, `font`, `size`, `x`, `y`, `align`, `baseline`, `paint`, `line`, `maxWidth` | The text from `(x, y)`. `font` is a key of the scene's `fonts`. With a `line` (`width`, `cap`, `join`, `miterLimit`, `dash`, `dashOffset`) the glyph outlines are stroked, as `strokeText` does; else filled. |
| `image` | `source`, `sx`, `sy`, `sw`, `sh`, `dx`, `dy`, `dw`, `dh`, `smooth` (true) | `drawImage`: the part `sx, sy, sw, sh` of the source (default all of it) into `dx, dy, dw, dh`. |
| `clip` | `path`, `rule`, `m` | Intersects the clip with the path, until the matching `unclip`. |
| `unclip` | | Ends the innermost `clip`. The context writes it for the `restore` that undoes a `clip()`; clips still open at the end of the list end with it. |

- **`paint`** is `{ "type": "color", "color" }`, `linear` (`x0 y0 x1 y1`), `radial` (`x0 y0 r0 x1 y1 r1`, two circles,
  as `createRadialGradient`), `conic` (`x y angle`, radians from 3 o'clock, as `createConicGradient`), each with `stops`
  (`[offset, colour]`, offsets 0 to 1 in order, none paints nothing), or `{ "type": "pattern", "source", "repeatX",
  "repeatY" }`. A gradient's coordinates are in the space of the command's `m`, as a canvas gradient's are in the
  transform in force when it paints. `globalAlpha` multiplies the paint's alpha.
- **`source`** is `{ "kind": "src", "src" }` (an image file of the scene, loaded like an image layer's, so it is
  among the files the renderer holds), `{ "kind": "pixels", "width", "height", "data" }` (straight-alpha RGBA8 in
  base64: an `ImageData`), or `{ "kind": "canvas", "width", "height", "commands" }` (another canvas, drawn as a
  whole: its commands are drawn into a layer that takes the `globalAlpha` and blend). A pattern takes the first two.
- **`blend`** is any `globalCompositeOperation`: `source-over`, `source-in`, `source-out`, `source-atop`,
  `destination-over`, `destination-in`, `destination-out`, `destination-atop`, `lighter`, `copy`, `xor`, `multiply`,
  `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`,
  `exclusion`, `hue`, `saturation`, `color` and `luminosity`; and `clear`, which `clearRect` writes. The Porter-Duff
  operations that change pixels outside the shape (`source-in`, `source-out`, `destination-in`, `destination-atop`,
  `copy`) act on the whole canvas, as they do in a browser.
- **Text** is shaped by the engine's text engine with the scene's fonts, so a measurement made with `measureText` is
  what is drawn. `align` is `start`, `end`, `left`, `right` or `center`, `baseline` is `alphabetic` (default), `top`,
  `hanging`, `middle`, `ideographic` or `bottom`, worked out from the font's ascent and descent. Text wider than
  `maxWidth` is squeezed to it. Letter spacing, word spacing and right-to-left `direction` are not applied.
- **Blending space.** Inside the canvas, colours blend in sRGB, as a browser's canvas does (`globalAlpha`, gradients,
  composite operations). The finished canvas is a layer like any other, and is blended with the layers around it in
  the scene's `blendSpace`.
- **Not drawn.** Shadows (`shadowBlur`, `shadowColor`, `shadowOffset*`), `filter`, `imageSmoothingQuality` above the
  default, `fontKerning`, `textRendering`, `fontStretch` and hit testing (`isPointInPath`) are not part of a layer;
  the context accepts the assignments and draws nothing for them.
- The pictures a canvas draws from files (`kind: "src"`) are read when a renderer is built from the scene, as an image
  layer's are. A bad path or block of pixels is an error naming the layer when the scene loads.
- Rendering is a pure function of the commands, the fonts and the files they name.
- Counts nothing in the [margin](#canvas-margin).

### video

```json
{ "id": "clip", "type": "video", "src": "clips/city.mp4", "width": 1080, "height": 608, "fit": "cover",
  "from": 30, "trimBefore": 15, "playbackRate": 1.5, "loop": true }
```

A video file, decoded by FFmpeg (`ffmpeg-next`), one picture per frame. The picture goes in like an
[image](#image): same box, `fit` and sampling. Like any layer it takes `effects`, `clip`, `mask`, `matte`,
`blendMode` and `opacity`. Its sound is not part of the scene: the authoring layer plays it (AUTHORING §11.3).

| Field | Default | Meaning |
|---|---|---|
| `src` | required | Any file FFmpeg demuxes with a video stream (`.mp4`, `.mov`, `.webm`, `.mkv`, …), relative to the scene. Its first video stream is used. |
| `width`, `height` | the stream's size | Animatable, not negative. As an image's: both left out is the stream's pixel size, one left out keeps its aspect ratio (of the coded size; the sample aspect ratio is ignored). |
| `fit` | `fill` | As an image's. |
| `frame` | the frame being rendered | Animatable. The scene frame the clip's clock reads, so a fractional motion-blur sub-frame time is the sub-frame's own time. The authoring layer sets it only to hold a picture (inside `<Freeze>`). |
| `from` | `0` | A number, not animated. The scene frame on which the clip's own frame 0 falls. |
| `trimBefore` | `0` | A number of scene frames, not animated, not negative. Skipped at the start of the file. |
| `trimAfter` | none | A number of scene frames from the start of the file, not animated, greater than `trimBefore`. The clip ends there. |
| `playbackRate` | `1` | A number above 0, not animated. |
| `loop` | `false` | Past the end, `false` holds the last picture and `true` starts again at `trimBefore`. |

Which picture is shown, for scene frame `f` (`frame`, or the frame being rendered) and the scene's `fps`:

1. The clip's frame is `n = (f − from) × playbackRate`.
2. The clip's end is `end = trimAfter`, or without it the stream's duration times `fps`, and its length is
   `L = end − trimBefore` (scene frames).
3. With `loop`, `n` wraps into `0 ≤ n < L` (modulo, so frames before `from` wrap too); without it `n` is clamped to
   `0 ≤ n ≤ L`.
4. The source time is `t = (trimBefore + n) / fps` seconds from the stream's first picture (a file whose first
   timestamp is not 0 is measured from that first picture).
5. The picture shown is the last one whose timestamp is at or before `t`, compared in the stream's time base
   (`t` rounded to the nearest tick). A `t` before the first picture shows the first; a `t` at or past `end`
   shows the last picture before `end`.

- **Purity.** The picture depends only on (scene, frame): never on what was decoded before. A renderer keeps one
  decoder per `src` that decodes forward from where it is and seeks (to the keyframe at or before the target, then
  decodes forward) on a jump back or a jump forward of more than a second of stream time, and decoded pictures may be
  cached; neither changes a pixel. Rendering frames out of order gives the same bytes as rendering them in order.
- **Colour.** Pictures are converted to straight-alpha sRGB RGBA8 by `swscale` at their own size with bit-exact
  flags (`SWS_BICUBIC | SWS_ACCURATE_RND | SWS_FULL_CHR_H_INT | SWS_BITEXACT`), using the stream's colour matrix and
  range. An untagged matrix is BT.709 for a stream at least 720 lines tall and BT.601 below that, an untagged range
  is limited (TV) range, as browsers do. A pixel format with alpha (VP9 or ProRes 4444 with alpha) keeps it; others
  are opaque. Colours are then read as sRGB, as an image's are.
- The stream's size, duration, time base and first timestamp are read when the scene loads (from the container, no
  decoding; a file's probe is remembered while the file is unchanged, so a scene per frame does not open it per frame).
  The first video stream that is not a cover picture is used. A stream's own duration is its length; a container that
  gives only its own (Matroska, where it is where the last picture ends) is not trusted, and the last packets say where
  the stream ends instead. A missing or unreadable file, one without a video stream, a `trimAfter` not above
  `trimBefore`, a `trimBefore` at or past the end of the stream, or a `playbackRate` not above 0 is a load error naming
  the layer.
- Decoded pictures are cached per file (the last 64 MiB, and at least 4 pictures), and a picture reaches Vello as one
  image, so the image atlas holds only the pictures drawn lately: Vello drops those unused for two frames when it needs
  the room. The layer cache redraws a video layer whenever the timestamp it asks for changes, which is when its
  picture changes and, for a clip slower than the scene, also between two frames of one picture.
- Counts nothing in the [margin](#canvas-margin).

### gif

```json
{ "id": "spinner", "type": "gif", "src": "spinner.gif", "width": 120, "height": 120, "fit": "contain", "time": 0.4 }
```

An animated GIF, decoded by the `image` crate. The picture goes in like an [image](#image) (same box, `fit` and
sampling) and takes every layer field.

| Field | Default | Meaning |
|---|---|---|
| `src` | required | A `.gif`, relative to the scene. |
| `width`, `height` | the GIF's logical screen size | As an image's. |
| `fit` | `fill` | As an image's. |
| `time` | the frame's time, `frame / fps` | Animatable. Seconds into the animation. |
| `loop` | `true` | Past the end, `true` wraps round and `false` holds the last picture. A file's own loop count is ignored. |

- **Timing.** Picture `i` shows from the sum of the delays of pictures `0..i` up to that plus its own delay. A delay
  of 10 ms or less counts as 100 ms, as browsers do. The duration is the sum of all delays. A `time` below 0 shows
  the first picture.
- **Pictures** are the full logical screen after each frame's disposal method (none, background, previous), as the
  `image` crate composes them, straight-alpha sRGB.
- A missing file, or one `image` cannot read the header of, is a load error naming the layer (its logical screen is read
  when the scene loads). A file with no pictures, or whose pictures cannot be decoded, is an error naming the layer when
  a renderer opens it, which decodes every picture. Counts nothing in the margin.

## Layout

A `group` with a `layout` places its children with CSS flexbox (the `taffy` crate), and any layer can say how it takes
part with `layoutItem`. Names and values are CSS's. Layout runs when a frame is resolved, after the fonts are
registered, and moves the children by their transforms, so everything downstream sees the laid-out layers: bounds, the
[margin](#canvas-margin) (layout changes none), the layer cache and `inspect`.

```json
{ "id": "row", "type": "group",
  "layout": { "flexDirection": "row", "justifyContent": "center", "alignItems": "center", "gap": 24,
              "padding": [0, 40, 0, 40], "width": 1080, "height": 400 },
  "children": [
    { "id": "a", "type": "shape", "shape": { "kind": "rect", "width": 200, "height": 120 }, "fill": "#f00" },
    { "id": "b", "type": "text", "text": "hi", "font": "DM Sans", "size": 64, "color": "#fff",
      "layoutItem": { "flexGrow": 1, "margin": 8 } },
    { "id": "badge", "type": "shape", "shape": { "kind": "ellipse", "width": 20, "height": 20 }, "fill": "#0f0",
      "layoutItem": { "position": "absolute" } } ] }
```

| `layout` field | Default | Values |
|---|---|---|
| `display` | `flex` | `flex`, the only one for now. |
| `flexDirection` | `row` | `row`, `column`, `row-reverse`, `column-reverse`. |
| `flexWrap` | `nowrap` | `nowrap`, `wrap`, `wrap-reverse`. |
| `justifyContent` | `flex-start` | `flex-start`, `flex-end`, `center`, `space-between`, `space-around`, `space-evenly`. |
| `alignItems` | `stretch` | `flex-start`, `flex-end`, `center`, `baseline`, `stretch`. |
| `alignContent` | `stretch` | As `justifyContent`, plus `stretch`. |
| `gap` | `0` | A number, or `[row, column]`: `row` is the space between rows, `column` between columns. |
| `padding` | `0` | A number, or `[top, right, bottom, left]`. |
| `width`, `height` | from the content | Pixels: the container's size. |

| `layoutItem` field | Default | Values |
|---|---|---|
| `position` | `relative` | `relative`: in the flow. `absolute`: out of the flow, placed by its transform alone. |
| `flexGrow`, `flexShrink` | `0`, `1` | Numbers, not negative. |
| `flexBasis` | `auto` | A number of pixels, or `auto`. |
| `alignSelf` | `auto` | `auto` (the container's `alignItems`), `flex-start`, `flex-end`, `center`, `baseline`, `stretch`. |
| `margin` | `0` | A number, or `[top, right, bottom, left]`. May be negative. |
| `width`, `height` | the layer's box | Pixels: the size the layout uses for this layer. |

Every number is animatable. A `gap`, `padding` or `margin` given as a list is a list of numbers; a list of keyframe
objects is one animated number. Loading a scene rejects a list of the wrong length, a negative gap, padding, size,
`flexGrow`, `flexShrink` or `flexBasis`, and a value that is not in the tables; the error names the layer.

- **Sizes.** A child's size for the layout is its box (the box `inset` clips use, see [Clip paths](#clip-paths): a
  shape's width x height, a path's bounding box, an image's, a noise's or a mesh's box, a text layer's laid-out box). A
  `layoutItem` `width` or `height` replaces that side. A group without a `layout` has no box and is 0 x 0 unless the
  item gives a size. A child group that has a `layout` is a flex container and a flex item at once: it gets the size
  the parent's layout gives it, from its content, its own `width` and `height`, the parent's `flexGrow` or stretching.
  A `layoutItem` `width` or `height` on it wins over its `layout` ones. The container's own `width` and `height`
  default to its content.
- **Leaves keep their size.** A layer that is not a layout group is never resized: if the layout stretches or grows its
  item, the layer is drawn at its own size from the item's top-left corner, and only its position changes. It also does
  not shrink below its own size.
- **Position.** The layout gives each child a position `(left, top)` in the container's space (inside the padding, after
  the margin). The child is drawn as if its transform's `x` and `y` were `x + left - box.x + anchorX` and
  `y + top - box.y + anchorY`, so with `x` and `y` at 0 its box's top-left corner lands at the position, and `scale`
  and `rotation` pivot about its anchor and origin. Its own `x` and `y` are an offset from the laid-out place, as a CSS
  `transform: translate()` is. Transforms never change the layout.
- **Absolute items** take no part in the flow and no space: their transform is left alone, in the container's space. An
  absolute child that is itself a layout group is laid out on its own.
- **The box of a layout group** is `(0, 0, width, height)` of the size it was given, so an `inset` clip, a `sweep` dot
  matrix, a `cornerPin`, a [box-unit gradient](#box-units) and a transform origin work on it, and a preserve3d group
  sorts it by the middle of that box.
- **Baselines.** `alignItems: baseline` (and `alignSelf`) lines up the first baselines of the items of a row: for text
  the first line's baseline, for any other layer its bottom edge (as CSS treats a box with no text), and for a layout
  group the baseline of its first item. In a column it does nothing, as in CSS.
- **Motion blur.** A layer's sub-frames (including `frames`, see [Sub-frame layers](#sub-frame-layers)) are placed at
  the position the frame's layer got, each from its own box and anchor. A layout group inside a blurred layer is laid out
  separately in each sub-frame; a blurred layout group that is a flex item keeps the size its parent gave it in all of them.
- A `layoutItem` on a layer whose parent has no `layout` does nothing.
- Fractions are kept: positions are not rounded to pixels.

## Effects

Each entry in a layer's `effects` is an object with a `type`. A group's effects run on its composited result.

### Canvas margin

An effect that paints outside its layer (a shadow, say) needs room beyond the canvas edge, and so does a layer that
hangs off the canvas, whose shadow can fall back onto it. So the renderer draws on a canvas padded by a margin on every
side and crops the margin off at the end. It is worked out when the scene loads: the largest distance the effects can
reach past a layer, at any keyframe on any layer (nested layers included), rounded up to whole pixels, or the scene's
`margin` if that is more. Each effect below says what it counts. The margin is limited so the padded canvas is at most
8192 pixels on a side.

- A scene with no such effect and no `margin` has margin 0 and is rendered exactly on the canvas, as it always was.
- `margin` on the scene is a floor, never a limit: the margin is `max(margin, reach)`, so no effect is ever cut off by
  it, and a scene that sets nothing gets what its effects need, as before. It exists for scenes that are made one frame
  at a time, as the TSX authoring layer does (`<Composition margin>`): every frame is its own scene whose keyframes are
  constants, so the reach follows that frame's values, and a frame that reaches a pixel further than the rest has a
  different margin. The textures that depend on the margin and the layer cache are rebuilt whenever it changes. Set
  `margin` to the largest reach of any frame and the margin is the same on all of them. A frame that still reaches
  further gets the room it needs (and rebuilds the textures), so a `margin` that is too small costs time, not pixels.
- A margin that covers the reach does not change what the canvas shows, for `grain`, `dither` and `displace`: they work
  from canvas positions, not from where the texture starts or how large it is, and `displace` gives the same bits at
  any margin. `halftone`, 3D transforms, `cornerPin` and the `noise` layer read the padded texture through the
  hardware filter or a matrix that includes the margin, and can differ by a level or so when it changes.
- `blur` is not counted. It spreads a layer's own pixels and nothing needs room beyond them, so a scene that uses
  only `blur` keeps margin 0.
- `glow` counts `3 * radius`, and `chromaticAberration` counts `|amount|`.
- `backdropBlur` counts `3 * radius` (it reads the canvas around a layer that sits at the edge).
- `dropShadow` and `insetShadow` count `max(|x|, |y|) + |spread| + 3 * blur`. (An inset shadow stays inside its
  layer, but it reads the space around the layer, so it needs the room too. A negative spread reads the pixels around
  a point as a positive one does.)
- `shader` counts its `padding`: it is how far you say the shader paints past the layer (or reads from), and nothing
  else is derived from the code.
- Reaches add up along a chain: two shadows in one `effects` list count the sum of their reaches, and a group's
  effects count on top of the largest reach among its children, because each works on what the one before painted.
- The `noise` and `meshGradient` layer kinds count nothing: they paint only inside their box or between their
  points.
- The colour filters, `gradientMap`, `lut`, `grain` and `dither` count nothing: they change pixels in place. `halftone`
  and `dotMatrix` count nothing either: their dots stay inside their cells.
- `displace` counts `|scale| / 2` in layer pixels, so unlike the others it is multiplied by the largest product of
  `scale` over the layer and its enclosing groups (a card scaled to 2 with a displacement of 10 counts 10).
- A bigger margin costs time and memory, because every texture is bigger. Animating a shadow's offset to a large
  value for one frame makes the whole scene pay for it.
- 3D transforms (`rotateX`, `rotateY`, `z`), the `camera` and `cornerPin` count nothing: they only move a finished
  layer, and can only show what its texture holds (see below for what that leaves out).
- `motionBlur` counts nothing: it averages whole textures. Its sub-frames' effects still count like any other
  (a blurred layer's shadow is in the margin).
- Layer coordinates do not change: (0, 0) is still the canvas's top-left corner, and a layer at a negative position is
  still drawn there. With a margin, the part of it that falls inside the margin is real and can bleed into effects.

### blur

```json
{ "type": "blur", "radius": 24 }
{ "type": "blur", "radius": [{ "frame": 0, "value": 0 }, { "frame": 30, "value": 40 }] }
```

| Field | Meaning |
|---|---|
| `radius` | Animatable number, in canvas pixels: roughly the standard deviation of the Gaussian. Clamped to 0..128. |

The blur is a Gaussian, run in linear light on premultiplied colour. Large radii are blurred at reduced resolution, but
never so low that the Gaussian is narrower than 4 texels, which hides the coarse grid. In tests (`tests/blur.rs`) the
measured standard deviation is within 5% of `radius` for radii from 2 to 128, and a small layer's blur follows its
position to within 0.01 pixel, so moving or resizing a blurred glow does not make it jump. Things to know:

- It does not scale with the layer's `scale` or a parent group's `scale`; the radius is always in canvas pixels.
- Radii below 1 do nothing.
- The layer is blurred as if it sat in transparent space: its edges fade out. Content that lies outside the canvas is
  part of the layer only as far as the scene's [margin](#canvas-margin) reaches, so in a scene with no margin (blur
  alone) it cannot bleed in, and in a scene with a margin it can, from at most that far out.

### glow

```json
{ "type": "glow", "radius": 16 }
{ "type": "glow", "radius": 24, "color": "#ffcc66", "intensity": 1.5 }
```

A halo: a blurred copy of the layer is drawn under it, so the layer keeps its own pixels and light spills out past its
edges.

| Field | Default | Meaning |
|---|---|---|
| `radius` | required | Animatable number, in canvas pixels, like the `blur` effect's: roughly the standard deviation. Clamped to 0..128; below 1 the effect does nothing. |
| `color` | none | Colours the halo. Without it the halo has the layer's own colours; with it the halo is this colour, scaled by the blurred layer's alpha (so the colour's own alpha dims it too). Not animated. |
| `intensity` | `1` | Animatable. Multiplies the halo, clamped to 0..4. At 0 the effect does nothing. |

The blur runs in linear light on premultiplied colour, so the halo is physically a light falloff. Where
`intensity` pushes the halo past fully opaque it is capped at alpha 1 with its colour kept (so it saturates rather than
shifting hue). The halo is made from the layer as it is after the effects before it, and opacity fades layer and halo
together. The halo reaches about three radii past the layer's edge, which the [margin](#canvas-margin) allows for, so
the glow of a layer that hangs off the canvas still falls on it.

### chromaticAberration

```json
{ "type": "chromaticAberration", "amount": 4 }
{ "type": "chromaticAberration", "amount": [{ "frame": 0, "value": 0 }, { "frame": 30, "value": 12 }], "angle": 45 }
```

Pulls the red, green and blue images of the layer apart, like a cheap lens: edges grow a red fringe on one side and a
blue one on the other, with the layer's centre unchanged.

| Field | Default | Meaning |
|---|---|---|
| `amount` | required | Animatable, in canvas pixels. The red channel is read from `amount` pixels along `angle`, the blue channel from `amount` pixels the other way, and green from the pixel itself. Reading from ahead means the red *image* appears shifted the opposite way (back along `angle`) and the blue image forwards. A negative `amount` swaps the two; 0 does nothing. Not limited, but the [margin](#canvas-margin) is. |
| `angle` | `0` | Animatable, in degrees, clockwise from the +x axis: 0 splits left and right, 90 up and down. |

The offsets are in canvas pixels, whatever the layer's `scale` or rotation. Reads are bilinear, so fractional amounts
and animation are smooth. The channels are premultiplied, and the alpha is the largest of the three samples' alphas:
a fringe at a layer's edge is a red or blue edge, not a black one, and the layer grows by up to `amount` pixels on
each side (counted in the [margin](#canvas-margin)). Colour filters before it in the list recolour what it splits; ones
after it recolour the fringes too.

### dropShadow

```json
{ "type": "dropShadow", "x": 0, "y": 8, "blur": 12, "spread": 0, "color": "#00000080" }
```

A shadow of the layer's shape under the layer, cast onto whatever is behind it. The layer itself is drawn on top of it
unchanged.

| Field | Default | Meaning |
|---|---|---|
| `x`, `y` | `0` | Offset of the shadow in canvas pixels (positive is right and down). Not scaled by the layer's `scale` or rotated with it. Fractions are fine and move the shadow smoothly. |
| `blur` | `0` | Blur of the shadow, in canvas pixels. The same scale as the `blur` effect: roughly the standard deviation of the Gaussian. Clamped to 0..128. CSS `box-shadow` takes the full width, which is about twice this, so `0 8px 24px` is `blur: 12`. |
| `spread` | `0` | Grows the shadow by this many pixels on every side before it is blurred. Negative shrinks it. Clamped to -128..128. |
| `color` | `#000000` | The shadow colour, with straight alpha (so `#00000080` is a half-strength black). Not animated. |

The shadow comes from the layer's alpha, so a half-transparent layer casts a half-strength shadow and a hollow shape
(a ring) casts a hollow shadow. `opacity` is applied afterwards, to the layer and its shadow together, as in CSS
`filter: drop-shadow()`. A group's shadow is of the whole composited group, so overlapping children cast one shadow.

Spread is done with a square window (a separate pass along each axis), not a round one, so a large spread turns the
corners of a round shape slightly square. It is exact for rectangles. Fractions of a pixel are
interpolated, so animating the spread is smooth.

A `dropShadow` that is the first effect of a `rect`, `roundedRect` or `ellipse` layer, filled with one colour and with
no stroke, is not made by blurring at all (when `blur` is at least 1; below that nothing is blurred in any case). The
renderer works the blurred shape out for each pixel from a formula, in the same pass that draws the layer over it: exact
for a rectangle, within about 0.002 of full alpha for the others, and it has no coarse grid. `blur` means the same
standard deviation, the offset is in canvas pixels, and the shadow's alpha is the fill's alpha, as above. The layer may
be rotated and uniformly scaled; a skewed or stretched one keeps the blurred path. So does an ellipse more than four
times as long as it is wide, and a `spread` unless the shape is a `rect` or `roundedRect` with its sides along the
canvas axes (a `rotation` of 0, 90, 180 or 270), where the spread grows it on every side. A layer that hangs off the
canvas casts the shadow of the whole shape, not just of the part inside the [margin](#canvas-margin).

The shadow is computed on the layer as it is after the effects before it in the list, and effects after it (a `blur`,
say) run on layer and shadow together. Shadow pixels past the canvas are real up to the [margin](#canvas-margin), so
the shadow of a layer that hangs off the canvas, or lies wholly outside it, still falls on the canvas.

### insetShadow

```json
{ "type": "insetShadow", "x": 0, "y": 6, "blur": 10, "spread": 0, "color": "#000000b3" }
```

A shadow cast inside the layer's shape: with `y: 6` it lies along the top edge. It is drawn over the layer and kept
to where the layer is opaque, so nothing spills outside the shape. The fields are those of `dropShadow`; the differences:

- `spread` grows the shadow inward, shrinking the lit area (negative shrinks the shadow).
- The shadow is made from the layer's alpha inverted, so everything outside the shape, including space beyond the
  canvas edge, counts as shadow. A shape that stops at the canvas edge therefore gets a shadow along that edge; one
  that continues past it into the margin does not.

### Colour filters

```json
{ "type": "saturate", "amount": 1.5 }
{ "type": "hueRotate", "angle": [{ "frame": 0, "value": 0 }, { "frame": 30, "value": 180 }] }
```

Seven effects change a layer's colours the way the CSS `filter` functions of the same name do. They use the matrices in
the W3C Filter Effects spec, so they match a browser's.

| `type` | Field | Default | Meaning |
|---|---|---|---|
| `saturate` | `amount` | `1` | `0` is greyscale, `1` no change, above `1` over-saturated. Below 0 counts as 0. |
| `contrast` | `amount` | `1` | Scales colours about mid grey (0.5): `0` is flat grey, `1` no change, above `1` more contrast. Below 0 counts as 0. |
| `brightness` | `amount` | `1` | Multiplies the colours: `0` is black, `1` no change, above `1` brighter. Below 0 counts as 0. |
| `grayscale` | `amount` | `1` | `0` no change, `1` fully grey (Rec. 709 weights). Clamped to 0..1. |
| `sepia` | `amount` | `1` | `0` no change, `1` full sepia. Clamped to 0..1. |
| `invert` | `amount` | `1` | `0` no change, `1` the negative, `0.5` flat mid grey. Clamped to 0..1. |
| `hueRotate` | `angle` | `0` | Degrees. Turns every hue round the colour wheel (positive is the CSS direction); greys stay grey. The W3C matrix is an approximation of a true hue turn, so brightness drifts slightly. |

All numbers are animatable. Alpha is never changed: a transparent pixel stays transparent (`invert` does not fill the
empty space around a shape) and a translucent one keeps its alpha.

A run of consecutive colour filters in one `effects` list is combined into a single matrix and drawn in one pass, so
`[sepia, hueRotate, contrast]` costs the same as `[sepia]`. Another kind of effect between them (a `blur`, say) splits
the run in two; they are applied in list order, so `[brightness 2, invert]` and `[invert, brightness 2]` differ.

Colours are filtered the way a browser does it: on the straight (not premultiplied) colour, in sRGB encoding, which is
not the linear light the rest of the compositor works in. So `brightness 0.5` is 0.5 on the sRGB value you would see in
an image editor, not half the light. The result is clamped to 0..1 once, at the end of the run. A browser clamps after
every filter, so a run that overshoots and then comes back, such as `[brightness 2, brightness 0.5]`, ends differently:
here it is a no-op, in a browser it is not. Any other effect between two filters splits the run and clamps there (a
`blur` with `radius: 0` draws nothing and serves).

Colour filters see the layer after the effects before them, so a filter after a `dropShadow` recolours the shadow too.
A run whose combined matrix is exactly the identity (a lone `saturate` of `1`, say) is skipped.

### gradientMap

```json
{ "type": "gradientMap", "stops": [
    { "offset": 0, "color": "#0a0030" }, { "offset": 0.4, "color": "#c2185b" },
    { "offset": 0.7, "color": "#ff9800" }, { "offset": 1, "color": "#fff8c4" } ] }
{ "type": "gradientMap", "amount": [{ "frame": 0, "value": 0 }, { "frame": 30, "value": 1 }],
  "stops": [{ "offset": 0, "color": "#000" }, { "offset": 1, "color": "#3cf" }] }
```

Replaces the layer's colours with colours looked up by brightness, the thermal-camera look. A pixel's luminance picks a
colour along the stops, dark pixels the early stops and light ones the late ones.

| Field | Default | Meaning |
|---|---|---|
| `stops` | required | 2 to 16 `{ "offset", "color" }` objects, the same as a [gradient's](#gradients) stops: `offset` is an animatable number in 0..1 and `color` may have alpha. A stop that goes backwards is held at the largest offset so far. Luminance below the first offset takes the first colour and above the last offset the last colour. |
| `amount` | `1` | Animatable, clamped to 0..1. Cross-fades from the original layer (`0`) to the graded one (`1`). At `0` the effect does nothing. |

- **Luminance** is Rec. 709 (0.2126, 0.7152, 0.0722) of the layer's straight colour in sRGB encoding, the same weights
  as `grayscale` and applied to the same values, so a white-to-black ramp as it looks in an image editor maps linearly
  along the stops. (The `luminance` mask and matte modes weigh the linear-light colour instead; they answer how much
  light there is, this answers how bright it looks.)
- **Colours** are interpolated in sRGB with straight alpha, not premultiplied: a stop at alpha 0 between two opaque
  ones fades the layer out along the way, and its own colour tints the fade. The result goes back to linear
  premultiplied like every colour filter.
- **Alpha** of the graded image is the layer's alpha times the stop's alpha, so a see-through stop makes the dark
  (or light) parts of the layer see-through. The cross-fade runs over colour and alpha together, in sRGB straight
  space. A fully transparent pixel stays empty.
- Counts nothing in the [margin](#canvas-margin).

### lut

```json
{ "type": "lut", "src": "looks/thermal.cube" }
{ "type": "lut", "src": "looks/teal-orange.cube", "amount": [{ "frame": 0, "value": 0 }, { "frame": 30, "value": 1 }] }
```

Grades the layer through a 3D colour lookup table from an Adobe/Resolve `.cube` file, the format colourists export.

| Field | Default | Meaning |
|---|---|---|
| `src` | required | Path of the `.cube` file, relative to the scene file like an image's `src`. The file is read and checked when the renderer is built, so a missing or malformed file fails before any frame; the error names the layer, the file and (for a bad file) the line. Several layers can share one file. |
| `amount` | `1` | Animatable, clamped to 0..1. Cross-fades from the original layer (`0`) to the graded one (`1`), in sRGB straight space. At `0` the effect does nothing. |

- **What is read.** `LUT_3D_SIZE` from 2 to 64, optional `DOMAIN_MIN` and `DOMAIN_MAX` (default 0 and 1), then
  `size`^3 rows of `r g b`, red varying fastest. `TITLE` and `#` comments are ignored. A 1D table (`LUT_1D_SIZE`), any
  other keyword and a wrong number of rows are errors.
- **How it is applied.** To the layer's straight colour in sRGB encoding (what the file's author saw), mapped from the
  domain to the table and clamped to it, with trilinear interpolation between the eight surrounding table points.
  Outputs are clamped to 0..1. Alpha is unchanged and a fully transparent pixel stays empty. The interpolation is
  done by hand on exact table reads, so the result does not depend on the GPU's filtering.
- Counts nothing in the [margin](#canvas-margin).

### grain

```json
{ "type": "grain", "amount": 0.15, "seed": 7 }
{ "type": "grain", "amount": 0.3, "size": 3, "seed": 21, "animate": false, "monochrome": false }
```

Film grain: noise added to the layer's own pixels, fixed to the screen. Rendering stays a pure function of the scene
and the frame, so the noise comes from an explicit `seed`, not a random generator.

| Field | Default | Meaning |
|---|---|---|
| `amount` | required | Animatable, clamped to 0..1: how far the noise moves a colour channel, as a fraction of the 0..1 range. `0.15` is a visible film grain, `1` is extreme. At `0` the effect does nothing. |
| `size` | `1` | Animatable, at least 1 (checked when the scene loads): the grain cell in canvas pixels. At `1` every pixel has its own value; above `1` the values sit on a grid `size` pixels apart and are blended smoothly between (value noise with a smoothstep), so large grain is soft, not blocky, and fainter than fine grain at the same `amount`. |
| `seed` | required | A whole number from 0 to 4294967295 (checked when the scene loads, naming the layer). Different seeds give unrelated patterns. |
| `animate` | `true` | A new pattern on every output frame. `false` shows the same pattern on every frame. |
| `monochrome` | `true` | One noise value for red, green and blue, so the grain only changes brightness. `false` gives each channel its own noise, which also changes hue. |

- **The noise** at a pixel is triangular (two uniform values summed, less 1: in -1..1, mean 0, standard deviation about
  0.41), from an integer hash of `seed`, the pixel and the frame. It is added to the straight colour in sRGB encoding,
  scaled by `amount`, and the result is clamped to 0..1. Pure black and pure white therefore lose the half of the
  noise that would take them past the ends, and show weaker grain. Alpha is not changed and a fully transparent pixel
  stays empty.
- **Canvas space.** The pixel is the canvas pixel, not a position on the layer: the grain does not move, scale or
  rotate with the layer, and does not change when the scene's [margin](#canvas-margin) does. (A layer whose pixels
  move under a fixed pattern shows grain that crawls across them, as film does.)
- **Motion blur.** The pattern uses the whole output frame number, so the sub-frames of one frame share a pattern
  rather than averaging the grain away.
- Counts nothing in the [margin](#canvas-margin). Grain on a group grains the group's combined pixels; grain after a
  `blur` grains the blurred image.

### dither

```json
{ "type": "dither", "levels": 2 }
{ "type": "dither", "mode": "random", "levels": 4, "size": 2, "seed": 3, "animate": true }
```

Cuts each colour channel down to a few levels and uses a pattern to decide which of the two nearest levels each pixel
gets, so gradients turn into the dotted look of a one-bit or low-colour display instead of bands.

| Field | Default | Meaning |
|---|---|---|
| `mode` | `ordered` | `ordered`: an 8x8 Bayer threshold matrix, the same crosshatch every frame. `random`: a seeded white-noise threshold. |
| `levels` | `2` | Animatable, rounded to a whole number, from 2 to 256 (checked when the scene loads). Values per channel: `2` is black or full on each of red, green and blue (8 colours), `256` is no visible change. |
| `size` | `1` | Animatable, at least 1 (checked when the scene loads): canvas pixels per dither cell, so `3` gives a coarse 3 x 3 pixel pattern. |
| `seed` | none | Whole number from 0 to 4294967295. Required for `random` (an error naming the layer if missing); `ordered` ignores it. |
| `animate` | `false` | `random` only: a new pattern on every output frame. `false` keeps one pattern. `ordered` has no randomness, so it ignores this. |

- **The maths.** Each channel `v` of the straight colour, in sRGB encoding, becomes `floor(v * (levels - 1) + t) /
  (levels - 1)`, where `t` in 0..1 is the cell's threshold: `(bayer + 0.5) / 64` for `ordered`, a seeded hash value for
  `random`. So 0 and 1 are always kept, and over a Bayer block a flat colour comes out on average as itself (a quarter
  grey at two levels is on in exactly 16 of the 64 cells). A tiny offset keeps a white that came back from the sRGB
  round trip a hair low from falling to the level below.
- **Alpha is kept, not dithered**: a translucent layer stays translucent, and a fully transparent pixel stays empty.
  Only the colour is quantised, so the soft edge of a shape or of text dithers its colours but not its coverage.
- **Canvas space.** Cells are `size` canvas pixels, laid on the screen from its top-left corner, not on the layer:
  the pattern does not move with the layer and does not change with the scene's [margin](#canvas-margin). Random
  thresholds come from an integer hash of `seed`, the cell and (if `animate`) the output frame.
- Counts nothing in the [margin](#canvas-margin).

### halftone

```json
{ "type": "halftone", "size": 8, "angle": 45 }
{ "type": "halftone", "size": 5, "angle": 0, "shape": "line", "color": "#ffcc00", "invert": true }
```

Replaces the layer with a halftone screen, the printed-newspaper look: a grid of dots whose size follows how bright the
layer is. The grid lives in the layer's own space, so the dots move, scale and rotate with the layer (unlike `grain`
and `dither`, which stay on the screen).

| Field | Default | Meaning |
|---|---|---|
| `size` | `8` | Animatable, greater than 0 (checked when the scene loads): the width of a grid cell in layer pixels. |
| `angle` | `45` | Animatable, degrees clockwise: the rotation of the grid. 45 is the classic screen. |
| `shape` | `circle` | `circle`, `square`, or `line` (parallel lines along the grid's x axis, whose thickness follows the layer and steps from one cell to the next along the line). |
| `color` | none | The dot colour. Its alpha scales the dots' coverage. Without it a dot takes the colour the layer has at its cell's centre, at full alpha. |
| `invert` | `false` | Big dots where the layer is dark instead of light. |

- **What each cell does.** The layer is read once per cell, at the cell's centre, with bilinear filtering. The cell's
  value `v` is the colour's luminance (Rec. 709, of the straight sRGB colour, as the colour filters use it) times its
  alpha, or `(1 - luminance) * alpha` with `invert`. A transparent or black cell therefore has no dot, and a white
  opaque one is solid. A cell whose centre lies off the texture (off the canvas, margin included) has no dot either.
- **Dot size.** The dot's area is the fraction `v` of the cell's: a `circle` has radius `size * sqrt(v / pi)`, which is
  where neighbouring dots touch at `v = pi/4`; above that the part of the circle inside the cell has area `v` (the
  radius is found by bisection and reaches the half diagonal at `v = 1`, so the cell is exactly solid). A `square` has
  side `size * sqrt(v)`, a `line` thickness `size * v`. A dot never leaves its cell.
- **Edges** are anti-aliased over about one canvas pixel, whatever the layer's scale. A dot narrower than half a pixel
  fades out instead of flickering.
- **Alpha.** The output alpha is the dots' coverage (times the `color`'s alpha), so a half-transparent layer gets
  smaller dots, not see-through ones, and an opacity set on the layer still multiplies the result afterwards.
- Counts nothing in the [margin](#canvas-margin). Halftone on a group screens the group's combined pixels; a `blur`
  before it is screened as it is blurred.

### dotMatrix

```json
{ "type": "dotMatrix", "progress": [{ "frame": 0, "value": 0 }, { "frame": 30, "value": 1 }], "seed": 1 }
{ "type": "dotMatrix", "size": 10, "progress": 0.5, "order": "sweep", "angle": 45, "stagger": 0.4, "shape": "square" }
```

A reveal: the layer seen through a grid of dots that grow from nothing to solid. Animate `progress` from 0 to 1 to
reveal the layer, or from 1 to 0 to hide it. The grid lives in the layer's own space, so it moves, scales and rotates
with the layer. `halftone` is the look that follows the layer's brightness; this one follows time.

| Field | Default | Meaning |
|---|---|---|
| `progress` | required | Animatable, clamped to 0..1: `0` shows nothing, `1` shows exactly the layer. |
| `size` | `12` | Animatable, greater than 0 (checked when the scene loads): the width of a grid cell in layer pixels. |
| `order` | `random` | `random`: each cell gets its own delay from the `seed`. `sweep`: the delay grows with the cell's position along `angle` across the layer's box. |
| `angle` | `0` | Animatable, degrees clockwise from +x, for `sweep`: `0` reveals left to right, `90` top to bottom, `180` right to left. Ignored by `random`. |
| `stagger` | `0.6` | Animatable, from 0 up to (not including) 1 (checked when the scene loads): how much of the `progress` range is spent on delays. `0` grows every dot together; the higher it is, the more the dots start one after another and the faster each grows. |
| `seed` | none | Whole number from 0 to 4294967295. Required for `random` (an error naming the layer if missing); `sweep` ignores it. |
| `shape` | `circle` | `circle` or `square`. |

- **Timing.** A cell has a delay `d` between 0 and `stagger`: a hash of the `seed` and the cell for `random`, or the cell
  centre's place along `angle` across the layer's box (0 at the nearest corner, `stagger` at the farthest) for `sweep`.
  Its dot is `clamp((progress - d) / (1 - stagger), 0, 1)` grown, so it starts at `progress = d`, takes `1 - stagger` of
  the range to finish, and the last cell is done exactly at `progress = 1`.
- **The dot.** A grown dot of `1` is a circle whose radius reaches the cell's corners, or a square reaching its sides,
  so the cell is exactly solid and the layer shows untouched: at `progress` 1 the effect does nothing and costs nothing.
  Between, the radius (or half side) is `grown` times that, so it opens like an iris. Edges are anti-aliased over
  about one canvas pixel; a dot narrower than half a pixel fades out instead of flickering.
- **The layer is multiplied** by the dots' coverage, in premultiplied linear colour, so the colours and alpha inside a
  dot are the layer's own and the rest is transparent.
- **Cells are in layer space**, counted from the layer's own origin, so the random delays stick to the layer as it
  moves, and a layer moving off the canvas keeps its pattern. Content above or left of the origin (a path with negative
  coordinates, a group's child placed there) is in cells at negative indices, which hash like any other.
- **`sweep` needs a box**: the box a shape, an image or a text layer has (the same as an `inset` clip measures from), so
  `sweep` on a group is an error when the scene loads, naming the layer. Use `random` on a group.
- Counts nothing in the [margin](#canvas-margin).

### displace

```json
{ "type": "displace", "scale": 10,
  "turbulence": { "type": "fractalNoise", "baseFrequency": 0.04, "numOctaves": 4, "seed": 7 } }
{ "type": "displace", "scale": [{ "frame": 0, "value": 0 }, { "frame": 30, "value": 20 }],
  "xChannelSelector": "B", "yChannelSelector": "A",
  "turbulence": { "type": "turbulence", "baseFrequency": [0.02, 0.08], "numOctaves": 2, "seed": 11 } }
```

Pushes the layer's pixels around with noise: SVG's `feTurbulence` feeding `feDisplacementMap` on the source graphic, with
the same attributes under the same names, so a filter like papercut's `url(#torn)` (a rough, ragged edge on a card)
ports by copying its values. A torn paper edge is `fractalNoise` at about `0.04`, 4 octaves, `scale` around 10; a
rougher, finer edge uses a higher `baseFrequency` and a smaller `scale`.

| Field | Default | Meaning |
|---|---|---|
| `scale` | required | Animatable, in layer pixels (SVG user units): how far the noise can move a pixel. Negative reverses the push; `0` leaves the layer alone and costs nothing. |
| `xChannelSelector` | `R` | `R`, `G`, `B` or `A`: the noise channel that moves pixels sideways. SVG's own default is `A` for both selectors, which pushes only along the diagonal; here the defaults are `R` and `G`. |
| `yChannelSelector` | `G` | The channel that moves pixels up and down. |
| `turbulence` | required | The noise, below. |

`turbulence` takes SVG's `feTurbulence` attributes (the [`noise` layer](#noise) takes the same object):

| Field | Default | Meaning |
|---|---|---|
| `type` | required | `fractalNoise` (soft clouds centred on grey) or `turbulence` (dark with bright veins). |
| `baseFrequency` | required | Animatable, not negative (checked when the scene loads): cycles per layer pixel of the first octave. One number, or `[x, y]` for a different frequency per axis (each a number or keyframes). A list of keyframe objects is one animated number for both axes. |
| `numOctaves` | `1` | Whole number from 0 to 10 (checked when the scene loads, an error naming the layer). Each octave doubles the frequency and halves the weight. Zero sums no noise, which the reference algorithm turns into a middle grey (0.5 in every channel, alpha too) for `fractalNoise` and transparent black for `turbulence`: a displacement with no octaves leaves a `fractalNoise` layer in place and moves a `turbulence` one `scale / 2` down and to the right. Not animated. |
| `seed` | required | A number, truncated toward zero (`7.9` is `7`, `-4.9` is `-4`) and then brought into the generator's range by SVG's `setup_seed` (zero and negatives are folded into positive seeds, huge ones held at the top). The same seed draws the same noise on every machine. Not animated. |

- **What a pixel does.** An output pixel at layer point `(x, y)` takes the layer's colour at
  `(x + scale * (XC - 0.5), y + scale * (YC - 0.5))`, where `XC` and `YC` are the selected noise channels, 0..1, at
  the pixel's centre. The noise is computed in the layer's own space, so the pattern and the push move, scale and
  rotate with the layer (as an SVG filter on a transformed element does), and a group is displaced in the group's
  space. The channels are used as the noise gives them, with no colour conversion between the two primitives (SVG's
  default `linearRGB` is the same for both).
- **Sampling.** Bilinear, on premultiplied colour, worked out in the shader from the canvas position and not by the
  hardware sampler, so the result is the same bit for bit at any [margin](#canvas-margin) (the sampler's weights come
  from the texture's size). What lies outside the texture (the canvas and its margin) is transparent. The noise follows the spec's reference algorithm in 32-bit floats and, unlike a browser's, is not
  quantised to 8 bits, so expect differences of about one 8-bit step against a browser, not a different pattern.
- Counts `|scale| / 2` times the largest product of `scale` over the layer and its ancestors in the
  [margin](#canvas-margin) (a pixel is read from that far away; at the largest keyframe, whichever way the scale
  points), so the torn edge of a card that hangs off the canvas still pulls in what lies beyond it. Other effects' reaches
  stay in canvas pixels and ignore `scale`. The factor is per axis: a rotated layer's diagonal push can reach up to
  1.41 times further in the worst case, which a margin this size can cut off.
- Effects after `displace` see the displaced layer; one before it (`glow`, a shadow) is displaced with it. For the
  papercut look put the shadow after: `[displace, dropShadow]` casts the shadow of the torn edge.

### filterGraph

An SVG `<filter>` as a graph of primitives: `feTurbulence` into `feDisplacementMap`, `feGaussianBlur`,
`feColorMatrix`, `feComposite`, and the rest, chained by `in`, `in2` and `result`. A port from SVG is mechanical:
every attribute keeps its SVG name and meaning.

```json
{ "type": "filterGraph",
  "filterUnits": "userSpaceOnUse", "x": -20, "y": -20, "width": 280, "height": 200,
  "primitives": [
    { "primitive": "feTurbulence", "type": "fractalNoise", "baseFrequency": 0.04, "numOctaves": 4, "seed": 7,
      "result": "noise" },
    { "primitive": "feDisplacementMap", "in": "SourceGraphic", "in2": "noise", "scale": 12,
      "xChannelSelector": "R", "yChannelSelector": "G" } ] }
```

The graph runs on the layer's own pixels (`SourceGraphic`) in the layer's own space, like `displace`: lengths, the
region and the noise are in layer pixels and follow the layer's `transform`, so a filter on a turned and scaled layer is
the same filter turned and scaled. The result of the last primitive is the layer.

| Field | Default | Meaning |
|---|---|---|
| `x`, `y`, `width`, `height` | -10%, -10%, 120%, 120% of the layer's box | The filter region: nothing outside it survives, not even the layer. |
| `filterUnits` | `objectBoundingBox` | `userSpaceOnUse`: the region is in layer pixels. `objectBoundingBox`: fractions of the layer's box (the box `inset` clips use). A group without a `layout` has no box: give it a `bbox`, or `userSpaceOnUse` with all four numbers and `primitiveUnits` `userSpaceOnUse` (a load error otherwise). |
| `primitiveUnits` | `userSpaceOnUse` | What primitive lengths and subregions are in. `objectBoundingBox` scales `stdDeviation`, `dx`, `dy`, `radius` and subregions by the box's width and height, and `scale` and light `z` by the root of the mean of their squares. |
| `colorInterpolationFilters` | `linearRGB` | The colour space primitives work in unless one says otherwise (`linearRGB` or `sRGB`). The layer is in linear light; a primitive in sRGB gets its inputs converted and its result converted back, so a blur, a blend or a colour matrix gives what a browser's does in either space. |
| `bbox` | none | `[x, y, width, height]`, the box that `objectBoundingBox` units and the default region are fractions of, in layer space. For a layer that has no box (a group) and for a port from SVG: the box of the element the SVG filter was on. It is used instead of the layer's own box when both exist. |
| `primitives` | required | In order. Each result can be named; a primitive can read the layer, any earlier result, or (left out) the previous result. |

Every primitive has `primitive` (its element name), `in`, `in2` (when it has two inputs), `result`, `x`, `y`, `width`,
`height` (the primitive subregion) and `colorInterpolationFilters`.

- **Inputs.** `SourceGraphic` is the layer cut to the filter region, `SourceAlpha` the same as black with its alpha. A
  name that no earlier primitive made reads the previous result (the layer, for the first primitive).
  `BackgroundImage`, `BackgroundAlpha`, `FillPaint` and `StrokePaint` are empty images, as in Chrome.
- **Subregions.** A primitive draws only inside its subregion: each side left out defaults to the union of the
  subregions of the primitives it reads, or to the filter region if it reads the layer or nothing (and for `feTile`).
  The subregion is cut to the filter region. Edges are hard: a pixel is in if its centre is.
- **Numbers.** Every number is an [animatable number](#animated-numbers), also inside `values`, `tableValues` and
  `kernelMatrix`. `stdDeviation`, `radius`, `baseFrequency` and `order` take one number or `[x, y]`.

| `primitive` | Attributes | Notes |
|---|---|---|
| `feTurbulence` | `type` (`turbulence` default or `fractalNoise`), `baseFrequency` (0), `numOctaves` (1, 0 to 10), `seed` (0), `stitchTiles` (`true` or `false`) | The spec's reference algorithm, as the [`noise` layer](#noise) and [`displace`](#displace) have it, including `stitchTiles` (the tile is the primitive subregion). Sampled at whole canvas positions, as a browser does. Output is the raw four channels, not premultiplied, in the primitive's colour space. |
| `feDisplacementMap` | `scale` (0), `xChannelSelector`, `yChannelSelector` (`R`, `G`, `B`, `A`; SVG's default is `A`) | `in` is moved by `in2`'s channels, read unpremultiplied and in the primitive's colour space (`in` is not converted). Nearest-pixel sampling, as a browser does. |
| `feGaussianBlur` | `stdDeviation` (0) | Per axis; 0 on one axis blurs along the other. A round blur of 12 pixels or more uses the same pyramid as the [`blur` effect](#blur), less is exact. A turned layer is blurred along the canvas axes with the variance the turned filter has on each. At most 256. |
| `feColorMatrix` | `type` (`matrix` default, `saturate`, `hueRotate`, `luminanceToAlpha`), `values` | On straight (unpremultiplied) colour, clamped to 0..1. A `values` of the wrong length is the identity. |
| `feOffset` | `dx`, `dy` | In layer pixels, so it turns with the layer. Fractions of a pixel are interpolated. |
| `feFlood` | `floodColor` (`#000000`), `floodOpacity` (1) | The colour is sRGB and converted to the primitive's space. |
| `feComposite` | `operator` (`over`, `in`, `out`, `atop`, `xor`, `arithmetic`), `k1` to `k4` | `in` is the source, `in2` the destination. `arithmetic` is `k1*i1*i2 + k2*i1 + k3*i2 + k4` on premultiplied values, clamped. |
| `feBlend` | `mode` | `normal`, `multiply`, `screen`, `darken`, `lighten`, `overlay`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`. `in` is on top of `in2`. |
| `feMerge` | `nodes`: the `in` of each `feMergeNode`, bottom first | |
| `feComponentTransfer` | `funcR`, `funcG`, `funcB`, `funcA`: `{ "type": "identity" \| "table" \| "discrete" \| "linear" \| "gamma", "tableValues", "slope", "intercept", "amplitude", "exponent", "offset" }` | On straight colour. At most 32 table values. |
| `feDropShadow` | `dx` (2), `dy` (2), `stdDeviation` (2), `floodColor`, `floodOpacity` | Made of the primitives the spec says: a blur of the alpha, an offset, a flood, `in` composite, a merge with the input. |
| `feMorphology` | `operator` (`erode` default, `dilate`), `radius` (0) | A box of `radius` layer pixels each way, as whole pixels (at most 200 on the canvas); on a turned layer the box is along the canvas axes. |
| `feTile` | | Repeats the input's subregion over its own. |
| `feConvolveMatrix` | `order` (3, at most 8), `kernelMatrix`, `divisor` (sum of the kernel, or 1), `bias` (0), `targetX`, `targetY` (middle), `edgeMode` (`duplicate`, `wrap`, `none`), `preserveAlpha` | In canvas pixels (`kernelUnitLength` is not used). |
| `feDiffuseLighting`, `feSpecularLighting` | `surfaceScale` (1), `diffuseConstant` or `specularConstant` (1), `specularExponent` (1, 1 to 128), `lightingColor` (white), `light` | `light` is `{ "type": "distant", "azimuth", "elevation" }`, `{ "type": "point", "x", "y", "z" }` or `{ "type": "spot", "x", "y", "z", "pointsAtX", "pointsAtY", "pointsAtZ", "specularExponent", "limitingConeAngle" }`. The input's alpha is the height; normals use the spec's Sobel kernels in canvas pixels, and a spot's cone fades over 0.016 of cosine like a browser's. |

`feImage` is not supported yet.

Loading a scene rejects a negative `stdDeviation`, `radius`, `baseFrequency` or subregion size, `numOctaves` outside 0
to 10, a `values` or `kernelMatrix` of the wrong length, and a graph that needs a box on a layer that has none; the
error names the layer.

The [margin](#canvas-margin) counts what moves pixels: the largest offset (and a drop shadow's), half a displacement's
`scale`, a dilation's radius and a convolution's order, summed along the graph, plus `3 * stdDeviation` of its blurs
(a graph that only blurs counts nothing, like `blur`).

### cornerPin

```json
{ "type": "cornerPin", "topRight": [200, 22], "bottomRight": [180, 128] }
{ "type": "cornerPin",
  "topLeft": [20, 0], "topRight": [150, [{ "frame": 0, "value": 0 }, { "frame": 30, "value": 24 }]],
  "bottomRight": [150, 92], "bottomLeft": [0, 80] }
```

Pins the four corners of the layer's box to four points, warping the layer into that quadrilateral with perspective:
a billboard, a screen in a photo, a flag. The box is the one the `inset` clip uses (a shape's, image's, noise's or mesh's
width by height, a text layer's layout box, a path's bounding box); a group has none, so a `cornerPin` on a group is a
load error naming the layer.

| Field | Default | Meaning |
|---|---|---|
| `topLeft`, `topRight`, `bottomRight`, `bottomLeft` | the box's own corner | Where that corner of the box goes, `[x, y]` in the layer's own space (each number animatable). A corner left out stays on the box, so pinning one or two corners moves just those. |

- **The map.** The homography taking the four box corners to the four points (computed exactly: the box's centre ends
  up where the pinned quadrilateral's diagonals cross, and straight lines stay straight). It is applied in the layer's
  space, so the pin moves, scales and rotates with the layer's `transform`; the layer is warped on the texture as
  `M * H * M^-1`, `M` being its flat matrix, with the same warp pass as the [3D transforms](#3d-transforms-and-the-camera)
  (bilinear, on premultiplied colour, transparent outside the texture).
- **Order.** It is an effect, so it runs in its place in `effects`: effects before it are warped with the layer (a
  `dropShadow` before it is pinned too), and effects after it see the warped layer (a shadow after it is cast by the
  new shape). `clip`, `mask` and `matte` come after all effects and work in the layer's own space, not the pinned one.
  A layer with a pin can also have `rotateX`, `rotateY` and `z`: the 3D warp then moves the pinned layer.
- **Doing nothing.** A pin whose four points are the box's corners (all left out, or written out exactly) changes
  nothing and costs no pass. Pinned corners that squeeze the box to a line or a point leave nothing to draw: the
  layer is empty for those frames. A bow tie (the pins in the wrong order, so the sides cross) is not a plane; the part
  of the layer that the map flips is not drawn.
- Counts nothing in the [margin](#canvas-margin): the warp can only bring in what the layer's texture holds, which is
  the canvas plus the margin. Pinning a corner far out stretches the layer's pixels, not new ones, and a layer that
  hangs off the canvas is cut at the texture's edge before it is pinned.
- Magnified parts are resampled (soft) and minified parts can alias, since there are no mipmaps.

### backdropBlur

```json
{ "type": "backdropBlur", "radius": 16 }
{ "type": "backdropBlur", "radius": [{ "frame": 0, "value": 0 }, { "frame": 30, "value": 20 }] }
```

Frosted glass. What is behind the layer is blurred and shown through the layer's shape, and the layer is drawn on
top of it.

| Field | Meaning |
|---|---|
| `radius` | Animatable number, in canvas pixels, like the `blur` effect's: roughly the standard deviation. Clamped to 0..128; below 1 it does nothing. Required. |

- **The backdrop** is the canvas as it is when the layer is reached: the background and every layer below it. Inside a
  group it is the backdrop of the group with the group's earlier children drawn over it (normal blend, full opacity),
  so a frosted card inside a group still blurs the scene beneath the group. Layers above the card, and the card's own
  siblings drawn later, are not in it.
- **Where it shows.** For a `shape` layer, the whole shape: its fill area if it has a `fill` and its stroke area if it
  has a `stroke`, each treated as fully opaque, so a see-through fill (`#ffffff30`) still frosts everything inside the
  shape. For `text`, `image` and `group` layers, wherever the layer is painted, in proportion to its alpha (so frosted
  text frosts only inside the letters, and a half-transparent image frosts half-strength).
- **Order.** Like every effect it works on the layer as it is after the effects before it, then the clip, mask and
  matte cut the result: a `clip` of an ellipse on a frosted square gives a round lens. `opacity` fades the layer and
  its frosted backdrop together, and a `blendMode` applies to both.
- A matte source (see [Track mattes](#track-mattes)) with a `backdropBlur` blurs the backdrop of the layer it mattes.
- The backdrop is blurred as the canvas plus the [margin](#canvas-margin): at the canvas edge it blurs in the
  background colour and whatever hangs past the edge up to the margin, and past that nothing (transparent). The
  margin counts `3 * radius`, so the edge of the canvas is blurred from real pixels.
- Cost: one extra full-canvas blur per frosted layer per frame, plus one canvas-sized copy when the layer is inside a
  group.

### shader

A fragment shader of your own, in WGSL, run over the layer.

```json
{
  "type": "shader",
  "code": "fn effect(px: vec2<f32>) -> vec4<f32> {\n  let wave = sin(px.y * 0.1 + globals.time * 6.0) * u.strength;\n  return layer(px + vec2<f32>(wave, 0.0));\n}",
  "uniforms": { "strength": [{ "frame": 0, "value": 0 }, { "frame": 30, "value": 12 }] },
  "padding": 16
}
```

| Field | Default | Meaning |
|---|---|---|
| `code` | required | WGSL that defines `fn effect(px: vec2<f32>) -> vec4<f32>`. May also define helper functions, constants and structs. |
| `uniforms` | `{}` | Named values, each an animatable number. They reach the shader as `u.<name>`, all `f32`. A name is a WGSL identifier (letters, digits, underscore; not a keyword). |
| `padding` | `0` | Animatable, in canvas pixels, not negative. How far past the layer the shader paints; counted in the [margin](#canvas-margin). |

`effect` returns the colour of the output pixel `px` as **linear, premultiplied** RGBA (the compositor's own format,
so an output with `rgb` above `a` is out of range and brightens when blended). `px` is in canvas pixels with (0, 0)
at the canvas's top-left corner: the centre of the first pixel is (0.5, 0.5), and pixels in the margin have negative
coordinates or ones past the canvas size. The effect runs over the whole padded canvas, so it can paint outside the
layer (a halo, a smear) as far as the margin goes.

What the engine puts before your code:

| Name | Meaning |
|---|---|
| `fn layer(px: vec2<f32>) -> vec4<f32>` | Reads the layer (as it is after the effects before this one) at canvas pixel `px`, bilinear, linear premultiplied. `layer(px)` at the output pixel's own `px` is that pixel exactly. Outside the padded canvas it is transparent. |
| `globals.frame` | The frame number, `f32`. |
| `globals.time` | `frame / fps` in seconds, `f32`. |
| `globals.canvas` | `vec2<f32>`: the canvas size in pixels (without the margin). |
| `globals.margin` | `f32`: the margin in pixels (see [Canvas margin](#canvas-margin)). `layer` already accounts for it. |
| `u.<name>` | One `f32` per key of `uniforms`, at this frame. |

The names `layer`, `globals`, `u`, `U`, `Globals` and anything starting with `kg_` belong to the engine; defining one
yourself is an error. Do not declare `@vertex`, `@fragment` or `@compute` entry points or your own `@group`/`@binding`
variables (constants and `var<private>` are fine): the engine adds a full-screen vertex and a fragment entry point that
calls `effect`. Nothing random or clock-based exists in WGSL here, so a shader is a pure function of the scene and the
frame like the rest of the renderer; derive any noise from `px`, `globals.frame` and the uniforms.

**Validation.** When the scene loads, the whole module (the engine's prelude, your code, the entry points) is parsed
and validated with naga, on the CPU and without a GPU. Errors name the layer and the line and column within your
`code`:

```
invalid scene: layer "card": shader code 2:30: expected `)`, found ";"
```

A missing `effect`, one with the wrong signature, a uniform name that is not an identifier, a negative `padding`, a
name of your own starting with `kg_`, and entry points or bindings of your own are errors too, naming the layer. Type
errors and unknown names (including a `u.` field you did not list in `uniforms`) are reported at the place they occur.
Each distinct shader (same `code` and same uniform names) is compiled to one pipeline when the renderer is created, so
no compilation happens per frame; the same shader on many layers, with different uniform values, costs one pipeline.

- The shader sees the layer texture, not the layers behind it, and not the layer's `transform`: `px` is always canvas
  pixels. To work in the layer's own space, animate a uniform with the offset.
- The padded canvas is the shader's whole domain, so the margin it implies costs every texture in the scene, like any
  other effect's reach.
- `layer` samples with a bilinear filter, so reading between pixels blurs slightly. Use `+ vec2<f32>(0.5)` after
  `floor` to land on pixel centres.

## Clip paths

`clip` cuts a layer to a shape: pixels outside it become transparent, and the edge is anti-aliased (16x multisampled,
like every shape). The shape is in the layer's own coordinates, so it follows the layer's `transform` (position,
scale, rotation). A layer's pixels go through, in this order: its `effects`, its `clip`, its `mask`, its `matte`,
then `opacity` and `blendMode`. So a blur is cut off by the clip, and the clip is not blurred. A group's clip applies to the composited
group. Every number is animatable.

```json
{ "id": "photo", "type": "image", "src": "photo.png", "width": 160, "height": 120,
  "clip": { "kind": "inset", "left": [{ "frame": 0, "value": 0 }, { "frame": 30, "value": 40 }], "radius": 12 } }
```

| `kind` | Fields | Notes |
|---|---|---|
| `polygon` | `points`: array of `[x, y]` pairs, at least 3 | Each coordinate is an animatable number. Non-zero fill rule, so a self-crossing star is filled throughout. |
| `inset` | `top`, `right`, `bottom`, `left`, `radius` (all default `0`) | The layer's own box shrunk by the four distances, like CSS `inset()`. A negative distance grows the box. `radius` rounds the corners, is at least 0 and is limited to half the shorter side. If the sides cross, nothing is kept. |
| `ellipse` | `cx`, `cy`, `rx`, `ry` | Centre and radii, at least 0. A radius of 0 keeps nothing. |
| `path` | `d`: SVG path data | Non-zero fill rule. The path is not animated (like a shape's `path`). |

The layer's own box, which `inset` is measured from:

| Layer | Box |
|---|---|
| `rect`, `roundedRect`, `ellipse` shape | `0, 0, width, height` (a stroke is not part of the box) |
| `path` shape | The path's bounding box |
| `image`, `lottie`, `canvas` | `0, 0, width, height` |
| `text` | `0, 0, maxWidth` (or the laid-out width when there is no `maxWidth`) by the laid-out height |
| `group` | None, unless it has a `layout`: then `0, 0, width, height` of the size the layout gave it. `inset` on a group without one is a load error; use `polygon`, `ellipse` or `path`. |

Loading a scene rejects a polygon with fewer than 3 points, a bad path `d`, a negative `radius`, `rx` or `ry` at any
keyframe, and `inset` on a group without a `layout`, and the error names the layer.

## Gradients

A gradient is an object that appears wherever a scene paints with one: `mask`, a shape's `fill` and a text layer's
`color`. Its coordinates are in the
space of whatever it paints, so a mask gradient lives in the layer's own space and follows the layer's `transform`.
Every number is animatable, including the stop offsets.

```json
{ "type": "linear", "x0": 0, "y0": 0, "x1": 400, "y1": 0,
  "stops": [{ "offset": 0, "color": "#ff0000" }, { "offset": 1, "color": "#0000ff" }], "extend": "pad" }
```

| `type` | Fields | Meaning |
|---|---|---|
| `linear` | `x0`, `y0`, `x1`, `y1` | Offset 0 is at (x0, y0) and offset 1 at (x1, y1); lines perpendicular to that axis have one colour. |
| `radial` | `cx`, `cy`, `r`, and optionally `fx`, `fy`, `fr` | Circles around the centre; offset 1 is at distance `r` (at least 0). With a focal circle (`fx`, `fy`, `fr`: each defaults to the centre's, and 0 for `fr`) offset 0 is on it and the circles in between grow from it to the outer one, as SVG's focal point does. |
| `conic` | `cx`, `cy`, `angle` (default `0`) | Offset 0 points `angle` degrees clockwise from 12 o'clock, as in CSS `conic-gradient`; offset 1 is a full turn later. |

Common fields:

| Field | Default | Meaning |
|---|---|---|
| `stops` | required | At least 2 `{ "offset", "color" }`. Offsets are between 0 and 1 at every keyframe. An offset lower than an earlier stop's is raised to it, as in CSS, so `[0.6, 0.3]` makes a hard edge at 0.6. Colours are plain colour strings (not animated) and may be translucent. |
| `extend` | `pad` | Outside the first and last stop. `pad` holds the end colours. `repeat` repeats the span from the first to the last stop, which is CSS `repeating-linear-gradient` and friends; `reflect` does the same with every second span backwards. For `conic`, which already goes round, `repeat` repeats the span within the turn. |
| `units` | `user` | What the coordinates are measured in. `user`: pixels of the painted layer. `box`: fractions of the painted layer's box, see [Box units](#box-units). |
| `transform` | none | A matrix `[a, b, c, d, e, f]` (SVG's `matrix()`, so `x' = a x + c y + e`) that takes the gradient's space (after `units`) to the painted layer's: SVG's `gradientTransform`. A non-uniform matrix turns a circle into an ellipse and skews a line's perpendiculars. |

Colours blend in sRGB with premultiplied alpha, as in CSS, so a stop fading to `#ffffff00` fades to transparent white
and not through grey. (Layers themselves are still blended in linear light.) A gradient with no extent paints the last
stop's colour everywhere: a linear gradient whose two points coincide, a radial one with `r` 0, or a repeating one
whose first and last stop have the same offset. The ramp between stops is sampled at 512 steps.

### Box units

With `"units": "box"` a gradient's coordinates are fractions of the box of the layer it paints: `(0, 0)` is the box's
top-left corner and `(1, 1)` its bottom-right (the box is the one `inset` clips use, see [Clip paths](#clip-paths)). The
gradient stretches with the box, as SVG's `objectBoundingBox` does, so a gradient that fits a layer keeps fitting it
when the layer is resized or animated, without knowing its size.

```json
{ "id": "glow", "type": "shape", "shape": { "kind": "ellipse", "width": 160, "height": 90 },
  "fill": { "type": "radial", "units": "box", "cx": 0.5, "cy": 0.5, "r": 0.5,
            "stops": [{ "offset": 0, "color": "#fff3b0" }, { "offset": 1, "color": "#9e2a2b" }] } }
```

- It applies wherever a gradient does: a shape's `fill`, a text layer's `color` and a layer's `mask`. A `stroke` takes
  only a colour.
- The whole gradient is stretched, not only its position: a `radial` gradient with `r` 0.5 on a box twice as wide as it
  is tall is an ellipse, and the turn of a `conic` one is stretched with it. `r` is measured in box widths along x and
  box heights along y.
- A gradient in box units on a shape is measured from the shape's geometry, not counting its stroke. On a text layer the
  box is the text box. For a path the box is its bounding box, which need not start at `(0, 0)`.
- A box with no width or no height has no extent, so the gradient paints the last stop's colour.
- A layer without a box has nothing to measure from: a `mask` in box units on a group without a `layout` is a load error
  naming the layer. A group with a `layout` has a box, see [Layout](#layout).

## Gradient fills

A shape's `fill` and a text layer's `color` take a [gradient](#gradients) in place of a colour string. The gradient's
coordinates are in the layer's own space, the same space as the shape's geometry (origin at the shape's top-left
corner), or, for text, the text box (origin at its top-left corner, as for `clip`). The gradient therefore follows the
layer's `transform` and moves with the layer when it is animated; to slide a gradient across a still shape, animate its
coordinates.

```json
{ "id": "card", "type": "shape", "shape": { "kind": "roundedRect", "width": 400, "height": 240, "radius": 24 },
  "fill": { "type": "linear", "x0": 0, "y0": 0, "x1": 400, "y1": 240,
            "stops": [{ "offset": 0, "color": "#ff4d4d" }, { "offset": 1, "color": "#2f6bff" }] } }

{ "id": "title", "type": "text", "text": "Gradient", "font": "DM Sans", "size": 56,
  "color": { "type": "linear", "x0": 0, "y0": 0, "x1": 200, "y1": 0, "extend": "reflect",
             "stops": [{ "offset": 0, "color": "#7aa2f7" }, { "offset": 1, "color": "#e05a9d" }] } }
```

- All four looks come from the one object: `linear`, `radial`, `conic`, and the repeating form of each with
  `"extend": "repeat"` (CSS `repeating-linear-gradient` and friends) or `"reflect"`. Everything else in
  [Gradients](#gradients) applies unchanged: `pad` by default, stop offsets 0..1, colours not animated, every number
  animatable.
- With `extend` `pad`, the fill covers the whole shape or all the glyphs, and the gradient holds its end colours past
  the first and last stop.
- Translucent stops make a translucent fill. The shape's `opacity` still multiplies the result.
- The `stroke` stays a plain colour, drawn over the fill.
- Loading a scene rejects a gradient with fewer than 2 stops, a stop offset outside 0..1 at any keyframe or a negative
  radial `r`; the error names the layer ("fill gradient" or "color gradient"). A `fill` or `color` that is neither a
  colour string nor an object is rejected with the parser's line and column.

## Gradient masks

`mask` multiplies the layer by a gradient, after the `clip`. It fades the layer in or out, or cuts it with a pattern.

```json
{ "id": "photo", "type": "image", "src": "photo.png", "width": 160, "height": 120,
  "mask": { "mode": "luminance",
            "gradient": { "type": "radial", "cx": 80, "cy": 60, "r": 90,
                          "stops": [{ "offset": 0, "color": "#ffffff" }, { "offset": 1, "color": "#000000" }] } } }
```

| Field | Default | Meaning |
|---|---|---|
| `gradient` | required | A [gradient](#gradients), in the layer's own coordinates, or in fractions of its box with `"units": "box"`. It covers the whole plane (see `extend`), not just the layer's box. |
| `mode` | `alpha` | `alpha` keeps the layer where the gradient is opaque. `luminance` keeps it where the gradient is light: the Rec. 709 luminance of the gradient's linear-light colour, times its alpha, so black and transparent both hide the layer. |

Loading a scene rejects a gradient with fewer than 2 stops, a stop offset outside 0..1 at any keyframe, a negative
radial `r`, and a `mode` other than `alpha` or `luminance`; the error names the layer.

## Track mattes

`matte` multiplies a layer by another layer's rendered pixels, after the `mask`. The other layer is the matte source;
it can be anything (text, an image, a group of shapes).

```json
{ "id": "photo", "type": "image", "src": "photo.png", "width": 171, "height": 128,
  "matte": { "layer": "word", "mode": "alpha" } },
{ "id": "word", "type": "text", "text": "Wave", "font": "DM Sans", "size": 84, "color": "#ffffff" }
```

| Field | Default | Meaning |
|---|---|---|
| `layer` | required | The `id` of the matte source. |
| `mode` | `alpha` | `alpha` keeps the layer where the source is opaque; `alphaInverted` where it is transparent. `luminance` keeps it where the source is light (Rec. 709 luminance of the linear-light colour, times alpha, as in a gradient mask); `luminanceInverted` where it is dark or transparent. `srgbLuminance` takes the luminance (0.2125, 0.7154, 0.0721) of the sRGB-encoded colour instead, times alpha, which is what an SVG `<mask>` does: mid grey (`#808080`) keeps half the layer, where `luminance` keeps a fifth. |

Rules:

- The source must be a sibling: in the same top-level `layers` list or the same group's `children`, before or after the
  layer. It cannot be the layer itself, and it cannot have a `matte` of its own. Several layers can share one source.
- A layer that is used as a matte source is not drawn on its own (as in After Effects). Its position in the list does
  not matter.
- The source is rendered with its own `transform`, `effects`, `clip`, `mask` and `opacity`, so it can be animated,
  blurred (a soft matte) or half transparent (a half-strength matte). Its `blendMode` is ignored. It is positioned
  with the same parent transforms as the layer it mattes, not the layer's own `transform`: the two move separately.
- An `opacity` of 0 on the source hides the whole matted layer in the modes that keep the opaque part, and shows it
  entirely in the inverted modes.

Loading a scene rejects a source that is missing, not a sibling, the layer itself or itself matted; the error names the
layer.

## 3D transforms and the camera

A layer can be turned and moved in 3D, and seen through a perspective camera, without leaving the 2D renderer.

```json
{
  "camera": { "perspective": 700 },
  "layers": [
    { "id": "photo", "type": "image", "src": "photo.png", "width": 150, "height": 112,
      "transform": { "x": 105, "y": 85, "anchorX": 75, "anchorY": 56,
                     "rotateY": [{ "frame": 0, "value": 0 }, { "frame": 30, "value": 50 }] } },
    { "id": "near", "type": "shape", "shape": { "kind": "rect", "width": 56, "height": 36 }, "fill": "#06d6a0",
      "transform": { "x": 330, "y": 70, "anchorX": 28, "anchorY": 18, "z": 300 } }
  ]
}
```

The `transform` fields `rotateX`, `rotateY` (degrees) and `z` (pixels) are all animatable numbers defaulting to 0. The
axes are CSS's: x to the right, y down, z toward the viewer; `rotateX(a)` is `[1 0 0; 0 cos -sin; 0 sin cos]` and
`rotateY(a)` is `[cos 0 sin; 0 1 0; -sin 0 cos]`, so a positive `rotateX` tips the top away and a positive `rotateY`
swings the right edge away. The whole matrix of a layer is, rightmost first,

```
translate(x, y, z) * rotateX * rotateY * rotate(rotation) * scale(scale, scale, 1) * translate(-anchorX, -anchorY, 0)
```

The layer turns about its position `(x, y)` (where its anchor lands), in the plane of its parent. It is never rendered
in 3D: it is drawn flat exactly as without these fields, run through its effects, clip, mask and matte, and then warped
onto the canvas by one 3x3 homography (`Proj * P * W * P^-1` restricted to the layer's plane, where `W` is the part of
the matrix above that the 2D matrix leaves out, `P` the flat matrix of its parent and `Proj` the camera). The order is
effects, clip, mask, matte, **warp**, then opacity and blend mode: as in CSS, the 3D transform moves the element after
its filters, so a `dropShadow` is flat and turns with the layer. A layer with none of the three fields is not warped
and is rendered as before, byte for byte.

`camera`, a field of the scene, is CSS's `perspective` and `perspective-origin`:

| Field | Default | Meaning |
|---|---|---|
| `perspective` | required | Animatable, canvas pixels, above 0 at every keyframe (checked when the scene loads). The distance from the eye to the canvas plane. A point `z` pixels toward the viewer is magnified by `perspective / (perspective - z)` about the origin. |
| `x`, `y` | the middle of the canvas | Animatable, canvas pixels. Where the eye looks at the canvas, the point that perspective does not move. |

There is one camera for the whole scene, and it applies to every layer with a 3D transform. Without a camera the
projection is orthographic: rotations foreshorten but nothing shrinks with distance, and `z` moves nothing on screen.

- **Groups** are flat: a group's children are drawn into the group's buffer as always, and the group is then turned as
  one picture (CSS without `preserve-3d`). A child's own 3D transform works in its parent's plane, after the
  parent's flat transforms: a child with `rotateX` in a group that is rotated 90 degrees turns about the group's
  horizontal axis, which is on the canvas's vertical.
- **Back faces** are drawn, mirrored, as in CSS's default: turn a layer past 90 degrees and you see it from behind.
- **Behind the eye.** The part of a layer that `z` (or a rotation) takes past the eye, to `perspective` pixels or more
  toward the viewer, is not drawn: it is cut off where it passes the eye plane, not mirrored back onto the screen.
  Near that plane the rest is magnified enormously, as in a browser. A layer seen exactly edge on (a `rotateY` of 90
  without a camera, or with one when the layer's plane runs through the eye) is not drawn at all; with a camera, a
  `rotateY` of 90 on a layer whose `x` is off the camera's `x` is seen from the side, as a thin sliver.
- `z` is in the units of the parent's plane and is not scaled by any `scale`: a group at `scale` 2 enlarges its
  children in the plane but not in depth (as `scale()` in CSS leaves z alone).
- A matte source cannot have `rotateX`, `rotateY` or `z` (a load error naming both layers): the source is cut out in the
  plane of the layer it mattes, and that layer is what moves. Put the 3D fields on the matted layer.
- Counts nothing in the [margin](#canvas-margin). The warp only reads what is in the flat texture, which is the canvas
  plus the margin: a layer that hangs off the canvas is cut at that edge before it is turned, and the cut shows once it
  is. Give it a margin with an effect, or keep it on the canvas.
- Sampling is bilinear on premultiplied colour. A layer magnified (toward the camera) is resampled and so soft; one
  minified (turned steeply, or far from the camera) can alias, since there are no mipmaps.
- There is no depth buffer: layers are drawn in document order (see `preserve3d` below for depth sorting), and two
  layers that cross in 3D do not intersect, one is simply over the other.
- `backdropBlur` on a layer that is turned frosts what is behind the layer *before* the turn, then turns the frosted
  picture with the layer.
- `grain` and `dither` are laid on the canvas pixels of the flat layer, before the warp, so on a turned layer their
  pattern turns and foreshortens with it (as it does under a `cornerPin` that comes after them).

### preserve3d groups

```json
{ "id": "stack", "type": "group", "preserve3d": true,
  "transform": { "x": 115, "y": 212, "rotateX": 24, "rotateY": [{ "frame": 0, "value": 10 }, { "frame": 30, "value": 70 }] },
  "children": [
    { "id": "back",  "type": "shape", "shape": { "kind": "roundedRect", "width": 88, "height": 54, "radius": 8 },
      "fill": "#2a9d8f", "transform": { "x": 34, "z": -60, "anchorX": 44, "anchorY": 27 } },
    { "id": "front", "type": "shape", "shape": { "kind": "roundedRect", "width": 88, "height": 54, "radius": 8 },
      "fill": "#e9c46a", "transform": { "x": 52, "z": 60, "anchorX": 44, "anchorY": 27 } }
  ] }
```

`"preserve3d": true` on a group is CSS's `transform-style: preserve-3d`. An ordinary group is flat: it renders its
children into a buffer and turns that picture as one. A preserve3d group has **no buffer of its own**: its children are
drawn straight into the group's parent, each in its own 3D position in the group's space, so cards at different `z`
inside a group that turns (a card stack, an orbiting ring of cards) move relative to one another in 3D and each is
warped on its own. A child's placement is the group's matrix times its own, as if the matrices were nested in 3D
(`W_total = W_G * (A_G * W_C * A_G^-1)`, deeper for deeper nesting); the child itself is still drawn flat, with the
groups' 2D matrices applied, and then warped like any layer with a 3D transform (see
[3D transforms and the camera](#3d-transforms-and-the-camera)). The scene's `camera` applies to all of them, and the
layers inside a preserve3d group are warped even when they have no 3D transform of their own, since the group moves
them.

**Depth sorting.** The layers a preserve3d group draws (its children, and recursively the children of preserve3d
groups nested in it, which sort together with them) are painted in **painter's order**: farthest first, by the `z` of
each layer's centre after its placement (before the camera's perspective, which does not change the order along a
line of sight). A layer's centre is the middle of its box (the box an `inset` clip uses: a shape's, image's, noise's or
mesh's width by height, a text layer's layout box, a path's bounding box), or its position `(x, y)` (where its anchor
lands) for a group without a `layout`, which has no box. The sort is stable: layers at the same depth (within 1/1024 of a pixel) keep
their document order. Only preserve3d groups sort. Every other list, a preserve3d group's parent and the children of an
ordinary group inside it included, keeps document order; an ordinary group inside a preserve3d group is one layer to sort,
at its position, and is drawn as a flat picture. The group as a whole is drawn at its place in its parent's list, so
siblings above and below it stay above and below.

Rules:

- A preserve3d group may not have `effects`, `clip`, `mask` or `matte`, a `blendMode` other than `normal`, or be a matte
  source: it has no buffer to apply them to. Loading a scene rejects it, naming the layer; wrap the group in an
  ordinary group and put them there. Its `transform` and `opacity` are fine.
- Its `opacity` is multiplied into each child it draws (CSS would flatten the group and fade the picture instead, so
  overlapping children show through one another here). A group at `opacity` 0 draws nothing.
- Children can have mattes among themselves (the source is a sibling in the same group, not drawn on its own), blend
  modes, effects, clips and masks like any layer; each is applied to the layer flat, before it is warped. A matte
  source cannot have `rotateX`, `rotateY` or `z` itself: the matte moves with the layer it cuts.
- A `backdropBlur` child blurs the canvas as painted so far, in depth order.
- Sorting only orders whole layers. There is no depth buffer, so two layers that cross each other (a card pushed through
  another) do not intersect: one is entirely over the other, and a layer that is large and tilted can be sorted wrong
  against a small one in front of part of it.
- A preserve3d group scaled to nothing draws nothing. Its `scale` enlarges its children in the plane only, not in
  depth (see above).

## Motion blur

```json
{ "id": "whip", "type": "group",
  "transform": { "x": [{ "frame": 0, "value": -300, "easing": "easeInOut" }, { "frame": 30, "value": 560 }], "y": 30 },
  "motionBlur": { "samples": 12, "shutter": 0.5 },
  "children": [ ... ] }
```

`motionBlur` on any layer renders it as a camera would: the layer is drawn at several moments inside the time the
shutter is open and the pictures are averaged, so what moves smears along its path. On a group it blurs the whole
subtree, children included, and what the children do relative to one another blurs too.

| Field | Default | Meaning |
|---|---|---|
| `samples` | `8` | Whole number, 2 to 64 (checked when the scene loads, naming the layer). Not animated. More is smoother and slower: the layer is drawn, run through its effects and warped once per sample. |
| `shutter` | `0.5` | Animatable, in frames, clamped to 0..2. How long the shutter is open: `0.5` is a 180 degree shutter, `1` a 360 degree one. `0` is exactly the layer without motion blur. |
| `frames` | none | An array of exactly `samples` complete layers of the same `type` as this one, one per sample in time order. See [Sub-frame layers](#sub-frame-layers). |

The sub-frame times are `t_i = frame + shutter * ((i + 0.5) / samples - 0.5)` for `i` in `0..samples`: the shutter is
cut into equal slots centred on the frame and each sample sits in the middle of its slot. Every sample is resolved by
the same keyframe evaluation as a whole frame, just at a fractional `t`, so *everything* animated on the layer and
its subtree blurs: position, rotation, scale, 3D fields, opacity, effects' parameters, shape and clip animation. The
layer's texture (drawn, effects, clip, mask, matte, then the 3D or `cornerPin` warp) is made for each sample and the
samples are added with equal weights in order, in linear light, so the result is the same every time. The blend onto
the layer's backdrop then happens once, with the layer's `blendMode`.

- **Opacity** of each sample is applied before averaging, and the blend then uses opacity 1. A layer that fades in
  across the frame is blurred by its fade, and a layer that is invisible at some of its sub-frames only shows for the
  ones where it is not. A frame whose own `opacity` is 0 is still drawn when a sample is not.
- **Seeded noise** (`grain`, a random `dither`, ...) that animates per frame uses the output frame, not the
  sub-frame time, so a blurred layer's samples share one pattern instead of averaging it away. A custom `shader`'s
  `kg.frame` and `kg.time` are the sub-frame's time, so they blur.
- **Mattes**: a layer's matte source is drawn through the layer it cuts, so it blurs with it when it has a
  `motionBlur` with the same `samples` (sample `i` of the layer uses sample `i` of the source). A source without one, or with a
  different number of samples, stays at the frame itself. A matte source's `motionBlur` does nothing for a layer that
  has none of its own.
- **Nesting**: `motionBlur` inside a layer that is blurred is ignored (its samples are already the average). A
  parent whose `shutter` is 0 does not stop its children's.
- **Only the layer moves**: the samples are of the layer and its subtree. Its enclosing groups and the scene's `camera`
  are taken at the frame itself, so a layer carried by a moving group, or seen by a moving camera, does not smear by
  that motion. Put the `motionBlur` on the group that moves; a camera move is not blurred at all.
- **preserve3d**: a `preserve3d` group, and the children it draws, cannot have `motionBlur` (a load error naming the
  layer): they are drawn straight into their parent, with no texture to average. Wrap the stack in an ordinary group and
  give that one `motionBlur` to blur the whole stack, an orbit included.
- **Precision**: the sum is kept in the compositor's half-float textures, so the average of many samples carries a
  rounding error of about one part in a thousand; a layer that does not move is not byte-identical to the same layer
  without `motionBlur`. Use `shutter: 0` (or leave the field out) for that.
- A sample that is seen edge on (see [3D transforms](#3d-transforms-and-the-camera)) adds nothing but still counts in
  the average, so the layer fades as it turns edge on.
- Counts nothing in the [margin](#canvas-margin).

### Sub-frame layers

Motion blur normally samples the layer by evaluating its keyframes at each sub-frame time. A layer whose values do not
come from keyframes (an authoring layer that renders its whole tree once per sub-frame time and writes the results as
constants) gives the sub-frames itself with `frames`:

```json
{ "id": "ball", "type": "shape", "shape": { "kind": "ellipse", "width": 40, "height": 40 }, "fill": "#fff",
  "transform": { "x": 100 },
  "motionBlur": { "samples": 2, "shutter": 1, "frames": [
    { "id": "ball", "type": "shape", "shape": { "kind": "ellipse", "width": 40, "height": 40 }, "fill": "#fff",
      "transform": { "x": 96 } },
    { "id": "ball", "type": "shape", "shape": { "kind": "ellipse", "width": 40, "height": 40 }, "fill": "#fff",
      "transform": { "x": 104 } } ] } }
```

- `frames` has exactly `samples` entries, each a complete layer of the same `type` as the layer it is in (a group's
  entries are groups with their own children). Sub-frame `i` is `frames[i]` resolved at time `t_i`, instead of the layer
  resolved there, so keyframes in a copy are still evaluated at `t_i`. The layer's own fields are used for the frame
  itself: when the shutter is shut (`shutter` 0) the frames are not used.
- Each copy is checked like a layer. Its `id` and its children's may repeat the layer's (they are not checked against
  the rest of the scene), a `matte` in it names a sibling of the layer, and its own `motionBlur` is ignored, as one
  inside any blurred layer is.
- A copy's effects count in the [margin](#canvas-margin) like the layer's, and the images, tables and shaders it uses
  are loaded like any other layer's. A count that is not `samples`, or an entry of another `type`, is a load error naming
  the layer.
- Everything else about sub-frames holds: opacity is applied per sample, mattes pair sample `i` with sample `i`, and the
  layer's enclosing groups and the camera are taken at the frame itself.

## Boxes from the DOM painter

The painter of the full engine (`crates/dom/src/paint`, docs/ENGINE.md section 8) writes CSS boxes as the layers above
and needs these fields, all optional, all new. Existing scenes do not change.

### Glyph runs

A `text` layer can carry glyphs that someone else shaped and positioned (Blitz's Parley lines), so a line breaks where
the browser-style layout broke it, with letter and word spacing, `white-space`, `vertical-align` and per-span fonts
already in the positions.

```json
{ "id": "p.text", "type": "text", "color": "#123", "boxWidth": 176.4, "boxHeight": 21,
  "runs": [ { "src": "/abs/Inter.ttf", "index": 0, "size": 28, "coords": [], "skew": 0, "embolden": 0,
              "glyphs": [[121, 0, 18], [133, 10.06, 18]] } ],
  "transform": { "x": 18, "y": 55 } }
```

| Field | Meaning |
|---|---|
| `runs` | When not empty, the layer is these runs and `text`, `font`, `size`, `maxWidth`, `align`, `lineHeight` and `chars` are not used. |
| `boxWidth`, `boxHeight` | The layer's box (for `inset` clips, box-unit gradients, a transform origin and layout), in pixels; default 0. |
| run `src`, `index` | The font file (relative to the scene, or absolute) and the face in it. It is read once and need not be in `fonts`. A file that is not there is a load error naming the layer. |
| run `size` | Font size in pixels. |
| run `coords` | Normalised variable-font coordinates (F2Dot14 as integers), as Parley reports them; default none. |
| run `skew` | Synthetic italic: degrees the glyphs lean right. |
| run `embolden` | Synthetic bold: pixels the outlines grow on each side (a 48th of the size is Chrome's fake bold). |
| run `glyphs` | `[glyph id, x, y]` for each glyph: the glyph's origin on its baseline, in the layer's box. |

`color` is a colour, a gradient (its box is the box above) or an [image paint](#image-paints), as for any text layer.

### Transform `matrix`

`transform.matrix` is a CSS `matrix3d()`: sixteen numbers, column-major (`a1, b1, c1, d1, a2, ...`), applied about the
anchor after `scale` and `rotation`, so a layer with only `x`, `y`, `anchorX`, `anchorY` (the transform origin) and
`matrix` is a CSS box with `transform-origin`. It is how the DOM painter writes the whole CSS transform: `translate`,
`rotate` and `scale` properties, `skew`, per-axis scale, `matrix()`, `rotate3d()`, and the `perspective()` function and
the `perspective` property of a parent (folded into its children's matrices, so there is no scene camera for them).

- A matrix that only moves the plane (no z, no perspective) is folded into the layer's flat 2D matrix, so the layer is
  drawn sharp, never resampled.
- Any other matrix warps the finished layer like `rotateX` does (`W` of [3D transforms](#3d-transforms-and-the-camera)
  gets the matrix, conjugated by the layer's own `rotation` and `scale`), and counts as a 3D transform: a matte source
  cannot have one, and a `preserve3d` group places its children by it.
- `transform.backfaceHidden` (default `false`) is CSS's `backface-visibility: hidden`: the layer is not drawn when its
  3D placement shows its back (the warp flips it). A layer with no 3D placement is never culled.

### Gradient `transform` in CSS

The DOM painter uses a gradient's `transform` (see [Gradients](#gradients), SVG's `gradientTransform`, applied after
`units`) for CSS: `[1, 0, 0, k, 0, cy * (1 - k)]` squashes a radial gradient about its centre `(cx, cy)` into an ellipse
with radii `r` and `k * r` (CSS's `radial-gradient(ellipse ...)` whatever the box), and `border-image` maps a slice of a
gradient onto its edge with one. It writes them with `units: user`, where the order against `units` does not matter.

### Image paints

A shape's `fill` and a text layer's `color` can be a picture, once or tiled, which is `background-image: url()` with
`background-repeat` and `background-size`:

```json
{ "type": "shape", "shape": { "kind": "rect", "width": 300, "height": 200 },
  "fill": { "type": "image", "src": "tex.png", "x": 0, "y": 0, "width": 64, "height": 64,
            "repeatX": true, "repeatY": true } }
```

The picture is drawn `width` x `height` with its top-left corner at (`x`, `y`) in the painted layer's space, bilinearly
resampled. It repeats along the axes with `repeatX` / `repeatY`; along an axis that does not repeat its edge pixels are
held, so cut the shape to the tile (a shape no taller than the tile for `repeat-x`). `src` is a PNG, JPEG or GIF
file, or a `data:` URL, which is decoded from memory (an `image` layer's `src` can be one too).

### Blend space

The scene's `"blendSpace"` is `"linear"` (default, as always) or `"srgb"`. In `srgb` every layer is composited, and
every blend mode evaluated, on sRGB-encoded values as CSS does: a half-transparent black over white is mid grey (128)
and not light grey (188), a translucent shadow is as dark as a browser's, and `multiply` and `screen` give a browser's
numbers. Blurs, colour filters and everything inside one layer are unchanged. The DOM painter's output asks for
`srgb` (`IslandOutput::blend_space`).

## Limits in this version

- Unknown fields are ignored rather than rejected, so a misspelt optional field has no effect.
- Effects so far: `blur`, `backdropBlur`, `glow`, `chromaticAberration`, `dropShadow`, `insetShadow`, `saturate`,
  `contrast`, `brightness`, `grayscale`, `sepia`, `invert`, `hueRotate`, `gradientMap`, `lut`, `grain`, `dither`,
  `halftone`, `dotMatrix`, `displace`, `filterGraph`, `cornerPin`, `shader`.
- Gradients are used by `mask`, a shape's `fill` and a text layer's
  `color`; a `stroke` takes only a colour. A gradient in box units has no box to measure on a group without a `layout` (a load error).
- Layout is flexbox only (`display: flex`; no grid, no block layout), with sizes in pixels (no percentages, `auto`
  margins, `min` or `max` sizes, or aspect ratios). A leaf layer is never resized by it, and does not shrink below its own
  size. Text is measured as one box of its own `maxWidth`, so it does not re-wrap to fit the container. Baseline
  alignment is for rows; a non-text layer's baseline is its bottom edge. See [Layout](#layout).
- `canvas` draws the commands of a Canvas 2D context (see [canvas](#canvas)): no shadows, no `filter`, no letter or word
  spacing, and a font is one face per key like a text layer's. Commands are drawn at the size the layer is drawn at
  (they are vectors), not from a bitmap.
- `lottie` is whatever ThorVG's CPU renderer draws (see [lottie](#lottie)); it is painted at the size the layer is
  drawn at, up to 4096 pixels a side, so a layer scaled up beyond that is resampled, and a layer that is turned or skewed
  is resampled from an upright picture. Layers cannot be overridden (no theming, slots or state machines), a file's
  text uses ThorVG's own font, and its sound is ignored. Building ThorVG needs a C++ toolchain.
- Per-character styling moves, scales, turns, fades and recolours whole glyphs. There is no per-character blur or
  effect, no outline or gradient of its own (a plain colour only), and characters are not re-flowed: the text box and
  the line breaks are those of the unstyled text. Text has one font per layer, no fallback and no bidi, so the clusters
  are those of left-to-right text.
- `video` uses the first video stream only; rotation metadata (a phone's display matrix), the sample aspect ratio,
  HDR transfer functions and interlacing are ignored, and a variable-frame-rate file is read by its timestamps (so it
  plays at its recorded pace, not a constant rate). Its audio is played by the authoring layer, not by the scene.
  `gif` ignores a file's loop count and keeps every decoded picture of a file in memory.
- An image's size is read from its header when the scene loads, only when a side is left out; `cover` cuts the picture
  with an anti-aliased clip and `contain` leaves the rest of the box empty (no background colour).
- `backdropBlur` on a shape frosts the shape's own geometry, not anything an earlier effect in the list painted (a
  `dropShadow` before it is not frosted). Its backdrop edge is the canvas plus margin described above; there is no
  edge-clamp mode as in browsers.
- A shadow's spread uses a square window (see `dropShadow`), and its colour is not animated.
- Colour filters clamp once per run of consecutive filters, not after each one as a browser does (see
  [Colour filters](#colour-filters)).
- `gradientMap` takes 2 to 16 stops and maps luminance only (no per-channel curves). `lut` reads 3D `.cube` files of
  size 2 to 64: no 1D tables, no `.3dl` or other formats, and a table's file cannot be swapped by keyframe (fade
  between two layers instead). Both, like `grain` and `dither`, work on the sRGB-encoded straight colour of the layer
  as it is after the effects before them.
- `grain` and `dither` are in canvas space and seeded with whole numbers from 0 to 4294967295. A seed out of range,
  or missing on a `random` dither, is an error naming the layer; a missing `grain` seed or one that is not a whole
  number is rejected by the JSON parser with a line and column. `ordered` dithering has one fixed 8x8 Bayer pattern.
- `halftone` has one dot per cell, read at the cell's centre: it does not average the layer over the cell, so a detail
  smaller than a cell can fall between samples. There is one screen (one angle), not the four of colour print; dots
  never overlap their neighbours, so the square and circle are cut at the cell's sides. Its cells are in layer space, so
  a screen on a layer that is scaled down a lot is finer than a pixel and aliases.
- `dotMatrix` has dots that grow linearly in radius (so their area is quadratic in `progress`), no easing of its own
  (ease `progress`), circle or square only, and `sweep` is a straight wipe across the box (no radial
  wipe). Random delays are per cell and fixed for a seed; a new seed is a new pattern.
- `displace` and the `noise` layer follow SVG's `feTurbulence` without `stitchTiles` (the noise does not tile
  seamlessly over a region), take at most 10 octaves, and do not animate `seed` or `numOctaves` (animate
  `baseFrequency` or `scale`, or swap layers). A `noise` layer's colours are the raw channels, taken as linear light
  (see [noise](#noise)). A rotated layer's displacement can reach 1.41 times past the margin it
  gets. The noise is evaluated at the output pixel in the layer's space, so a layer scaled up a lot shows its noise
  magnified (and one scaled far down aliases it); there are no mipmaps.
- `meshGradient` takes 2 to 8 points along each axis and static colours; there is no twist control (the twist is
  fixed by the neighbouring points), no per-patch colour in another space, and the mesh is only as smooth as its 16 x 16
  quads per patch (a patch scaled up a great deal shows its facets). The edge is anti-aliased by 4 samples per pixel.
  Overlapping patches blend in document order without depth.
- `cornerPin` needs a box (no groups), costs one pass each, and warps with bilinear sampling like the 3D transforms (no
  mipmaps). It cannot bring in pixels from beyond the texture (canvas plus margin).
- 3D is a warp of a flat layer, not a 3D renderer: no depth buffer, no intersecting layers, no lighting, one scene
  camera, no mipmaps (see [3D transforms and the camera](#3d-transforms-and-the-camera)), and a layer that hangs off the
  canvas is cut at the canvas edge (plus margin) before it is turned.
- A `preserve3d` group sorts whole layers by the depth of their centre (painter's order); it cannot have effects, a
  clip, a mask, a matte or a blend mode, and multiplies its `opacity` into its children instead of fading them as one
  picture (see [preserve3d groups](#preserve3d-groups)).
- `motionBlur` averages 2 to 64 equally weighted samples of the shutter (no sample-weighting curve, no random
  jitter), so a very fast move over a wide shutter shows its steps as separate ghosts; raise `samples`. It cannot be
  used on a `preserve3d` group or its children, and nested `motionBlur` inside a blurred layer is ignored (see
  [Motion blur](#motion-blur)). It blurs the layer's own animation, not that of its enclosing groups or of the camera.
  It multiplies the layer's cost by `samples`.
- Clip and mask coverage goes through an 8-bit texture, so a clip edge or a mask fade has 256 levels.
- An unknown clip `kind`, gradient `type`, `extend`, mask `mode` or matte `mode` is rejected with the JSON parser's
  line and column, not the layer id.
- A custom `shader` takes numbers only (`f32` uniforms), no extra textures, and it sees one layer, not the backdrop.
  Its uniforms are `f32` even when the number is a whole frame count.
