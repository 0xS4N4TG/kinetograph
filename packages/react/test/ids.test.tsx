import { Fragment, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { LayerJson } from '@kinetograph/scene';
import { Camera, createSceneRoot, Layer, Rect, Text } from '../src/index.js';
import { at, layersOf } from './harness.js';

/** The ids of a tree, depth first, as `a(b, c)`. */
function shape(layers: LayerJson[]): string {
  return layers.map((l) => (l.type === 'group' && l.children.length > 0 ? `${l.id}(${shape(l.children)})` : l.id)).join(', ');
}

const R = (props: { id?: string } = {}) => <Rect width={1} height={1} {...props} />;

describe('automatic ids', () => {
  it('are $ plus the host-tree index path', () => {
    expect(
      shape(
        layersOf(
          <>
            <R />
            <Layer>
              <R />
              <Layer>
                <R />
                <R />
              </Layer>
            </Layer>
            <R />
          </>,
        ),
      ),
    ).toBe('$0, $1($1.0, $1.1($1.1.0, $1.1.1)), $2');
  });

  it('count host elements only: components and fragments in between do not add to the path', () => {
    const Wrapper = ({ children }: { children?: ReactNode }) => <Fragment>{children}</Fragment>;
    const Card = () => (
      <Wrapper>
        <Layer>
          <Wrapper>
            <R />
          </Wrapper>
        </Layer>
      </Wrapper>
    );
    expect(shape(layersOf(<Wrapper><Card /><Card /></Wrapper>))).toBe('$0($0.0), $1($1.0)');
  });

  it('count <Camera> and <Audio>, which are host elements too', () => {
    expect(shape(layersOf(<><Camera perspective={700} /><R /></>))).toBe('$1');
  });

  it('are the same for the same tree, render after render, and across roots', () => {
    const tree = (
      <Layer>
        <R />
        <Text font="Inter" size={10}>x</Text>
      </Layer>
    );
    const first = layersOf(tree);
    expect(layersOf(tree)).toEqual(first);
    const root = createSceneRoot();
    expect(root.render(at(tree, 0)).layers).toEqual(first);
    expect(root.render(at(tree, 40)).layers).toEqual(first);
    root.unmount();
  });

  it('stay with their elements while the tree keeps its shape, however the props change', () => {
    const root = createSceneRoot();
    const a = root.render(at(<Layer><R /><Rect width={5} height={5} x={1} /></Layer>)).layers;
    const b = root.render(at(<Layer><R /><Rect width={9} height={9} x={2} /></Layer>)).layers;
    expect(shape(a)).toBe(shape(b));
    root.unmount();
  });

  it('shift with the tree when a conditional child appears, which is what explicit ids are for', () => {
    const tree = (show: boolean) => (
      <Layer>
        {show && <R />}
        <R />
      </Layer>
    );
    expect(shape(layersOf(tree(false)))).toBe('$0($0.0)');
    expect(shape(layersOf(tree(true)))).toBe('$0($0.0, $0.1)');
  });
});

describe('explicit ids', () => {
  it('are kept as given and stay put when siblings come and go', () => {
    const tree = (show: boolean) => (
      <Layer id="stage">
        {show && <R id="banner" />}
        <R id="card" />
      </Layer>
    );
    expect(shape(layersOf(tree(false)))).toBe('stage(card)');
    expect(shape(layersOf(tree(true)))).toBe('stage(banner, card)');
  });

  it('follow their elements through a keyed reorder', () => {
    const items = (order: string[]) => (
      <Layer id="list">
        {order.map((name) => (
          <Rect key={name} id={name} width={name.length} height={1} />
        ))}
      </Layer>
    );
    const root = createSceneRoot();
    const first = root.render(at(items(['a', 'bb', 'ccc']))).layers[0] as { children: LayerJson[] };
    expect(first.children.map((l) => [l.id, (l as { shape: { width: number } }).shape.width])).toEqual([
      ['a', 1],
      ['bb', 2],
      ['ccc', 3],
    ]);
    const second = root.render(at(items(['ccc', 'a', 'bb']))).layers[0] as { children: LayerJson[] };
    expect(second.children.map((l) => [l.id, (l as { shape: { width: number } }).shape.width])).toEqual([
      ['ccc', 3],
      ['a', 1],
      ['bb', 2],
    ]);
    // A removed key takes its layer with it; the others are untouched.
    const third = root.render(at(items(['bb', 'ccc']))).layers[0] as { children: LayerJson[] };
    expect(third.children.map((l) => l.id)).toEqual(['bb', 'ccc']);
    root.unmount();
  });

  it('let a matte name a source by its id whatever the order', () => {
    const [photo, word] = layersOf(
      <>
        <Rect id="photo" width={1} height={1} matte={{ layer: 'word' }} />
        <Text id="word" font="Inter" size={10}>w</Text>
      </>,
    );
    expect(photo).toMatchObject({ id: 'photo', matte: { layer: 'word' } });
    expect(word).toMatchObject({ id: 'word' });
  });

  it('mix with automatic ones', () => {
    expect(shape(layersOf(<><R /><R id="mine" /><R /></>))).toBe('$0, mine, $2');
  });
});

describe('keyed lists without explicit ids', () => {
  it('get ids by position, so a reorder changes which layer has which id', () => {
    const list = (order: number[]) => (
      <>
        {order.map((w) => (
          <Rect key={w} width={w} height={1} />
        ))}
      </>
    );
    const widths = (order: number[]) => layersOf(list(order)).map((l) => [l.id, (l as { shape: { width: number } }).shape.width]);
    expect(widths([1, 2])).toEqual([['$0', 1], ['$1', 2]]);
    expect(widths([2, 1])).toEqual([['$0', 2], ['$1', 1]]);
  });
});
