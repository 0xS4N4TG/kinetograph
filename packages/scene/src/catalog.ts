// Every effect and its fields, for `kinetograph effects` (AUTHORING.md §5.2).
// The descriptions follow SCENE.md; "Num" is an animatable number (a constant
// or keyframes). A field without a default is required.

export interface EffectField {
  name: string;
  /** TypeScript-ish: `Num`, `number`, `boolean`, `color`, a literal union, ... */
  type: string;
  /** SCENE.md's default; absent for a required field and for one that has none. */
  default?: unknown;
  /** True when the effect cannot load without the field. */
  required?: boolean;
  description: string;
}
export interface EffectInfo {
  type: string;
  description: string;
  fields: EffectField[];
}

const radius = (clamp: string): EffectField => ({
  name: 'radius',
  type: 'Num',
  required: true,
  description: `In canvas pixels: roughly the standard deviation of the Gaussian. ${clamp}`,
});

const shadowFields: EffectField[] = [
  {
    name: 'x',
    type: 'Num',
    default: 0,
    description: "Offset in canvas pixels (positive is right). Not scaled by the layer's scale or rotated with it.",
  },
  { name: 'y', type: 'Num', default: 0, description: 'Offset in canvas pixels (positive is down).' },
  {
    name: 'blur',
    type: 'Num',
    default: 0,
    description:
      "Blur in canvas pixels, the same scale as the blur effect (roughly the standard deviation). Clamped to 0..16384. CSS box-shadow takes the full width, about twice this, so '0 8px 24px' is blur 12.",
  },
  {
    name: 'spread',
    type: 'Num',
    default: 0,
    description: 'Grows the shadow by this many pixels on every side before it is blurred; negative shrinks it. Clamped to -128..128.',
  },
  {
    name: 'color',
    type: 'color',
    default: '#000000',
    description: 'The shadow colour, with straight alpha (#00000080 is a half-strength black). Not animated.',
  },
];

const amount = (clamp: string): EffectField => ({
  name: 'amount',
  type: 'Num',
  default: 1,
  description: clamp,
});

export const effectCatalog: EffectInfo[] = [
  {
    type: 'blur',
    description: 'Gaussian blur of the layer, run in linear light on premultiplied colour. Does not scale with the layer; radii below 1 do nothing.',
    fields: [radius('Clamped to 0..16384.')],
  },
  {
    type: 'backdropBlur',
    description:
      'Frosted glass: what is behind the layer is blurred and shown through the layer\'s shape, with the layer drawn on top.',
    fields: [
      radius('Clamped to 0..16384; below 1 it does nothing.'),
      {
        name: 'edgeMode',
        type: "'canvas' | 'mirror'",
        default: 'canvas',
        description:
          "mirror: only the backdrop inside the layer's box is blurred, mirrored past its edges, as CSS backdrop-filter is drawn. canvas: the canvas around the layer, and the margin past the canvas.",
      },
    ],
  },
  {
    type: 'glow',
    description: 'A halo: a blurred copy of the layer is drawn under it, so light spills out past its edges.',
    fields: [
      radius('Clamped to 0..16384; below 1 the effect does nothing.'),
      {
        name: 'color',
        type: 'color',
        description:
          "Colours the halo, scaled by the blurred layer's alpha. Without it the halo has the layer's own colours. Not animated.",
      },
      {
        name: 'intensity',
        type: 'Num',
        default: 1,
        description: 'Multiplies the halo, clamped to 0..4. At 0 the effect does nothing.',
      },
    ],
  },
  {
    type: 'chromaticAberration',
    description: 'Pulls the red, green and blue images of the layer apart like a cheap lens: a red fringe on one side, a blue one on the other.',
    fields: [
      {
        name: 'amount',
        type: 'Num',
        required: true,
        description:
          'In canvas pixels. Red is read from this far along angle, blue from the other way, green from the pixel itself. Negative swaps red and blue; 0 does nothing.',
      },
      {
        name: 'angle',
        type: 'Num',
        default: 0,
        description: 'Degrees clockwise from the +x axis: 0 splits left and right, 90 up and down.',
      },
    ],
  },
  {
    type: 'dropShadow',
    description: "A shadow of the layer's shape under the layer, cast onto whatever is behind it. The layer is drawn on top unchanged.",
    fields: shadowFields,
  },
  {
    type: 'insetShadow',
    description: "A shadow cast inside the layer's shape, drawn over the layer and kept to where the layer is opaque. Fields as dropShadow; spread grows it inward.",
    fields: shadowFields,
  },
  {
    type: 'saturate',
    description: 'CSS saturate(): 0 is greyscale, 1 no change, above 1 over-saturated.',
    fields: [amount('Below 0 counts as 0.')],
  },
  {
    type: 'contrast',
    description: 'CSS contrast(): scales colours about mid grey. 0 is flat grey, 1 no change, above 1 more contrast.',
    fields: [amount('Below 0 counts as 0.')],
  },
  {
    type: 'brightness',
    description: 'CSS brightness(): multiplies the colours. 0 is black, 1 no change, above 1 brighter.',
    fields: [amount('Below 0 counts as 0.')],
  },
  {
    type: 'grayscale',
    description: 'CSS grayscale() with Rec. 709 weights: 0 no change, 1 fully grey.',
    fields: [amount('Clamped to 0..1.')],
  },
  {
    type: 'sepia',
    description: 'CSS sepia(): 0 no change, 1 full sepia.',
    fields: [amount('Clamped to 0..1.')],
  },
  {
    type: 'invert',
    description: 'CSS invert(): 0 no change, 1 the negative, 0.5 flat mid grey. Alpha is never changed.',
    fields: [amount('Clamped to 0..1.')],
  },
  {
    type: 'hueRotate',
    description: 'CSS hue-rotate(): turns every hue round the colour wheel; greys stay grey.',
    fields: [{ name: 'angle', type: 'Num', default: 0, description: 'Degrees; positive is the CSS direction.' }],
  },
  {
    type: 'gradientMap',
    description: "Replaces the layer's colours with colours looked up by brightness (Rec. 709 luminance): the thermal-camera look.",
    fields: [
      {
        name: 'stops',
        type: 'Stop[]',
        required: true,
        description:
          '2 to 16 { offset, color } objects, as a gradient\'s: offset is an animatable number in 0..1, color may have alpha. Dark pixels take the early stops and light ones the late ones.',
      },
      {
        name: 'amount',
        type: 'Num',
        default: 1,
        description: 'Clamped to 0..1. Cross-fades from the original layer (0) to the graded one (1); at 0 the effect does nothing.',
      },
    ],
  },
  {
    type: 'lut',
    description: 'Grades the layer through a 3D colour lookup table from an Adobe/Resolve .cube file (LUT_3D_SIZE 2 to 64).',
    fields: [
      {
        name: 'src',
        type: 'string',
        required: true,
        description: 'Path of the .cube file, relative to the scene file. Read and checked when the renderer is built.',
      },
      {
        name: 'amount',
        type: 'Num',
        default: 1,
        description: 'Clamped to 0..1. Cross-fades from the original layer (0) to the graded one (1).',
      },
      {
        name: 'interpolation',
        type: "'trilinear' | 'tetrahedral'",
        default: 'trilinear',
        description: 'How a colour between two grid points is blended. Tetrahedral (as DaVinci Resolve, OpenColorIO and ffmpeg lut3d=interp=tetrahedral) uses four of the cell\'s corners and keeps greys on a straight table grey.',
      },
    ],
  },
  {
    type: 'colorGrade',
    description:
      "HyperFrames' colour grade in one pass: exposure to saturation, tonal wheels, curves, hue curves, secondaries, a .cube look-up table, vignette and grain, then its 18 look effects (blur, bloom, halftone, ascii, dither, scanlines, CRT, glitch, tape, film, engraving, crosshatch, kuwahara, ...). The same maths as the original shader, with no browser.",
    fields: [
      { name: 'intensity', type: 'number', default: 1, description: 'Clamped to 0..1: how much of the grade replaces the picture (the effects are not scaled by it).' },
      { name: 'adjust', type: 'object', description: 'exposure (-2..2), contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation (each -1..1); missing ones are 0.' },
      { name: 'wheels', type: 'object', description: 'shadows, midtones and highlights, each { hue (degrees), amount (0..1), level (-1..1) }.' },
      { name: 'curves', type: 'object', description: 'master, red, green and blue: lists of [input, output] points, 2 to 16, inputs 0..1 and increasing.' },
      { name: 'hueCurves', type: 'object', description: 'hueVsHue (-180..180), hueVsSaturation, hueVsLuma (-1..1): lists of [hue degrees, delta], 3 to 16.' },
      { name: 'secondaries', type: 'object[]', description: 'Up to four { key: { hue, saturation, luma }, correction: { hueShift, saturation, luma, temperature, tint } } qualifiers.' },
      { name: 'lut', type: '{ src: string; intensity?: number }', description: 'A .cube file relative to the scene file, and how much of it (0..1, default 1).' },
      { name: 'vignette', type: 'object', description: '{ amount, midpoint, roundness, feather }, laid out on the graded box.' },
      { name: 'grain', type: 'object', description: '{ amount, size, roughness, seed }: film grain on the graded box. seed is a whole number; film artifacts use it as their frame count.' },
      {
        name: 'effects',
        type: 'Record<ColorGradeEffectKey, number>',
        description:
          'The look effects, by control name: blur, pixelate, chromaBleed, tapeDamage (+ tapeTracking, tapeNoise, tapeSpeed), filmArtifacts, halftone (+ halftoneSize), twoInkPrint (+ twoInkPrintSize), ascii (+ asciiSize, asciiInvert, asciiStyle 0..7, asciiColor, asciiRotation), dither (+ ditherSize), bloom 0..3 (+ bloomRadius 1..100), monoScreen (+ monoScreenSize, Angle, Spread, Shape 0..4, Invert), scanlines (+ scanlineCount, scanlineSoftness), chromaticAberration (+ chromaticAngle), crtCurvature, digitalGlitch (+ ColorSplit, LineTear, Pixelate, BlockAmount, BlockDisplacement, BlockOpacity, Speed), engraving (+ Spacing, MinThickness, MaxThickness, Angle, Contrast, Sharpness, Wave, WaveFrequency), crosshatch (+ Spacing, Thickness, Angle, Contrast, Edges, LineWeight, Wave, WaveFrequency), kuwahara (+ Radius, Sharpness, Saturation). Each 0..1 unless noted; 0 turns an effect off.',
      },
      { name: 'palette', type: 'string[]', description: '2 to 6 "#rrggbb" colours, darkest first, for ascii, dither, monoScreen, engraving and crosshatch. Default black and white (dark ink on paper for engraving and crosshatch).' },
      { name: 'time', type: 'number', description: 'Seconds the time-varying effects run at (tape, glitch, crosshatch waves). Default: the frame time, frame / fps.' },
      { name: 'box', type: '[number, number, number, number]', description: "The picture's box [x, y, width, height] in the layer's space: the vignette, grain and effects are laid out on it. Default: the layer's own box." },
    ],
  },
  {
    type: 'grain',
    description: 'Film grain: seeded noise added to the layer\'s own pixels, fixed to the screen. A pure function of seed, pixel and frame.',
    fields: [
      {
        name: 'amount',
        type: 'Num',
        required: true,
        description: 'Clamped to 0..1: how far the noise moves a colour channel. 0.15 is a visible film grain, 1 is extreme.',
      },
      {
        name: 'size',
        type: 'Num',
        default: 1,
        description: 'At least 1: the grain cell in canvas pixels. Above 1 the values are blended smoothly between grid points.',
      },
      {
        name: 'seed',
        type: 'number',
        required: true,
        description: 'Whole number from 0 to 4294967295. Different seeds give unrelated patterns.',
      },
      { name: 'animate', type: 'boolean', default: true, description: 'A new pattern on every output frame; false shows the same pattern on every frame.' },
      {
        name: 'monochrome',
        type: 'boolean',
        default: true,
        description: 'One noise value for red, green and blue, so the grain only changes brightness; false gives each channel its own noise.',
      },
    ],
  },
  {
    type: 'dither',
    description: 'Cuts each colour channel to a few levels and uses a pattern to pick between the two nearest, for the dotted look of a low-colour display.',
    fields: [
      {
        name: 'mode',
        type: "'ordered' | 'random'",
        default: 'ordered',
        description: 'ordered: an 8x8 Bayer matrix, the same every frame. random: a seeded white-noise threshold.',
      },
      {
        name: 'levels',
        type: 'Num',
        default: 2,
        description: 'Rounded to a whole number, 2 to 256: values per channel. 2 is black or full on each channel (8 colours).',
      },
      { name: 'size', type: 'Num', default: 1, description: 'At least 1: canvas pixels per dither cell.' },
      {
        name: 'seed',
        type: 'number',
        description: 'Whole number from 0 to 4294967295. Required for random; ordered ignores it.',
      },
      { name: 'animate', type: 'boolean', default: false, description: 'random only: a new pattern on every output frame.' },
    ],
  },
  {
    type: 'halftone',
    description: 'Replaces the layer with a halftone screen, the printed-newspaper look: dots whose size follows how bright the layer is. The grid lives in layer space.',
    fields: [
      { name: 'size', type: 'Num', default: 8, description: 'Greater than 0: the width of a grid cell in layer pixels.' },
      { name: 'angle', type: 'Num', default: 45, description: 'Degrees clockwise: the rotation of the grid.' },
      { name: 'shape', type: "'circle' | 'square' | 'line'", default: 'circle', description: 'The dot shape; line is parallel lines whose thickness follows the layer.' },
      {
        name: 'color',
        type: 'color',
        description: "The dot colour; its alpha scales the dots' coverage. Without it a dot takes the layer's colour at its cell's centre.",
      },
      { name: 'invert', type: 'boolean', default: false, description: 'Big dots where the layer is dark instead of light.' },
    ],
  },
  {
    type: 'dotMatrix',
    description: 'A reveal: the layer seen through a grid of dots that grow from nothing to solid. Animate progress 0 to 1 to reveal, 1 to 0 to hide.',
    fields: [
      { name: 'progress', type: 'Num', required: true, description: 'Clamped to 0..1: 0 shows nothing, 1 shows exactly the layer.' },
      { name: 'size', type: 'Num', default: 12, description: 'Greater than 0: the width of a grid cell in layer pixels.' },
      {
        name: 'order',
        type: "'random' | 'sweep'",
        default: 'random',
        description: "random: each cell gets its own delay from the seed. sweep: the delay grows along angle across the layer's box (not for groups).",
      },
      { name: 'angle', type: 'Num', default: 0, description: 'Degrees clockwise from +x, for sweep: 0 reveals left to right, 90 top to bottom.' },
      {
        name: 'stagger',
        type: 'Num',
        default: 0.6,
        description: 'From 0 up to (not including) 1: how much of the progress range is spent on delays. 0 grows every dot together.',
      },
      {
        name: 'seed',
        type: 'number',
        description: 'Whole number from 0 to 4294967295. Required for random; sweep ignores it.',
      },
      { name: 'shape', type: "'circle' | 'square'", default: 'circle', description: 'The dot shape.' },
    ],
  },
  {
    type: 'displace',
    description:
      "Pushes the layer's pixels around with noise: SVG's feTurbulence feeding feDisplacementMap, for torn paper edges and rough outlines.",
    fields: [
      {
        name: 'scale',
        type: 'Num',
        required: true,
        description: 'In layer pixels: how far the noise can move a pixel. Negative reverses the push; 0 does nothing.',
      },
      {
        name: 'xChannelSelector',
        type: "'R' | 'G' | 'B' | 'A'",
        default: 'R',
        description: 'The noise channel that moves pixels sideways. (SVG\'s own default is A.)',
      },
      { name: 'yChannelSelector', type: "'R' | 'G' | 'B' | 'A'", default: 'G', description: 'The noise channel that moves pixels up and down.' },
      {
        name: 'turbulence',
        type: 'Turbulence',
        required: true,
        description:
          "feTurbulence's attributes: { type: 'fractalNoise' | 'turbulence', baseFrequency: Num | [Num, Num], numOctaves?: 0..10 (default 1), seed: number }.",
      },
    ],
  },
  {
    type: 'cornerPin',
    description: "Pins the four corners of the layer's box to four points, warping the layer into that quadrilateral with perspective. Not for groups (they have no box).",
    fields: ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'].map(
      (name): EffectField => ({
        name,
        type: '[Num, Num]',
        description: `Where the box's ${name.replace(/([A-Z])/g, ' $1').toLowerCase()} corner goes, [x, y] in the layer's own space. Left out, the corner stays on the box.`,
      }),
    ),
  },
  {
    type: 'shader',
    description: 'A fragment shader of your own, in WGSL, run over the layer. Reads the layer with layer(px) and globals.frame, globals.time, globals.canvas, globals.margin and u.<name>.',
    fields: [
      {
        name: 'code',
        type: 'string',
        required: true,
        description: 'WGSL that defines fn effect(px: vec2<f32>) -> vec4<f32>, returning linear premultiplied RGBA. May define helpers, constants and structs.',
      },
      { name: 'uniforms', type: 'Record<string, Num>', default: {}, description: 'Named animatable numbers, reaching the shader as u.<name> (all f32).' },
      {
        name: 'padding',
        type: 'Num',
        default: 0,
        description: 'Not negative, in canvas pixels: how far past the layer the shader paints; counted in the margin.',
      },
    ],
  },
];
