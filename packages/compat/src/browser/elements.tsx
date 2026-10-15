// The native elements as React DOM components (docs/COMPAT.md §6.2): what `@kinetograph/react` exports, under the same
// names and props, for the Chrome bundle. A `Layer` is a positioned `div` with CSS transforms; shapes are `svg`;
// `Text` is a `div` set in the registered font; `Image`, `Video` and `Gif` are `img`s. Effects CSS has become `filter`;
// the rest are left out with one warning each. Every number is read at the frame being drawn, so the markup is a pure
// function of (props, frame).

import { Children, createElement, Fragment, useId, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { evalNum, type CharStyle, type Gradient, type Num, type Paint } from '@kinetograph/scene';
import type {
  AudioProps,
  CameraProps,
  CommonProps,
  EllipseProps,
  GifProps,
  ImageProps,
  LayerProps,
  LottieProps,
  MeshGradientProps,
  NoiseProps,
  PathProps,
  RectProps,
  SequenceHostProps,
  ShapeProps,
  TextProps,
  VideoProps,
} from './props.js';
import { fmt, isAbsolute, layoutCss, layoutItemCss, num, paintCss, transformCss } from './style.js';
import { useTimeline } from './timeline.js';
import { fileUrl, gifUrl, videoUrl } from './urls.js';
import { warnOnce } from './warn.js';

const cx = (...names: (string | false | undefined)[]): string => names.filter(Boolean).join(' ');
const px = (value: number): string => `${fmt(value)}px`;

// ---- a leaf: an element with a box of its own ----

interface LeafProps {
  common: CommonProps;
  tag: 'div' | 'img' | 'svg';
  className?: string;
  style?: CSSProperties;
  attrs?: Record<string, unknown>;
  children?: ReactNode;
}

/**
 * A layer that is not a group. Inside a layout it is never resized (SCENE.md "Layout", "Leaves keep their size"): the
 * layout sizes and places an item box around it, and the layer is drawn at its own size from the box's top-left corner.
 * The layer's transform, opacity, filter and clip are on the inner element, as they are on the layer.
 */
function Leaf({ common, tag, className, style, attrs, children }: LeafProps): ReactElement {
  const frame = useTimeline().absoluteFrame;
  return (
    <div className={cx('kg-el', 'kg-item', isAbsolute(common.layoutItem) && 'kg-abs')} style={layoutItemCss(common.layoutItem, frame)}>
      {createElement(
        tag,
        {
          ...attrs,
          className: cx('kg-leaf', className),
          'data-kg-id': common.id,
          style: { ...transformCss(common, frame), ...paintCss(common, frame, warnOnce), ...style },
        },
        children,
      )}
    </div>
  );
}

// ---- Layer ----

/** A group. With a `layout` it is a flex container the size it is given; without one it has no box. */
export function Layer(props: LayerProps): ReactElement {
  const frame = useTimeline().absoluteFrame;
  const flex = props.layout !== undefined;
  const style: CSSProperties = {
    ...(flex ? layoutCss(props.layout!, frame) : {}),
    ...layoutItemCss(props.layoutItem, frame),
    ...transformCss(props, frame, flex),
    ...paintCss(props, frame, warnOnce),
  };
  // A group that turns its children in 3D must not be flattened by isolation (SCENE.md "preserve3d groups").
  if (props.preserve3d) {
    style.transformStyle = 'preserve-3d';
    style.isolation = 'auto';
  }
  return (
    <div
      className={cx('kg-el', 'kg-layer', flex && 'kg-flex', !flex && 'kg-box', isAbsolute(props.layoutItem) && 'kg-abs')}
      data-kg-id={props.id}
      style={style}
    >
      {props.children}
    </div>
  );
}

// ---- shapes ----

/** A gradient as an SVG paint server (SCENE.md "Gradients"); conic gradients have no SVG form. */
function gradientDef(gradient: Gradient, id: string, frame: number): ReactElement | null {
  const box = gradient.units === 'box';
  const stops = gradient.stops.map((stop, i) => (
    <stop key={i} offset={fmt(Math.min(1, Math.max(0, num(stop.offset, frame, 0))))} stopColor={stop.color} />
  ));
  const common = {
    id,
    gradientUnits: box ? 'objectBoundingBox' : 'userSpaceOnUse',
    spreadMethod: gradient.extend === 'repeat' ? 'repeat' : gradient.extend === 'reflect' ? 'reflect' : 'pad',
  };
  if (gradient.type === 'linear') {
    return (
      <linearGradient {...common} x1={num(gradient.x0, frame, 0)} y1={num(gradient.y0, frame, 0)} x2={num(gradient.x1, frame, 0)} y2={num(gradient.y1, frame, 0)}>
        {stops}
      </linearGradient>
    );
  }
  if (gradient.type === 'radial') {
    return (
      <radialGradient {...common} cx={num(gradient.cx, frame, 0)} cy={num(gradient.cy, frame, 0)} r={Math.max(0, num(gradient.r, frame, 0))}>
        {stops}
      </radialGradient>
    );
  }
  return null;
}

/** The SVG `fill` attribute for a paint, and the gradient it needs. */
function paintOf(paint: Paint | undefined, id: string, frame: number): { value: string; def: ReactElement | null } {
  if (paint === undefined) return { value: 'none', def: null };
  if (typeof paint === 'string') return { value: paint, def: null };
  const def = gradientDef(paint, id, frame);
  if (def === null) {
    warnOnce('gradient.conic', 'a conic gradient has no SVG form; the first stop colour is used in Chrome frames');
    return { value: paint.stops[0]?.color ?? 'none', def: null };
  }
  return { value: `url(#${id})`, def };
}

interface ShapeGeometry {
  kind: 'rect' | 'roundedRect' | 'ellipse' | 'path';
  width?: Num;
  height?: Num;
  radius?: Num;
  d?: string;
}

function ShapeElement(props: CommonProps & { fill?: Paint; stroke?: { color: string; width: Num } }, geometry: ShapeGeometry): ReactElement {
  const frame = useTimeline().absoluteFrame;
  const gradientId = `kg-g${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const width = Math.max(0, num(geometry.width, frame, 0));
  const height = Math.max(0, num(geometry.height, frame, 0));
  const fill = paintOf(props.fill, gradientId, frame);
  const stroke = props.stroke ? { color: props.stroke.color, width: Math.max(0, num(props.stroke.width, frame, 0)) } : null;
  const paint = {
    fill: fill.value,
    ...(stroke ? { stroke: stroke.color, strokeWidth: stroke.width } : {}),
  };
  let shape: ReactElement;
  if (geometry.kind === 'path') {
    shape = <path d={geometry.d ?? ''} {...paint} />;
  } else if (geometry.kind === 'ellipse') {
    shape = <ellipse cx={width / 2} cy={height / 2} rx={width / 2} ry={height / 2} {...paint} />;
  } else {
    const radius = geometry.kind === 'roundedRect' ? Math.max(0, num(geometry.radius, frame, 0)) : 0;
    shape = <rect x={0} y={0} width={width} height={height} rx={radius || undefined} {...paint} />;
  }
  // A path is drawn in its own coordinates, from the layer's origin, so its svg has no extent of its own.
  const box = geometry.kind === 'path' ? { width: 0, height: 0 } : { width, height };
  return (
    <Leaf common={props} tag="svg" style={{ display: 'block', overflow: 'visible' }} attrs={box}>
      {fill.def ? <defs>{fill.def}</defs> : null}
      {shape}
    </Leaf>
  );
}

export function Shape(props: ShapeProps): ReactElement {
  return ShapeElement(props, props);
}
export function Rect(props: RectProps): ReactElement {
  return ShapeElement(props, { kind: 'roundedRect', width: props.width, height: props.height, radius: props.radius });
}
export function Ellipse(props: EllipseProps): ReactElement {
  return ShapeElement(props, { kind: 'ellipse', width: props.width, height: props.height });
}
export function Path(props: PathProps): ReactElement {
  return ShapeElement(props, { kind: 'path', d: props.d });
}

// ---- text ----

function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      throw new Error('<Text> children must be strings and numbers');
    })
    .join('');
}

/** The CSS for one character's style (SCENE.md "Per-character styles"): offset, then turn and scale about its centre. */
function charStyle(style: CharStyle, frame: number): CSSProperties {
  const x = num(style.x, frame, 0);
  const y = num(style.y, frame, 0);
  const scale = num(style.scale, frame, 1);
  const rotation = num(style.rotation, frame, 0);
  const parts: string[] = [];
  if (x !== 0 || y !== 0) parts.push(`translate(${px(x)}, ${px(y)})`);
  if (rotation !== 0) parts.push(`rotate(${fmt(rotation)}deg)`);
  if (scale !== 1) parts.push(`scale(${fmt(scale)})`);
  const css: CSSProperties = { display: 'inline-block', whiteSpace: 'pre' };
  if (parts.length > 0) css.transform = parts.join(' ');
  if (style.opacity !== undefined) css.opacity = Math.min(1, Math.max(0, num(style.opacity, frame, 1)));
  if (style.color !== undefined) css.color = style.color;
  return css;
}

/** The text, with each styled character in an inline-block of its own. */
function textContent(text: string, chars: TextProps['chars'], frame: number): ReactNode {
  if (chars === undefined) return text;
  const letters = Array.from(text);
  const styles = typeof chars === 'function' ? letters.map((c, i) => chars(c, i, letters.length) ?? null) : chars;
  const out: ReactNode[] = [];
  let plain = '';
  letters.forEach((letter, i) => {
    const style = styles[i];
    if (!style || letter === '\n') {
      plain += letter;
      return;
    }
    if (plain) out.push(plain);
    plain = '';
    out.push(
      <span key={i} style={charStyle(style, frame)}>
        {letter}
      </span>,
    );
  });
  if (plain) out.push(plain);
  return createElement(Fragment, null, ...out);
}

/**
 * Text in the registered font. The font is a CSS family, weight and style: the driver declares an `@font-face` for each
 * registered font under exactly those, so the browser picks the file the engine would. Lines break at `\n`, and at
 * `maxWidth` when there is one.
 */
export function Text(props: TextProps): ReactElement {
  const frame = useTimeline().absoluteFrame;
  const weight = typeof props.weight === 'string' ? Number(props.weight) || props.weight : (props.weight ?? 400);
  const colour = props.color ?? props.fill ?? '#000000';
  if (typeof colour !== 'string') {
    warnOnce('text.gradient', 'a gradient text colour is not drawn in Chrome frames; the first stop colour is used');
  }
  const maxWidth = props.maxWidth === undefined ? null : num(props.maxWidth, frame, 0);
  const style: CSSProperties = {
    fontFamily: `"${props.font.replace(/"/g, '\\"')}"`,
    fontWeight: weight as CSSProperties['fontWeight'],
    fontStyle: props.fontStyle ?? 'normal',
    fontSize: px(num(props.size, frame, 16)),
    lineHeight: props.lineHeight === undefined ? 'normal' : fmt(num(props.lineHeight, frame, 1)),
    color: typeof colour === 'string' ? colour : (colour.stops[0]?.color ?? '#000000'),
    textAlign: props.align ?? 'left',
    whiteSpace: maxWidth === null ? 'pre' : 'pre-wrap',
    width: maxWidth === null ? 'max-content' : px(maxWidth),
    margin: 0,
  };
  return (
    <Leaf common={props} tag="div" className="kg-text" style={style}>
      {textContent(textOf(props.children), props.chars, frame)}
    </Leaf>
  );
}

// ---- pictures ----

const OBJECT_FIT = { fill: 'fill', contain: 'contain', cover: 'cover' } as const;

/** `10` and `'10px'` are 10; anything else is null. */
function pixels(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = /^\s*(-?\d*\.?\d+)(px)?\s*$/.exec(value);
    if (match) return Number(match[1]);
  }
  return null;
}

/** The box and fit of a picture: `style.width`, `style.height` and `style.objectFit` win over the props. */
function pictureBox(
  props: { width?: Num; height?: Num; fit?: 'fill' | 'contain' | 'cover'; style?: Record<string, unknown> },
  frame: number,
): CSSProperties {
  const style = props.style ?? {};
  const out: CSSProperties = { display: 'block' };
  const width = pixels(style.width) ?? (props.width === undefined ? null : evalNum(props.width, frame));
  const height = pixels(style.height) ?? (props.height === undefined ? null : evalNum(props.height, frame));
  // One side left out keeps the aspect ratio; both left out is the picture's own size.
  if (width !== null) out.width = px(Math.max(0, width));
  if (height !== null) out.height = px(Math.max(0, height));
  if (width !== null && height === null) out.height = 'auto';
  if (height !== null && width === null) out.width = 'auto';
  const objectFit = style.objectFit;
  const fit = objectFit === 'scale-down' ? 'contain' : typeof objectFit === 'string' && objectFit in OBJECT_FIT ? (objectFit as keyof typeof OBJECT_FIT) : props.fit;
  out.objectFit = fit ?? 'fill';
  return out;
}

const PICTURE_ATTRS = { alt: '', decoding: 'sync', loading: 'eager', draggable: false } as const;

export function Image(props: ImageProps): ReactElement {
  const frame = useTimeline().absoluteFrame;
  return <Leaf common={props} tag="img" style={pictureBox(props, frame)} attrs={{ ...PICTURE_ATTRS, src: fileUrl(props.src) }} />;
}

/**
 * The picture the engine would show at this frame: the driver's server applies the time rules of SCENE.md "video" and
 * decodes it with the addon (the same code the video layer uses), so the two paths show the same picture.
 */
export function Video(props: VideoProps): ReactElement {
  const timeline = useTimeline();
  const { src, playbackRate = 1 } = props;
  const label = `<Video src=${JSON.stringify(src)}>`;
  if (typeof src !== 'string' || src === '') throw new Error(`<Video> needs a src, got ${JSON.stringify(src)}`);
  if (!(playbackRate > 0 && Number.isFinite(playbackRate))) throw new Error(`${label} playbackRate must be above 0, got ${String(playbackRate)}`);
  const url = videoUrl({
    src,
    n: timeline.frame * playbackRate,
    fps: timeline.config.fps,
    trimBefore: props.trimBefore ?? props.startFrom ?? 0,
    trimAfter: props.trimAfter ?? props.endAt ?? null,
    loop: props.loop ?? false,
  });
  return <Leaf common={props} tag="img" style={pictureBox(props, timeline.absoluteFrame)} attrs={{ ...PICTURE_ATTRS, src: url }} />;
}

/** The same element as `<Video>`. */
export const OffthreadVideo = Video;

/** An animated GIF shown at the time `frame / fps * playbackRate`, from the driver's frame endpoint. */
export function Gif(props: GifProps): ReactNode {
  const timeline = useTimeline();
  const { src, playbackRate = 1, loopBehavior = 'loop' } = props;
  if (typeof src !== 'string' || src === '') throw new Error(`<Gif> needs a src, got ${JSON.stringify(src)}`);
  const time = (timeline.frame / timeline.config.fps) * playbackRate;
  if (loopBehavior === 'unmount-after-finish' && props.durationInSeconds !== undefined && time >= props.durationInSeconds) return null;
  const url = gifUrl(src, time, loopBehavior === 'loop');
  return <Leaf common={props} tag="img" style={pictureBox(props, timeline.absoluteFrame)} attrs={{ ...PICTURE_ATTRS, src: url }} />;
}

// ---- the elements Chrome frames leave out ----

/** A box of the right size where a layer with no CSS form would be. */
function Placeholder({ props, what }: { props: CommonProps & { width: Num; height: Num }; what: string }): ReactElement {
  const frame = useTimeline().absoluteFrame;
  warnOnce(`element.${what}`, `<${what}> has no CSS form and is left out of Chrome frames`);
  return <Leaf common={props} tag="div" style={{ width: px(num(props.width, frame, 0)), height: px(num(props.height, frame, 0)) }} />;
}

export function Noise(props: NoiseProps): ReactElement {
  return <Placeholder props={props} what="Noise" />;
}
export function MeshGradient(props: MeshGradientProps): ReactElement {
  return <Placeholder props={props} what="MeshGradient" />;
}

/** There is no Lottie in Chrome in this pass: the frame fails, naming itself. */
export function Lottie(_props: LottieProps): ReactElement {
  const timeline = useTimeline();
  throw new Error(
    `<Lottie> cannot be drawn in Chrome (frame ${timeline.absoluteFrame}): Chrome frames have no Lottie renderer in this version. ` +
      'Keep the frames that hold a Lottie off the Chrome path.',
  );
}

/** Sound is not part of a picture. */
export function Audio(_props: AudioProps): null {
  return null;
}

/**
 * The camera is the page's perspective: a marker the runtime reads after each frame and sets on the stage
 * (`perspective` and `perspective-origin`). It reaches the stage's direct children, which is where CSS puts it.
 */
export function Camera(props: CameraProps): ReactElement {
  const frame = useTimeline().absoluteFrame;
  return (
    <div
      hidden
      data-kg-camera=""
      data-perspective={num(props.perspective, frame, 0)}
      data-x={props.x === undefined ? undefined : num(props.x, frame, 0)}
      data-y={props.y === undefined ? undefined : num(props.y, frame, 0)}
    />
  );
}

/** `<Sequence>` records itself for the timeline; in Chrome only what is inside it matters. */
export function SequenceHost(props: SequenceHostProps): ReactElement {
  return <>{props.children}</>;
}
