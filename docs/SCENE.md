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

## Limits in this version

- Unknown fields are ignored rather than rejected, so a misspelt optional field has no effect.
- `blur` is the only effect.
- No video layers, masks, mattes, gradients or per-glyph text animation yet.
