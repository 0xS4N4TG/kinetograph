// Turns the host tree into scene JSON (packages/cli/skills/kinetograph/references/AUTHORING.md §6.3). The host tree
// keeps each element's props as React gave them; everything the JSON needs
// (automatic ids, the transform object, lifted motion-blur markers, text
// concatenation) is worked out here, in one pass, each time a tree is asked
// for. Nothing here reads time: `<Lottie>` and `<Audio>` already resolved it.

import {
  canStartDomIslands,
  collectStyleElements,
  importedStylesheets,
  isDomElement,
  mapDomIsland,
  resolveRemoteAsset,
  startDomIsland,
  type StartedIsland,
} from '@kinetographdev/compat/dom';
import { canvasEnvironment, headHost, propsWithOverlay, withCanvasCommands } from '@kinetographdev/compat/shim';
import { gatherShaderInputs } from './shader-groups.js';
import { layerLabel, sequenceLabel } from './labels.js';
import { studioBuild, type Origin } from './origin.js';
import {
  createCanvasContext,
  glslShader,
  fontKey,
  unsupportedFilters,
  type AudioClipJson,
  type CameraJson,
  type LayerName,
  type CharStyle,
  type Camera3DJson,
  type Light3DJson,
  type Object3DJson,
  type SequenceJson,
  type Unsupported,
  type Effect,
  type LayerJson,
  type MotionBlurJson,
  type Num,
  type Transform,
} from '@kinetographdev/scene';

/** An element of the host tree: what the reconciler keeps for a `kg-*` element. */
export interface HostElement {
  kind: 'element';
  type: string;
  props: Record<string, any>;
  children: HostNode[];
  /** Studio builds only: the component and JSX line it came from. */
  origin?: Origin;
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
  /** Every `<Sequence>` in the tree, showing or not, in tree order (packages/cli/skills/kinetograph/references/AUTHORING.md §11.4). */
  sequences: SequenceJson[];
  /** Layer id to name and source; studio builds only. */
  names?: LayerNames;
  /** What DOM elements in the tree ask for that compat mode cannot draw natively (kinetograph site, /docs/compat/). */
  unsupported: Unsupported[];
  /** The least scene `margin` the DOM islands need for their blurs (packages/cli/skills/kinetograph/references/ENGINE.md §2); absent when none does. */
  margin?: number;
  /** `srgb` when any DOM island was painted for it (ENGINE.md §2); absent otherwise. */
  blendSpace?: 'srgb';
}

/** What `emit` needs to know to draw DOM elements. */
export interface EmitOptions {
  /** The composition's size: the box a DOM island is laid out in. */
  viewport?: { width: number; height: number };
  /** The registered fonts, read when an island is mapped (fonts may be registered after the root is made). */
  fonts?: () => Record<string, string>;
  /** Leave DOM elements out instead of drawing them (composition discovery, which wants only the `<Composition>`s). */
  ignoreDom?: boolean;
  /** The clock CSS animations and transitions read, in seconds (frame / fps), asked for when an island is drawn. */
  time?: () => number;
  /**
   * While the frame loop renders motion-blur sub-frames: the ids of the blurred layers, the only layers a sub-frame's
   * tree is read for (packages/cli/skills/kinetograph/references/AUTHORING.md §7.3). What cannot hold one is left out of the tree then: a DOM island with no
   * native element in it, a native element other than a `<Layer>`. Null for a whole tree.
   */
  subFrameLayers?: () => ReadonlySet<string> | null;
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
  'kg-canvas': 'Canvas',
  'kg-glsl': 'GlslShader',
  'kg-scene3d': 'Scene3D',
  'kg-camera3d': 'Camera3D',
  'kg-ambient-light': 'AmbientLight',
  'kg-directional-light': 'DirectionalLight',
  'kg-point-light': 'PointLight',
  'kg-mesh': 'Mesh',
  'kg-model': 'Model',
  'kg-text3d': 'Text3D',
  'kg-extrude': 'Extrude',
  'kg-group3d': 'Group3D',
  'kg-video': 'Video',
  'kg-gif': 'Gif',
  'kg-camera': 'Camera',
  'kg-audio': 'Audio',
  'kg-sequence': 'Sequence',
};

type Props = Record<string, any>;

/** A remote `src` is the file it was downloaded to once (`setRemoteAssetResolver`); any other is as it is. */
function localSrc(props: Props): Record<string, unknown> {
  const src = props.src;
  return typeof src === 'string' ? { src: resolveRemoteAsset(src) ?? src } : {};
}

/** A datamosh whose hold clip's `src` is the local file a remote one was downloaded to. */
function moshHold(datamosh: Props): Props {
  const hold = datamosh.hold;
  if (hold === undefined || hold === 'previous') return datamosh;
  return { ...datamosh, hold: { ...hold, src: resolveRemoteAsset(hold.src) ?? hold.src } };
}

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

/** Whether any native element (other than a `<Sequence>`) is in `nodes` or below them. */
function holdsNative(nodes: HostNode[]): boolean {
  return nodes.some(
    (n) => n.kind === 'element' && ((n.type !== 'kg-sequence' && !isDomElement(n.type)) || holdsNative(n.children)),
  );
}

/** Whether any DOM element is in `nodes` or below them (through native elements and `<Sequence>`s too). */
function holdsDom(nodes: HostNode[]): boolean {
  return nodes.some((n) => n.kind === 'element' && (isDomElement(n.type) || holdsDom(n.children)));
}

/**
 * `<AbsoluteFill>` (and the wrapper of a `<Sequence>` or `<Loop>`, which is one in Remotion) as the `div` it is in
 * Remotion, when what is inside it holds DOM elements or it sits inside DOM already: a column flex box over
 * the whole page with the author's style laid over it, so that `justifyContent`, `alignItems` and the rest place the
 * DOM children as CSS does. A tree of native elements only keeps the layer mapping (the hand ports render as before).
 * Null for any other element.
 */
export function domFillOf(element: HostElement, insideDom = false): HostElement | null {
  if (element.type !== 'kg-layer') return null;
  const fill = element.props.domFill as { style: Record<string, unknown>; id?: string; background: boolean } | undefined;
  // Inside DOM it always is the `div` (CSS has no native layer to put in a flow); outside, only when DOM is inside it.
  if (fill === undefined || (!insideDom && !holdsDom(element.children))) return null;
  return {
    kind: 'element',
    type: 'div',
    props: {
      ...(fill.id !== undefined ? { id: fill.id } : {}),
      style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', ...fill.style },
    },
    // The layer mapping's own background rectangle is the style's `backgroundColor` here.
    children: fill.background ? element.children.slice(1) : element.children,
    ...(element.origin !== undefined ? { origin: element.origin } : {}),
  };
}

/**
 * A DOM element with each `<Sequence>` inside it replaced by what is inside that (and, when `sequences` is given,
 * recorded there), so a Sequence takes no place in the paths (packages/cli/skills/kinetograph/references/AUTHORING.md §11.4). Native elements are kept as
 * they are: they are emitted on their own.
 */
export function flattenDomElement(element: HostElement, path: string, sequences: SequenceJson[] | null): HostElement {
  // A script's writes to `style` and attributes (through a ref) are laid over the props.
  // A `<canvas>` carries what its 2D context drew, which the painter makes a canvas layer of.
  return { ...element, props: withCanvasCommands(element, propsWithOverlay(element)), children: flattenDomChildren(element.children, path, { next: 0 }, sequences) };
}

function flattenDomChildren(nodes: HostNode[], parentPath: string, place: { next: number }, sequences: SequenceJson[] | null): HostNode[] {
  const out: HostNode[] = [];
  for (const child of nodes) {
    if (child.kind === 'text') {
      out.push(child);
    } else if (child.type === 'kg-sequence') {
      const { sequence, wrapped } = child.props as { sequence: Omit<SequenceJson, 'layer'>; wrapped: boolean };
      const record: SequenceJson = { ...sequence, layer: null, ...sequenceNames(sequence.name, child.origin) };
      sequences?.push(record);
      const first = place.next;
      const inner = flattenDomChildren(child.children, parentPath, place, sequences);
      out.push(...inner);
      if (wrapped && place.next > first) {
        const head = inner.find((n): n is HostElement => n.kind === 'element');
        if (head !== undefined) record.layer = typeof head.props.id === 'string' ? head.props.id : `${parentPath}.${first}`;
      }
    } else {
      const path = `${parentPath}.${place.next++}`;
      // An `<AbsoluteFill>` that holds DOM elements, inside DOM, is part of the same CSS tree: its `div`.
      const node = isDomElement(child.type) ? child : (domFillOf(child, true) ?? child);
      out.push(isDomElement(node.type) ? flattenDomElement(node, path, sequences) : node);
    }
  }
  return out;
}

/** `label`, `component` and `source` of a Sequence's record: studio builds only (otherwise `origin` is absent and so is all of it). */
function sequenceNames(name: string | null, origin: Origin | undefined): Pick<SequenceJson, 'label' | 'component' | 'source'> {
  if (origin === undefined) return {};
  return {
    label: sequenceLabel(name, origin.child),
    ...(origin.component !== undefined ? { component: origin.component } : {}),
    ...(origin.source !== undefined ? { source: origin.source } : {}),
  };
}

/** The tags whose text is part of the text of the element around them. */
const INLINE = new Set(['span', 'b', 'i', 'em', 'strong', 'a', 'br', 'small', 'code', 'sup', 'sub', 'mark', 'u', 's']);

/** The text of an element that holds only text and inline elements; undefined when it holds anything else. */
function plainText(element: HostElement): string | undefined {
  let out = '';
  for (const child of element.children) {
    if (child.kind === 'text') {
      out += child.text;
    } else if (INLINE.has(child.type)) {
      const inner = plainText(child);
      if (inner === undefined) return undefined;
      out += inner;
    } else {
      return undefined;
    }
  }
  return out;
}

/** Layer id → name for a host tree. */
export type LayerNames = Record<string, LayerName>;

/**
 * The names the studio shows for the layers `roots` emit (studio builds only: it needs the origins the reconciler
 * recorded). Layers get their ids by the index path, `<Sequence>` transparent; each is under its path id and, when it
 * has one, its explicit id.
 */
export function collectNames(roots: HostNode[]): LayerNames {
  const out: LayerNames = {};
  const walk = (
    nodes: HostNode[],
    parentPath: string,
    place: { next: number },
    insideDom: boolean,
    parentComponent: string | undefined,
    group: { name: string | undefined },
  ): void => {
    for (const node of nodes) {
      if (node.kind === 'text') continue;
      if (node.type === 'kg-sequence') {
        const { sequence, wrapped } = node.props as { sequence: Omit<SequenceJson, 'layer'>; wrapped: boolean };
        const name = wrapped ? sequenceNames(sequence.name, node.origin).label : undefined;
        walk(node.children, parentPath, place, insideDom, parentComponent, { name });
        continue;
      }
      const path = `${parentPath}${parentPath === '' ? '$' : '.'}${place.next++}`;
      const dom = isDomElement(node.type) ? node : domFillOf(node, insideDom);
      const effective = dom ?? node;
      const explicit = typeof effective.props.id === 'string' && effective.props.id !== '' && !effective.props.id.startsWith('$') ? effective.props.id : undefined;
      const component = node.origin?.component;
      let text: string | undefined;
      if (node.type === 'kg-text') text = node.children.map((c) => (c.kind === 'text' ? c.text : '')).join('');
      else if (dom !== null && node.type !== 'kg-layer') text = plainText(effective);
      const src = typeof effective.props.src === 'string' ? effective.props.src : undefined;
      const label = layerLabel({
        type: node.type,
        ...(group.name !== undefined ? { sequenceName: group.name } : {}),
        ...(explicit !== undefined ? { id: explicit } : {}),
        ...(typeof effective.props.className === 'string' ? { className: effective.props.className } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(src !== undefined ? { src } : {}),
        // The first element a component draws is the component; the rest of what it draws is told apart by tag.
        ...(component !== undefined && component !== parentComponent ? { component } : {}),
        ...(component !== undefined ? { owner: component } : {}),
      });
      group.name = undefined;
      const name: LayerName = {
        label,
        ...(component !== undefined ? { component } : {}),
        ...(node.origin?.source !== undefined ? { source: node.origin.source } : {}),
      };
      out[path] = name;
      if (explicit !== undefined) out[explicit] = name;
      walk(effective.children, path, { next: 0 }, insideDom || dom !== null, component ?? parentComponent, { name: undefined });
    }
  };
  walk(roots, '', { next: 0 }, false, undefined, { name: undefined });
  return out;
}

class Emitter {
  readonly layers: LayerJson[] = [];
  readonly cameras: CameraJson[] = [];
  readonly audio: AudioClipJson[] = [];
  readonly sequences: SequenceJson[] = [];
  readonly unsupported: Unsupported[] = [];
  /** The largest `margin` any island asked for. */
  margin = 0;
  blendSpace: 'srgb' | null = null;
  private readonly ids = new Set<string>();

  private sheets: string[] | null = null;
  /** `EmitOptions.subFrameLayers`, and how many of those layers the element being emitted is inside. */
  private readonly keep: ReadonlySet<string> | null;
  private inside = 0;
  /** In a sub-frame, islands are started and their layers left for `finishIslands`. */
  readonly deferred: boolean;

  constructor(
    private readonly options: EmitOptions = {},
    private readonly roots: HostNode[] = [],
  ) {
    this.keep = options.subFrameLayers?.() ?? null;
    this.deferred = this.keep !== null && canStartDomIslands();
  }

  /** In a sub-frame, outside the blurred layers: whether `node` (at `path`) can be left out, holding none of them. */
  private unread(node: HostElement, path: string): boolean {
    if (this.keep === null || this.inside > 0) return false;
    if (isDomElement(node.type)) return !holdsNative(node.children);
    if (node.type === 'kg-sequence') return false;
    const id = node.props.id;
    if (this.keep.has(typeof id === 'string' ? id : path)) return false;
    // A `<Layer>` can hold blurred layers, unless it is an `<AbsoluteFill>` drawn as a DOM island without them.
    return node.type !== 'kg-layer' || (domFillOf(node) !== null && !holdsNative(node.children));
  }

  /** Document-wide CSS: the project's imported files, then every `<style>` element in the tree, in order. */
  private stylesheets(): string[] {
    return (this.sheets ??= [...importedStylesheets(), ...collectStyleElements([headHost, ...this.roots])]);
  }

  /**
   * An island: a DOM element, with everything inside it, drawn by the compat mapping. Its
   * `<Sequence>`s are taken out first, as `collect` does, so that they take no place in the paths.
   */
  private island(root: HostElement, path: string): LayerJson[] {
    const { viewport } = this.options;
    if (this.options.ignoreDom) return [];
    if (viewport === undefined) {
      throw new Error(
        `<${root.type}> is a DOM element, which is laid out in the composition's box: create the root with createSceneRoot({ viewport: { width, height } })`,
      );
    }
    const context = {
      path,
      viewport,
      fonts: this.options.fonts?.() ?? {},
      emitNative: (node: unknown, at: string) => this.element(node as HostElement, at),
      time: this.options.time?.() ?? 0,
      stylesheets: this.stylesheets(),
    };
    if (this.deferred) {
      // Read for its blurred layers only (`keep`), a sub-frame's island is drawn while the next sub-frame renders.
      const started = startDomIsland(flattenDomElement(root, path, this.sequences), context);
      return [{ type: STARTED, id: path, started } as unknown as LayerJson];
    }
    const result = mapDomIsland(flattenDomElement(root, path, this.sequences), context);
    this.unsupported.push(...result.unsupported);
    if (result.margin !== undefined) this.margin = Math.max(this.margin, result.margin);
    if (result.blendSpace === 'srgb') this.blendSpace = 'srgb';
    // One camera serves the tree: the same one asked for twice is one.
    const { camera } = result;
    if (camera !== null && !this.cameras.some((c) => JSON.stringify(c) === JSON.stringify(camera))) this.cameras.push(camera);
    return result.layers;
  }

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
   * the index path themselves, so a `<Sequence>` never moves an automatic id (packages/cli/skills/kinetograph/references/AUTHORING.md §11.4).
   */
  private collect(nodes: HostNode[], parentPath: string, parentName: string, out: LayerJson[], place: { next: number }): void {
    for (const node of nodes) {
      if (node.kind === 'text') {
        // The reconciler refuses these on the way in; this keeps `emit` honest on its own.
        throw new Error(`Raw text "${node.text}" is not allowed inside <${parentName}>; wrap it in <Text>`);
      }
      if (node.type === 'kg-sequence') {
        const { sequence, wrapped } = node.props as { sequence: Omit<SequenceJson, 'layer'>; wrapped: boolean };
        const record: SequenceJson = { ...sequence, layer: null, ...sequenceNames(sequence.name, node.origin) };
        this.sequences.push(record);
        const before = out.length;
        this.collect(node.children, parentPath, parentName, out, place);
        // The group its children are in: the `<Layer>` a Sequence renders, unless it has `layout="none"`.
        if (wrapped && out.length > before) record.layer = out[before]!.id;
        continue;
      }
      const path = `${parentPath}${parentPath === '' ? '$' : '.'}${place.next++}`;
      if (this.unread(node, path)) continue;
      if (isDomElement(node.type)) {
        out.push(...this.island(node, path));
        continue;
      }
      const fill = domFillOf(node);
      if (fill !== null) {
        out.push(...this.island(fill, path));
        continue;
      }
      const layer = this.element(node, path);
      if (layer !== null) out.push(layer);
    }
  }

  /** The camera, lights and objects a `<Scene3D>` holds, as the layer's fields. */
  private scene3d(scene: HostElement): { camera?: Camera3DJson; lights?: Light3DJson[]; objects?: Object3DJson[] } {
    let camera: Camera3DJson | undefined;
    const lights: Light3DJson[] = [];
    const objects: Object3DJson[] = [];
    for (const node of scene.children) {
      if (node.kind === 'text') throw new Error(`Raw text "${node.text}" is not allowed inside <Scene3D>; use <Text3D>`);
      switch (node.type) {
        case 'kg-camera3d':
          if (camera !== undefined) throw new Error('A <Scene3D> takes one <Camera3D>');
          camera = pick(node.props, ['type', 'fov', 'height', 'near', 'far', 'position', 'target', 'up']) as Camera3DJson;
          break;
        case 'kg-ambient-light':
          lights.push({ type: 'ambient', ...pick(node.props, ['color', 'intensity']) });
          break;
        case 'kg-directional-light':
          lights.push({ type: 'directional', ...pick(node.props, ['direction', 'color', 'intensity', 'castShadow', 'shadow']) });
          break;
        case 'kg-point-light':
          if (node.props.position === undefined) throw new Error('<PointLight> needs a position');
          lights.push({ type: 'point', ...pick(node.props, ['position', 'color', 'intensity', 'range']) } as Light3DJson);
          break;
        case 'kg-sequence':
          throw new Error('<Sequence> cannot be inside <Scene3D>: put it around the <Scene3D>');
        default:
          objects.push(this.object3d(node, 'Scene3D'));
      }
    }
    return {
      ...(camera !== undefined ? { camera } : {}),
      ...(lights.length > 0 ? { lights } : {}),
      ...(objects.length > 0 ? { objects } : {}),
    };
  }

  private object3d(node: HostElement, parent: string): Object3DJson {
    const { type, props } = node;
    const name = ELEMENT_NAMES[type] ?? type;
    const placement = pick(props, ['id', 'position', 'rotation', 'scale', 'visible']);
    const shadowing = pick(props, ['castShadow', 'receiveShadow']);
    const material = pick(props, ['material']);
    switch (type) {
      case 'kg-mesh': {
        const kind = props.geometry?.kind;
        if (!['box', 'sphere', 'plane', 'cylinder', 'torus'].includes(kind)) {
          throw new Error(`<Mesh> geometry.kind must be box, sphere, plane, cylinder or torus, got ${JSON.stringify(kind)}`);
        }
        return { type: 'mesh', geometry: props.geometry, ...material, ...shadowing, ...placement } as Object3DJson;
      }
      case 'kg-model':
        if (typeof props.src !== 'string') throw new Error('<Model> needs a src, the path of a .gltf or .glb file');
        return { type: 'model', src: props.src, ...pick(props, ['animation', 'time', 'loop']), ...material, ...shadowing, ...placement } as Object3DJson;
      case 'kg-text3d':
        if (typeof props.font !== 'string') throw new Error('<Text3D> needs a font, a key of the scene\'s fonts');
        return {
          type: 'text',
          text: textOf(node),
          font: fontKey(props.font, props.weight, props.fontStyle),
          ...pick(props, ['size', 'depth', 'align', 'lineHeight']),
          ...material,
          ...shadowing,
          ...placement,
        } as Object3DJson;
      case 'kg-extrude':
        if (typeof props.path !== 'string') throw new Error('<Extrude> needs a path, SVG path data');
        return { type: 'extrude', path: props.path, ...pick(props, ['size', 'depth', 'fillRule']), ...material, ...shadowing, ...placement } as Object3DJson;
      case 'kg-group3d': {
        const children: Object3DJson[] = [];
        for (const child of node.children) {
          if (child.kind === 'text') throw new Error(`Raw text "${child.text}" is not allowed inside <Group3D>; use <Text3D>`);
          children.push(this.object3d(child, 'Group3D'));
        }
        return { type: 'group', children, ...placement } as Object3DJson;
      }
      default:
        throw new Error(`<${name}> cannot be inside <${parent}>: it takes <Mesh>, <Model>, <Text3D>, <Extrude> and <Group3D>`);
    }
  }

  /** A layer, or null for `<Camera>` and `<Audio>`, which land in `cameras` and `audio` instead. */
  private element(element: HostElement, path: string): LayerJson | null {
    // A native element inside an island is emitted from here.
    if (this.unread(element, path)) return null;
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
      case 'kg-layer': {
        // A native element met inside an island (`emitNative`) can be an `<AbsoluteFill>` that holds DOM elements.
        const fill = domFillOf(element);
        if (fill !== null) {
          const layers = this.island(fill, path);
          if (this.deferred) return { ...layers[0]!, wrap: id } as unknown as LayerJson;
          return layers.length === 1 ? layers[0]! : ({ id, type: 'group', children: layers } as LayerJson);
        }
        const kept = this.keep?.has(id) ?? false;
        if (kept) this.inside += 1;
        try {
          return {
            id,
            type: 'group',
            ...pick(props, ['preserve3d', 'passThrough', 'layout', 'glsl', 'canvas']),
            ...commonOf(props, name),
            children: this.children(element.children, path, name),
          } as LayerJson;
        } finally {
          if (kept) this.inside -= 1;
        }
      }
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
        return { id, type: 'image', ...pick(props, ['width', 'height', 'fit']), ...localSrc(props), ...commonOf(props, name) } as LayerJson;
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
      case 'kg-canvas': {
        const { width, height, draw } = props;
        for (const [side, value] of [['width', width], ['height', height]] as const) {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            throw new Error(`<Canvas> ${side} must be a number of pixels, 0 or more, got ${JSON.stringify(value)}`);
          }
        }
        if (typeof draw !== 'function') throw new Error('<Canvas> needs a draw(context) function');
        // The function draws on a context of its own, made empty for this frame: a canvas is a function of its props.
        const context = createCanvasContext({ size: () => ({ width, height }), ...canvasEnvironment(this.options.fonts) });
        draw(context);
        for (const value of unsupportedFilters(context.commands)) {
          this.unsupported.push({ path: `${path} <${name}>`, element: name, property: 'filter', value, reason: 'a url() filter names a <filter> of a page, and a <Canvas> layer has none; it is drawn without' });
        }
        return { id, type: 'canvas', width, height, commands: context.commands, ...commonOf(props, name) } as LayerJson;
      }
      case 'kg-glsl': {
        const { width, height, fragment, vertex, uniforms, textures } = props;
        for (const [side, value] of [['width', width], ['height', height]] as const) {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            throw new Error(`<GlslShader> ${side} must be a number of pixels, 0 or more, got ${JSON.stringify(value)}`);
          }
        }
        if (typeof fragment !== 'string') throw new Error('<GlslShader> needs a fragment shader');
        const content = glslShader({ width, height, fragment, vertex, uniforms, textures });
        return { id, type: 'glsl', width, height, ...content, ...commonOf(props, name) } as LayerJson;
      }
      case 'kg-scene3d': {
        for (const side of ['width', 'height'] as const) {
          if (props[side] === undefined) throw new Error(`<Scene3D> needs a ${side}, the size of its box in layer pixels`);
        }
        return {
          id,
          type: 'scene3d',
          ...pick(props, ['width', 'height', 'msaa']),
          ...(props.environment !== undefined
            ? { environment: typeof props.environment === 'string' ? { src: props.environment } : props.environment }
            : {}),
          ...this.scene3d(element),
          ...commonOf(props, name),
        } as LayerJson;
      }
      case 'kg-camera3d':
      case 'kg-ambient-light':
      case 'kg-directional-light':
      case 'kg-point-light':
      case 'kg-mesh':
      case 'kg-model':
      case 'kg-text3d':
      case 'kg-extrude':
      case 'kg-group3d':
        throw new Error(`<${name}> must be inside a <Scene3D>`);
      case 'kg-video':
        // The sound is not part of the layer: it is an audio clip with the layer's id.
        this.audio.push({ id, ...props.sound });
        return {
          id,
          type: 'video',
          ...pick(props, ['width', 'height', 'fit', 'frame', 'from', 'trimBefore', 'trimAfter', 'playbackRate', 'loop']),
          ...localSrc(props),
          ...(props.datamosh !== undefined ? { datamosh: moshHold(props.datamosh) } : {}),
          ...commonOf(props, name),
        } as LayerJson;
      case 'kg-gif':
        return {
          id,
          type: 'gif',
          ...pick(props, ['width', 'height', 'fit', 'time', 'loop']),
          ...localSrc(props),
          ...commonOf(props, name),
        } as LayerJson;
      default:
        throw new Error(`Unknown element <${type}>`);
    }
  }
}

/** What a started island stands as in a sub-frame's tree until `finishIslands`. */
const STARTED = '$started';

type Started = { type: typeof STARTED; id: string; started: StartedIsland; wrap?: string };

function isStarted(layer: LayerJson): boolean {
  return (layer as { type: string }).type === STARTED;
}

/**
 * A sub-frame's layers with each island that was started (`EmitOptions.subFrameLayers`) put in, as `emit` would have
 * put it there itself. Layers without one are the same objects.
 */
export function finishIslands(layers: LayerJson[]): LayerJson[] {
  const put = (list: LayerJson[]): LayerJson[] => {
    let changed = false;
    const out: LayerJson[] = [];
    for (const layer of list) {
      if (isStarted(layer)) {
        changed = true;
        const { started, wrap } = layer as unknown as Started;
        const inner = put(started.finish().layers);
        if (wrap !== undefined && inner.length !== 1) out.push({ id: wrap, type: 'group', children: inner } as LayerJson);
        else out.push(...inner);
        continue;
      }
      if (layer.type === 'group') {
        const children = put(layer.children);
        if (children !== layer.children) {
          changed = true;
          out.push({ ...layer, children });
          continue;
        }
      }
      out.push(layer);
    }
    return changed ? out : list;
  };
  const finished = put(layers);
  gatherShaderInputs(finished);
  return finished;
}

/** The scene JSON of a host tree (the children of the root). */
export function emit(roots: HostNode[], options?: EmitOptions): RenderedTree {
  const emitter = new Emitter(options, roots);
  const layers = emitter.children(roots, '', 'the root of the tree');
  // Shader inputs are gathered once the started islands' layers are in (`finishIslands`).
  if (!emitter.deferred) gatherShaderInputs(layers);
  if (emitter.cameras.length > 1) {
    throw new Error(`Only one <Camera> is allowed per tree, found ${emitter.cameras.length}`);
  }
  return {
    layers,
    camera: emitter.cameras[0] ?? null,
    audio: emitter.audio,
    sequences: emitter.sequences,
    ...(studioBuild() ? { names: collectNames(roots) } : {}),
    unsupported: emitter.unsupported,
    ...(emitter.margin > 0 ? { margin: emitter.margin } : {}),
    ...(emitter.blendSpace !== null ? { blendSpace: emitter.blendSpace } : {}),
  };
}
