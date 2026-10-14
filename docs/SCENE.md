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
is drawn over the fill.

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
- The layer is blurred as if it sat in transparent space: its edges fade out, and content that lies outside the canvas
  is not part of the layer, so it cannot bleed in.

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

A gradient is an object that appears wherever a scene paints with one (so far, `mask`). Its coordinates are in the
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
- `blur` is the only effect.
- No video layers, gradient fills or per-glyph text animation yet. Gradients are only used by `mask`.
- Clip and mask coverage goes through an 8-bit texture, so a clip edge or a mask fade has 256 levels.
- An unknown clip `kind`, gradient `type`, `extend`, mask `mode` or matte `mode` is rejected with the JSON parser's
  line and column, not the layer id.
