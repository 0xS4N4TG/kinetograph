// The field tables Remotion's Studio reads to draw its property controls for a component (`Interactive.baseSchema`,
// `absoluteFillSchema`, …). A render never reads them; they are exported so a project that spreads one into its own
// `Interactive.create({ schema })` or imports `absoluteFillSchema` still bundles, with the values Remotion has.

export interface SchemaField {
  type: string;
  default?: unknown;
  description?: string;
  [key: string]: unknown;
}

export type InteractivitySchema = Record<string, SchemaField>;

const number = (extra: Omit<SchemaField, 'type'>): SchemaField => ({ type: 'number', ...extra });
const enumOf = (description: string, initial: string, names: string[]): SchemaField => ({
  type: 'enum',
  default: initial,
  description,
  variants: Object.fromEntries(names.map((name) => [name, {}])),
});

export const captionsSchema: InteractivitySchema = {
  captions: { type: 'remotion-captions', default: undefined, description: 'Captions', keyframable: false },
};

export const transformSchema: InteractivitySchema = {
  'style.transformOrigin': { type: 'transform-origin', step: 1, default: '50% 50%', description: 'Transform origin' },
  'style.translate': { type: 'translate', step: 1, default: '0px 0px', description: 'Offset' },
  'style.scale': {
    type: 'scale',
    max: 100,
    step: 0.01,
    default: 1,
    description: 'Scale',
    defaultKeyframeOutput: 'perceptual-scale',
  },
  'style.rotate': { type: 'rotation-css', step: 1, default: '0deg', description: 'Rotation' },
  'style.opacity': number({ min: 0, max: 1, step: 0.01, default: 1, description: 'Opacity', hiddenFromList: false }),
};

export const textSchema: InteractivitySchema = {
  'style.color': { type: 'color', default: undefined, description: 'Color' },
  'style.fontFamily': { type: 'font-family', default: undefined, description: 'Font family', keyframable: false },
  'style.fontSize': number({ default: undefined, min: 0, step: 1, description: 'Font size', hiddenFromList: false }),
  'style.lineHeight': number({ default: undefined, min: 0, step: 0.05, description: 'Line height', hiddenFromList: false }),
  'style.fontWeight': { type: 'font-weight', default: 400, description: 'Font weight' },
  'style.fontStyle': enumOf('Font style', 'normal', ['normal', 'italic', 'oblique']),
  'style.textAlign': enumOf('Text align', 'left', ['left', 'center', 'right', 'justify', 'start', 'end']),
  'style.letterSpacing': number({ default: undefined, step: 0.1, description: 'Letter spacing', hiddenFromList: false }),
};

export const borderSchema: InteractivitySchema = {
  'style.borderWidth': number({ default: undefined, min: 0, step: 1, description: 'Border width', hiddenFromList: false }),
  'style.borderStyle': enumOf('Border style', 'none', [
    'none',
    'hidden',
    'solid',
    'dashed',
    'dotted',
    'double',
    'groove',
    'ridge',
    'inset',
    'outset',
  ]),
  'style.borderColor': { type: 'color', default: undefined, description: 'Border color' },
};

const radius = (description: string, extra: Omit<SchemaField, 'type'> = {}): SchemaField =>
  number({ default: 0, min: 0, step: 1, description, hiddenFromList: false, ...extra });

export const borderRadiusSchema: InteractivitySchema = {
  'style.borderRadius': radius('Border radius', { keyframable: true }),
  'style.borderTopLeftRadius': radius('Top left radius'),
  'style.borderTopRightRadius': radius('Top right radius'),
  'style.borderBottomRightRadius': radius('Bottom right radius'),
  'style.borderBottomLeftRadius': radius('Bottom left radius'),
};

export const backgroundSchema: InteractivitySchema = {
  'style.backgroundColor': { type: 'color', default: 'transparent', description: 'Color' },
};

export const svgStrokeSchema: InteractivitySchema = {
  color: { type: 'color', default: undefined, description: 'Current color' },
  stroke: { type: 'color', default: 'none', description: 'Stroke' },
  strokeWidth: number({ default: 1, description: 'Stroke width', min: 0, step: 1, hiddenFromList: false }),
};

export const svgPaintSchema: InteractivitySchema = {
  fill: { type: 'color', default: undefined, description: 'Fill' },
  ...svgStrokeSchema,
};

export const childrenSchema: InteractivitySchema = {
  children: { type: 'string', default: '', description: 'Text', keyframable: false },
};

export const premountSchema: InteractivitySchema = {
  premountFor: number({ default: undefined, description: 'Premount For', min: 0, step: 1, hiddenFromList: false, keyframable: false }),
  postmountFor: number({ default: 0, min: 0, step: 1, hiddenFromList: true, keyframable: false }),
};

const crop = (description: string): SchemaField =>
  number({ default: 0, description, min: 0, max: 1, step: 0.01, hiddenFromList: false, keyframable: true });

export const cropSchema: InteractivitySchema = {
  cropLeft: crop('Crop left'),
  cropRight: crop('Crop right'),
  cropTop: crop('Crop top'),
  cropBottom: crop('Crop bottom'),
};

export const baseSchema: InteractivitySchema = {
  durationInFrames: number({ default: undefined, min: 1, step: 1, hiddenFromList: true }),
  from: number({ default: 0, step: 1, hiddenFromList: true }),
  trimBefore: number({ default: 0, min: 0, step: 1, hiddenFromList: true }),
  playbackRate: number({
    default: 1,
    min: 0.01,
    step: 0.1,
    description: 'Playback rate',
    hiddenFromList: false,
    keyframable: false,
  }),
  freeze: number({ default: null, step: 1, hiddenFromList: true }),
  hidden: { type: 'boolean', default: false, description: 'Hidden' },
  name: { type: 'hidden' },
  showInTimeline: { type: 'hidden' },
};

export const sequenceSchema: InteractivitySchema = {
  ...baseSchema,
  layout: {
    type: 'enum',
    default: 'absolute-fill',
    description: 'Layout',
    variants: {
      'absolute-fill': {
        ...cropSchema,
        ...transformSchema,
        ...backgroundSchema,
        ...borderSchema,
        ...borderRadiusSchema,
        ...premountSchema,
      },
      none: {},
    },
  },
};

/** The fields of `<AbsoluteFill>`: Remotion's `absoluteFillSchema`. */
export const absoluteFillSchema: InteractivitySchema = {
  ...baseSchema,
  ...premountSchema,
  ...transformSchema,
  ...backgroundSchema,
  ...borderSchema,
  ...borderRadiusSchema,
  ...textSchema,
  ...childrenSchema,
};
