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
| `fonts` | object | Optional. Font family name to font file path. Text layers refer to these names. |
| `camera` | object | Optional. The viewpoint for layers with a 3D transform. See [3D transforms and the camera](#3d-transforms-and-the-camera). |
| `layers` | array | Bottom layer first, topmost last (the same order as SVG and DOM paint order). |

Asset paths (`fonts`, image `src`, `lut` `src`) resolve relative to the directory of the scene file.

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
| `type` | string | required | `shape`, `text`, `image`, `group`, `noise` or `meshGradient`. |
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

The layer matrix is `translate(x, y) * rotate(rotation) * scale(scale) * translate(-anchorX, -anchorY)`. A child's
matrix is applied inside its parent's. `rotateX`, `rotateY` and `z` do not change it: they move the finished layer
afterwards.

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

Left-aligned, one font per layer, no fallback, no bidi. `\n` starts a new line. The layer origin is the top-left of
the text box.

- `font`: a key of the scene's `fonts`.
- `size`: font size in pixels.
- `color`: a colour string or a [gradient](#gradients) (see [Gradient fills](#gradient-fills)).
- `lineHeight`: multiple of `size`. Omitted: the font's own line height.
- `maxWidth`: wrap width in pixels. Omitted: lines break only at `\n`.

Fonts are registered before any text is measured.

### image

```json
{ "id": "logo", "type": "image", "src": "logo.png", "width": 256, "height": 256 }
```

PNG or JPEG, scaled to `width` x `height` from the layer origin. Colours are read as sRGB.

### group

```json
{ "id": "stack", "type": "group", "opacity": 0.8, "children": [ ... ] }
```

A group composites its children (bottom first) into its own buffer, then blends that result into its parent using the
group's `opacity` and `blendMode`. Its `transform` applies to all children. `anchorX/anchorY` are in the group's
coordinates. `"preserve3d": true` (default `false`) makes the group a 3D scene instead: see
[preserve3d groups](#preserve3d-groups).

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
- A group has no box, but a noise layer does: an `inset` clip or a `sweep` dot matrix on one measures from
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
- A group has no box, but a mesh does: an `inset` clip or a `sweep` dot matrix on one measures from
  `(0, 0, width, height)`.
- Counts nothing in the [margin](#canvas-margin).

## Effects

Each entry in a layer's `effects` is an object with a `type`. A group's effects run on its composited result.

### Canvas margin

An effect that paints outside its layer (a shadow, say) needs room beyond the canvas edge, and so does a layer that
hangs off the canvas, whose shadow can fall back onto it. So the renderer draws on a canvas padded by a margin on every
side and crops the margin off at the end. You do not set it; it is worked out when the scene loads: the largest distance
the effects can reach past a layer, at any keyframe on any layer (nested layers included), rounded up to whole
pixels. Each effect below says what it counts. The margin is limited so the padded canvas is at most 8192 pixels on a
side.

- A scene with no such effect has margin 0 and is rendered exactly on the canvas, as it always was.
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
- **Sampling.** Bilinear, on premultiplied colour. What lies outside the texture (the canvas and its margin) is
  transparent. The noise follows the spec's reference algorithm in 32-bit floats and, unlike a browser's, is not
  quantised to 8 bits, so expect differences of about one 8-bit step against a browser, not a different pattern.
- Counts `|scale| / 2` times the largest product of `scale` over the layer and its ancestors in the
  [margin](#canvas-margin) (a pixel is read from that far away; at the largest keyframe, whichever way the scale
  points), so the torn edge of a card that hangs off the canvas still pulls in what lies beyond it. Other effects' reaches
  stay in canvas pixels and ignore `scale`. The factor is per axis: a rotated layer's diagonal push can reach up to
  1.41 times further in the worst case, which a margin this size can cut off.
- Effects after `displace` see the displaced layer; one before it (`glow`, a shadow) is displaced with it. For the
  papercut look put the shadow after: `[displace, dropShadow]` casts the shadow of the torn edge.

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
| `image` | `0, 0, width, height` |
| `text` | `0, 0, maxWidth` (or the laid-out width when there is no `maxWidth`) by the laid-out height |
| `group` | None. `inset` on a group is a load error; use `polygon`, `ellipse` or `path`. |

Loading a scene rejects a polygon with fewer than 3 points, a bad path `d`, a negative `radius`, `rx` or `ry` at any
keyframe, and `inset` on a group, and the error names the layer.

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
| `radial` | `cx`, `cy`, `r` | Circles around the centre; offset 1 is at distance `r` (at least 0). |
| `conic` | `cx`, `cy`, `angle` (default `0`) | Offset 0 points `angle` degrees clockwise from 12 o'clock, as in CSS `conic-gradient`; offset 1 is a full turn later. |

Common fields:

| Field | Default | Meaning |
|---|---|---|
| `stops` | required | At least 2 `{ "offset", "color" }`. Offsets are between 0 and 1 at every keyframe. An offset lower than an earlier stop's is raised to it, as in CSS, so `[0.6, 0.3]` makes a hard edge at 0.6. Colours are plain colour strings (not animated) and may be translucent. |
| `extend` | `pad` | Outside the first and last stop. `pad` holds the end colours. `repeat` repeats the span from the first to the last stop, which is CSS `repeating-linear-gradient` and friends; `reflect` does the same with every second span backwards. For `conic`, which already goes round, `repeat` repeats the span within the turn. |

Colours blend in sRGB with premultiplied alpha, as in CSS, so a stop fading to `#ffffff00` fades to transparent white
and not through grey. (Layers themselves are still blended in linear light.) A gradient with no extent paints the last
stop's colour everywhere: a linear gradient whose two points coincide, a radial one with `r` 0, or a repeating one
whose first and last stop have the same offset. The ramp between stops is sampled at 512 steps.

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
| `gradient` | required | A [gradient](#gradients), in the layer's own coordinates. It covers the whole plane (see `extend`), not just the layer's box. |
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
| `mode` | `alpha` | `alpha` keeps the layer where the source is opaque; `alphaInverted` where it is transparent. `luminance` keeps it where the source is light (Rec. 709 luminance of the linear-light colour, times alpha, as in a gradient mask); `luminanceInverted` where it is dark or transparent. |

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
lands) for a group, which has no box. The sort is stable: layers at the same depth (within 1/1024 of a pixel) keep
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
- **preserve3d**: a `preserve3d` group, and the children it draws, cannot have `motionBlur` (a load error naming the
  layer): they are drawn straight into their parent, with no texture to average. Wrap the stack in an ordinary group and
  give that one `motionBlur` to blur the whole stack, an orbit included.
- **Precision**: the sum is kept in the compositor's half-float textures, so the average of many samples carries a
  rounding error of about one part in a thousand; a layer that does not move is not byte-identical to the same layer
  without `motionBlur`. Use `shutter: 0` (or leave the field out) for that.
- A sample that is seen edge on (see [3D transforms](#3d-transforms-and-the-camera)) adds nothing but still counts in
  the average, so the layer fades as it turns edge on.
- Counts nothing in the [margin](#canvas-margin).

## Limits in this version

- Unknown fields are ignored rather than rejected, so a misspelt optional field has no effect.
- Effects so far: `blur`, `backdropBlur`, `glow`, `chromaticAberration`, `dropShadow`, `insetShadow`, `saturate`,
  `contrast`, `brightness`, `grayscale`, `sepia`, `invert`, `hueRotate`, `gradientMap`, `lut`, `grain`, `dither`,
  `halftone`, `dotMatrix`, `displace`, `cornerPin`, `shader`.
- No video layers or per-glyph text animation yet. Gradients are used by `mask`, a shape's `fill` and a text layer's
  `color`; a `stroke` takes only a colour.
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
  [Motion blur](#motion-blur)). It multiplies the layer's cost by `samples`.
- Clip and mask coverage goes through an 8-bit texture, so a clip edge or a mask fade has 256 levels.
- An unknown clip `kind`, gradient `type`, `extend`, mask `mode` or matte `mode` is rejected with the JSON parser's
  line and column, not the layer id.
- A custom `shader` takes numbers only (`f32` uniforms), no extra textures, and it sees one layer, not the backdrop.
  Its uniforms are `f32` even when the number is a whole frame count.
