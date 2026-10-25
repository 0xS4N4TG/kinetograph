// The names the studio shows for layers and Sequences (studio builds only; the scene JSON a render uses never carries
// them). Pure functions: the fiber walking that finds the component and the source is in `origin.ts`.

/** Longest text snippet in a label. */
const SNIPPET = 30;

/** `Rewrote Remotion in Rust, from scratch` → `Rewrote Remotion in Rust, fro…`; whitespace collapsed. */
export function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET ? `${flat.slice(0, SNIPPET - 1).trimEnd()}…` : flat;
}

/** What a layer of this host type is called when nothing better is known. */
const TYPE_NAMES: Record<string, string> = {
  'kg-layer': 'Group',
  'kg-shape': 'Shape',
  'kg-rect': 'Shape',
  'kg-ellipse': 'Shape',
  'kg-path': 'Shape',
  'kg-text': 'Text',
  'kg-image': 'Image',
  'kg-video': 'Video',
  'kg-gif': 'Gif',
  'kg-noise': 'Noise',
  'kg-mesh-gradient': 'Gradient',
  'kg-lottie': 'Lottie',
  'kg-canvas': 'Canvas',
  'kg-glsl': 'Shader',
  'kg-scene3d': '3D scene',
  'kg-camera3d': 'Camera',
  'kg-camera': 'Camera',
  'kg-audio': 'Audio',
  img: 'Image',
  video: 'Video',
  audio: 'Audio',
  canvas: 'Canvas',
  svg: 'SVG',
};

export interface LabelInput {
  /** The host type: `kg-text`, `div`, … */
  type: string;
  /** The element's explicit `id` prop. */
  id?: string;
  className?: string;
  /** The text the element shows, when it is a text element. */
  text?: string;
  /** The `src` of an image or video. */
  src?: string;
  /** The user component that rendered it, when it is the first element that component drew (not an inner one). */
  component?: string;
  /** The user component that rendered it, whether or not it is the first element. */
  owner?: string;
  /** The name of the Sequence this element is the group of. */
  sequenceName?: string;
}

const isDefaultName = (name: string): boolean => /^<.*>$/.test(name);

/** A Sequence's name for people: `<Solid>` (a library default) is `Solid`. */
export function sequenceLabel(name: string | null, childComponent: string | undefined): string {
  if (name !== null && name !== '') return isDefaultName(name) ? name.slice(1, -1) : name;
  return childComponent ?? 'Sequence';
}

/** The tag and first class: `div.card`. */
function tagAndClass(type: string, className: string | undefined): string {
  const first = className?.trim().split(/\s+/)[0];
  return first ? `${type}.${first}` : type;
}

const basename = (src: string): string => {
  const clean = src.split(/[?#]/)[0] ?? src;
  return clean.slice(clean.lastIndexOf('/') + 1);
};

/**
 * The label of a layer. Priority: the Sequence's `name` (for the group it renders), the element's `id`, the component
 * with a snippet of its text, the component, the tag with its class, the kind of layer.
 */
export function layerLabel(input: LabelInput): string {
  if (input.sequenceName !== undefined) return input.sequenceName;
  if (input.id !== undefined && input.id !== '') return input.id;
  const text = input.text !== undefined ? snippet(input.text) : '';
  const quoted = text === '' ? '' : `“${text}”`;
  if (quoted !== '') return `${input.owner ?? input.component ?? TYPE_NAMES[input.type] ?? input.type} · ${quoted}`;
  if (input.component !== undefined) return input.component;
  const kind = TYPE_NAMES[input.type];
  if (input.type.startsWith('kg-') || kind !== undefined) {
    const base = kind ?? input.type.replace(/^kg-/, '');
    return input.src !== undefined && input.src !== '' ? `${base} · ${basename(input.src)}` : base;
  }
  return tagAndClass(input.type, input.className);
}
