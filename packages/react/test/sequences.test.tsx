import { describe, expect, it } from 'vitest';
import { Layer, Rect, SequenceHost, Text } from '../src/index.js';
import { renderAt } from './harness.js';

const entry = { key: '/Sequence@0+10', name: null, from: 0, durationInFrames: 10, parent: null };

describe('kg-sequence', () => {
  it('is accepted at the root and inside a Layer, and emits no layer of its own', () => {
    const tree = renderAt(
      <>
        <SequenceHost sequence={entry} wrapped={false}>
          <Rect id="a" width={1} height={1} />
        </SequenceHost>
        <Layer id="g">
          <SequenceHost sequence={{ ...entry, key: '/inner', parent: null }} wrapped={true}>
            <Layer>
              <Rect width={1} height={1} />
            </Layer>
          </SequenceHost>
        </Layer>
      </>,
    );
    expect(tree.layers.map((l) => l.id)).toEqual(['a', 'g']);
    expect(tree.sequences).toEqual([
      { ...entry, layer: null },
      { ...entry, key: '/inner', layer: '$1.0' },
    ]);
  });

  it('with no children records itself and takes no place in the index path', () => {
    const tree = renderAt(
      <>
        <SequenceHost sequence={entry} wrapped={true} />
        <Rect width={1} height={1} />
      </>,
    );
    expect(tree.layers.map((l) => l.id)).toEqual(['$0']);
    expect(tree.sequences).toEqual([{ ...entry, layer: null }]);
  });

  it('lists sequences in tree order, a parent before what is inside it', () => {
    const at = (key: string) => ({ ...entry, key });
    const tree = renderAt(
      <>
        <SequenceHost sequence={at('a')} wrapped={true}>
          <Layer>
            <SequenceHost sequence={at('a/b')} wrapped={true} />
          </Layer>
        </SequenceHost>
        <SequenceHost sequence={at('c')} wrapped={true} />
      </>,
    );
    expect(tree.sequences.map((s) => s.key)).toEqual(['a', 'a/b', 'c']);
  });

  it('is refused inside <Text> and inside a shape', () => {
    expect(() =>
      renderAt(
        <Text font="Inter" size={10}>
          <SequenceHost sequence={entry} wrapped={true} />
        </Text>,
      ),
    ).toThrow('<Sequence> cannot be inside <Text>');
    expect(() =>
      renderAt(
        // @ts-expect-error Rect takes no children
        <Rect width={1} height={1}>
          <SequenceHost sequence={entry} wrapped={false} />
        </Rect>,
      ),
    ).toThrow(/<Rect> cannot have children/);
  });

  it('is transparent to the text check: raw text inside it is reported against the element it stands in', () => {
    expect(() =>
      renderAt(
        <Layer id="g">
          <SequenceHost sequence={entry} wrapped={false}>
            stray
          </SequenceHost>
        </Layer>,
      ),
    ).toThrow('Raw text "stray" is not allowed inside <Layer>');
  });
});
