// Turns the host tree into scene JSON (docs/AUTHORING.md §6.3). The host tree
// keeps each element's props as React gave them; everything the JSON needs
// (automatic ids, the transform object, lifted motion-blur markers, text
// concatenation) is worked out here, in one pass, each time a tree is asked
// for. Nothing here reads time: `<Lottie>` and `<Audio>` already resolved it.

import {
  fontKey,
  type AudioClipJson,
  type CameraJson,
  type CharStyle,
  type SequenceJson,
  type Effect,
  type LayerJson,
  type MotionBlurJson,
  type Num,
  type Transform,
} from '@kinetograph/scene';

/** An element of the host tree: what the reconciler keeps for a `kg-*` element. */
export interface HostElement {
  kind: 'element';
  type: string;
  props: Record<string, any>;
  children: HostNode[];
}
/** The text a string or number child becomes; only `<Text>` may hold one. */
export interface HostText {
  kind: 'text';
  text: string;
}
export type HostNode = HostElement | HostText;

export interface RenderedTree {
  layers: LayerJson[];
  camera: CameraJson | null;
  audio: AudioClipJson[];
  /** Every `<Sequence>` in the tree, showing or not, in tree order (docs/AUTHORING.md §11.4). */
  sequences: SequenceJson[];
}

/** The name of an element as a user writes it, for error messages. */
export const ELEMENT_NAMES: Record<string, string> = {
  'kg-layer': 'Layer',
  'kg-shape': 'Shape',
  'kg-rect': 'Rect',
  'kg-ellipse': 'Ellipse',
  'kg-path': 'Path',
  'kg-text': 'Text',
  'kg-image': 'Image',
  'kg-noise': 'Noise',
  'kg-mesh-gradient': 'MeshGradient',
  'kg-lottie': 'Lottie',
  'kg-video': 'Video',
  'kg-gif': 'Gif',
  'kg-camera': 'Camera',
  'kg-audio': 'Audio',
  'kg-sequence': 'Sequence',
};

type Props = Record<string, any>;

/** Only the keys of `source` listed in `keys` that are set. */
function pick(source: Props, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

const TRANSFORM_KEYS = ['x', 'y', 'scale', 'rotation', 'anchorX', 'anchorY', 'originX', 'originY', 'rotateX', 'rotateY', 'z'] as const;

function transformOf(props: Props, name: string): Transform | undefined {
  const transform: Record<string, unknown> = pick(props, TRANSFORM_KEYS);
  // `origin` is sugar for originX/originY; an explicit originX/originY wins.
  const origin = props.origin;
  if (origin !== undefined) {
    let pair: readonly [unknown, unknown];
    if (origin === 'center') pair = [0.5, 0.5];
    else if (Array.isArray(origin) && origin.length === 2) pair = origin as [unknown, unknown];
    else throw new Error(`<${name}> origin must be 'center' or [originX, originY], got ${JSON.stringify(origin)}`);
    transform.originX ??= pair[0];
    transform.originY ??= pair[1];
  }
  return Object.keys(transform).length > 0 ? (transform as Transform) : undefined;
}

/** `effects` with the motionBlur markers taken out, and the markers merged into one `motionBlur` object. The
 *  `motionBlur` prop is applied after the markers, so it wins field by field. */
function effectsOf(props: Props, name: string): { effects?: Effect[]; motionBlur?: MotionBlurJson } {
  const out: { effects?: Effect[]; motionBlur?: MotionBlurJson } = {};
  let motionBlur: MotionBlurJson | undefined;
  if (props.effects !== undefined) {
    if (!Array.isArray(props.effects)) throw new Error(`<${name}> effects must be an array`);
    const effects: Effect[] = [];
    for (const effect of props.effects) {
      if (typeof effect !== 'object' || effect === null || typeof effect.type !== 'string') {
        throw new Error(`<${name}> effects must be effect objects such as blur(8), got ${JSON.stringify(effect)}`);
      }
      if (effect.type === 'motionBlur') {
        motionBlur = { ...motionBlur, ...pick(effect, ['samples', 'shutter']) };
      } else {
        effects.push(effect);
      }
    }
    if (effects.length > 0) out.effects = effects;
  }
  if (props.motionBlur !== undefined) {
    motionBlur = { ...motionBlur, ...pick(props.motionBlur, ['samples', 'shutter']) };
  }
  if (motionBlur !== undefined) out.motionBlur = motionBlur;
  return out;
}

function commonOf(props: Props, name: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const transform = transformOf(props, name);
  if (transform !== undefined) out.transform = transform;
  Object.assign(out, pick(props, ['opacity', 'blendMode']));
  const { effects, motionBlur } = effectsOf(props, name);
  if (effects !== undefined) out.effects = effects;
  Object.assign(out, pick(props, ['clip', 'mask', 'matte']));
  if (motionBlur !== undefined) out.motionBlur = motionBlur;
  Object.assign(out, pick(props, ['layoutItem']));
  return out;
}

/** Whether a radius is above 0 at any keyframe, so an animated radius that starts at 0 still gets a roundedRect. */
function isRounded(radius: Num | undefined): boolean {
  if (radius === undefined) return false;
  if (typeof radius === 'number') return radius > 0;
  return radius.some((key) => key.value > 0);
}

function textOf(element: HostElement): string {
  return element.children.map((child) => (child.kind === 'text' ? child.text : '')).join('');
}

function charsOf(chars: unknown, text: string): (CharStyle | null)[] {
  if (Array.isArray(chars)) return chars.map((entry) => entry ?? null);
  if (typeof chars !== 'function') throw new Error('<Text> chars must be an array or a function (char, index, count) => style');
  const all = Array.from(text);
  return all.map((char, index) => chars(char, index, all.length) ?? null);
}

class Emitter {
  readonly layers: LayerJson[] = [];
  readonly cameras: CameraJson[] = [];
  readonly audio: AudioClipJson[] = [];
  readonly sequences: SequenceJson[] = [];
  private readonly ids = new Set<string>();

  /** The element's id: explicit (checked) or `$` + its index path among the host elements. */
  private idOf(element: HostElement, path: string): string {
    const explicit = element.props.id;
    if (explicit === undefined) return path;
    const name = ELEMENT_NAMES[element.type] ?? element.type;
    if (typeof explicit !== 'string' || explicit === '') {
      throw new Error(`<${name}> id must be a non-empty string, got ${JSON.stringify(explicit)}`);
    }
    if (explicit.startsWith('$')) {
      throw new Error(`<${name}> id "${explicit}" is reserved: ids beginning with "$" are generated`);
    }
    if (this.ids.has(explicit)) {
      throw new Error(`Duplicate id "${explicit}" on <${name}>: ids must be unique across the tree`);
    }
    this.ids.add(explicit);
    return explicit;
  }

  children(nodes: HostNode[], parentPath: string, parentName: string): LayerJson[] {
    const out: LayerJson[] = [];
    this.collect(nodes, parentPath, parentName, out, { next: 0 });
    return out;
  }

  /**
   * Emits `nodes` into `out`. A `kg-sequence` is transparent: it is recorded in `sequences` (before what is inside it,
   * so the list is in tree order) and its children are emitted as if they stood where it does, taking no place in
   * the index path themselves, so a `<Sequence>` never moves an automatic id (docs/AUTHORING.md §11.4).
   */
  private collect(nodes: HostNode[], parentPath: string, parentName: string, out: LayerJson[], place: { next: number }): void {
    for (const node of nodes) {
      if (node.kind === 'text') {
        // The reconciler refuses these on the way in; this keeps `emit` honest on its own.
        throw new Error(`Raw text "${node.text}" is not allowed inside <${parentName}>; wrap it in <Text>`);
      }
      if (node.type === 'kg-sequence') {
        const { sequence, wrapped } = node.props as { sequence: Omit<SequenceJson, 'layer'>; wrapped: boolean };
        const record: SequenceJson = { ...sequence, layer: null };
        this.sequences.push(record);
        const before = out.length;
        this.collect(node.children, parentPath, parentName, out, place);
        // The group its children are in: the `<Layer>` a Sequence renders, unless it has `layout="none"`.
        if (wrapped && out.length > before) record.layer = out[before]!.id;
        continue;
      }
      const layer = this.element(node, `${parentPath}${parentPath === '' ? '$' : '.'}${place.next++}`);
      if (layer !== null) out.push(layer);
    }
  }

  /** A layer, or null for `<Camera>` and `<Audio>`, which land in `cameras` and `audio` instead. */
  private element(element: HostElement, path: string): LayerJson | null {
    const { type, props } = element;
    const name = ELEMENT_NAMES[type] ?? type;
    const id = this.idOf(element, path);

    switch (type) {
      case 'kg-camera':
        this.cameras.push({ perspective: props.perspective, ...pick(props, ['x', 'y']) } as CameraJson);
        return null;
      case 'kg-audio':
        this.audio.push({ id, ...props.clip });
        return null;
      case 'kg-layer':
        return {
          id,
          type: 'group',
          ...pick(props, ['preserve3d', 'layout']),
          ...commonOf(props, name),
          children: this.children(element.children, path, name),
        } as LayerJson;
      case 'kg-shape': {
        const kind = props.kind;
        let shape: Record<string, unknown>;
        if (kind === 'rect' || kind === 'ellipse') shape = { kind, ...pick(props, ['width', 'height']) };
        else if (kind === 'roundedRect') shape = { kind, ...pick(props, ['width', 'height']), radius: props.radius ?? 0 };
        else if (kind === 'path') shape = { kind, d: props.d };
        else throw new Error(`<Shape> kind must be rect, roundedRect, ellipse or path, got ${JSON.stringify(kind)}`);
        return { id, type: 'shape', shape, ...pick(props, ['fill', 'stroke']), ...commonOf(props, name) } as LayerJson;
      }
      case 'kg-rect': {
        const geometry = pick(props, ['width', 'height']);
        const shape = isRounded(props.radius)
          ? { kind: 'roundedRect', ...geometry, radius: props.radius }
          : { kind: 'rect', ...geometry };
        return { id, type: 'shape', shape, ...pick(props, ['fill', 'stroke']), ...commonOf(props, name) } as LayerJson;
      }
      case 'kg-ellipse':
        return {
          id,
          type: 'shape',
          shape: { kind: 'ellipse', ...pick(props, ['width', 'height']) },
          ...pick(props, ['fill', 'stroke']),
          ...commonOf(props, name),
        } as LayerJson;
      case 'kg-path':
        return {
          id,
          type: 'shape',
          shape: { kind: 'path', d: props.d },
          ...pick(props, ['fill', 'stroke']),
          ...commonOf(props, name),
        } as LayerJson;
      case 'kg-text': {
        const text = textOf(element);
        const layer: Record<string, unknown> = {
          id,
          type: 'text',
          text,
          font: fontKey(props.font, props.weight, props.fontStyle),
          ...pick(props, ['size']),
        };
        const color = props.color ?? props.fill;
        if (color !== undefined) layer.color = color;
        Object.assign(layer, pick(props, ['lineHeight', 'maxWidth', 'align']));
        if (props.chars !== undefined) layer.chars = charsOf(props.chars, text);
        return { ...layer, ...commonOf(props, name) } as unknown as LayerJson;
      }
      case 'kg-image':
        return { id, type: 'image', ...pick(props, ['src', 'width', 'height', 'fit']), ...commonOf(props, name) } as LayerJson;
      case 'kg-noise':
        return {
          id,
          type: 'noise',
          ...pick(props, ['width', 'height', 'turbulence', 'channels']),
          ...commonOf(props, name),
        } as LayerJson;
      case 'kg-mesh-gradient':
        return {
          id,
          type: 'meshGradient',
          ...pick(props, ['width', 'height', 'columns', 'rows', 'points', 'colors']),
          ...commonOf(props, name),
        } as LayerJson;
      case 'kg-lottie':
        return {
          id,
          type: 'lottie',
          ...pick(props, ['src', 'width', 'height', 'time', 'loop']),
          ...commonOf(props, name),
        } as LayerJson;
      case 'kg-video':
        // The sound is not part of the layer: it is an audio clip with the layer's id.
        this.audio.push({ id, ...props.sound });
        return {
          id,
          type: 'video',
          ...pick(props, ['src', 'width', 'height', 'fit', 'frame', 'from', 'trimBefore', 'trimAfter', 'playbackRate', 'loop']),
          ...commonOf(props, name),
        } as LayerJson;
      case 'kg-gif':
        return {
          id,
          type: 'gif',
          ...pick(props, ['src', 'width', 'height', 'fit', 'time', 'loop']),
          ...commonOf(props, name),
        } as LayerJson;
      default:
        throw new Error(`Unknown element <${type}>`);
    }
  }
}

/** The scene JSON of a host tree (the children of the root). */
export function emit(roots: HostNode[]): RenderedTree {
  const emitter = new Emitter();
  const layers = emitter.children(roots, '', 'the root of the tree');
  if (emitter.cameras.length > 1) {
    throw new Error(`Only one <Camera> is allowed per tree, found ${emitter.cameras.length}`);
  }
  return { layers, camera: emitter.cameras[0] ?? null, audio: emitter.audio, sequences: emitter.sequences };
}
