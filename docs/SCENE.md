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
| `layers` | array | Bottom layer first, topmost last (the same order as SVG and DOM paint order). |

Asset paths (`fonts`, image `src`) resolve relative to the directory of the scene file.

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
| `type` | string | required | `shape`, `text`, `image` or `group`. |
| `transform` | object | identity | See below. |
| `opacity` | number | `1` | Clamped to 0..1. |
| `blendMode` | string | `normal` | `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `colorDodge`, `colorBurn`, `hardLight`, `softLight`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`. These are the 16 modes of W3C Compositing and Blending Level 1, evaluated in linear light, then mixed in with the layer's `opacity`. |
| `effects` | array | `[]` | Applied in order to the layer's own pixels, before it is blended. See [Effects](#effects). |
| `clip` | object | none | Cuts the layer to a shape. See [Clip paths](#clip-paths). |
| `mask` | object | none | Fades the layer by a gradient. See [Gradient masks](#gradient-masks). |
| `matte` | object | none | Cuts the layer by a sibling layer. See [Track mattes](#track-mattes). |

`transform` fields, all animatable numbers:

| Field | Default | Meaning |
|---|---|---|
| `x`, `y` | `0` | Where the anchor point lands in the parent, in pixels. |
| `scale` | `1` | Uniform scale about the anchor. |
| `rotation` | `0` | Degrees, clockwise. |
| `anchorX`, `anchorY` | `0` | Anchor point in the layer's own coordinates. Scale and rotation pivot here. |

The layer matrix is `translate(x, y) * rotate(rotation) * scale(scale) * translate(-anchorX, -anchorY)`. A child's
matrix is applied inside its parent's.

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
coordinates.

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
- The colour filters count nothing: they change pixels in place.
- A bigger margin costs time and memory, because every texture is bigger. Animating a shadow's offset to a large
  value for one frame makes the whole scene pay for it.
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

## Limits in this version

- Unknown fields are ignored rather than rejected, so a misspelt optional field has no effect.
- Effects so far: `blur`, `backdropBlur`, `glow`, `chromaticAberration`, `dropShadow`, `insetShadow`, `saturate`,
  `contrast`, `brightness`, `grayscale`, `sepia`, `invert`, `hueRotate`, `shader`.
- No video layers or per-glyph text animation yet. Gradients are used by `mask`, a shape's `fill` and a text layer's
  `color`; a `stroke` takes only a colour.
- `backdropBlur` on a shape frosts the shape's own geometry, not anything an earlier effect in the list painted (a
  `dropShadow` before it is not frosted). Its backdrop edge is the canvas plus margin described above; there is no
  edge-clamp mode as in browsers.
- A shadow's spread uses a square window (see `dropShadow`), and its colour is not animated.
- Colour filters clamp once per run of consecutive filters, not after each one as a browser does (see
  [Colour filters](#colour-filters)).
- Clip and mask coverage goes through an 8-bit texture, so a clip edge or a mask fade has 256 levels.
- An unknown clip `kind`, gradient `type`, `extend`, mask `mode` or matte `mode` is rejected with the JSON parser's
  line and column, not the layer id.
- A custom `shader` takes numbers only (`f32` uniforms), no extra textures, and it sees one layer, not the backdrop.
  Its uniforms are `f32` even when the number is a whole frame count.
