// `<Track>` and `Interactive` (docs/AUTHORING.md §7.1): the components Remotion's Studio can show in its timeline and
// edit by hand. A render shows what they wrap, so each is a `<Sequence layout="none">` (timing, `hidden`, `freeze`)
// around the element, with the crop props as a clip-path. The schemas the Studio draws its controls from are data,
// exported as Remotion has them (interactivity-schema.ts).

import type { ComponentPropsWithRef, ComponentType, CSSProperties, JSX, ReactNode } from 'react';
import { createElement } from 'react';
import { AbsoluteFill, type FillStyle } from './fill.js';
import * as schemas from './interactivity-schema.js';
import type { InteractivitySchema } from './interactivity-schema.js';
import { croppedStyle, Sequenced, splitCrop, splitTiming, type CropProps, type SequenceTimingProps } from './sequenced.js';

export interface TrackProps extends SequenceTimingProps {
  children?: ReactNode;
}

/** Groups clips on one Studio timeline row and applies Sequence timing. Shows its children for `from` and `durationInFrames`. */
export function Track({ children, ...timing }: TrackProps): ReactNode {
  return (
    <Sequenced timing={timing} component="<Track>" defaultName="Track">
      {children}
    </Sequenced>
  );
}

type ManagedProps = SequenceTimingProps & CropProps;

/** The props of Remotion's `<Interactive.Div>` and the rest: the element's own, with the timing and crop props. */
export type InteractiveElementProps<Tag extends keyof JSX.IntrinsicElements> = Omit<ComponentPropsWithRef<Tag>, keyof ManagedProps> &
  ManagedProps;

function makeElement<Tag extends keyof JSX.IntrinsicElements>(tag: Tag, label: string): (props: InteractiveElementProps<Tag>) => ReactNode {
  const displayName = `<Interactive.${label}>`;
  function InteractiveElement(props: InteractiveElementProps<Tag>): ReactNode {
    const [timing, withoutTiming] = splitTiming(props as ManagedProps);
    const [crop, { style, ...rest }] = splitCrop(withoutTiming as CropProps & { style?: CSSProperties });
    return (
      <Sequenced timing={timing} component={displayName} defaultName={displayName}>
        {createElement(tag, { ...rest, style: croppedStyle(displayName, crop, style) })}
      </Sequenced>
    );
  }
  InteractiveElement.displayName = displayName;
  return InteractiveElement;
}

export interface InteractiveCreateOptions<P extends object> {
  Component: ComponentType<P>;
  /** The fields the Studio draws controls for. A render does not read them. */
  schema?: InteractivitySchema;
  /** The label in the Studio's timeline; the component's name by default. */
  componentName?: string;
  /** How the Studio recognises the component. A render does not read it. */
  componentIdentity?: string;
  /**
   * `none` (the default): `Component` is shown as it is, with its `style` cropped. `absolute-fill`: it is shown in a
   * clipped `div` the size of the `width` and `height` props, which also takes the `style`.
   */
  layout?: 'none' | 'absolute-fill';
}

type CreatedProps<P extends object> = P & ManagedProps & { width?: number; height?: number };

/**
 * A component with Sequence timing and crop props, as Remotion's `Interactive.create()`: `<Sequence layout="none">`
 * around `Component`, or around a clipped `div` that holds it with `layout: 'absolute-fill'`.
 */
function create<P extends object>(options: InteractiveCreateOptions<P>): (props: CreatedProps<P>) => ReactNode {
  const { Component, layout = 'none' } = options;
  const componentName = options.componentName ?? (Component.displayName || Component.name.replace(/(.+)Inner$/, '$1') || 'Component');
  function Created(props: CreatedProps<P>): ReactNode {
    const { width, height, ...withoutSize } = props;
    const [timing, withoutTiming] = splitTiming((layout === 'absolute-fill' ? withoutSize : props) as ManagedProps);
    const [crop, { style, ...rest }] = splitCrop(withoutTiming as CropProps & { style?: CSSProperties });
    const cropped = croppedStyle(componentName, crop, style);
    const content =
      layout === 'absolute-fill' ? (
        <AbsoluteFill style={{ ...(width ? { width } : {}), ...(height ? { height } : {}), overflow: 'hidden', ...(cropped as FillStyle) }}>
          <Component {...(rest as unknown as P)} />
        </AbsoluteFill>
      ) : (
        <Component {...({ ...rest, style: cropped } as unknown as P)} />
      );
    return (
      <Sequenced timing={timing} component={`<${componentName}>`} defaultName={componentName}>
        {content}
      </Sequenced>
    );
  }
  Created.displayName = componentName;
  return Created;
}

/** The older form of `create`: with `wrapInSequence` it is the same, without it the component is returned as it is. */
function withSchema<P extends object>(options: InteractiveCreateOptions<P> & { wrapInSequence?: boolean }): ComponentType<P> {
  return (options.wrapInSequence ? create(options) : options.Component) as ComponentType<P>;
}

export const Interactive = {
  baseSchema: schemas.baseSchema,
  captionsSchema: schemas.captionsSchema,
  childrenSchema: schemas.childrenSchema,
  transformSchema: schemas.transformSchema,
  textSchema: schemas.textSchema,
  backgroundSchema: schemas.backgroundSchema,
  borderSchema: schemas.borderSchema,
  borderRadiusSchema: schemas.borderRadiusSchema,
  cropSchema: schemas.cropSchema,
  svgPaintSchema: schemas.svgPaintSchema,
  svgStrokeSchema: schemas.svgStrokeSchema,
  premountSchema: schemas.premountSchema,
  sequenceSchema: schemas.sequenceSchema,
  create,
  withSchema,
  A: makeElement('a', 'A'),
  Article: makeElement('article', 'Article'),
  Aside: makeElement('aside', 'Aside'),
  Button: makeElement('button', 'Button'),
  Circle: makeElement('circle', 'Circle'),
  Code: makeElement('code', 'Code'),
  Div: makeElement('div', 'Div'),
  Ellipse: makeElement('ellipse', 'Ellipse'),
  Em: makeElement('em', 'Em'),
  Footer: makeElement('footer', 'Footer'),
  G: makeElement('g', 'G'),
  H1: makeElement('h1', 'H1'),
  H2: makeElement('h2', 'H2'),
  H3: makeElement('h3', 'H3'),
  H4: makeElement('h4', 'H4'),
  H5: makeElement('h5', 'H5'),
  H6: makeElement('h6', 'H6'),
  Header: makeElement('header', 'Header'),
  Label: makeElement('label', 'Label'),
  Li: makeElement('li', 'Li'),
  Line: makeElement('line', 'Line'),
  Main: makeElement('main', 'Main'),
  Nav: makeElement('nav', 'Nav'),
  Ol: makeElement('ol', 'Ol'),
  P: makeElement('p', 'P'),
  Path: makeElement('path', 'Path'),
  Pre: makeElement('pre', 'Pre'),
  Rect: makeElement('rect', 'Rect'),
  Section: makeElement('section', 'Section'),
  Small: makeElement('small', 'Small'),
  Span: makeElement('span', 'Span'),
  Strong: makeElement('strong', 'Strong'),
  Svg: makeElement('svg', 'Svg'),
  Text: makeElement('text', 'Text'),
  Ul: makeElement('ul', 'Ul'),
};
