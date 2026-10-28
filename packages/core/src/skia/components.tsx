// RN-Skia's components (`@shopify/react-native-skia`): each makes the node the addon draws, with the same defaults as
// RN-Skia. Props are RN-Skia's own and are checked by the addon when it draws, which names the node and the prop.

import { createElement, isValidElement, type ComponentType, type ReactElement, type ReactNode } from 'react';

/** The props of every Skia component: RN-Skia's own, plus children. */
export type SkiaNodeProps = Record<string, any> & { children?: ReactNode };

/** A component for the node `type`, with `defaults` under the props it is given. */
function node(type: string, defaults: Record<string, unknown> = {}): ComponentType<SkiaNodeProps> {
  const Component = (props: SkiaNodeProps): ReactElement => createElement(type, { ...defaults, ...props });
  Component.displayName = type;
  return Component;
}

// ---- shapes and drawings ----

export const Fill = node('Fill');
export const Paint = node('Paint');
export const Rect = node('Rect');
export const RoundedRect = node('RoundedRect');
export const Oval = node('Oval');
export const Circle = node('Circle');
export const Line = node('Line');
export const Points = node('Points', { mode: 'points' });
export const DiffRect = node('DiffRect');
export const Path = node('Path', { start: 0, end: 1 });
export const Box = node('Box');
export const BoxShadow = node('BoxShadow');
export const Vertices = node('Vertices', { mode: 'triangles' });
export const Image = node('Image', { fit: 'contain' });
export const ImageSVG = node('ImageSVG');
export const Picture = node('Picture');
export const Atlas = node('Atlas');
export const Patch = node('Patch');
export const Text = node('Text', { x: 0, y: 0 });
export const TextBlob = node('TextBlob', { x: 0, y: 0 });
export const Glyphs = node('Glyphs', { x: 0, y: 0 });
export const TextPath = node('TextPath', { initialOffset: 0 });
export const Paragraph = node('Paragraph');

// ---- shaders ----

export const Shader = node('Shader', { uniforms: {} });
export const ImageShader = node('ImageShader', { tx: 'decal', ty: 'decal', fit: 'none', transform: [] });
export const ColorShader = node('ColorShader');
export const LinearGradient = node('LinearGradient');
export const RadialGradient = node('RadialGradient');
export const SweepGradient = node('SweepGradient');
export const TwoPointConicalGradient = node('TwoPointConicalGradient');
export const Turbulence = node('Turbulence', { seed: 0, tileWidth: 0, tileHeight: 0 });
export const FractalNoise = node('FractalNoise', { seed: 0, tileWidth: 0, tileHeight: 0 });
export const Blend = node('Blend');

// ---- image filters, colour filters, mask filters, path effects ----

export const Blur = node('BlurImageFilter', { mode: 'decal' });
export const Shadow = node('DropShadowImageFilter');
export const Offset = node('OffsetImageFilter', { x: 0, y: 0 });
export const Morphology = node('MorphologyImageFilter', { operator: 'dilate' });
export const DisplacementMap = node('DisplacementMapImageFilter');
export const RuntimeShader = node('RuntimeShaderImageFilter');
export const BlendColor = node('BlendColorFilter');
export const ColorMatrix = node('MatrixColorFilter');
export const Lerp = node('LerpColorFilter');
export const LumaColorFilter = node('LumaColorFilter');
export const LinearToSRGBGamma = node('LinearToSRGBGammaColorFilter');
export const SRGBToLinearGamma = node('SRGBToLinearGammaColorFilter');
export const BlurMask = node('BlurMaskFilter', { style: 'normal', respectCTM: true });
export const CornerPathEffect = node('CornerPathEffect');
export const DashPathEffect = node('DashPathEffect');
export const DiscretePathEffect = node('DiscretePathEffect', { seed: 0 });
export const Line2DPathEffect = node('Line2DPathEffect');
export const Path1DPathEffect = node('Path1DPathEffect');
export const Path2DPathEffect = node('Path2DPathEffect');
export const SumPathEffect = node('SumPathEffect');

/** Opacity as a colour matrix, as RN-Skia's `OpacityMatrix`. */
export const OpacityMatrix = (opacity: number): number[] => [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, opacity, 0];

// ---- groups ----

const Group_ = node('Group');
const Layer_ = node('Layer');

/** A group; `layer` is true, or a `<Paint>` element (a layer drawn with that paint), or a paint object. */
export function Group({ layer, ...props }: SkiaNodeProps): ReactElement {
  if (isValidElement(layer)) {
    return createElement(Layer_, null, layer, createElement(Group_, props));
  }
  return createElement(Group_, { layer, ...props });
}

/** What is behind the group, filtered by `filter`, then the children. */
export function BackdropFilter({ filter, children, ...props }: SkiaNodeProps): ReactElement {
  return createElement(Group_, props, createElement(node('BackdropFilter'), null, filter), children);
}

export function BackdropBlur({ blur, children, ...props }: SkiaNodeProps): ReactElement {
  return createElement(BackdropFilter, { filter: createElement(Blur, { blur, mode: 'clamp' }), ...props }, children);
}

/** Draws `children` through `mask`, by its alpha or luminance; `clip` cuts the children where the mask is empty. */
export function Mask({ children, mask, mode = 'alpha', clip = true }: SkiaNodeProps & { mask: ReactNode }): ReactElement {
  const through = createElement(Paint, { blendMode: 'src' }, mode === 'luminance' ? createElement(LumaColorFilter) : null);
  return createElement(
    Group,
    { layer: true },
    createElement(
      Group,
      { layer: through },
      mask,
      clip ? createElement(Group, { layer: createElement(Paint, { blendMode: 'dstIn' }) }, children) : null,
    ),
    createElement(Group, { blendMode: 'srcIn' }, children),
  );
}

// ---- fitting ----

type Fit = 'cover' | 'contain' | 'fill' | 'fitHeight' | 'fitWidth' | 'none' | 'scaleDown';
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** RN-Skia's `fitRects`: the part of `src` shown and where it goes in `dst`, as `<Image fit>` places a picture. */
export function fitRects(fit: Fit, src: Rect, dst: Rect): { src: Rect; dst: Rect } {
  const [iw, ih, ow, oh] = [src.width, src.height, dst.width, dst.height];
  let s: [number, number];
  let d: [number, number];
  if (iw <= 0 || ih <= 0 || ow <= 0 || oh <= 0) {
    s = [0, 0];
    d = [0, 0];
  } else if (fit === 'fill') {
    s = [iw, ih];
    d = [ow, oh];
  } else if (fit === 'cover') {
    s = ow / oh > iw / ih ? [iw, (iw * oh) / ow] : [(ih * ow) / oh, ih];
    d = [ow, oh];
  } else if (fit === 'fitWidth') {
    s = [iw, (iw * oh) / ow];
    d = [ow, (s[1] * ow) / s[0]];
  } else if (fit === 'fitHeight') {
    s = [(ih * ow) / oh, ih];
    d = [(s[0] * oh) / s[1], oh];
  } else if (fit === 'none') {
    s = [Math.min(iw, ow), Math.min(ih, oh)];
    d = s;
  } else if (fit === 'scaleDown') {
    const aspect = iw / ih;
    s = [iw, ih];
    d = [iw, ih];
    if (d[1] > oh) d = [oh * aspect, oh];
    if (d[0] > ow) d = [ow, ow / aspect];
  } else {
    s = [iw, ih];
    d = ow / oh > iw / ih ? [(iw * oh) / ih, oh] : [ow, (ih * ow) / iw];
  }
  const inscribe = ([w, h]: [number, number], r: Rect): Rect => ({ x: r.x + (r.width - w) / 2, y: r.y + (r.height - h) / 2, width: w, height: h });
  return { src: inscribe(s, src), dst: inscribe(d, dst) };
}

/** RN-Skia's `rect2rect`: the transform that maps `src` onto `dst`. */
export function rect2rect(src: Rect, dst: Rect): Record<string, number>[] {
  const scaleX = dst.width / src.width;
  const scaleY = dst.height / src.height;
  return [{ translateX: dst.x - src.x * scaleX }, { translateY: dst.y - src.y * scaleY }, { scaleX }, { scaleY }];
}

/** RN-Skia's `fitbox`: the transform that fits `src` into `dst` by `fit`, turned by `rotation` degrees (0, 90, 180, 270). */
export function fitbox(fit: Fit, src: Rect, dst: Rect, rotation: 0 | 90 | 180 | 270 = 0): Record<string, number>[] {
  const turned = rotation === 90 || rotation === 270;
  const box = turned ? { x: src.x, y: src.y, width: src.height, height: src.width } : src;
  const fitted = fitRects(fit, box, dst);
  const out = rect2rect(fitted.src, fitted.dst);
  if (rotation === 0) return out;
  const from = { x: src.x + src.width / 2, y: src.y + src.height / 2 };
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return [
    ...out,
    { translateX: to.x },
    { translateY: to.y },
    { rotate: (rotation * Math.PI) / 180 },
    { translateX: -from.x },
    { translateY: -from.y },
  ];
}

/** Its children scaled and moved so that `src` fits into `dst` by `fit` (default `contain`), as RN-Skia's `<FitBox>`. */
export function FitBox({ fit = 'contain', src, dst, children }: { fit?: Fit; src: Rect; dst: Rect; children?: ReactNode }): ReactElement {
  return createElement(Group_, { transform: fitbox(fit, src, dst) }, children);
}
