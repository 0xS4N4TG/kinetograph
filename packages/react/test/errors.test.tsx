import { describe, expect, it } from 'vitest';
import { Camera, createSceneRoot, Layer, Rect, Text } from '../src/index.js';
import { at, renderAt } from './harness.js';

const R = (props: { id?: string } = {}) => <Rect width={1} height={1} {...props} />;

describe('raw text', () => {
  it('outside <Text> is an error naming the parent element', () => {
    expect(() => renderAt(<Layer id="g">hello</Layer>)).toThrow('Raw text "hello" is not allowed inside <Layer>; wrap it in <Text>');
  });

  it('names the nearest host parent through components and fragments', () => {
    const Wrapper = () => <>stray</>;
    expect(() =>
      renderAt(
        <Layer>
          <Layer>
            <Wrapper />
          </Layer>
        </Layer>,
      ),
    ).toThrow('Raw text "stray" is not allowed inside <Layer>');
  });

  it('is an error at the top of the tree too', () => {
    expect(() => renderAt('top level')).toThrow('Raw text "top level" is not allowed inside the root of the tree');
  });

  it('includes numbers', () => {
    const n = 42;
    expect(() => renderAt(<Layer>{n}</Layer>)).toThrow('Raw text "42" is not allowed inside <Layer>');
  });

  it('is fine inside <Text>', () => {
    expect(() => renderAt(<Text font="Inter" size={10}>fine</Text>)).not.toThrow();
  });

  it('does not count empty children, null, false or undefined', () => {
    expect(() => renderAt(<Layer>{null}{false}{undefined}{''}</Layer>)).not.toThrow();
  });
});

describe('ids', () => {
  it('a duplicate explicit id is an error naming the id', () => {
    expect(() => renderAt(<><R id="card" /><R id="card" /></>)).toThrow('Duplicate id "card" on <Rect>');
  });

  it('is found across nesting levels', () => {
    expect(() =>
      renderAt(
        <>
          <R id="x" />
          <Layer>
            <Layer>
              <R id="x" />
            </Layer>
          </Layer>
        </>,
      ),
    ).toThrow('Duplicate id "x"');
  });

  it('an id beginning with $ is reserved', () => {
    expect(() => renderAt(<R id="$0" />)).toThrow('id "$0" is reserved');
    expect(() => renderAt(<Layer id="$custom" />)).toThrow(/reserved/);
  });

  it('an id must be a non-empty string', () => {
    expect(() => renderAt(<R id="" />)).toThrow(/non-empty string/);
    // @ts-expect-error a number is not an id
    expect(() => renderAt(<R id={7} />)).toThrow(/non-empty string/);
  });
});

describe('elements', () => {
  it('two cameras are an error', () => {
    expect(() => renderAt(<><Camera perspective={1} /><Camera perspective={2} /></>)).toThrow(/Only one <Camera>/);
  });

  it('a DOM element is an error that says what is allowed', () => {
    expect(() => renderAt(<div />)).toThrow(/Unknown element <div>/);
  });

  it('an element cannot sit inside <Text>', () => {
    expect(() => renderAt(<Text font="Inter" size={10}><Layer /></Text>)).toThrow('<Layer> cannot be inside <Text>');
  });

  it('only <Layer> takes children', () => {
    expect(() =>
      renderAt(
        // @ts-expect-error Camera takes no children
        <Camera perspective={1}><R /></Camera>,
      ),
    ).toThrow(/<Camera> cannot have children/);
  });

  it('a component that throws surfaces its own error', () => {
    const Boom = () => {
      throw new Error('boom from a component');
    };
    expect(() => renderAt(<Boom />)).toThrow('boom from a component');
  });
});

describe('recovery', () => {
  it('a root that failed renders the next valid element', () => {
    const root = createSceneRoot();
    expect(() => root.render(at(<Layer>oops</Layer>))).toThrow(/Raw text/);
    expect(root.render(at(<R id="ok" />)).layers.map((l) => l.id)).toEqual(['ok']);
    root.unmount();
  });

  it('a failed emit (duplicate ids) leaves the root usable', () => {
    const root = createSceneRoot();
    expect(() => root.render(at(<><R id="a" /><R id="a" /></>))).toThrow(/Duplicate id/);
    expect(() => root.snapshot()).toThrow(/Duplicate id/);
    expect(root.render(at(<><R id="a" /><R id="b" /></>)).layers.map((l) => l.id)).toEqual(['a', 'b']);
    root.unmount();
  });

  it('reports the same error again for the same input', () => {
    const root = createSceneRoot();
    for (let i = 0; i < 3; i += 1) {
      expect(() => root.render(at(<Layer>oops</Layer>))).toThrow('Raw text "oops"');
    }
    root.unmount();
  });
});
